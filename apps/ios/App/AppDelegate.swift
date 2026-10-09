import Capacitor
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        FlowLog.i("Flow \(info["CFBundleShortVersionString"] ?? "?") (\(info["CFBundleVersion"] ?? "?")) started on iOS "
            + UIDevice.current.systemVersion)
        WidgetFeed.start()
        #if DEBUG
        // The test runner: a widget's button with Flow not running (Flow started for it).
        if let action = UserDefaults.standard.string(forKey: "FlowTestWidget").flatMap(WidgetAction.init(rawValue:)) {
            FlowPlayer.shared.widget(action)
        }
        #endif
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    /// Flow swiped away while it played: the music stops, its place kept for the next start.
    func applicationWillTerminate(_ application: UIApplication) {
        FlowLog.i("closed")
        FlowPlayer.shared.letGo()
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = FlowViewController.background
        window.rootViewController = FlowViewController()
        window.makeKeyAndVisible()
        self.window = window
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
