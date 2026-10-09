import Foundation

/// The tags of Ogg (Opus, Vorbis) and FLAC files, which iOS does not read
/// (AVFoundation's metadata has none of them): their Vorbis comments (TITLE,
/// ARTIST, ALBUMARTIST, ALBUM) and picture (FLAC's PICTURE block, Ogg's
/// METADATA_BLOCK_PICTURE), the front cover first, as the desktop reads them
/// (@flow/core/tags.js).
enum VorbisComments {
    struct Tags {
        var title = ""
        var artist = ""
        var albumArtist = ""
        var album = ""
        var picture: Data?
        fileprivate var pictureType: UInt32?
    }

    /// Only a file's start is read: the tags come first (a picture makes them big).
    private static let most = 24 * 1024 * 1024

    static func read(_ url: URL) -> Tags? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: most), data.count > 4 else { return nil }
        let b = [UInt8](data)
        if b.starts(with: Array("fLaC".utf8)) { return flac(b) }
        if b.starts(with: Array("OggS".utf8)) { return ogg(b) }
        return nil
    }

    /// Whether an Ogg file holds Vorbis (which iOS does not play), by its first packet.
    static func isVorbis(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 4096), let first = packets([UInt8](data), count: 1).first else { return false }
        return first.starts(with: [1] + Array("vorbis".utf8))
    }

    // MARK: Ogg

    private static func ogg(_ b: [UInt8]) -> Tags? {
        let p = packets(b, count: 2)
        guard p.count == 2 else { return nil }
        let opus = Array("OpusTags".utf8)
        let vorbis = [3] + Array("vorbis".utf8)
        var tags = Tags()
        if p[1].starts(with: opus) {
            comments(p[1], from: opus.count, into: &tags)
        } else if p[1].starts(with: vorbis) {
            comments(p[1], from: vorbis.count, into: &tags)
        } else {
            return nil
        }
        return tags
    }

    /// The first `count` packets of the file's first stream, put together from its pages.
    private static func packets(_ b: [UInt8], count: Int) -> [[UInt8]] {
        var out: [[UInt8]] = []
        var packet: [UInt8] = []
        var serial: UInt32?
        var at = 0
        while at + 27 <= b.count, b[at] == 0x4F, b[at + 1] == 0x67, b[at + 2] == 0x67, b[at + 3] == 0x53 {
            let s = le32(b, at + 14) ?? 0
            let segments = Int(b[at + 26])
            guard at + 27 + segments <= b.count else { break }
            if serial == nil { serial = s }
            var body = at + 27 + segments
            for i in 0..<segments {
                let length = Int(b[at + 27 + i])
                guard body + length <= b.count else { return out }
                if s == serial {
                    packet.append(contentsOf: b[body..<(body + length)])
                    // A segment shorter than 255 ends its packet.
                    if length < 255 {
                        out.append(packet)
                        packet = []
                        if out.count >= count { return out }
                    }
                }
                body += length
            }
            at = body
        }
        return out
    }

    // MARK: FLAC

    private static func flac(_ b: [UInt8]) -> Tags? {
        var tags = Tags()
        var at = 4
        while at + 4 <= b.count {
            let head = b[at]
            let length = Int(b[at + 1]) << 16 | Int(b[at + 2]) << 8 | Int(b[at + 3])
            let body = at + 4
            guard body + length <= b.count else { break }
            switch head & 0x7F {
            case 4: comments(Array(b[body..<(body + length)]), from: 0, into: &tags)
            case 6: keep(picture(Array(b[body..<(body + length)])), in: &tags)
            default: break
            }
            // The last block before the sound.
            if head & 0x80 != 0 { break }
            at = body + length
        }
        return tags
    }

    // MARK: the comments and pictures

    /// A comment block (after its packet's name): the vendor, then "KEY=value" fields.
    private static func comments(_ c: [UInt8], from start: Int, into tags: inout Tags) {
        guard let vendor = le32(c, start) else { return }
        var at = start + 4 + Int(vendor)
        guard let count = le32(c, at) else { return }
        at += 4
        for _ in 0..<min(Int(count), 10000) {
            guard let length = le32(c, at), at + 4 + Int(length) <= c.count else { return }
            let field = c[(at + 4)..<(at + 4 + Int(length))]
            at += 4 + Int(length)
            guard let eq = field.firstIndex(of: 0x3D) else { continue }
            let key = String(decoding: field[field.startIndex..<eq], as: UTF8.self).uppercased()
            let value = String(decoding: field[(eq + 1)...], as: UTF8.self).trimmingCharacters(in: .whitespaces)
            switch key {
            case "TITLE": if tags.title.isEmpty { tags.title = value }
            case "ARTIST": if tags.artist.isEmpty { tags.artist = value }
            case "ALBUMARTIST", "ALBUM ARTIST": if tags.albumArtist.isEmpty { tags.albumArtist = value }
            case "ALBUM": if tags.album.isEmpty { tags.album = value }
            case "METADATA_BLOCK_PICTURE":
                if let raw = Data(base64Encoded: value, options: .ignoreUnknownCharacters) { keep(picture([UInt8](raw)), in: &tags) }
            default: break
            }
        }
    }

    /// A FLAC PICTURE block: { type, the picture's bytes }.
    private static func picture(_ b: [UInt8]) -> (type: UInt32, data: Data)? {
        guard let type = be32(b, 0), let mime = be32(b, 4) else { return nil }
        var at = 8 + Int(mime)
        guard let description = be32(b, at) else { return nil }
        // Past the description, width, height, depth and colours.
        at += 4 + Int(description) + 16
        guard let length = be32(b, at), at + 4 + Int(length) <= b.count, length > 0 else { return nil }
        return (type, Data(b[(at + 4)..<(at + 4 + Int(length))]))
    }

    /// The front cover (type 3) over any other picture, else the first one.
    private static func keep(_ p: (type: UInt32, data: Data)?, in tags: inout Tags) {
        guard let p = p else { return }
        if tags.picture == nil || (p.type == 3 && tags.pictureType != 3) {
            tags.picture = p.data
            tags.pictureType = p.type
        }
    }

    private static func le32(_ b: [UInt8], _ at: Int) -> UInt32? {
        guard at >= 0, at + 4 <= b.count else { return nil }
        return UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
    }

    private static func be32(_ b: [UInt8], _ at: Int) -> UInt32? {
        guard at >= 0, at + 4 <= b.count else { return nil }
        return UInt32(b[at]) << 24 | UInt32(b[at + 1]) << 16 | UInt32(b[at + 2]) << 8 | UInt32(b[at + 3])
    }
}
