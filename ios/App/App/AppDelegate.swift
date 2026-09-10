import UIKit
import SwiftUI
import AnjadheUI

// The iPhone app is native SwiftUI (AnjadheUI, ios-engine/Anjadhe). There is no
// WebView UI any more: the only web content in the process is the hidden sync
// host that AnjadheUI.SyncCoordinator runs (docs/MOBILE_NATIVE.md).
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        // White window + white hosting view so there's no black flash between the
        // launch screen (white + logo) and SwiftUI's first painted frame.
        window.backgroundColor = .white
        let host = UIHostingController(rootView: AppRoot())
        host.view.backgroundColor = .white
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
