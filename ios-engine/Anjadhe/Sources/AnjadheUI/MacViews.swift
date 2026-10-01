import Foundation
import Combine
import AnjadheCore

/// Mac-served views (data lane 2 in docs/MOBILE_NATIVE.md): read-only digests
/// of data that deliberately does not sync as a blob — email insights, news,
/// portfolio numbers. A screen calls `view("insights", ttl:)` on every render:
/// it returns the cached digest immediately and, when the cache is past its
/// TTL, asks the Mac in the background and bumps `revision` on arrival.
/// Failures are remembered briefly (no hot retry loop) and surfaced as
/// `error` so screens can say honestly why the data is old.
public final class MacViews: ObservableObject {
    public struct Snapshot {
        public let data: JSONValue?
        public let at: Date?
        public let loading: Bool
        public let error: String?
        /// The Mac was away and this phone built the answer itself
        /// (MOBILE_NATIVE.md M5 phase 2) — the screen says so.
        public var builtOnPhone: Bool { data?["_builtOn"]?.stringValue == "phone" }
    }

    /// Builds a view ON THE PHONE when the Mac cannot answer (M5 phase 2):
    /// the same JSON shape the Mac's `js/agent/mobile-views.js` returns, from
    /// synced blobs and the web. Returns false for a view it cannot build
    /// (email insights — the mailbox is the Mac's), true once it has called
    /// back with an answer or an error. Set by AppRoot (`PhoneViews`).
    public var localBuilder: ((_ view: String, _ params: [String: JSONValue]?,
                               _ done: @escaping (Result<JSONValue, Error>) -> Void) -> Bool)?

    @Published public private(set) var revision = 0
    private let sync: SyncCoordinator
    private var inFlight: Set<String> = []
    private var errors: [String: String] = [:]
    private var triedAt: [String: Date] = [:]
    private var cache: [String: (at: Date, data: JSONValue)] = [:]
    public static let retryInterval: TimeInterval = 30
    public static let phoneBuiltTTL: TimeInterval = 10

    /// What each slot is BUILT FROM: the store keys whose change makes its
    /// cached answer wrong (see `dependsOn:`).
    private var dependsOn: [String: Set<String>] = [:]
    /// Slots whose data changed under them — stale whatever their TTL says.
    private var stale: Set<String> = []
    /// When each slot was last drawn, so a change refetches what is on screen
    /// now and merely marks the rest for their next appearance.
    private var drawnAt: [String: Date] = [:]
    /// A slot drawn this recently is treated as on screen.
    private static let liveWindow: TimeInterval = 120
    private var settledSub: AnyCancellable?

    public init(sync: SyncCoordinator) {
        self.sync = sync
        // A Mac-served view is a cached ANSWER, and nothing in it can tell
        // that the question changed: the TTL was the only thing that ever
        // expired it, so a task edited on the phone (or on the Mac, or on
        // another Mac) sat behind rows up to TTL seconds old until someone
        // tapped refresh. Now the data itself says when to ask again.
        settledSub = sync.dataSettled.sink { [weak self] keys in self?.dataChanged(keys) }
    }

    /// Store keys have settled on both sides — expire what was built from
    /// them, and re-ask at once for whatever is on screen.
    public func dataChanged(_ keys: Set<String>) {
        guard !keys.isEmpty else { return }
        var live: [String] = []
        for (name, deps) in dependsOn where !deps.isDisjoint(with: keys) {
            stale.insert(name)
            triedAt[name] = nil
            if let d = drawnAt[name], Date().timeIntervalSince(d) < Self.liveWindow { live.append(name) }
        }
        guard !live.isEmpty else { return }
        for name in live { fetch(name) }
    }

    private func key(_ name: String) -> String { "anjadhe:view:\(name)" }

    private func cached(_ name: String) -> (at: Date, data: JSONValue)? {
        // (also mutated by markInsightRead)
        if let c = cache[name] { return c }
        guard let data = UserDefaults.standard.data(forKey: key(name)),
              let row = try? JSONDecoder().decode(CacheRow.self, from: data) else { return nil }
        let c = (at: Date(timeIntervalSince1970: row.at), data: row.data)
        cache[name] = c
        return c
    }

    private struct CacheRow: Codable { let at: TimeInterval; let data: JSONValue }

    /// The last answer stored for a slot, whoever built it. PhoneNews reads
    /// the Mac's routing facts (`route`, `webOn`) and the Topics page's
    /// furniture from it, and carries them forward in what it builds.
    static func storedAnswer(_ name: String) -> JSONValue? {
        guard let data = UserDefaults.standard.data(forKey: "anjadhe:view:\(name)"),
              let row = try? JSONDecoder().decode(CacheRow.self, from: data) else { return nil }
        return row.data
    }

    private func storeCache(_ name: String, _ data: JSONValue) {
        let now = Date()
        cache[name] = (at: now, data: data)
        if let d = try? JSONEncoder().encode(CacheRow(at: now.timeIntervalSince1970, data: data)) {
            UserDefaults.standard.set(d, forKey: key(name))
        }
    }

    /// Read (and, if stale, refresh) a Mac-served view. Safe to call from a
    /// view body: state changes are deferred off the render pass.
    ///
    /// `request` and `params` (2026-09-21) split the CACHE SLOT from the ASK.
    /// Portfolio and News are families of parameterised views — one account's
    /// scope, one ticker, one plan — and they each want their own cached
    /// digest and their own "Updated … ago" stamp. So the slot is a name the
    /// caller composes (`"portfolio:<accountId>"`) while the Mac is asked the
    /// real view (`"portfolio"`) with its parameters. With neither given this
    /// behaves exactly as it always did.
    ///
    /// `dependsOn` (2026-09-22) is the slot's own answer to "when is this
    /// wrong?" — the store keys it is computed from. A TTL says how long an
    /// answer may be assumed still true; this says when it demonstrably is
    /// not. A view with no dependencies behaves exactly as it always did.
    public func view(_ name: String, ttl: TimeInterval,
                     request: String? = nil, params: [String: JSONValue]? = nil,
                     dependsOn: [String]? = nil) -> Snapshot {
        if request != nil || params != nil { asks[name] = (request ?? name, params) }
        if let deps = dependsOn { self.dependsOn[name] = Set(deps) }
        drawnAt[name] = Date()
        let c = cached(name)
        // A phone-built answer (the Mac was away) is cheap to rebuild and is
        // not expired by the Mac's settle signal, which cannot come while the
        // Mac is away — so it stays fresh for seconds, not for the TTL.
        let phoneBuilt = c?.data["_builtOn"]?.stringValue == "phone"
        let maxAge = phoneBuilt ? min(ttl, Self.phoneBuiltTTL) : ttl
        let fresh = !stale.contains(name) && (c.map { Date().timeIntervalSince($0.at) < maxAge } ?? false)
        let backoff = phoneBuilt ? Self.phoneBuiltTTL : Self.retryInterval
        let recentlyTried = triedAt[name].map { Date().timeIntervalSince($0) < backoff } ?? false
        if !fresh && !inFlight.contains(name) && !recentlyTried {
            DispatchQueue.main.async { self.fetch(name) }
        }
        return Snapshot(data: c?.data, at: c?.at, loading: inFlight.contains(name), error: errors[name])
    }

    /// User-initiated refresh: forget the backoff stamp and ask now.
    public func refresh(_ name: String) {
        triedAt[name] = nil
        stale.insert(name)
        fetch(name)
    }

    /// What a cache slot actually asks the Mac for, when it is not its name.
    private var asks: [String: (view: String, params: [String: JSONValue]?)] = [:]

    /// Is the Mac there to ask? A channel that is not live fails a view at
    /// once or after 35 s; the phone builds what it can instead (P1 — the
    /// Mac first, but not a Mac that is plainly away).
    private var macLive: Bool { sync.paired && (sync.state == "idle" || sync.state == "syncing") }

    /// Errors that mean "the Mac is away", as opposed to the Mac answering
    /// with a real refusal (which the screen must show as it is).
    static func meansAway(_ message: String) -> Bool {
        let m = message.lowercased()
        return m == "offline" || m.contains("timed out") || m.contains("not open on your mac")
            || m.contains("did not answer in time") || m.contains("view failed")
    }

    private func settle(_ name: String, _ result: Result<JSONValue, Error>, fromPhone: Bool) {
        inFlight.remove(name)
        switch result {
        case .success(var data):
            if fromPhone, case .object(var o) = data { o["_builtOn"] = .string("phone"); data = .object(o) }
            errors[name] = nil
            stale.remove(name)
            storeCache(name, data)
        case .failure(let err):
            errors[name] = err.localizedDescription
        }
        revision += 1
    }

    private func buildOnPhone(_ name: String, _ ask: (view: String, params: [String: JSONValue]?)) -> Bool {
        guard let build = localBuilder else { return false }
        return build(ask.view, ask.params) { [weak self] result in
            DispatchQueue.main.async { self?.settle(name, result, fromPhone: true) }
        }
    }

    private func fetch(_ name: String) {
        guard !inFlight.contains(name) else { return }
        inFlight.insert(name)
        triedAt[name] = Date()
        revision += 1
        let ask = asks[name] ?? (view: name, params: nil)
        if !macLive && buildOnPhone(name, ask) { return }
        sync.requestView(ask.view, params: ask.params) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if case .failure(let err) = result, Self.meansAway(err.localizedDescription),
                   self.buildOnPhone(name, ask) { return }
                self.settle(name, result, fromPhone: false)
            }
        }
    }

    /// A one-off parameterised request (an insight's detail) — not cached
    /// by name like the digests; the caller holds the result.
    public func request(_ name: String, params: [String: JSONValue], completion: @escaping (Result<JSONValue, Error>) -> Void) {
        let local: () -> Bool = { [weak self] in
            guard let build = self?.localBuilder else { return false }
            return build(name, params) { result in
                let marked = result.map { d -> JSONValue in
                    guard case .object(var o) = d else { return d }
                    o["_builtOn"] = .string("phone"); return .object(o)
                }
                DispatchQueue.main.async { completion(marked) }
            }
        }
        if !macLive && local() { return }
        sync.requestView(name, params: params) { result in
            DispatchQueue.main.async {
                if case .failure(let err) = result, Self.meansAway(err.localizedDescription), local() { return }
                completion(result)
            }
        }
    }

    /// Reflect a read/unread change in the cached insights digest at once,
    /// so folder counts and the Unread filter move before the next refresh.
    public func markInsightRead(_ emailId: String, read: Bool) {
        guard var c = cached("insights"), var obj = c.data.objectValue,
              var rows = obj["insights"]?.arrayValue else { return }
        var unreadDelta = 0
        for i in rows.indices {
            guard case .object(var r) = rows[i], r["emailId"]?.stringValue == emailId else { continue }
            let was = r["read"]?.boolValue ?? false
            if was != read { unreadDelta += read ? -1 : 1 }
            r["read"] = .bool(read)
            rows[i] = .object(r)
        }
        obj["insights"] = .array(rows)
        obj["unread"] = .number(max(0, (obj["unread"]?.numberValue ?? 0) + Double(unreadDelta)))
        c.data = .object(obj)
        cache["insights"] = c
        if let d = try? JSONEncoder().encode(CacheRow(at: c.at.timeIntervalSince1970, data: c.data)) {
            UserDefaults.standard.set(d, forKey: key("insights"))
        }
        revision += 1
    }

    /// "just now" / "5m ago" / "2h ago" / "3d ago" — the honesty line under
    /// every Mac-served screen.
    public static func agoLabel(_ date: Date?) -> String {
        guard let d = date else { return "" }
        let mins = Int((Date().timeIntervalSince(d) / 60).rounded())
        if mins < 1 { return "just now" }
        if mins < 60 { return "\(mins)m ago" }
        let h = Int((Double(mins) / 60).rounded())
        if h < 24 { return "\(h)h ago" }
        return "\(Int((Double(h) / 24).rounded()))d ago"
    }
}
