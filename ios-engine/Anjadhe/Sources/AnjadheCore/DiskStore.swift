import Foundation

/// File-backed persistence for `KVStore`.
///
/// Without this the on-device store is purely in-memory: every relaunch — and
/// every redeploy from Xcode — starts with an empty cache, which silently
/// discards ALL synced data and the channel pairing keys. That is why sync
/// looked broken and pairing dropped on every deploy: nothing was ever written
/// to disk. This writes the whole store as one JSON file in Application Support
/// (debounced, off the main thread) and hydrates it back at launch.
///
/// Pairing identity/record reach the native store via the JS bridge's `persist`
/// messages, so persisting `KVStore` is what makes pairing survive too.
public final class DiskStore {
    private let url: URL
    private let io = DispatchQueue(label: "com.anjadhe.diskstore", qos: .utility)
    /// Where this store's own state is read and written. The app leaves it
    /// as `.main` — every caller (AppRoot, SyncCoordinator) is already there,
    /// and the flags below are deliberately unsynchronised because of it.
    /// Tests inject a serial queue instead: SwiftPM runs XCTest bodies off
    /// the main thread and does not service the main queue while they run,
    /// so a main-queue-only class is untestable rather than merely awkward.
    private let apply: DispatchQueue
    private weak var kv: KVStore?
    private var saveScheduled = false
    /// False between `attachAsync` and the file landing. NOTHING may be
    /// written to disk in that window: the store is only partly populated,
    /// and a save would replace the real file with a fraction of itself.
    /// A save asked for in the meantime is remembered and runs on arrival.
    private var hydrated = true
    private var savePending = false
    /// Held so `hydrateNowIfNeeded` can fire it, and so it fires exactly once
    /// whichever path gets there first.
    private var onHydratedOnce: (() -> Void)?

    public init(filename: String = "anjadhe-store.json", directory: URL? = nil,
                applyQueue: DispatchQueue = .main) {
        self.apply = applyQueue
        let base = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("Anjadhe", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent(filename)
    }

    /// Path of the backing file (useful for diagnostics / tests).
    public var fileURL: URL { url }

    private struct Row: Codable { let value: JSONValue?; let deleted: Bool; let modifiedAt: String }

    /// Read the persisted rows (empty if the file is missing or unreadable).
    public func load() -> [String: RemoteEntry] {
        guard let data = try? Data(contentsOf: url),
              let rows = try? JSONDecoder().decode([String: Row].self, from: data) else { return [:] }
        return rows.mapValues { RemoteEntry(value: $0.value, deleted: $0.deleted, modifiedAt: $0.modifiedAt) }
    }

    /// Hydrate `kv` from disk now, and persist every future write back to disk.
    /// Synchronous: the caller is blocked for as long as decoding takes.
    public func attach(to kv: KVStore) {
        self.kv = kv
        hydrated = true
        kv.hydrate(load())
        kv.persist = { [weak self] _, _ in self?.scheduleSave() }
        kv.onPurge = { [weak self] in self?.scheduleSave() }
    }

    /// The same, but the FILE READ happens off the main thread.
    ///
    /// WHY. Decoding the whole store into `JSONValue` trees measured 223 ms
    /// for 8.9 MB on a Mac (a real store is bigger, a phone slower), and it
    /// ran inside `AppRoot.init()` — before the first frame, with the main
    /// thread held the entire time. Off the main thread it overlaps the rest
    /// of launch instead of being added to it.
    ///
    /// Three things make that safe, and all three are load-bearing:
    ///   * the persist hooks are installed IMMEDIATELY, so a write made
    ///     during the load is not lost;
    ///   * `KVStore.hydrate` never overwrites a key already in the cache, so
    ///     such a write is not then undone by the file;
    ///   * nothing may be written to disk until the load lands (`hydrated`),
    ///     or a save would replace the file with the fraction of itself that
    ///     happens to be in memory.
    /// `onHydrated` runs on the main thread once the store is whole — the
    /// signal for anything that must see the real data before it acts.
    public func attachAsync(to kv: KVStore, onHydrated: @escaping () -> Void) {
        self.kv = kv
        hydrated = false
        savePending = false
        onHydratedOnce = onHydrated
        kv.persist = { [weak self] _, _ in self?.scheduleSave() }
        kv.onPurge = { [weak self] in self?.scheduleSave() }
        io.async { [weak self] in
            guard let self = self else { return }
            let rows = self.load()
            self.apply.async {
                guard !self.hydrated else { return } // a write beat us to it
                self.finishHydration(rows, into: kv)
            }
        }
    }

    /// Complete the load RIGHT NOW if it is still in flight.
    ///
    /// The one case that needs it is a WRITE arriving before the file has
    /// landed. `KVStore.hydrate` preserves what is already in the cache, so a
    /// blob written from an unhydrated (empty) read would win over the real
    /// one — and then be saved over it. Blocking here is the honest answer:
    /// it costs the read we were trying to overlap, once, instead of losing
    /// data. Reads do NOT go through this; they may return empty while
    /// loading, which is what the splash covers.
    public func hydrateNowIfNeeded() {
        guard !hydrated, let kv = kv else { return }
        finishHydration(load(), into: kv)
    }

    private func finishHydration(_ rows: [String: RemoteEntry], into kv: KVStore) {
        kv.hydrate(rows)
        hydrated = true
        if savePending { savePending = false; scheduleSave() }
        let done = onHydratedOnce
        onHydratedOnce = nil
        done?()
    }

    /// Coalesce a burst of writes (e.g. a full sync touching many keys) into a
    /// single file write. Flag + snapshot are read on the main thread so we
    /// don't race the KVStore cache regardless of which thread `persist` fired on.
    private func scheduleSave() {
        apply.async { [weak self] in
            guard let self = self else { return }
            // Still loading: remember that a save is owed and take it up
            // when the store is whole.
            guard self.hydrated else { self.savePending = true; return }
            guard !self.saveScheduled else { return }
            self.saveScheduled = true
            self.apply.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self else { return }
                self.saveScheduled = false
                guard let snap = self.kv?.snapshot() else { return }
                self.io.async { self.write(snap) }
            }
        }
    }

    private func write(_ snapshot: [String: RemoteEntry]) {
        let rows = snapshot.mapValues { Row(value: $0.value, deleted: $0.deleted, modifiedAt: $0.modifiedAt) }
        guard let data = try? JSONEncoder().encode(rows) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Synchronously flush the current state (call on app background/terminate
    /// so a write within the debounce window isn't lost). Must run on the
    /// apply queue — `.main` for the app.
    public func flushNow() {
        // Same rule as `scheduleSave`: a partial store must never reach the
        // file. The write is owed, and is taken up when the load lands.
        guard hydrated else { savePending = true; return }
        saveScheduled = false
        guard let snap = kv?.snapshot() else { return }
        io.sync { write(snap) }
    }
}
