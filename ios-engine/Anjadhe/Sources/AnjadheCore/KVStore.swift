import Foundation

/// One synced entry as seen on the wire (the channel's value/tombstone shape).
public struct RemoteEntry: Equatable, Codable {
    public var value: JSONValue?   // nil when deleted
    public var deleted: Bool
    public var modifiedAt: String
    public init(value: JSONValue?, deleted: Bool, modifiedAt: String) {
        self.value = value; self.deleted = deleted; self.modifiedAt = modifiedAt
    }
    private enum CodingKeys: String, CodingKey { case value, deleted, modifiedAt }
    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        deleted = try fields.decode(Bool.self, forKey: .deleted)
        modifiedAt = try fields.decode(String.self, forKey: .modifiedAt)
        value = deleted ? nil : (try fields.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null)
    }
}

/// In-memory view of transactionally committed local records.
public final class KVStore {
    enum Entry {
        case live(JSONValue, String)   // value, modifiedAt
        case tomb(String)              // tombAt
    }

    public static let epoch = "1970-01-01T00:00:00.000Z"

    private var cache: [String: Entry] = [:]
    public enum WriteOrigin: String, Codable { case local, remote }
    /// Runtime persistence commits BEFORE cache changes or sync callbacks.
    /// A failure leaves the previous cache/stamp intact and returns false.
    public var commit: ((_ key: String, _ entry: RemoteEntry, _ before: RemoteEntry?, _ origin: WriteOrigin) throws -> [String: RemoteEntry])?
    /// All read keys participate in compare-and-swap, including absent keys.
    public var commitBatch: ((_ changes: [String: RemoteEntry], _ expected: [String: RemoteEntry], _ readKeys: [String]) throws -> Void)?
    public var onWriteFailure: ((Error) -> Void)?

    public init() {}

    /// Rehydrate the cache from persisted rows at launch.
    ///
    /// A key already in the cache is LEFT ALONE. When hydration was
    /// synchronous that could not happen; now that the app loads the file off
    /// the main thread (so launch is not blocked on decoding megabytes of
    /// JSON), a user write can land first — and anything already here was
    /// written by this session, which makes it newer than the disk by
    /// construction. Overwriting it would silently undo what the user just
    /// typed.
    public func hydrate(_ rows: [String: RemoteEntry]) {
        for (k, e) in rows where cache[k] == nil {
            cache[k] = e.deleted ? .tomb(e.modifiedAt) : .live(e.value ?? .null, e.modifiedAt)
        }
    }

    // MARK: Local reads/writes (the electronStore surface)

    public func get(_ key: String) -> JSONValue? {
        if case .live(let v, _)? = cache[key] { return v }
        return nil
    }

    public func has(_ key: String) -> Bool {
        if case .live? = cache[key] { return true }
        return false
    }

    @discardableResult
    public func set(_ key: String, _ value: JSONValue, now: String) -> Bool {
        guard durable(key, RemoteEntry(value: value, deleted: false, modifiedAt: now), .local) else { return false }
        cache[key] = .live(value, now)
        return true
    }

    @discardableResult
    public func delete(_ key: String, now: String) -> Bool {
        guard durable(key, RemoteEntry(value: nil, deleted: true, modifiedAt: now), .local) else { return false }
        cache[key] = .tomb(now)
        return true
    }

    /// An approved action and its receipt land together. Never fall back to
    /// sequential single-key commits: that would expose a partial action.
    public func setBatch(_ values: [String: JSONValue], expected: [String: RemoteEntry], readKeys: [String], now: String) throws {
        let keys = Set(readKeys)
        guard Set(values.keys).isSubset(of: keys), Set(expected.keys).isSubset(of: keys),
              exportValues(readKeys) == expected else { throw LocalRecordStore.StoreError.staleRevision }
        let changes = values.mapValues { RemoteEntry(value: $0, deleted: false, modifiedAt: now) }
        if let commitBatch { try commitBatch(changes, expected, readKeys) }
        else if commit != nil { throw TransactionalStore.Failure.notReady }
        for (key, entry) in changes { cache[key] = .live(entry.value ?? .null, entry.modifiedAt) }
    }

    public var liveKeys: [String] {
        cache.compactMap { if case .live = $0.value { return $0.key }; return nil }
    }

    // MARK: Local snapshots

    public func localModifiedAt(_ key: String) -> String {
        switch cache[key] {
        case .live(_, let m): return m
        case .tomb(let a): return a
        case nil: return Self.epoch
        }
    }

    /// Complete local snapshot including tombstones.
    public func snapshot() -> [String: RemoteEntry] {
        var out: [String: RemoteEntry] = [:]
        for (k, e) in cache {
            switch e {
            case .live(let v, let at): out[k] = RemoteEntry(value: v, deleted: false, modifiedAt: at)
            case .tomb(let at): out[k] = RemoteEntry(value: nil, deleted: true, modifiedAt: at)
            }
        }
        return out
    }

    /// Values (or tombstones) for a specific subset of keys.
    public func exportValues(_ keys: [String]) -> [String: RemoteEntry] {
        var out: [String: RemoteEntry] = [:]
        for k in keys {
            switch cache[k] {
            case .live(let v, let at): out[k] = RemoteEntry(value: v, deleted: false, modifiedAt: at)
            case .tomb(let at): out[k] = RemoteEntry(value: nil, deleted: true, modifiedAt: at)
            case nil: break
            }
        }
        return out
    }

    private func durable(_ key: String, _ entry: RemoteEntry, _ origin: WriteOrigin) -> Bool {
        do {
            let companions = try commit?(key, entry, exportValues([key])[key], origin) ?? [:]
            for (key, row) in companions {
                cache[key] = row.deleted ? .tomb(row.modifiedAt) : .live(row.value ?? .null, row.modifiedAt)
            }
            return true
        }
        catch { onWriteFailure?(error); return false }
    }

    // MARK: Timestamps

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ s: String) -> Date {
        isoFractional.date(from: s) ?? isoPlain.date(from: s) ?? Date(timeIntervalSince1970: 0)
    }

    /// ISO-8601 with milliseconds + Z, matching JS `new Date().toISOString()`.
    public static func nowISO(_ date: Date = Date()) -> String {
        isoFractional.string(from: date)
    }
}
