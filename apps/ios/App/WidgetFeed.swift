import UIKit
import WidgetKit

/// The widget's song (Widget/), kept up to date from Flow's player: written
/// into the App Group's folder whenever what the widget shows changes (the
/// song, its cover, playing or not, a jump in its place), and the widget
/// asked to draw it again. The widget's buttons come back here
/// (WidgetControl) and go to the player (FlowPlayer.widget).
enum WidgetFeed {
    private static var told: WidgetSong?
    // The artwork (the page's path) the cover in the folder was made from.
    private static var coverFrom = ""
    private static let queue = DispatchQueue(label: "io.github.ceeser1.flow.widget")
    private static let coverSize: CGFloat = 320

    /// At the app's start: the widget's buttons to the player.
    static func start() {
        WidgetControl.handler = { action in
            await MainActor.run { FlowPlayer.shared.widget(action) }
        }
    }

    /// What plays now; artwork: its cover's path (the page's), if any. On the main thread.
    static func tell(title: String, artist: String, playing: Bool, position: Double, duration: Double, artwork: String) {
        let now = Date()
        let song = WidgetSong(title: title, artist: artist, playing: playing, position: max(0, position), duration: max(0, duration),
                              at: now, cover: !artwork.isEmpty)
        if let was = told, was.title == song.title, was.artist == song.artist, was.playing == song.playing,
           abs(was.duration - song.duration) < 1, artwork == coverFrom {
            // Where it should be by now, if nothing jumped: the widget's timeline is there already.
            let expected = was.position + (was.playing ? now.timeIntervalSince(was.at) : 0)
            if abs(expected - song.position) < 2 { return }
        }
        let newCover = artwork != coverFrom
        told = song
        coverFrom = artwork
        queue.async {
            // Signed without the App Group: no widget to tell.
            guard let songFile = FlowGroup.songFile, let coverFile = FlowGroup.coverFile else { return }
            var out = song
            if newCover {
                out.cover = writeCover(artwork, to: coverFile)
            } else {
                out.cover = out.cover && FileManager.default.fileExists(atPath: coverFile.path)
            }
            if let data = try? JSONEncoder().encode(out) {
                try? data.write(to: songFile, options: .atomic)
            }
            WidgetCenter.shared.reloadTimelines(ofKind: "FlowWidget")
        }
    }

    /// Nothing loaded any more: the song stays on the widget, paused.
    static func stopped() {
        guard var song = told, song.playing else { return }
        let now = Date()
        song.position += now.timeIntervalSince(song.at)
        song.at = now
        song.playing = false
        tell(title: song.title, artist: song.artist, playing: false, position: song.position, duration: song.duration, artwork: coverFrom)
    }

    /// The cover, small (a widget's pictures must be), into the folder. Whether there is one.
    private static func writeCover(_ artwork: String, to file: URL) -> Bool {
        guard !artwork.isEmpty, let source = FlowPaths.resolve(artwork), let image = UIImage(contentsOfFile: source.path) else {
            try? FileManager.default.removeItem(at: file)
            return false
        }
        let scale = min(1, coverSize / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let data = small.jpegData(compressionQuality: 0.85) else { return false }
        do {
            try data.write(to: file, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
