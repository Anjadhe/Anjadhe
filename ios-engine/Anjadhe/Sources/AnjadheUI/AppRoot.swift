import SwiftUI
import AnjadheCore

/// The native app root. Builds a disk-backed store that hydrates persisted data
/// + pairing at launch and persists every write (so nothing is lost on relaunch
/// or redeploy), starts the hidden JS sync host, and shows the shell.
/// AppDelegate installs this as the window's root view.
public struct AppRoot: View {
    @StateObject private var store: AppStore
    @StateObject private var sync: SyncCoordinator
    @StateObject private var views: MacViews
    @StateObject private var chat: ChatState
    @StateObject private var router = Router()

    public init() {
        // Register the bundled Nunito display font + apply it to nav-bar titles
        // before the first render so titles match the Mac immediately.
        #if canImport(UIKit)
        Theme.applyNavBarAppearance()
        #endif
        let appStore = AppStore.persistent()
        let coordinator = SyncCoordinator(store: appStore)
        _store = StateObject(wrappedValue: appStore)
        _sync = StateObject(wrappedValue: coordinator)
        _views = StateObject(wrappedValue: MacViews(sync: coordinator))
        _chat = StateObject(wrappedValue: ChatState(store: appStore, sync: coordinator))
    }

    @Environment(\.scenePhase) private var scenePhase
    @State private var showSplash = true
    @State private var started = false

    public var body: some View {
        ZStack {
            // The shell mounts immediately and loads (sync host, disk hydrate)
            // underneath the splash, so when the splash fades the app is ready.
            Shell()
                .environmentObject(store)
                .environmentObject(sync)
                .environmentObject(views)
                .environmentObject(chat)
                .environmentObject(router)
                .tint(Theme.text)
                .onChange(of: scenePhase) { phase in
                    if phase == .active { if started { sync.onForeground() } }
                    else { store.flush() }
                }
                .onAppear {
                    guard !started else { return }
                    started = true
                    // Start the hidden JS sync host against the bundled web assets.
                    if let www = Bundle.main.url(forResource: "public", withExtension: nil) { sync.start(baseURL: www) }
                }
            if showSplash {
                SplashView { withAnimation(.easeOut(duration: 0.4)) { showSplash = false } }
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
    }
}
