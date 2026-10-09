import Capacitor
import Foundation

/// The page's way to FlowPlayer, for its audio engine
/// (apps/android/src/engine.js), as FlowAudio.java: run({ ops }) applies a list
/// of operations and answers the state after them, state() answers where it
/// is, attach() what the page starting finds (FlowPlayer.attach). Events:
/// "state", "ended" { id }, "error" { id, message, status, unsupported }, "advance" { from,
/// id, key, heard, reason }, "signedIn" { token } and "previous".
/// keepSession(state) hands SessionKeeper what the page last told the server,
/// for while Flow is out of sight.
@objc(FlowAudioPlugin)
public class FlowAudioPlugin: CAPPlugin, CAPBridgedPlugin, FlowPlayerEvents {
    public let identifier = "FlowAudioPlugin"
    public let jsName = "FlowAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepSession", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        let me = self
        DispatchQueue.main.async {
            FlowPlayer.shared.events = me
            // Watching for Flow going out of sight from the start.
            _ = SessionKeeper.shared
        }
    }

    @objc func run(_ call: CAPPluginCall) {
        let ops = FlowPlayer.dicts(call.options["ops"])
        DispatchQueue.main.async {
            let player = FlowPlayer.shared
            player.apply(ops)
            // The state after them: what the page goes by from now on.
            call.resolve(player.state())
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(FlowPlayer.shared.state()) }
    }

    @objc func attach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(FlowPlayer.shared.attach()) }
    }

    /// What this app last told the server, for SessionKeeper ({ off: true }: hosting nothing).
    @objc func keepSession(_ call: CAPPluginCall) {
        var o: [String: Any] = [:]
        for (k, v) in call.options ?? [:] {
            if let name = k as? String { o[name] = v }
        }
        DispatchQueue.main.async {
            SessionKeeper.shared.keep(o)
            call.resolve()
        }
    }

    // MARK: FlowPlayerEvents

    func onState(_ state: [String: Any]) {
        notifyListeners("state", data: state)
    }

    func onEnded(_ id: String) {
        notifyListeners("ended", data: ["id": id])
    }

    func onError(_ id: String, _ message: String, _ status: Int, _ unsupported: Bool) {
        notifyListeners("error", data: ["id": id, "message": message, "status": status, "unsupported": unsupported])
    }

    func onSignedIn(_ token: String) {
        notifyListeners("signedIn", data: ["token": token])
    }

    func onAdvance(_ from: String, _ id: String, _ key: String, _ heard: Double, _ reason: String) {
        notifyListeners("advance", data: ["from": from, "id": id, "key": key, "heard": heard, "reason": reason])
    }

    func onPrevious() {
        notifyListeners("previous", data: [:])
    }
}
