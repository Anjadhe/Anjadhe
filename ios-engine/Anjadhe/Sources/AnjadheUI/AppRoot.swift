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
        // Put the serif on nav-bar large titles before the first render so
        // headings match the Mac immediately.
        #if canImport(UIKit)
        Theme.applyNavBarAppearance()
        #endif
        LaunchTrace.mark("AppRoot.init")
        let appStore = AppStore.persistent()
        let coordinator = SyncCoordinator(store: appStore)
        _store = StateObject(wrappedValue: appStore)
        _sync = StateObject(wrappedValue: coordinator)
        _views = StateObject(wrappedValue: MacViews(sync: coordinator))
        _chat = StateObject(wrappedValue: ChatState(store: appStore, sync: coordinator))
    }

    @Environment(\.scenePhase) private var scenePhase
    @State private var started = false
    /// The splash's two clocks, owned HERE.
    ///
    /// They used to live inside `SplashView`, which was a bug that made the
    /// app unusable: AppRoot's body re-evaluates constantly (the store bumps,
    /// the sync state changes — seventeen times in the first two seconds on
    /// a real phone), the splash's own `@State` churned with it, and the
    /// reveal condition was never satisfied twice in the same instant. The
    /// splash simply never left. State that decides whether the app is
    /// VISIBLE belongs in the stable view, not the one being rebuilt.
    @State private var splashMinimumShown = false
    @State private var splashDeadlinePassed = false

    /// Long enough that the hand-off from the static launch screen does not
    /// read as a flicker.
    private static let splashMinimum: TimeInterval = 0.35
    /// And the safety net. A splash that waits on a condition must have a
    /// deadline, or one wrong condition is a bricked app rather than a slow
    /// one — which is exactly what happened. After this, it goes regardless:
    /// the shell underneath is already mounted and renders fine with an
    /// empty store, so the worst case is a moment of empty sections.
    private static let splashDeadline: TimeInterval = 4.0

    /// Gone once the app is genuinely ready — or once we have waited long
    /// enough to stop pretending.
    private var splashDone: Bool {
        splashDeadlinePassed || (splashMinimumShown && started && store.hydrated)
    }

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
                    else {
                        // Order matters: land any debounced edit FIRST, then
                        // persist. Flushing the disk before the edit exists
                        // would write the state just before it.
                        PendingWrites.shared.flushAll()
                        store.flush()
                    }
                }
                .onAppear {
                    guard !started else { return }
                    LaunchTrace.mark("shell on screen")
                    started = true
                    // Start the hidden JS sync host against the bundled web assets.
                    if let www = Bundle.main.url(forResource: "public", withExtension: nil) { sync.start(baseURL: www) }
                    LaunchTrace.mark("sync host started")
                }
            let _ = splashDone ? LaunchTrace.mark("splash gone") : ()
            if !splashDone {
                // `started` flips in the Shell's own onAppear — once the app
                // underneath has mounted — and `hydrated` when the on-disk
                // store has finished loading, which happens OFF the main
                // thread. So the splash covers real work and animates while
                // it happens, instead of freezing through a synchronous
                // decode and then waiting out a flat 1.25s regardless.
                SplashView()
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(.easeOut(duration: 0.4), value: splashDone)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.splashMinimum) { splashMinimumShown = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.splashDeadline) { splashDeadlinePassed = true }
        }
    }
}
