import Foundation

/// Signs in to the Flow Server again without the page, as ServerSignIn.java,
/// and as the page's client does at its start (packages/core/src/client/remote.js
/// login and restoreProfile): the server's password, then the profile this
/// phone was signed in to, with its PIN. For the player, when the server ended
/// its session (a song refused with 401) while the page slept.
///
/// What it needs the client keeps in Flow's files: settings.json (serverSecret,
/// clientId) and server-sync.json (profile, profilePin), the secrets encrypted
/// with the Keychain's key (FlowSync). It sends the same app id (clientId), so
/// the server replaces this app's old token.
enum ServerSignIn {
    /// What came of it: a token, and whether it is the profile's (or there is none).
    struct Result {
        let token: String?
        let profileOk: Bool
        let problem: String
    }

    static let timeout: TimeInterval = 20
    private static let queue = DispatchQueue(label: "io.github.ceeser1.flow.signin")

    /// Signs in to the server at `base` off the main thread; `done` is called on the main thread.
    static func start(base: String, done: @escaping (Result) -> Void) {
        let device = FlowSync.shared.deviceName()
        queue.async {
            let r = signIn(base, device)
            DispatchQueue.main.async { done(r) }
        }
    }

    private static func signIn(_ base: String, _ device: String) -> Result {
        let settings = readJson("settings.json")
        let sync = readJson("server-sync.json")
        let password = FlowSync.shared.reveal(settings["serverSecret"] as? String ?? "")
        if password.isEmpty { return Result(token: nil, profileOk: false, problem: "no password kept") }
        let client = settings["clientId"] as? String ?? ""

        let login = post(base + "/api/login", ["password": password, "device": device, "client": client], token: "")
        guard login.status == 200, let token = login.json["token"] as? String, !token.isEmpty else {
            return Result(token: nil, profileOk: false, problem: login.status == 401 ? "wrong password" : "login answered \(login.status)")
        }

        let profile = sync["profile"] as? [String: Any]
        let profileId = profile?["id"] as? String ?? ""
        if profileId.isEmpty { return Result(token: token, profileOk: true, problem: "") }
        let hasPin = profile?["pin"] as? Bool ?? false
        let pin = hasPin ? FlowSync.shared.reveal(sync["profilePin"] as? String ?? "") : ""
        if hasPin && pin.isEmpty { return Result(token: token, profileOk: false, problem: "the profile's PIN is not kept") }
        let which = post(base + "/api/profiles/login", ["profileId": profileId, "pin": pin, "device": device, "client": client], token: token)
        guard which.status == 200, let profileToken = which.json["token"] as? String, !profileToken.isEmpty else {
            return Result(token: token, profileOk: false, problem: "profile login answered \(which.status)")
        }
        return Result(token: profileToken, profileOk: true, problem: "")
    }

    private static func readJson(_ name: String) -> [String: Any] {
        let file = FlowPaths.files.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: file), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return [:]
        }
        return o
    }

    /// POSTs `body` as JSON (with the token, if any), waiting for the answer:
    /// its status (-1: none came) and JSON body (empty when it sent none). Not on the main thread.
    static func post(_ url: String, _ body: [String: Any], token: String,
                     timeout: TimeInterval = ServerSignIn.timeout) -> (status: Int, json: [String: Any]) {
        guard let u = URL(string: url), let data = try? JSONSerialization.data(withJSONObject: body) else { return (-1, [:]) }
        var request = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let answer = Answer()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            answer.status = (response as? HTTPURLResponse)?.statusCode ?? -1
            if let data = data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                answer.json = o
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + timeout + 5)
        return (answer.status, answer.json)
    }

    private final class Answer {
        var status = -1
        var json: [String: Any] = [:]
    }
}
