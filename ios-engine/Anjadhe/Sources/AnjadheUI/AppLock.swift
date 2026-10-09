import SwiftUI
import AnjadheCore
#if canImport(LocalAuthentication)
import LocalAuthentication
#endif

// Lock nenva on the phone (2026-10-08, by request: "the lock setting should
// be shared between desktop and mobile apps and flippable in both"). ONE
// switch: the synced `lock` blob `{enabled, after, updatedAt}` that the Mac's
// Settings › Privacy › Lock writes too (main.js readLockPref / writeLockPref).
//
// L1 With the switch on, nenva opens locked and locks again when it comes
//    back after `after` minutes away (the Mac's "Lock after"); Face ID, or
//    the phone's passcode, opens it.
// L2 With the switch on, the app switcher shows a cover, never the content.
// L3 Flipping the switch here asks for Face ID first, both ways: it changes
//    the Mac's lock too.
// L4 A flip from the Mac never unlocks a locked screen. Turned on there, it
//    takes effect the next time the phone leaves nenva.
// L5 The last known state is kept in UserDefaults so a cold launch is covered
//    before the store has loaded.

@MainActor
final class AppLock: ObservableObject {
    static let shared = AppLock()
    private static let cacheKey = "lock-enabled-cache"

    @Published private(set) var locked: Bool
    @Published private(set) var covered = false
    private var leftAt: Date?
    private var prompting = false
    private var launchChecked = false

    private init() { locked = UserDefaults.standard.bool(forKey: Self.cacheKey) }

    static func enabled(_ store: AppStore) -> Bool { store.blob("lock")["enabled"]?.boolValue ?? false }
    static func after(_ store: AppStore) -> Int {
        let n = Int(store.blob("lock")["after"]?.numberValue ?? 5)
        return n > 0 ? n : 5
    }

    /// The store loaded or changed: keep the cache in step (L5), and never
    /// unlock because of a remote flip (L4).
    func storeChanged(_ store: AppStore) {
        guard store.hydrated else { return }
        let on = Self.enabled(store)
        UserDefaults.standard.set(on, forKey: Self.cacheKey)
        // The first launch after the switch was turned on elsewhere (no cache
        // yet) still opens locked.
        if !launchChecked { launchChecked = true; if on && !locked { locked = true; unlock() } }
        if !on && !locked { covered = false }
    }

    func scene(_ phase: ScenePhase, store: AppStore) {
        let on = store.hydrated ? Self.enabled(store) : UserDefaults.standard.bool(forKey: Self.cacheKey)
        switch phase {
        case .active:
            covered = false
            if on, let t = leftAt, Date().timeIntervalSince(t) >= Double(Self.after(store) * 60) { locked = true }
            leftAt = nil
            if locked { unlock() }
        case .inactive:
            if on { covered = true }
        case .background:
            if on { covered = true; if leftAt == nil { leftAt = Date() } }
        @unknown default: break
        }
    }

    func unlock() {
        guard locked, !prompting else { return }
        prompting = true
        Self.authenticate(reason: "Unlock nenva") { [weak self] ok in
            guard let self else { return }
            self.prompting = false
            if ok { self.locked = false; self.covered = false }
        }
    }

    /// Flip the shared switch (L3). Calls back with what was saved.
    func set(_ on: Bool, store: AppStore, sync: SyncCoordinator, done: @escaping (Bool) -> Void) {
        Self.authenticate(reason: on ? "Turn on Lock nenva" : "Turn off Lock nenva") { ok in
            guard ok else { done(false); return }
            Self.save(store: store, sync: sync, enabled: on, after: Self.after(store))
            UserDefaults.standard.set(on, forKey: Self.cacheKey)
            done(true)
        }
    }

    func setAfter(_ minutes: Int, store: AppStore, sync: SyncCoordinator) {
        Self.save(store: store, sync: sync, enabled: Self.enabled(store), after: minutes)
    }

    private static func save(store: AppStore, sync: SyncCoordinator, enabled: Bool, after: Int) {
        store.saveBlob("lock", ["enabled": .bool(enabled), "after": .number(Double(after)), "updatedAt": .string(KVStore.nowISO())])
        sync.triggerSync()
    }

    static var canAuthenticate: Bool {
        #if canImport(LocalAuthentication)
        var err: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
        #else
        return false
        #endif
    }

    /// Face ID / Touch ID with the passcode as the fallback.
    static func authenticate(reason: String, _ done: @escaping @MainActor (Bool) -> Void) {
        #if canImport(LocalAuthentication)
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            Task { @MainActor in done(false) }
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            Task { @MainActor in done(ok) }
        }
        #else
        Task { @MainActor in done(false) }
        #endif
    }
}

/// What covers the app while it is locked (L1) or in the app switcher (L2).
struct LockCover: View {
    @ObservedObject var lock: AppLock
    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "lock").font(.system(size: 28, weight: .regular)).foregroundStyle(Theme.text)
                Text("nenva is locked").font(Theme.display(26)).foregroundStyle(Theme.text)
                if lock.locked {
                    Button { lock.unlock() } label: {
                        Text("Unlock").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 28).padding(.vertical, 11)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// Settings › Lock: the same switch as the Mac's Settings › Privacy › Lock.
struct LockSettingsCard: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @State private var busy = false

    private static let minutes = [1, 2, 5, 10, 15, 30]

    var body: some View {
        let _ = store.revision
        let on = AppLock.enabled(store)
        VStack(alignment: .leading, spacing: 10) {
            if !AppLock.canAuthenticate {
                Text("Set a passcode on this phone to lock nenva.")
                    .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
            }
            SettingsGroup {
                VStack(spacing: 0) {
                    Toggle(isOn: Binding(get: { on }, set: { flip($0) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Lock nenva").font(.system(size: 16)).foregroundStyle(Theme.text)
                            Text("On this phone and on your Mac").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                        }
                    }
                    .disabled(busy || !AppLock.canAuthenticate)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    if on {
                        Divider().padding(.leading, 12)
                        HStack {
                            Text("Lock after").font(.system(size: 16)).foregroundStyle(Theme.text)
                            Spacer()
                            Picker("Lock after", selection: Binding(get: { AppLock.after(store) }, set: { AppLock.shared.setAfter($0, store: store, sync: sync) })) {
                                ForEach(Self.minutes, id: \.self) { Text("\($0) min").tag($0) }
                            }
                            .labelsHidden()
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                    }
                }
            }
            Text("Face ID, or your passcode, before nenva opens and when you come back after the time above. Your Mac asks for Touch ID. Changing it here changes it there too.")
                .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func flip(_ on: Bool) {
        busy = true
        AppLock.shared.set(on, store: store, sync: sync) { ok in
            busy = false
            if ok { router.showToast(on ? "Lock nenva is on, here and on your Mac" : "Lock nenva is off, here and on your Mac") }
        }
    }
}
