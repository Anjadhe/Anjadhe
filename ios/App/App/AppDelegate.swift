import UIKit
import SwiftUI
import AnjadheUI

// Native standalone app; shared rules execute in JavaScriptCore.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        // White window + white hosting view so there's no black flash between the
        // launch screen (white + logo) and SwiftUI's first painted frame.
        window.backgroundColor = .white
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        let root: AnyView
        if arguments.contains("--preview-mobile-setup") {
            root = AnyView(MobileSetupPreview(registered: arguments.contains("--preview-mobile-setup-model")))
        } else { root = AnyView(AppRoot()) }
        #else
        let root = AnyView(AppRoot())
        #endif
        let host = UIHostingController(rootView: root)
        host.view.backgroundColor = .white
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
