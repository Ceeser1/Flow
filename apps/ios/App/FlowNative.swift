import AVFoundation
import AVKit
import Capacitor
import MediaPlayer
import UIKit

/// What the page asks of the phone that takes a while, as window.flow's phone
/// shim (apps/android/src) calls it, with the methods and events of
/// FlowNative.java: a server's file saved straight to storage and a file sent
/// up (Transfers), Flow Servers looked for on the network (Discovery), a link
/// opened, songs of the phone's own picked and copied in (AudioFiles), the
/// window let turn (Add Songs), a waveform read, where the sound comes out
/// and the phone's volume. What Android has and the iPhone has no need for
/// (Back, the installer, battery settings) answers as harmlessly as it can;
/// the window hides those controls by its caps (@flow/core/client/caps IOS).
@objc(FlowNativePlugin)
public class FlowNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlowNativePlugin"
    public let jsName = "FlowNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leave", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "orientation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "peaks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "output", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chooseOutput", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mediaVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMediaVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "power", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allowBackground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appSettings", returnType: CAPPluginReturnPromise),
    ]

    /// The plugin of the page there now (a share arriving reaches it).
    static weak var current: FlowNativePlugin?

    private var observers: [NSObjectProtocol] = []
    private var volumeWatch: NSKeyValueObservation?
    /// A volume slider off screen: setting the phone's volume goes through it
    /// (iOS has no call for it), and with it there iOS shows no volume panel.
    private var volumeView: MPVolumeView?
    private var routePicker: AVRoutePickerView?

    override public func load() {
        FlowNativePlugin.current = self
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("outputChanged", data: [:])
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("resume", data: [:])
        })
        volumeWatch = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] session, _ in
            self?.notifyListeners("mediaVolume", data: ["value": Double(session.outputVolume)])
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        volumeWatch?.invalidate()
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let e = FlowError.from(error)
        call.reject(e.message, e.offline ? "OFFLINE" : nil)
    }

    private func headers(_ call: CAPPluginCall) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in call.getObject("headers") ?? [:] {
            if let s = v as? String { out[k] = s }
        }
        return out
    }

    // MARK: transfers

    /// GET `url` into the file `path` (in Flow's storage), with `headers`:
    /// { status, bytes } for 200, any other answer { status, text } and no file.
    /// Unreachable, timed out or cut off: rejected with code OFFLINE. Progress
    /// goes out as "downloadProgress" { id, frac } when `id` is given.
    @objc func download(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let id = call.getString("id") ?? ""
        guard let url = URL(string: call.getString("url") ?? ""), let dest = FlowPaths.resolve(path) else {
            call.reject("Not one of Flow's files: \(path)")
            return
        }
        let timeout = Double(call.getInt("timeout") ?? 30000) / 1000
        let progress: ((Double) -> Void)? = id.isEmpty ? nil : { [weak self] frac in
            self?.notifyListeners("downloadProgress", data: ["id": id, "frac": frac])
        }
        Transfers.shared.download(url, headers: headers(call), to: dest, timeout: timeout, progress: progress) { [weak self] result in
            switch result {
            case .success(let r): call.resolve(r)
            case .failure(let e): self?.reject(call, e)
            }
        }
    }

    /// Sends the file `path` (in Flow's storage) to `url` as the body (`method`,
    /// PUT by default), with `headers`: { status, text }. Unreachable, timed out
    /// or cut off: rejected with code OFFLINE. Progress goes out as
    /// "uploadProgress" { id, frac } when `id` is given.
    @objc func upload(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let id = call.getString("id") ?? ""
        guard let url = URL(string: call.getString("url") ?? ""), let file = FlowPaths.resolve(path),
              FileManager.default.fileExists(atPath: file.path) else {
            call.reject("Not one of Flow's files: \(path)")
            return
        }
        let timeout = Double(call.getInt("timeout") ?? 120000) / 1000
        let progress: ((Double) -> Void)? = id.isEmpty ? nil : { [weak self] frac in
            self?.notifyListeners("uploadProgress", data: ["id": id, "frac": frac])
        }
        Transfers.shared.upload(file, to: url, method: call.getString("method") ?? "PUT", headers: headers(call),
                                timeout: timeout, progress: progress) { [weak self] result in
            switch result {
            case .success(let r): call.resolve(r)
            case .failure(let e): self?.reject(call, e)
            }
        }
    }

    // MARK: the network

    /// Asks the home network who is a Flow Server (Discovery): { answers:
    /// [{ address, text }], own: [this phone's addresses] } after `timeout` ms.
    /// Never rejects.
    @objc func discover(_ call: CAPPluginCall) {
        let timeout = call.getInt("timeout") ?? 2500
        let sends = call.getInt("sends") ?? 3
        DispatchQueue.global(qos: .userInitiated).async {
            var r = Discovery.run(timeoutMs: timeout, sends: sends)
            // The first search makes iOS ask whether Flow may find devices on
            // the local network, and nothing goes out until that is answered:
            // once allowed, searched again, so the first start still finds the server.
            if r["refused"] as? Bool == true, Discovery.waitUntilAllowed(seconds: 120) {
                FlowLog.i("discovery: the local network allowed, asking again")
                r = Discovery.run(timeoutMs: timeout, sends: sends)
            }
            r["refused"] = nil
            call.resolve(r)
        }
    }

    /// A web link opened outside the app (Safari, YouTube).
    @objc func openUrl(_ call: CAPPluginCall) {
        let text = call.getString("url") ?? ""
        guard text.hasPrefix("https://") || text.hasPrefix("http://"), let url = URL(string: text) else {
            call.reject("Only web links open from Flow.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("No app opens that link.") }
            }
        }
    }

    /// Android's Back with nothing left to close; an iPhone has no Back to press.
    @objc func leave(_ call: CAPPluginCall) {
        call.resolve()
    }

    // MARK: songs of the phone's own

    @objc func pickAudio(_ call: CAPPluginCall) {
        let folder = call.getBool("folder") ?? false
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("Flow's window is not there.")
                return
            }
            AudioFiles.pick(folder: folder, from: vc) { result in call.resolve(result) }
        }
    }

    @objc func importAudio(_ call: CAPPluginCall) {
        let uri = call.getString("uri") ?? ""
        let stem = call.getString("stem") ?? ""
        let cover = call.getString("cover") ?? ""
        Task {
            do {
                let result = try await AudioFiles.importFile(uri: uri, stem: stem, cover: cover)
                call.resolve(result)
            } catch {
                call.reject(FlowError.from(error).message)
            }
        }
    }

    /// A file's waveform for the trim: { peaks: [min, max, ...] }.
    @objc func peaks(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let duration = call.getDouble("duration") ?? 0
        Task {
            do {
                let peaks = try await AudioFiles.peaks(path: path, duration: duration)
                call.resolve(["peaks": peaks])
            } catch {
                call.reject(FlowError.from(error).message)
            }
        }
    }

    // MARK: the window

    /// `free`: the window turns with the phone (as on Add Songs); otherwise it stays upright.
    @objc func orientation(_ call: CAPPluginCall) {
        let free = call.getBool("free") ?? false
        DispatchQueue.main.async {
            FlowViewController.current?.mayTurn = free
            call.resolve()
        }
    }

    // MARK: where the sound comes out

    /// Where music comes out now: { name, builtin } (this phone, headphones, a
    /// Bluetooth or AirPlay device's own name; builtin: the phone's own speaker).
    static func outputNow() -> (name: String, builtin: Bool) {
        guard let out = AVAudioSession.sharedInstance().currentRoute.outputs.first else { return ("This phone", true) }
        switch out.portType {
        case .builtInSpeaker, .builtInReceiver: return ("This phone", true)
        case .headphones: return ("Headphones", false)
        default: return (out.portName.isEmpty ? "Another device" : out.portName, false)
        }
    }

    @objc func output(_ call: CAPPluginCall) {
        let now = FlowNativePlugin.outputNow()
        call.resolve(["name": now.name, "builtin": now.builtin])
    }

    /// iOS's own chooser of where the sound comes out (this phone, Bluetooth,
    /// AirPlay): the one behind the AirPlay button. Resolves { shown }.
    @objc func chooseOutput(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                call.resolve(["shown": false])
                return
            }
            if self.routePicker == nil {
                let picker = AVRoutePickerView(frame: CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1))
                picker.alpha = 0.011
                picker.isUserInteractionEnabled = false
                view.addSubview(picker)
                self.routePicker = picker
            }
            let button = self.routePicker.flatMap { FlowNativePlugin.firstButton(in: $0) }
            button?.sendActions(for: .touchUpInside)
            FlowLog.i("output chooser " + (button == nil ? "not found" : "opened") + ", music to \(FlowNativePlugin.outputNow().name)")
            call.resolve(["shown": button != nil])
        }
    }

    private static func firstButton(in view: UIView) -> UIButton? {
        for sub in view.subviews {
            if let b = sub as? UIButton { return b }
            if let b = firstButton(in: sub) { return b }
        }
        return nil
    }

    /// The phone's volume, 0-1 (what its buttons set): { value }.
    @objc func mediaVolume(_ call: CAPPluginCall) {
        call.resolve(["value": Double(AVAudioSession.sharedInstance().outputVolume)])
    }

    /// Sets the phone's volume ({ value } 0-1), as its buttons would, without
    /// iOS's volume panel: a session's member changing the volume of the
    /// phone hosting it.
    @objc func setMediaVolume(_ call: CAPPluginCall) {
        let value = Float(max(0, min(1, call.getDouble("value") ?? 0)))
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                call.reject("Flow's window is not there.")
                return
            }
            if self.volumeView == nil {
                let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 10, height: 10))
                v.alpha = 0.011
                view.addSubview(v)
                self.volumeView = v
            }
            // The slider is ready a moment after the view is there.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                let slider = self.volumeView?.subviews.compactMap { $0 as? UISlider }.first
                slider?.setValue(value, animated: false)
                slider?.sendActions(for: .valueChanged)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    call.resolve(["value": Double(AVAudioSession.sharedInstance().outputVolume)])
                }
            }
        }
    }

    // MARK: Android's alone

    /// iOS lets an app that plays run in the background: nothing restricts Flow.
    @objc func power(_ call: CAPPluginCall) {
        call.resolve(["unrestricted": true, "restricted": false, "maker": "apple"])
    }

    @objc func allowBackground(_ call: CAPPluginCall) {
        call.resolve(["shown": false])
    }

    /// Flow's page in iOS's Settings.
    @objc func appSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.resolve(["shown": false])
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in call.resolve(["shown": opened]) }
        }
    }

    // MARK: a link shared to Flow

    /// Another app's Share > Flow (the share extension, through flow://share):
    /// what was shared goes to the page as "share" { text, subject }, kept until
    /// the page listens (a share may be what starts Flow).
    func shared(text: String, subject: String = "") {
        notifyListeners("share", data: ["text": text, "subject": subject], retainUntilConsumed: true)
    }
}
