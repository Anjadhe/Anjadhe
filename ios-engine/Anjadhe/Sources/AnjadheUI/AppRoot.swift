import SwiftUI
import AnjadheCore

/// Standalone native lifecycle. No hidden sync host or Mac credential path.
public struct AppRoot: View {
    @StateObject private var store: AppStore
    @StateObject private var access = DeviceAccessModel()
    @StateObject private var router = Router()
    @ObservedObject private var lock = AppLock.shared
    @Environment(\.scenePhase) private var scenePhase
    public init() {
        #if canImport(UIKit)
        Theme.applyNavBarAppearance()
        #endif
        _store = StateObject(wrappedValue: AppStore.persistent())
    }
    public var body: some View {
        ZStack {
            Shell().environmentObject(store).environmentObject(access).environmentObject(router).tint(Theme.text)
            if !store.hydrated {
                ScreenColumn {
                    ScreenHead(store.loadError == nil ? "Opening your data" : "Couldn’t open your data")
                    if let error = store.loadError {
                        Text(error).font(Theme.bodyFont)
                        Text("Your existing files have been kept. Nothing has been reset.")
                        PrimaryButton(label: "Try again") { store.retryLoading() }
                    } else { ProgressView() }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
            } else if !access.loaded || !access.configured {
                DeviceSetupView(onboarding: true).environmentObject(access)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
            }
            if lock.locked || lock.covered { LockCover(lock: lock) }
        }
        .task { await access.open(); lock.storeChanged(store) }
        .onChange(of: store.hydrated) { _ in lock.storeChanged(store) }
        .onChange(of: store.revision) { _ in lock.storeChanged(store) }
        .onChange(of: scenePhase) { phase in
            lock.scene(phase, store: store)
            if phase != .active { PendingWrites.shared.flushAll() }
        }
        .alert("Couldn’t save", isPresented: Binding(get: { store.saveError != nil }, set: { if !$0 { store.saveError = nil } })) {
            Button("OK") { store.saveError = nil }
        } message: { Text((store.saveError ?? "") + " Your last saved data is unchanged. Keep the editor open and retry.") }
    }
}
