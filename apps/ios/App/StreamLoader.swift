import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// How the player fetches songs from a Flow Server, as Streams.java: AVPlayer
/// gets them as "flow-http(s)://..." addresses and asks Flow for their bytes
/// (AVAssetResourceLoader), which fetches them itself.
///
/// With the newest token: a song's address carries the token it was made with
/// (?t=), and a server reached from the internet ends a session after a while.
/// Every request goes with the token in use now: the page's newest, or the
/// player's own after it signed in again.
///
/// Signed in again: a server that ended this app's session (401) is signed in
/// to again here (ServerSignIn) and the request made again, so the song plays
/// on where it was. AVQueuePlayer moves past a song that failed by itself, so
/// a 401 that reached it would cost the songs after it too.
///
/// Patiently: a stream that breaks off (no network, the server away a moment)
/// is tried again where it stopped, at most every RETRY_MAX s, for about
/// RETRY_FOR, while the player waits as for a slow network. A refusal (403,
/// 404...) fails at once, its status kept for the page (refusal(of:)).
/// Anything else (a broken answer) is tried a few times.
final class StreamLoader: NSObject {
    static let shared = StreamLoader()

    private static let prefix = "flow-"
    private static let retryMax: TimeInterval = 10
    private static let retryFor: TimeInterval = 10 * 60

    /// One of AVPlayer's requests: bytes of a song, from `offset` to `end` (nil: to its end).
    private final class Load {
        let request: AVAssetResourceLoadingRequest
        let address: String
        var offset: Int64
        let end: Int64?
        var task: URLSessionDataTask?
        var status = 0
        var tokenUsed = ""
        // Bytes to drop: a server that sent the whole song where a part was asked for.
        var skip: Int64 = 0
        var tries = 0
        var brokeSince: Date?
        var signedIn = false
        var done = false

        init(request: AVAssetResourceLoadingRequest, address: String, offset: Int64, end: Int64?) {
            self.request = request
            self.address = address
            self.offset = offset
            self.end = end
        }
    }

    private let queue = DispatchQueue(label: "io.github.ceeser1.flow.streams")
    private var session: URLSession!

    // The token and the servers' refusals, read from any thread.
    private let lock = NSLock()
    private var token = ""
    private var pageToken = ""
    private var refusals: [String: Int] = [:]

    // On `queue` only.
    private var byTask: [Int: Load] = [:]
    private var byRequest: [ObjectIdentifier: Load] = [:]
    private var waiting: [Load] = []
    private var signingIn = false

    private override init() {
        super.init()
        let ops = OperationQueue()
        ops.underlyingQueue = queue
        ops.maxConcurrentOperationCount = 1
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        // Silence this long (no byte) breaks a stream off: tried again.
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config, delegate: self, delegateQueue: ops)
    }

    /// A song's sound from an address: a Flow Server's through here, any other as it is.
    func asset(_ address: String) -> AVURLAsset? {
        guard let url = URL(string: address), url.scheme == "http" || url.scheme == "https" else { return nil }
        guard !FlowPlayer.baseOf(address).isEmpty, let own = URL(string: StreamLoader.prefix + address) else {
            return AVURLAsset(url: url)
        }
        let asset = AVURLAsset(url: own)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    // MARK: the token

    /// An address the page sent: the token in it is the one to use, if the page has a new one.
    func fromPage(_ address: String) {
        let t = FlowPlayer.tokenOf(address)
        lock.lock()
        defer { lock.unlock() }
        if t.isEmpty || t == pageToken { return }
        pageToken = t
        token = t
    }

    /// Signed in again (here, or by SessionKeeper): the songs go with this token now.
    func use(_ t: String) {
        lock.lock()
        token = t
        lock.unlock()
    }

    private func tokenNow() -> String {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    private static func withToken(_ address: String, _ t: String) -> String {
        guard !t.isEmpty, var parts = URLComponents(string: address), let items = parts.queryItems,
              items.contains(where: { $0.name == "t" && $0.value != t }) else {
            return address
        }
        parts.queryItems = items.map { $0.name == "t" ? URLQueryItem(name: "t", value: t) : $0 }
        return parts.string ?? address
    }

    // MARK: refusals

    /// The server's answer when it last refused this song (403, 404...), else 0.
    func refusal(of address: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return refusals[StreamLoader.plain(address)] ?? 0
    }

    private func setRefusal(_ address: String, _ status: Int) {
        lock.lock()
        refusals[StreamLoader.plain(address)] = status == 0 ? nil : status
        lock.unlock()
    }

    /// An address without its query (the token): the song's.
    private static func plain(_ address: String) -> String {
        String(address.split(separator: "?", maxSplits: 1).first ?? "")
    }

    /// No network or no server for a moment, not the server saying no: a server
    /// busy or away behind its proxy (502-504), or one that asked to wait.
    private static func passing(_ status: Int) -> Bool {
        status >= 500 || status == 408 || status == 429
    }

    // MARK: what the song is

    /// AVFoundation's type for what the server says a song is ("audio/ogg": its Ogg).
    static func type(of mime: String) -> String {
        let m = mime.lowercased()
        if let t = UTType(mimeType: m), !t.isDynamic, playable.contains(t.identifier) { return t.identifier }
        return byMime[m] ?? UTType.audio.identifier
    }

    private static let playable = Set(AVURLAsset.audiovisualTypes().map { $0.rawValue })

    private static let byMime: [String: String] = {
        var map: [String: String] = [:]
        for t in AVURLAsset.audiovisualTypes() {
            guard let type = UTType(t.rawValue) else { continue }
            for m in type.tags[.mimeType] ?? [] where map[m.lowercased()] == nil {
                map[m.lowercased()] = type.identifier
            }
        }
        return map
    }()

    private func describe(_ info: AVAssetResourceLoadingContentInformationRequest, _ http: HTTPURLResponse) {
        info.contentType = StreamLoader.type(of: http.mimeType ?? "")
        var length: Int64 = -1
        if let range = http.value(forHTTPHeaderField: "Content-Range"), let slash = range.lastIndex(of: "/") {
            length = Int64(range[range.index(after: slash)...].trimmingCharacters(in: .whitespaces)) ?? -1
        } else if http.statusCode == 200 {
            length = http.expectedContentLength
        }
        if length > 0 { info.contentLength = length }
        info.isByteRangeAccessSupported = http.statusCode == 206
            || (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "").lowercased().contains("bytes")
    }

    // MARK: fetching (on `queue`)

    private func fetch(_ load: Load) {
        guard !load.done else { return }
        if let end = load.end, load.offset >= end {
            finish(load)
            return
        }
        let t = tokenNow()
        guard let url = URL(string: StreamLoader.withToken(load.address, t)) else {
            fail(load, FlowError(message: "Not an address."))
            return
        }
        var request = URLRequest(url: url)
        request.setValue("bytes=\(load.offset)-" + (load.end.map { String($0 - 1) } ?? ""), forHTTPHeaderField: "Range")
        load.tokenUsed = t
        load.status = 0
        let task = session.dataTask(with: request)
        load.task = task
        byTask[task.taskIdentifier] = load
        task.resume()
    }

    /// A stream that broke off, tried again where it stopped.
    private func again(_ load: Load, _ error: Error?, passing: Bool) {
        load.tries += 1
        let why = error.map { FlowError.from($0).message } ?? "the server answered \(load.status)"
        if !passing {
            if load.tries > 3 {
                fail(load, error ?? FlowError(message: why))
                return
            }
        } else if let since = load.brokeSince {
            if Date().timeIntervalSince(since) > StreamLoader.retryFor {
                FlowLog.i("stream given up after \(load.tries) tries: \(why)")
                fail(load, error ?? FlowError(message: why, offline: true))
                return
            }
        } else {
            load.brokeSince = Date()
            FlowLog.i("stream broke off (\(why)), trying again")
        }
        // Waits of 1, 2, 4, 8 s, then RETRY_MAX each.
        let wait = load.tries <= 4 ? pow(2, Double(load.tries - 1)) : StreamLoader.retryMax
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.fetch(load) }
    }

    /// Signed out by the server: signed in again (once for all requests waiting), then asked again.
    private func signIn(_ load: Load) {
        // Signed in since this one was asked: asked again with that token.
        if tokenNow() != load.tokenUsed {
            fetch(load)
            return
        }
        waiting.append(load)
        guard !signingIn else { return }
        signingIn = true
        let base = FlowPlayer.baseOf(load.address)
        FlowLog.i("signed out by the server: signing in again")
        DispatchQueue.main.async {
            ServerSignIn.start(base: base) { r in
                self.queue.async { self.signedIn(r) }
                FlowPlayer.shared.streamsSignedIn(r)
            }
        }
    }

    private func signedIn(_ r: ServerSignIn.Result) {
        signingIn = false
        if let t = r.token { use(t) }
        let list = waiting
        waiting = []
        for load in list where !load.done {
            load.signedIn = true
            if r.token != nil {
                fetch(load)
            } else {
                refuse(load, 401)
            }
        }
    }

    private func refuse(_ load: Load, _ status: Int) {
        FlowLog.i("the server refused a song (\(status))")
        setRefusal(load.address, status)
        fail(load, NSError(domain: "Flow", code: status, userInfo: [NSLocalizedDescriptionKey: "The server answered \(status)."]))
    }

    private func fail(_ load: Load, _ error: Error) {
        guard !load.done else { return }
        load.done = true
        byRequest[ObjectIdentifier(load.request)] = nil
        load.request.finishLoading(with: error)
    }

    private func finish(_ load: Load) {
        guard !load.done else { return }
        load.done = true
        byRequest[ObjectIdentifier(load.request)] = nil
        load.request.finishLoading()
    }
}

extension StreamLoader: AVAssetResourceLoaderDelegate {
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard let own = loadingRequest.request.url?.absoluteString, own.hasPrefix(StreamLoader.prefix) else { return false }
        var offset: Int64 = 0
        var end: Int64?
        if let wanted = loadingRequest.dataRequest {
            offset = wanted.requestedOffset
            if !wanted.requestsAllDataToEndOfResource { end = wanted.requestedOffset + Int64(wanted.requestedLength) }
        } else {
            // Only what the song is: its first bytes tell.
            end = 2
        }
        let load = Load(request: loadingRequest, address: String(own.dropFirst(StreamLoader.prefix.count)), offset: offset, end: end)
        byRequest[ObjectIdentifier(loadingRequest)] = load
        fetch(load)
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        guard let load = byRequest.removeValue(forKey: ObjectIdentifier(loadingRequest)) else { return }
        load.done = true
        load.task?.cancel()
        waiting.removeAll { $0 === load }
    }
}

extension StreamLoader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let load = byTask[dataTask.taskIdentifier], !load.done, let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        load.status = http.statusCode
        // Anything but the song: decided when the request ends.
        guard http.statusCode == 200 || http.statusCode == 206 else {
            completionHandler(.cancel)
            return
        }
        load.skip = http.statusCode == 200 ? load.offset : 0
        if let info = load.request.contentInformationRequest { describe(info, http) }
        setRefusal(load.address, 0)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let load = byTask[dataTask.taskIdentifier], !load.done, let wanted = load.request.dataRequest else { return }
        var chunk = data
        if load.skip > 0 {
            let drop = Int(min(Int64(chunk.count), load.skip))
            load.skip -= Int64(drop)
            chunk = Data(chunk.dropFirst(drop))
        }
        if let end = load.end, Int64(chunk.count) > end - load.offset {
            chunk = Data(chunk.prefix(Int(max(0, end - load.offset))))
        }
        guard !chunk.isEmpty else { return }
        wanted.respond(with: chunk)
        load.offset += Int64(chunk.count)
        if load.brokeSince != nil {
            FlowLog.i("stream back after \(load.tries) tries")
            load.brokeSince = nil
        }
        load.tries = 0
        if let end = load.end, load.offset >= end {
            finish(load)
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let load = byTask.removeValue(forKey: task.taskIdentifier) else { return }
        load.task = nil
        guard !load.done else { return }
        let status = load.status
        if status == 401 && !load.signedIn {
            signIn(load)
        } else if status != 0 && status != 200 && status != 206 && !StreamLoader.passing(status) {
            refuse(load, status)
        } else if error == nil && (status == 200 || status == 206) {
            // All that was asked for, or all there was.
            finish(load)
        } else {
            again(load, error, passing: status != 0 || (error.map { FlowError.from($0).offline } ?? false))
        }
    }
}
