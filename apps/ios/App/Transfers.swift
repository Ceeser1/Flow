import Foundation

/// A failure as the page hears it: what went wrong, and whether it was the
/// network (the page's OfflineError, code OFFLINE).
struct FlowError: LocalizedError {
    let message: String
    var offline = false

    var errorDescription: String? { message }

    /// A request that failed: the network's fault, or not.
    static func from(_ error: Error) -> FlowError {
        if let e = error as? FlowError { return e }
        let e = error as NSError
        let network = [
            NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost,
            NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed,
            NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff, NSURLErrorCallIsActive,
            NSURLErrorSecureConnectionFailed, NSURLErrorResourceUnavailable,
        ]
        let offline = e.domain == NSURLErrorDomain && network.contains(e.code)
        let message = e.domain == NSURLErrorDomain && e.code == NSURLErrorTimedOut
            ? "The server did not answer in time." : e.localizedDescription
        return FlowError(message: message, offline: offline)
    }
}

/// Files to and from a Flow Server (FlowNative download and upload, as
/// FlowNative.java's): a server's file saved straight into Flow's storage, a
/// file of Flow's sent as a request's body, each with its progress.
final class Transfers {
    static let shared = Transfers()

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    /// What a transfer's progress needs to keep between its calls.
    private final class Watch {
        var observation: NSKeyValueObservation?
        var told = 0.0
    }

    private func follow(_ task: URLSessionTask, _ w: Watch, _ progress: ((Double) -> Void)?) {
        guard let progress = progress else { return }
        w.observation = task.progress.observe(\.fractionCompleted) { p, _ in
            let f = p.fractionCompleted
            // In steps of 2%, as on Android.
            if f - w.told >= 0.02 || (f >= 1 && w.told < 1) {
                w.told = f
                progress(f)
            }
        }
    }

    /// GET `url` into the file `dest`: { status, bytes } for 200, any other
    /// answer { status, text } and no file. Unreachable, timed out or cut off:
    /// a FlowError marked offline.
    func download(_ url: URL, headers: [String: String], to dest: URL, timeout: TimeInterval,
                  progress: ((Double) -> Void)?, done: @escaping (Result<[String: Any], FlowError>) -> Void) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let w = Watch()
        let task = session.downloadTask(with: request) { temp, response, error in
            w.observation?.invalidate()
            if let error = error {
                done(.failure(FlowError.from(error)))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let temp = temp else {
                done(.failure(FlowError(message: "The download failed.")))
                return
            }
            if status != 200 {
                let text = (try? String(contentsOf: temp, encoding: .utf8)) ?? ""
                done(.success(["status": status, "text": String(text.prefix(65536))]))
                return
            }
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                try fm.moveItem(at: temp, to: dest)
            } catch {
                done(.failure(FlowError(message: error.localizedDescription)))
                return
            }
            let bytes = ((try? fm.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
            if let expected = response?.expectedContentLength, expected > 0, expected != bytes {
                try? fm.removeItem(at: dest)
                done(.failure(FlowError(message: "The download was cut off.", offline: true)))
                return
            }
            done(.success(["status": status, "bytes": bytes]))
        }
        follow(task, w, progress)
        task.resume()
    }

    /// Sends the file `file` to `url` as the body (`method`): { status, text }.
    /// Unreachable, timed out or cut off: a FlowError marked offline.
    func upload(_ file: URL, to url: URL, method: String, headers: [String: String], timeout: TimeInterval,
                progress: ((Double) -> Void)?, done: @escaping (Result<[String: Any], FlowError>) -> Void) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        let w = Watch()
        let task = session.uploadTask(with: request, fromFile: file) { data, response, error in
            w.observation?.invalidate()
            if let error = error {
                done(.failure(FlowError.from(error)))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.map { String(decoding: $0.prefix(65536), as: UTF8.self) } ?? ""
            done(.success(["status": status, "text": text]))
        }
        follow(task, w, progress)
        task.resume()
    }
}
