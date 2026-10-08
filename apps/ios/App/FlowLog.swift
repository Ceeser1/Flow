import Foundation
import os

/// What playback did, kept in Flow's files to read afterwards (as
/// FlowLog.java): <files>/logs/flow.log, moved to flow.1.log once it reaches
/// maxBytes, so at most two of them. The Simulator's runs on GitHub fetch it
/// (apps/ios/testing). Lines also go to the system log (subsystem
/// io.github.ceeser1.flow) and, in Debug builds, to the app's output.
enum FlowLog {
    private static let maxBytes: UInt64 = 512 * 1024
    private static let queue = DispatchQueue(label: "io.github.ceeser1.flow.log")
    private static let logger = Logger(subsystem: "io.github.ceeser1.flow", category: "Flow")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    static var dir: URL { FlowPaths.files.appendingPathComponent("logs", isDirectory: true) }

    static func i(_ text: String) {
        logger.info("\(text, privacy: .public)")
        #if DEBUG
        print("Flow: \(text)")
        #endif
        let now = Date()
        queue.async { FlowLog.write(now, text) }
    }

    private static func write(_ when: Date, _ text: String) {
        let line = "\(stamp.string(from: when)) \(text)\n"
        let fm = FileManager.default
        let folder = dir
        let file = folder.appendingPathComponent("flow.log")
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: file.path))?[.size] as? UInt64, size > maxBytes {
                let old = folder.appendingPathComponent("flow.1.log")
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: file, to: old)
            }
            if !fm.fileExists(atPath: file.path) {
                fm.createFile(atPath: file.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            _ = try handle.seekToEnd()
            try handle.write(contentsOf: Data(line.utf8))
        } catch {
            logger.error("log: \(error.localizedDescription, privacy: .public)")
        }
    }
}
