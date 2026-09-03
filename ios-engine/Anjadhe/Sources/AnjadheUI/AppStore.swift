import Foundation
import Combine
import AnjadheCore

/// SwiftUI-observable wrapper around the native `KVStore`. Screens read the
/// synced app blobs through it and re-render when `revision` bumps after any
/// write (local or remote).
public final class AppStore: ObservableObject {
    public let kv: KVStore
    @Published public private(set) var revision: Int = 0
    /// Retains the disk backer (its persist closure holds it weakly).
    private var disk: DiskStore?

    public init(kv: KVStore = KVStore()) { self.kv = kv }

    /// Build a disk-backed store: hydrate from the on-device file at launch and
    /// persist every write, so synced data AND channel pairing survive relaunch
    /// and redeploys. Use this for the real app; the bare `init` stays in-memory
    /// for tests and seeded screenshots.
    public static func persistent(directory: URL? = nil) -> AppStore {
        let kv = KVStore()
        let store = AppStore(kv: kv)
        let disk = DiskStore(directory: directory)
        disk.attach(to: kv)
        store.disk = disk
        return store
    }

    /// Flush pending writes synchronously (call on background/terminate).
    public func flush() { disk?.flushNow() }

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

    public func saveBlob(_ blobKey: String, _ blob: [String: JSONValue]) {
        kv.set(Self.appKey(blobKey), .object(blob), now: KVStore.nowISO())
        bump()
    }

    public func items(_ blobKey: String, _ arrayKey: String) -> [JSONValue] {
        kv.get(Self.appKey(blobKey))?[arrayKey]?.arrayValue ?? []
    }

    public func saveItems(_ blobKey: String, _ arrayKey: String, _ list: [JSONValue]) {
        var b = blob(blobKey)
        b[arrayKey] = .array(list)
        saveBlob(blobKey, b)
    }

    /// Insert a new record at the front (createdAt/modifiedAt stamped). Returns its id.
    @discardableResult
    public func addItem(_ blobKey: String, _ arrayKey: String, _ fields: [String: JSONValue], append: Bool = false) -> String {
        let id = Self.newId()
        let now = KVStore.nowISO()
        var rec = fields
        rec["id"] = .string(id)
        if rec["createdAt"] == nil { rec["createdAt"] = .string(now) }
        if rec["modifiedAt"] == nil { rec["modifiedAt"] = .string(now) }
        var arr = items(blobKey, arrayKey)
        if append { arr.append(.object(rec)) } else { arr.insert(.object(rec), at: 0) }
        saveItems(blobKey, arrayKey, arr)
        return id
    }

    public func patchItem(_ blobKey: String, _ arrayKey: String, id: String, _ fields: [String: JSONValue]) {
        var arr = items(blobKey, arrayKey)
        guard let i = arr.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var rec) = arr[i] else { return }
        for (k, v) in fields { rec[k] = v }
        rec["modifiedAt"] = .string(KVStore.nowISO())
        arr[i] = .object(rec)
        saveItems(blobKey, arrayKey, arr)
    }

    public func deleteItem(_ blobKey: String, _ arrayKey: String, id: String) {
        saveItems(blobKey, arrayKey, items(blobKey, arrayKey).filter { $0["id"]?.stringValue != id })
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
