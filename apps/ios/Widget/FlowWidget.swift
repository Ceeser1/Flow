import AppIntents
import SwiftUI
import UIKit
import WidgetKit

// Flow on the home screen, as the Android widget: the song playing (cover,
// title, artist) with Play/Pause and Next; the medium one has a bigger cover,
// the timeline and Previous too. The buttons work Flow's player without
// opening Flow, even when Flow is not running (Shared/WidgetShared.swift: it
// then plays the song it stopped on); a tap anywhere else opens Flow. Flow
// draws it again whenever its song or playing changes (App/WidgetFeed.swift);
// while playing, the timeline moves on by itself.

struct SongEntry: TimelineEntry {
    let date: Date
    let song: WidgetSong?
    let cover: UIImage?
}

struct SongProvider: TimelineProvider {
    func placeholder(in context: Context) -> SongEntry {
        SongEntry(date: Date(), song: WidgetSong(title: "Song", artist: "Artist", playing: false, position: 0, duration: 0, at: Date(), cover: false),
                  cover: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (SongEntry) -> Void) {
        completion(now())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SongEntry>) -> Void) {
        // Flow asks for it again itself.
        completion(Timeline(entries: [now()], policy: .never))
    }

    private func now() -> SongEntry {
        let song = FlowGroup.song()
        var cover: UIImage?
        if song?.cover == true, let file = FlowGroup.coverFile {
            cover = UIImage(contentsOfFile: file.path)
        }
        return SongEntry(date: Date(), song: song, cover: cover)
    }
}

// Flow's colours (renderer/style.css: --bg, --text, --accent).
private enum Palette {
    static let background = Color(red: 0x1E / 255, green: 0x1E / 255, blue: 0x22 / 255)
    static let ink = Color(red: 0xD2 / 255, green: 0xD2 / 255, blue: 0xD8 / 255)
    static let accent = Color(red: 0x5A / 255, green: 0x8C / 255, blue: 0xDC / 255)
}

struct FlowWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SongEntry

    var body: some View {
        Group {
            if let song = entry.song {
                if family == .systemSmall {
                    small(song)
                } else {
                    medium(song)
                }
            } else {
                empty
            }
        }
        .containerBackground(for: .widget) { Palette.background }
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "music.note").font(.title2).foregroundStyle(Palette.accent)
            Text("Flow").font(.headline).foregroundStyle(Palette.ink)
            Text("Open Flow and play a song.").font(.caption2).foregroundStyle(Palette.ink.opacity(0.6)).multilineTextAlignment(.center)
        }
    }

    private func small(_ song: WidgetSong) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            cover(56)
            Spacer(minLength: 0)
            names(song, lines: 1)
            controls(song, previous: false)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func medium(_ song: WidgetSong) -> some View {
        HStack(spacing: 14) {
            cover(120)
            VStack(alignment: .leading, spacing: 8) {
                names(song, lines: 2)
                Spacer(minLength: 0)
                progress(song)
                controls(song, previous: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }

    private func cover(_ size: CGFloat) -> some View {
        Group {
            if let image = entry.cover {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    Palette.accent.opacity(0.22)
                    Image(systemName: "music.note").font(.system(size: size * 0.36)).foregroundStyle(Palette.accent)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.1))
    }

    private func names(_ song: WidgetSong, lines: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(song.title.isEmpty ? "Unknown" : song.title)
                .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(lines)
            if !song.artist.isEmpty {
                Text(song.artist).font(.caption).foregroundStyle(Palette.ink.opacity(0.65)).lineLimit(1)
            }
        }
    }

    /// Where the song is: moving on by itself while it plays.
    @ViewBuilder
    private func progress(_ song: WidgetSong) -> some View {
        if song.duration > 0 {
            let start = song.at.addingTimeInterval(-song.position)
            if song.playing {
                ProgressView(timerInterval: start...start.addingTimeInterval(song.duration), countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .tint(Palette.accent)
            } else {
                ProgressView(value: min(max(song.position, 0), song.duration), total: song.duration).tint(Palette.accent)
            }
        }
    }

    private func controls(_ song: WidgetSong, previous: Bool) -> some View {
        HStack(spacing: previous ? 22 : 16) {
            if previous {
                Button(intent: PreviousSongIntent()) { Image(systemName: "backward.fill") }
            }
            Button(intent: TogglePlayIntent()) { Image(systemName: song.playing ? "pause.fill" : "play.fill") }
            Button(intent: NextSongIntent()) { Image(systemName: "forward.fill") }
        }
        .buttonStyle(.plain)
        .font(.title3)
        .foregroundStyle(Palette.ink)
    }
}

struct FlowNowWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowWidget", provider: SongProvider()) { entry in
            FlowWidgetView(entry: entry)
        }
        .configurationDisplayName("Flow")
        .description("The song playing, with Play/Pause and Next.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct FlowWidgets: WidgetBundle {
    var body: some Widget {
        FlowNowWidget()
    }
}
