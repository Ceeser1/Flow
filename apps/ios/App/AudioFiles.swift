import AVFoundation
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Songs of the phone's own and their waveforms (FlowNative pickAudio,
/// importAudio and peaks, as FlowNative.java's): iOS's file picker, a picked
/// file copied into Flow's storage with its names and picture read by
/// AVFoundation, and a file's waveform for the trim.
enum AudioFiles {
    /// What Flow plays as it is (@flow/core/formats AUDIO_EXTS); the phone converts nothing.
    static let exts: Set<String> = ["mp3", "m4a", "aac", "opus", "ogg", "oga", "flac", "wav"]
    /// A folder is looked through for at most this many songs (as the desktop's localScan).
    static let maxFiles = 2000
    /// Covers are squares this big (@flow/core/cover SIZE).
    static let coverSize = 512
    /// The waveform, as the desktop's (@flow/core/media): at most this many stretches, 8000 samples a second.
    static let peakBuckets = 6400
    static let peakRate = 8000.0

    // MARK: picking

    /// The picker on screen, kept until it answers.
    private static var picking: Picker?
    /// The folder picked last: iOS lets Flow read its files while it is "accessed".
    private static var openFolder: URL?

    private final class Picker: NSObject, UIDocumentPickerDelegate {
        let folder: Bool
        let done: ([String: Any]) -> Void

        init(folder: Bool, done: @escaping ([String: Any]) -> Void) {
            self.folder = folder
            self.done = done
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            AudioFiles.picking = nil
            let done = self.done
            if folder, let url = urls.first {
                DispatchQueue.global(qos: .userInitiated).async { done(AudioFiles.listFolder(url)) }
                return
            }
            let items: [[String: Any]] = urls.map { url in
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
                return ["uri": url.absoluteString, "name": url.lastPathComponent, "size": size]
            }
            done(["items": items, "name": "", "truncated": false])
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            AudioFiles.picking = nil
            done(["cancelled": true])
        }
    }

    /// iOS's picker: audio files (several, copied for Flow), or with `folder` a
    /// folder, looked through for audio files. Answers { items: [{ uri, name,
    /// size }], name (the folder's), truncated }, or { cancelled: true }.
    static func pick(folder: Bool, from vc: UIViewController, done: @escaping ([String: Any]) -> Void) {
        let picker: UIDocumentPickerViewController
        if folder {
            picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        } else {
            // Ogg and Opus by their names, should iOS not count them as audio.
            let more = ["opus", "ogg", "oga", "flac"].compactMap { UTType(filenameExtension: $0) }
            picker = UIDocumentPickerViewController(forOpeningContentTypes: [.audio] + more, asCopy: true)
            picker.allowsMultipleSelection = true
        }
        let p = Picker(folder: folder, done: done)
        picking = p
        picker.delegate = p
        vc.present(picker, animated: true)
    }

    /// The audio files in a picked folder, then those of the folders in it, A to Z within each.
    private static func listFolder(_ url: URL) -> [String: Any] {
        if let old = openFolder { old.stopAccessingSecurityScopedResource() }
        openFolder = url.startAccessingSecurityScopedResource() ? url : nil
        var items: [[String: Any]] = []
        var truncated = false
        func walk(_ dir: URL, _ depth: Int) {
            if depth > 12 || truncated { return }
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .nameKey]
            guard let children = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys,
                                                                                options: [.skipsHiddenFiles]) else { return }
            var files: [(URL, Int)] = []
            var dirs: [URL] = []
            for c in children {
                let v = try? c.resourceValues(forKeys: Set(keys))
                if v?.isDirectory == true {
                    dirs.append(c)
                } else if exts.contains(c.pathExtension.lowercased()) {
                    files.append((c, v?.fileSize ?? -1))
                }
            }
            files.sort { $0.0.lastPathComponent.localizedCaseInsensitiveCompare($1.0.lastPathComponent) == .orderedAscending }
            for (f, size) in files {
                if items.count >= maxFiles {
                    truncated = true
                    return
                }
                items.append(["uri": f.absoluteString, "name": f.lastPathComponent, "size": size])
            }
            dirs.sort { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
            for d in dirs { walk(d, depth + 1) }
        }
        walk(url, 0)
        return ["items": items, "name": url.lastPathComponent, "truncated": truncated]
    }

    // MARK: importing

    /// A picked file (`uri`) copied to `stem` + its extension in Flow's storage,
    /// with what its tags say, and its picture (when it has one) as a square
    /// JPEG at `cover`: { path, format, title, artist, album, duration (s),
    /// cover (true when written), bytes }. A file that is no audio, or of a
    /// kind Flow cannot play, is refused and not kept.
    static func importFile(uri: String, stem: String, cover: String) async throws -> [String: Any] {
        guard let src = URL(string: uri), src.isFileURL else { throw FlowError(message: "The file could not be opened.") }
        let ext = src.pathExtension.lowercased()
        guard exts.contains(ext) else {
            throw FlowError(message: "Flow cannot play this kind of file on the iPhone (MP3, M4A, AAC, Opus, Ogg, FLAC and WAV play).")
        }
        let path = stem + "." + ext
        guard let dest = FlowPaths.resolve(path) else { throw FlowError(message: "Not one of Flow's files: \(stem)") }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.copyItem(at: src, to: dest)
        } catch {
            throw FlowError(message: "The file could not be opened.")
        }
        do {
            let asset = AVURLAsset(url: dest)
            let tracks = try await asset.loadTracks(withMediaType: .audio)
            let duration = try await asset.load(.duration).seconds
            guard !tracks.isEmpty, duration.isFinite, duration > 0 else { throw FlowError(message: "This file has no audio in it.") }
            var title = ""
            var artist = ""
            var albumArtist = ""
            var album = ""
            var picture: Data?
            for item in try await asset.load(.commonMetadata) {
                switch item.commonKey {
                case .commonKeyTitle?: title = (try? await item.load(.stringValue)) ?? title
                case .commonKeyArtist?: artist = (try? await item.load(.stringValue)) ?? artist
                case .commonKeyAlbumName?: album = (try? await item.load(.stringValue)) ?? album
                case .commonKeyArtwork?: picture = (try? await item.load(.dataValue)) ?? picture
                default: break
                }
            }
            if artist.isEmpty {
                // The album's artist (ID3 TPE2, iTunes aART) when the song names none.
                let all = try await asset.load(.metadata)
                for item in all where item.identifier == .id3MetadataBand || item.identifier == .iTunesMetadataAlbumArtist {
                    albumArtist = (try? await item.load(.stringValue)) ?? albumArtist
                }
                artist = albumArtist
            }
            var wrote = false
            if let picture = picture, !cover.isEmpty, let coverURL = FlowPaths.resolve(cover) {
                wrote = writeCover(picture, to: coverURL)
            }
            let bytes = ((try? fm.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
            return [
                "path": path, "format": ext, "title": title.trimmingCharacters(in: .whitespaces),
                "artist": artist.trimmingCharacters(in: .whitespaces), "album": album.trimmingCharacters(in: .whitespaces),
                "duration": duration, "cover": wrote, "bytes": bytes,
            ]
        } catch {
            try? fm.removeItem(at: dest)
            if let e = error as? FlowError { throw e }
            throw FlowError(message: "The file could not be read as audio.")
        }
    }

    /// A picture as a coverSize square JPEG (the middle of it), as the desktop makes covers.
    static func writeCover(_ data: Data, to dest: URL) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
        let side = min(image.width, image.height)
        guard side > 0,
              let square = image.cropping(to: CGRect(x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)),
              let ctx = CGContext(data: nil, width: coverSize, height: coverSize, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            return false
        }
        ctx.interpolationQuality = .high
        ctx.draw(square, in: CGRect(x: 0, y: 0, width: coverSize, height: coverSize))
        guard let scaled = ctx.makeImage() else { return false }
        try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let out = CGImageDestinationCreateWithURL(dest as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(out, scaled, [kCGImageDestinationLossyCompressionQuality as String: 0.9] as CFDictionary)
        return CGImageDestinationFinalize(out)
    }

    // MARK: the waveform

    /// The waveform of `path` (in Flow's storage), `duration` s long, as the
    /// desktop draws it with ffmpeg (@flow/core/media peaksFor): the channels
    /// mixed, the song cut into stretches (at most peakBuckets, 8000 a second),
    /// each with its lowest and highest sample (-1 to 1): [min, max, ...].
    static func peaks(path: String, duration: Double) async throws -> [Double] {
        guard let url = FlowPaths.resolve(path), FileManager.default.fileExists(atPath: url.path) else {
            throw FlowError(message: "Not one of Flow's files: \(path)")
        }
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw FlowError(message: "This file has no audio in it.")
        }
        var length = duration
        if length <= 0 { length = try await asset.load(.duration).seconds }
        guard length.isFinite, length > 0 else { throw FlowError(message: "The song's length is not known.") }
        let total = Int((length * peakRate).rounded())
        let buckets = max(1, min(peakBuckets, total))
        let perBucket = max(1, Int((Double(total) / Double(buckets)).rounded(.up)))

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: peakRate,
        ])
        reader.add(output)
        guard reader.startReading() else { throw FlowError(message: "The waveform could not be read.") }
        var mins = [Float](repeating: 0, count: buckets)
        var maxs = [Float](repeating: 0, count: buckets)
        var seen = [Bool](repeating: false, count: buckets)
        var frame = 0
        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let bytes = CMBlockBufferGetDataLength(block)
            guard bytes >= MemoryLayout<Float>.size else { continue }
            var values = [Float](repeating: 0, count: bytes / MemoryLayout<Float>.size)
            let status = values.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: raw.count, destination: raw.baseAddress!)
            }
            guard status == kCMBlockBufferNoErr else { continue }
            for v in values {
                let b = min(buckets - 1, frame / perBucket)
                if !seen[b] {
                    seen[b] = true
                    mins[b] = v
                    maxs[b] = v
                } else {
                    if v < mins[b] { mins[b] = v }
                    if v > maxs[b] { maxs[b] = v }
                }
                frame += 1
            }
        }
        if reader.status == .failed { throw FlowError(message: reader.error?.localizedDescription ?? "The waveform could not be read.") }
        guard frame > 0 else { throw FlowError(message: "No audio could be read from the file.") }
        var flat: [Double] = []
        flat.reserveCapacity(buckets * 2)
        for b in 0..<buckets {
            flat.append((Double(mins[b]) * 1000).rounded() / 1000)
            flat.append((Double(maxs[b]) * 1000).rounded() / 1000)
        }
        return flat
    }
}
