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
        hideFormBar(webView)
        bridge?.registerPluginInstance(FlowNativePlugin())
        bridge?.registerPluginInstance(FlowAudioPlugin())
        #if DEBUG
        Harness.start(webView: webView)
        #endif
    }

    /// No bar of arrows and a tick over the keyboard (a web page's, which an
    /// app's text fields do not have, nor Android's): the page's content view
    /// becomes a kind of itself without one, as Capacitor's Keyboard plugin does it.
    private func hideFormBar(_ webView: WKWebView) {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let base: AnyClass = object_getClass(content) else { return }
        let name = "\(base)_FlowNoFormBar"
        var plain: AnyClass? = NSClassFromString(name)
        if plain == nil, let made = objc_allocateClassPair(base, name, 0) {
            let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), "@@:")
            objc_registerClassPair(made)
            plain = made
        }
        if let plain = plain { object_setClass(content, plain) }
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
