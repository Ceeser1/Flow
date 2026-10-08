import Capacitor
import UIKit
import WebKit

/// Flow's window: Capacitor's page, with Flow's own plugins (FlowNative,
/// FlowAudio), window.FlowSync, and upright except where the page lets it
/// turn (Add Songs, FlowNative.orientation).
final class FlowViewController: CAPBridgeViewController {
    /// Flow's window, once there (the plugins reach it for pickers and turning).
    static weak var current: FlowViewController?

    private var flowUIDelegate: FlowUIDelegate?

    /// Whether the window may turn sideways with the phone.
    var mayTurn = false {
        didSet {
            guard mayTurn != oldValue else { return }
            setNeedsUpdateOfSupportedInterfaceOrientations()
            if !mayTurn, let scene = view.window?.windowScene, scene.interfaceOrientation != .portrait {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { error in
                    FlowLog.i("could not turn upright: \(error.localizedDescription)")
                }
            }
        }
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        FlowViewController.current = self
        guard let webView = webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = FlowViewController.background
        webView.scrollView.backgroundColor = FlowViewController.background
        // window.FlowSync, before any of the page's own scripts.
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: FlowSync.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let inner = webView.uiDelegate as? NSObject {
            let delegate = FlowUIDelegate(inner: inner)
            flowUIDelegate = delegate
            webView.uiDelegate = delegate
        }
        bridge?.registerPluginInstance(FlowNativePlugin())
        bridge?.registerPluginInstance(FlowAudioPlugin())
        #if DEBUG
        Harness.start(webView: webView)
        #endif
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        mayTurn ? .allButUpsideDown : .portrait
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .lightContent
    }

    /// Flow's background (--bg in the renderer's style.css).
    static let background = UIColor(red: 30 / 255, green: 30 / 255, blue: 34 / 255, alpha: 1)
}

/// The page's window.FlowSync calls come as prompt("flow-sync", ...): answered
/// here (FlowSync). Everything else goes on to Capacitor's own delegate, which
/// shows alerts and confirms and asks for cookies the same way.
final class FlowUIDelegate: NSObject, WKUIDelegate {
    private let inner: NSObject

    init(inner: NSObject) {
        self.inner = inner
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }

    @objc func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                       initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if prompt == FlowSync.marker {
            completionHandler(FlowSync.shared.answer(defaultText ?? ""))
            return
        }
        guard let ui = inner as? WKUIDelegate else {
            completionHandler(nil)
            return
        }
        ui.webView?(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText,
                    initiatedByFrame: frame, completionHandler: completionHandler)
    }
}
