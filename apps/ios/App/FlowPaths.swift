import Foundation

/// Where Flow keeps its things on the iPhone, and the names the page knows
/// them by.
///
/// An iPhone app's folders move whenever it is updated, and SideStore
/// re-signing Flow every week counts as an update: their path holds an id that
/// changes. So the page never keeps the real paths. It gets names that stay,
/// "/Flow/files" and "/Flow/cache" (FlowSync.info), and every path it hands
/// over is taken for the folder that name stands for now. The real paths
/// (`real` in FlowSync.info) are only for addresses the page loads at once
/// (Capacitor.convertFileSrc).
enum FlowPaths {
    static let filesName = "/Flow/files"
    static let cacheName = "/Flow/cache"

    /// Library/Flow: Flow's own files, kept until Flow is deleted.
    static let files: URL = folder(FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0], "Flow")

    /// Library/Caches/Flow: iOS may empty it when the phone runs out of room.
    static let cache: URL = folder(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0], "Flow")

    private static func folder(_ parent: URL, _ name: String) -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A path from the page (a name above, or a real path) as the file it is
    /// now; nil when it is not in Flow's files or cache.
    static func resolve(_ path: String) -> URL? {
        guard !path.isEmpty else { return nil }
        var real = path
        if path == filesName || path.hasPrefix(filesName + "/") {
            real = files.path + path.dropFirst(filesName.count)
        } else if path == cacheName || path.hasPrefix(cacheName + "/") {
            real = cache.path + path.dropFirst(cacheName.count)
        }
        let url = URL(fileURLWithPath: real).standardizedFileURL
        return inside(url, files) || inside(url, cache) ? url : nil
    }

    /// A file of Flow's by the name the page knows it by ("/Flow/files/...").
    static func name(of url: URL) -> String {
        let p = canonical(url)
        for (dir, name) in [(files, filesName), (cache, cacheName)] {
            let d = canonical(dir)
            if p == d { return name }
            if p.hasPrefix(d + "/") { return name + p.dropFirst(d.count) }
        }
        return url.path
    }

    static func inside(_ url: URL, _ dir: URL) -> Bool {
        let p = canonical(url)
        let d = canonical(dir)
        return p == d || p.hasPrefix(d + "/")
    }

    /// A path to compare: no "..", no trailing slash, and /private/var as /var
    /// (iOS gives the same folder either way).
    private static func canonical(_ url: URL) -> String {
        var p = url.standardizedFileURL.path
        if p.hasPrefix("/private/") { p = String(p.dropFirst("/private".count)) }
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }
}
