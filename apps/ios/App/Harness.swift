#if DEBUG
import AVFoundation
import Foundation
import WebKit

/// The test runs' hand on Flow in the Simulator (apps/ios/testing/harness.js),
/// as the Android harness drives the WebView over DevTools. Started with
/// `-FlowHarness http://127.0.0.1:<port>`, the app asks there for the page's
/// next script (GET /next, held open until there is one), runs it as the body
/// of an async function and sends back what it returned as JSON (POST
/// /result). Only in Debug builds: a Release build has no such door.
enum Harness {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config)
    }()

    static func start(webView: WKWebView) {
        guard let base = UserDefaults.standard.string(forKey: "FlowHarness"), let url = URL(string: base) else { return }
        FlowLog.i("harness: \(base)")
        poll(url, webView)
    }

    private static func poll(_ base: URL, _ webView: WKWebView) {
        var request = URLRequest(url: base.appendingPathComponent("next"))
        request.timeoutInterval = 45
        session.dataTask(with: request) { data, response, error in
            guard let data = data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let job = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = job["id"] as? String else {
                // Nothing to do yet (204), or the harness not there (yet).
                DispatchQueue.main.asyncAfter(deadline: .now() + (error == nil ? 0.05 : 1)) { Harness.poll(base, webView) }
                return
            }
            if let native = job["native"] as? String {
                DispatchQueue.main.async { Harness.answerNative(id, native, base, webView) }
                return
            }
            let body = job["js"] as? String ?? "return null;"
            DispatchQueue.main.async { Harness.run(id, body, base, webView) }
        }.resume()
    }

    private static func run(_ id: String, _ body: String, _ base: URL, _ webView: WKWebView) {
        let wrapped = "const value = await (async () => {\n\(body)\n})();\nreturn JSON.stringify(value === undefined ? null : value);"
        webView.callAsyncJavaScript(wrapped, arguments: [:], in: nil, in: .page) { result in
            var out: [String: Any] = ["id": id]
            switch result {
            case .success(let value):
                out["ok"] = true
                out["value"] = value as? String ?? "null"
            case .failure(let error):
                let info = (error as NSError).userInfo
                out["ok"] = false
                out["error"] = (info["WKJavaScriptExceptionMessage"] as? String) ?? error.localizedDescription
            }
            Harness.send(base, out) { Harness.poll(base, webView) }
        }
    }

    /// What the app knows itself, answered while its page sleeps (out of sight).
    private static func answerNative(_ id: String, _ what: String, _ base: URL, _ webView: WKWebView) {
        var out: [String: Any] = ["id": id, "ok": true]
        let value: Any
        switch what {
        case "player": value = FlowPlayer.shared.state()
        case "source": value = FlowPlayer.shared.sourceNow()
        case "output": value = ["name": FlowNativePlugin.outputNow().name]
        // The kinds of sound this iOS's player takes (Ogg: iOS 18.4 and later).
        case "codecs": value = AVURLAsset.audiovisualMIMETypes().filter { $0.hasPrefix("audio/") }.sorted()
        // The type StreamLoader gives AVPlayer for each kind the Flow Server sends.
        case "types":
            value = Dictionary(uniqueKeysWithValues: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/flac", "audio/wav"]
                .map { ($0, StreamLoader.type(of: $0)) })
        default: value = NSNull()
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["v": value]) {
            out["value"] = String(decoding: data, as: UTF8.self)
        }
        Harness.send(base, out) { Harness.poll(base, webView) }
    }

    private static func send(_ base: URL, _ result: [String: Any], then: @escaping () -> Void) {
        var request = URLRequest(url: base.appendingPathComponent("result"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: result)
        session.dataTask(with: request) { _, _, _ in
            DispatchQueue.main.async { then() }
        }.resume()
    }
}
#endif
