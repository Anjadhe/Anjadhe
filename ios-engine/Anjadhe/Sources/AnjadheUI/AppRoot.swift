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
    @ObservedObject private var lock = AppLock.shared

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
        let macViews = MacViews(sync: coordinator)
        let chatState = ChatState(store: appStore, sync: coordinator)
        // When the Mac cannot answer, the phone builds what it can itself
        // (MOBILE_NATIVE.md M5 phase 2).
        macViews.localBuilder = { view, params, done in
            PhoneViews(store: appStore).build(view, params, done)
        }
        _views = StateObject(wrappedValue: macViews)
        _chat = StateObject(wrappedValue: chatState)
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

    // Never replace phone data automatically on connection. The legacy
    // one-time re-download could discard unpublished phone edits. A future
    // standalone migration must preserve and merge both stores (S7).

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
                .onChange(of: store.revision) { _ in lock.storeChanged(store) }
                .onChange(of: store.hydrated) { _ in lock.storeChanged(store) }
                .onChange(of: scenePhase) { phase in
                    lock.scene(phase, store: store)
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
                    store.whenHydrated {
                        if let www = Bundle.main.url(forResource: "public", withExtension: nil) { sync.start(baseURL: www) }
                        LaunchTrace.mark("sync host started")
                    }
                }
                .alert("Couldn’t save", isPresented: Binding(
                    get: { store.saveError != nil },
                    set: { if !$0 { store.saveError = nil } }
                )) {
                    Button("OK") { store.saveError = nil }
                } message: {
                    Text((store.saveError ?? "") + " Your last saved data is unchanged. Keep this editor open and retry the edit.")
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
            // A loading failure must never expose an empty, writable app.
            // Keep the shell mounted so drafts are not recreated on redraw.
            if !store.hydrated && splashDone {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(store.loadError == nil ? "Opening your data" : "Couldn’t open your data")
                            .displayStyle(30)
                        if let error = store.loadError {
                            Text(error).font(Theme.bodyFont)
                            Text("Your existing files have been kept. Nothing has been reset.").font(Theme.detailFont)
                            PrimaryButton(label: "Try again") { store.retryLoading() }
                        } else { ProgressView() }
                    }
                    .frame(maxWidth: Theme.readingWidth, alignment: .leading).padding(24)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bg).zIndex(1)
            }
            // Lock nenva (AppLock.swift): over everything, splash included.
            if lock.locked || lock.covered {
                LockCover(lock: lock).zIndex(2)
            }
        }
        .animation(.easeOut(duration: 0.4), value: splashDone)
        .onAppear {
            // An approval the Mac is waiting on, raised wherever the user is.
            let r = router
            if lock.locked { lock.unlock() }
            lock.storeChanged(store)
            chat.onNewAsk = { msg in r.showToast(msg) }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.splashMinimum) { splashMinimumShown = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.splashDeadline) { splashDeadlinePassed = true }
        }
    }
}
