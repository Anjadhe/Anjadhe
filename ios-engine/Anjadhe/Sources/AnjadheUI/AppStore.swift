import Foundation
import Combine
import AnjadheCore

/// SwiftUI-observable wrapper around the native `KVStore`. Screens read the
/// synced app blobs through it and re-render when `revision` bumps after any
/// write (local or remote).
public final class AppStore: ObservableObject {
    public let kv: KVStore
    @Published public private(set) var revision: Int = 0
    /// False until the on-disk store has finished loading. Launch does not
    /// wait for it (see `persistent`), so anything that would act on the
    /// ABSENCE of data — rather than merely render it — must ask first, or
    /// go through `whenHydrated`.
    @Published public private(set) var hydrated = false
    @Published public private(set) var loadError: String?
    @Published public var saveError: String?
    private var disk: TransactionalStore?
    private var directory: URL?
    private var loading = false
    private var hydrationWaiters: [() -> Void] = []

    public init(kv: KVStore = KVStore()) {
        self.kv = kv
        hydrated = true // explicit in-memory stores, previews and tests
        kv.onWriteFailure = { [weak self] error in self?.saveError = error.localizedDescription }
    }

    /// Open/import off the main thread. No writes or sync hydration are
    /// allowed until the complete store has loaded successfully.
    public static func persistent(directory: URL? = nil) -> AppStore {
        let store = AppStore()
        store.directory = directory
        store.hydrated = false
        store.kv.commit = { _, _, _, _ in throw TransactionalStore.Failure.notReady }
        store.loadPersistentStore()
        return store
    }

    public func retryLoading() { if !hydrated { loadPersistentStore() } }

    private func loadPersistentStore() {
        guard !loading else { return }
        loading = true
        loadError = nil
        let destination = directory
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { () -> (TransactionalStore, [String: RemoteEntry]) in
                let disk = try TransactionalStore(directory: destination)
                return (disk, try disk.snapshot())
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading = false
                switch result {
                case .success(let (disk, rows)):
                    self.disk = disk
                    disk.attach(to: self.kv, rows: rows)
                    self.hydrated = true
                    self.saveError = nil
                    self.bump()
                    LaunchTrace.mark("transactional store hydrated")
                    let waiters = self.hydrationWaiters
                    self.hydrationWaiters = []
                    for waiter in waiters { waiter() }
                case .failure(let error):
                    self.loadError = error.localizedDescription
                }
            }
        }
    }

    /// Run `block` once the store holds the real data — immediately if it
    /// already does. Main thread, in registration order.
    public func whenHydrated(_ block: @escaping () -> Void) {
        if hydrated { block(); return }
        hydrationWaiters.append(block)
    }

    /// Compatibility hook: successful writes are already committed.
    public func flush() {}

    public func bump() { revision += 1 }

    public static func newId() -> String {
        "m\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))\(String(Int.random(in: 0..<1_000_000), radix: 36))"
    }

    // MARK: App blobs — generic list helpers
    // Built-in apps store one blob per key (e.g. "schedule") holding an array
    // under a sub-key (e.g. "scheduleItems"). These mirror the old mobile
    // app's load/save/patch helpers so each screen stays small. All writes
    // bump the local-write hook → sync upload.

    /// The desktop StorageManager namespaces every app blob as `app_<name>`
    /// (storage-manager.js), and those are the keys that sync. Screens pass
    /// the bare name ("schedule", "notes", …), so map it here.
    public static func appKey(_ blobKey: String) -> String {
        blobKey.hasPrefix("app_") ? blobKey : "app_\(blobKey)"
    }

    /// The whole blob for an app key (an empty object when absent).
    public func blob(_ blobKey: String) -> [String: JSONValue] {
        kv.get(Self.appKey(blobKey))?.objectValue ?? [:]
    }

    private func canWrite() -> Bool {
        guard hydrated else {
            saveError = TransactionalStore.Failure.notReady.localizedDescription
            return false
        }
        return true
    }

    @discardableResult
    public func saveBlob(_ blobKey: String, _ blob: [String: JSONValue]) -> Bool {
        guard canWrite(), kv.set(Self.appKey(blobKey), .object(blob), now: KVStore.nowISO()) else { return false }
        bump()
        return true
    }

    public func items(_ blobKey: String, _ arrayKey: String) -> [JSONValue] {
        kv.get(Self.appKey(blobKey))?[arrayKey]?.arrayValue ?? []
    }

    @discardableResult
    public func saveItems(_ blobKey: String, _ arrayKey: String, _ list: [JSONValue]) -> Bool {
        guard canWrite() else { return false }
        var b = blob(blobKey)
        b[arrayKey] = .array(list)
        return saveBlob(blobKey, b)
    }

    /// Insert a new record at the front (createdAt/modifiedAt stamped). Returns its id.
    @discardableResult
    public func addItem(_ blobKey: String, _ arrayKey: String, _ fields: [String: JSONValue], append: Bool = false) -> String {
        guard canWrite() else { return "" }
        let id = Self.newId()
        let now = KVStore.nowISO()
        var rec = fields
        rec["id"] = .string(id)
        if rec["createdAt"] == nil { rec["createdAt"] = .string(now) }
        if rec["modifiedAt"] == nil { rec["modifiedAt"] = .string(now) }
        var arr = items(blobKey, arrayKey)
        if append { arr.append(.object(rec)) } else { arr.insert(.object(rec), at: 0) }
        return saveItems(blobKey, arrayKey, arr) ? id : ""
    }

    @discardableResult
    public func patchItem(_ blobKey: String, _ arrayKey: String, id: String, _ fields: [String: JSONValue]) -> Bool {
        guard canWrite() else { return false }
        var arr = items(blobKey, arrayKey)
        guard let i = arr.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var rec) = arr[i] else {
            saveError = "This record is no longer available. Your edit has not been saved."
            return false
        }
        if fields.allSatisfy({ rec[$0.key] == $0.value }) { return true }
        for (k, v) in fields { rec[k] = v }
        rec["modifiedAt"] = .string(KVStore.nowISO())
        arr[i] = .object(rec)
        return saveItems(blobKey, arrayKey, arr)
    }

    @discardableResult
    public func deleteItem(_ blobKey: String, _ arrayKey: String, id: String) -> Bool {
        guard canWrite() else { return false }
        return saveItems(blobKey, arrayKey, items(blobKey, arrayKey).filter { $0["id"]?.stringValue != id })
    }

    public func findItem(_ blobKey: String, _ arrayKey: String, id: String) -> JSONValue? {
        items(blobKey, arrayKey).first { $0["id"]?.stringValue == id }
    }

    // MARK: Cross-app links (port of the Mac's LinkManager read side)

    /// IDs of items in `targetApp` linked to (app, id) — checks both link
    /// directions, mirroring the Mac's LinkManager.getLinksFor. App names match
    /// the desktop: "goals", "schedule" (tasks), "notes".
    public func linkedIds(_ app: String, _ id: String, to targetApp: String) -> [String] {
        var out: [String] = []
        for l in items("links", "links") {
            guard let o = l.objectValue else { continue }
            if o["sourceApp"]?.stringValue == app, o["sourceId"]?.stringValue == id,
               o["targetApp"]?.stringValue == targetApp, let t = o["targetId"]?.stringValue {
                out.append(t)
            } else if o["targetApp"]?.stringValue == app, o["targetId"]?.stringValue == id,
                      o["sourceApp"]?.stringValue == targetApp, let s = o["sourceId"]?.stringValue {
                out.append(s)
            }
        }
        return out
    }

    /// Resolve linked items to their records (blobKey/arrayKey), dropping any
    /// dangling links whose target no longer exists.
    public func linkedItems(_ app: String, _ id: String, targetApp: String, blobKey: String, arrayKey: String) -> [JSONValue] {
        let ids = Set(linkedIds(app, id, to: targetApp))
        guard !ids.isEmpty else { return [] }
        return items(blobKey, arrayKey).filter { ids.contains($0["id"]?.stringValue ?? "") }
    }
}
