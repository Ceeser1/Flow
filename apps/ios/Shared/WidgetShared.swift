import AppIntents
import Foundation

// What Flow and its widget (Widget/) share: the song the widget shows, kept
// in the App Group's folder by the app (App/WidgetFeed.swift), and the
// widget's buttons. Built into both.

/// The song on the widget, as the app last told it.
struct WidgetSong: Codable, Equatable {
    var title: String
    var artist: String
    var playing: Bool
    /// Where the song was (s) at `at`, and its length (s; 0: not known).
    var position: Double
    var duration: Double
    var at: Date
    /// Its cover is in the folder (FlowGroup.coverFile).
    var cover: Bool
}

enum FlowGroup {
    /// The App Group: as SideStore named it for the Apple ID that signed Flow
    /// (it writes the names into Info.plist's ALTAppGroups), else Flow's own.
    static let id: String = {
        if let names = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String], let first = names.first, !first.isEmpty {
            return first
        }
        return "group.io.github.ceeser1.flow"
    }()

    static var folder: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) }
    static var songFile: URL? { folder?.appendingPathComponent("widget-song.json") }
    static var coverFile: URL? { folder?.appendingPathComponent("widget-cover.jpg") }

    static func song() -> WidgetSong? {
        guard let file = songFile, let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(WidgetSong.self, from: data)
    }
}

/// The widget's buttons.
enum WidgetAction: String {
    case toggle, next, previous
}

/// Carries a button out. Audio intents run in Flow's own process (iOS starts
/// it in the background when it is not running): there the app sets this at
/// its start; in the widget's process it stays nil.
enum WidgetControl {
    nonisolated(unsafe) static var handler: ((WidgetAction) async -> Void)?
}

struct TogglePlayIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Play or Pause"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await WidgetControl.handler?(.toggle)
        return .result()
    }
}

struct NextSongIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Next Song"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await WidgetControl.handler?(.next)
        return .result()
    }
}

struct PreviousSongIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Previous Song"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await WidgetControl.handler?(.previous)
        return .result()
    }
}
