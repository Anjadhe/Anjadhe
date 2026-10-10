import Foundation
import CSQLite

/// Standalone storage foundation. This is not the v2 wire/merge protocol and
/// must not be pointed at the legacy KVStore or its JSON persistence file.
///
/// L1 A successful mutation commits its record, local change and search entry
///    together, before returning; no debounce or lifecycle flush is required.
/// L2 A stale editor cannot replace a revision it has not read.
/// L3 Deletes retain tombstones; identical saves add no new change.
/// L4 Corruption, unsupported schemas and failed transactions throw. They
///    never become an empty store or a successful partial save.
/// L5 The local journal is retained until a future sync implementation can
///    prove safe compaction. Reading/searching/rebuilding indexes adds no work.
///
/// Each connection is serialized. Call from a background executor for large
/// reads/imports. The runtime compatibility adapter uses separate kv_* tables;
/// the record-level API is not yet the UI's authoritative data model.
public final class LocalRecordStore {
    public struct Record: Codable, Equatable {
        public let type: String
        public let id: String
        public let schemaVersion: Int
        public let value: JSONValue? // nil is an explicit tombstone; .null is a value
        public let searchText: String
        public let revision: Int64 // local revision, NOT a cross-device clock
        public let modifiedAt: String
        public var deleted: Bool { value == nil }

        private enum CodingKeys: String, CodingKey {
            case type, id, schemaVersion, value, searchText, revision, modifiedAt
        }

        init(type: String, id: String, schemaVersion: Int, value: JSONValue?,
             searchText: String, revision: Int64, modifiedAt: String) {
            self.type = type; self.id = id; self.schemaVersion = schemaVersion
            self.value = value; self.searchText = searchText
            self.revision = revision; self.modifiedAt = modifiedAt
        }

        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            type = try fields.decode(String.self, forKey: .type)
            id = try fields.decode(String.self, forKey: .id)
            schemaVersion = try fields.decode(Int.self, forKey: .schemaVersion)
            // Synthesized Optional decoding collapses JSON null into nil.
            // A missing value is a tombstone; a present null is live data.
            value = fields.contains(.value) ? try fields.decode(JSONValue.self, forKey: .value) : nil
            searchText = try fields.decode(String.self, forKey: .searchText)
            revision = try fields.decode(Int64.self, forKey: .revision)
            modifiedAt = try fields.decode(String.self, forKey: .modifiedAt)
        }
    }

    public struct Change: Codable, Equatable {
        public let writerID: String
        public let sequence: Int64
        public let before: Record?
        public let record: Record
        public var id: String { "\(writerID):\(sequence)" }
    }

    public enum StoreError: Error, Equatable, LocalizedError {
        case database(Int32)
        case unsupportedSchema(Int)
        case staleRevision
        case invalidRecord
        case invalidLimit
        case corruptData

        public var errorDescription: String? {
            switch self {
            case .database(let code): return "The local store could not complete the operation (\(code))."
            case .unsupportedSchema: return "This store needs a newer version of nenva."
            case .staleRevision: return "This record changed since it was opened. Your edit needs review."
            case .invalidRecord: return "The record is not valid."
            case .invalidLimit: return "The requested page size is not valid."
            case .corruptData: return "The local store could not be read. Its data has been kept."
            }
        }
    }

    public let databaseURL: URL
    private let queue = DispatchQueue(label: "com.anjadhe.records")
    private var db: OpaquePointer?
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private let decoder = JSONDecoder()
    private static let schemaVersion = 2
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Explicit destination keeps tests isolated. The parent directory is
    /// created, never replaced/reset. TransactionalStore owns legacy import.
    public init(databaseURL: URL) throws {
        guard databaseURL.isFileURL else { throw StoreError.invalidRecord }
        self.databaseURL = databaseURL
        try FileManager.default.createDirectory(at: databaseURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let opened = sqlite3_open_v2(databaseURL.path, &db,
                                    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard opened == SQLITE_OK else {
            sqlite3_close_v2(db); db = nil
            throw StoreError.database(opened)
        }
        do {
            try queue.sync {
                try check(sqlite3_busy_timeout(db, 2500))
                // Inspect version BEFORE changing a newer store's schema.
                let version = try scalar("PRAGMA user_version")
                guard version <= Self.schemaVersion else { throw StoreError.unsupportedSchema(Int(version)) }
                try execute("PRAGMA journal_mode = WAL")
                try execute("PRAGMA synchronous = FULL")
                try transaction {
                    if version == 0 {
                        // No IF NOT EXISTS: an unrelated/incomplete database
                        // must fail, not be adopted as an empty new install.
                        try execute("""
                        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                        CREATE TABLE records (
                            type TEXT NOT NULL, id TEXT NOT NULL,
                            revision INTEGER NOT NULL, deleted INTEGER NOT NULL,
                            payload BLOB NOT NULL, PRIMARY KEY(type, id)
                        );
                        CREATE TABLE local_changes (
                            sequence INTEGER PRIMARY KEY, payload BLOB NOT NULL
                        );
                        CREATE VIRTUAL TABLE record_search USING fts5(
                            type UNINDEXED, id UNINDEXED, text, tokenize='unicode61'
                        );
                        INSERT INTO metadata VALUES ('sequence', '0');
                        PRAGMA user_version = 1;
                        """)
                        try run("INSERT INTO metadata VALUES ('writer', ?)", [.text(UUID().uuidString)])
                    }
                    if version < 2 {
                        try execute("""
                        CREATE TABLE kv_entries (key TEXT PRIMARY KEY, payload BLOB NOT NULL);
                        CREATE TABLE kv_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB NOT NULL);
                        PRAGMA user_version = 2;
                        """)
                    }
                    guard let writer = try metadata("writer"), !writer.isEmpty,
                          let sequence = try metadata("sequence"), let counter = Int64(sequence), counter >= 0 else {
                        throw StoreError.corruptData
                    }
                    // Validate required columns without scanning the full
                    // collection or its growing journal at every launch.
                    for query in [
                        "SELECT type, id, revision, deleted, payload FROM records LIMIT 0",
                        "SELECT sequence, payload FROM local_changes LIMIT 0",
                        "SELECT type, id, text FROM record_search LIMIT 0",
                        "SELECT key, payload FROM kv_entries LIMIT 0",
                        "SELECT sequence, payload FROM kv_history LIMIT 0"
                    ] {
                        try statement(query) { _ in }
                    }
                }
            }
        } catch {
            sqlite3_close_v2(db); db = nil
            throw error
        }
    }

    deinit { sqlite3_close_v2(db) }

    public func record(type: String, id: String) throws -> Record? {
        try queue.sync { try readRecord(type: type, id: id) }
    }

    /// nil expectedRevision means "create only if absent". To restore a
    /// tombstone, the caller must explicitly supply its current revision.
    @discardableResult
    public func save(type: String, id: String, value: JSONValue,
                     searchText: String, expectedRevision: Int64?,
                     schemaVersion: Int = 1, modifiedAt: String = KVStore.nowISO()) throws -> Record {
        try mutate(type: type, id: id, value: value, searchText: searchText,
                   expectedRevision: expectedRevision, schemaVersion: schemaVersion, modifiedAt: modifiedAt)
    }

    @discardableResult
    public func delete(type: String, id: String, expectedRevision: Int64?,
                       schemaVersion: Int = 1, modifiedAt: String = KVStore.nowISO()) throws -> Record {
        try mutate(type: type, id: id, value: nil, searchText: "",
                   expectedRevision: expectedRevision, schemaVersion: schemaVersion, modifiedAt: modifiedAt)
    }

    /// Bounded, stable keyset pagination. Tombstones are read by identity or
    /// from the journal, not presented as ordinary live records.
    public func records(type: String, afterID: String = "", limit: Int = 100) throws -> [Record] {
        try validateLimit(limit)
        return try queue.sync {
            try payloads("SELECT payload FROM records WHERE type = ? AND id > ? AND deleted = 0 ORDER BY id LIMIT ?",
                         [.text(type), .text(afterID), .integer(Int64(limit))], as: Record.self)
        }
    }

    /// Durable local changes, in commit order. No upload or deletion API is
    /// exposed until the v2 receipt/compaction contract has been implemented.
    public func changes(after sequence: Int64 = 0, limit: Int = 100) throws -> [Change] {
        try validateLimit(limit)
        return try queue.sync {
            try payloads("SELECT payload FROM local_changes WHERE sequence > ? ORDER BY sequence LIMIT ?",
                         [.integer(sequence), .integer(Int64(limit))], as: Change.self)
        }
    }

    /// A literal phrase, not raw FTS query syntax. All input is bound.
    public func search(_ query: String, type: String? = nil, limit: Int = 50) throws -> [Record] {
        try validateLimit(limit)
        let phrase = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !phrase.isEmpty else { return [] }
        let match = "\"" + phrase.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        return try queue.sync {
            var arguments: [Binding] = [.text(match)]
            if let type { arguments.append(.text(type)) }
            arguments.append(.integer(Int64(limit)))
            return try payloads("""
                SELECT r.payload FROM record_search
                JOIN records r ON r.type = record_search.type AND r.id = record_search.id
                WHERE record_search MATCH ? AND r.deleted = 0
                \(type == nil ? "" : "AND r.type = ?")
                ORDER BY rank, r.type, r.id LIMIT ?
                """, arguments, as: Record.self)
        }
    }

    /// Derived data only. Does not touch revisions, tombstones or the journal.
    public func rebuildSearch() throws {
        try queue.sync {
            try transaction {
                try execute("DELETE FROM record_search")
                try statement("SELECT payload FROM records WHERE deleted = 0") { cursor in
                    while try step(cursor) {
                        let record: Record = try decode(cursor)
                        try index(record)
                    }
                }
            }
        }
    }

    private func mutate(type: String, id: String, value: JSONValue?, searchText: String,
                        expectedRevision: Int64?, schemaVersion: Int, modifiedAt: String) throws -> Record {
        guard [type, id].allSatisfy({ !$0.isEmpty && !$0.contains("\0") && $0.utf8.count <= 512 }),
              schemaVersion > 0, !modifiedAt.isEmpty else { throw StoreError.invalidRecord }
        return try queue.sync {
            try transaction {
                let before = try readRecord(type: type, id: id)
                guard before?.revision == expectedRevision else { throw StoreError.staleRevision }
                if let before, before.value == value, before.searchText == searchText,
                   before.schemaVersion == schemaVersion { return before }
                guard let raw = try metadata("sequence"), let last = Int64(raw), last >= 0, last < Int64.max,
                      let writer = try metadata("writer") else { throw StoreError.corruptData }
                let sequence = last + 1
                let record = Record(type: type, id: id, schemaVersion: schemaVersion, value: value,
                                    searchText: searchText, revision: sequence, modifiedAt: modifiedAt)
                let change = Change(writerID: writer, sequence: sequence, before: before, record: record)
                try run("""
                    INSERT INTO records (type, id, revision, deleted, payload) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(type, id) DO UPDATE SET revision=excluded.revision,
                        deleted=excluded.deleted, payload=excluded.payload
                    """, [.text(type), .text(id), .integer(sequence), .integer(record.deleted ? 1 : 0),
                          .data(try encoder.encode(record))])
                try run("INSERT INTO local_changes VALUES (?, ?)", [.integer(sequence), .data(try encoder.encode(change))])
                try run("UPDATE metadata SET value = ? WHERE key = 'sequence'", [.text(String(sequence))])
                try run("DELETE FROM record_search WHERE type = ? AND id = ?", [.text(type), .text(id)])
                if !record.deleted { try index(record) }
                return record
            }
        }
    }

    private func index(_ record: Record) throws {
        try run("INSERT INTO record_search (type, id, text) VALUES (?, ?, ?)",
                [.text(record.type), .text(record.id), .text(record.searchText)])
    }

    private func readRecord(type: String, id: String) throws -> Record? {
        let result: Record? = try payloads("SELECT payload FROM records WHERE type = ? AND id = ?",
                                          [.text(type), .text(id)], as: Record.self).first
        if let result, result.type != type || result.id != id { throw StoreError.corruptData }
        return result
    }

    private func metadata(_ key: String) throws -> String? {
        try statement("SELECT value FROM metadata WHERE key = ?", [.text(key)]) { stmt in
            guard try step(stmt), let value = sqlite3_column_text(stmt, 0) else { return nil }
            return String(cString: value)
        }
    }

    private func validateLimit(_ limit: Int) throws {
        guard (1...500).contains(limit) else { throw StoreError.invalidLimit }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private enum Binding { case text(String), integer(Int64), data(Data) }

    private func check(_ result: Int32) throws {
        guard result == SQLITE_OK else { throw StoreError.database(result) }
    }

    private func execute(_ sql: String) throws { try check(sqlite3_exec(db, sql, nil, nil, nil)) }

    private func statement<T>(_ sql: String, _ arguments: [Binding] = [],
                              _ body: (OpaquePointer) throws -> T) throws -> T {
        var cursor: OpaquePointer?
        try check(sqlite3_prepare_v2(db, sql, -1, &cursor, nil))
        guard let cursor else { throw StoreError.corruptData }
        defer { sqlite3_finalize(cursor) }
        for (offset, value) in arguments.enumerated() {
            let i = Int32(offset + 1)
            switch value {
            case .text(let text):
                try check(text.withCString { sqlite3_bind_text(cursor, i, $0, Int32(text.utf8.count), Self.transient) })
            case .integer(let number): try check(sqlite3_bind_int64(cursor, i, number))
            case .data(let data):
                try check(data.withUnsafeBytes { sqlite3_bind_blob(cursor, i, $0.baseAddress, Int32(data.count), Self.transient) })
            }
        }
        return try body(cursor)
    }

    private func step(_ cursor: OpaquePointer) throws -> Bool {
        let code = sqlite3_step(cursor)
        if code == SQLITE_ROW { return true }
        if code == SQLITE_DONE { return false }
        throw StoreError.database(code)
    }

    private func run(_ sql: String, _ arguments: [Binding]) throws {
        try statement(sql, arguments) { cursor in
            guard try !step(cursor) else { throw StoreError.corruptData }
        }
    }

    private func scalar(_ sql: String) throws -> Int64 {
        try statement(sql) { cursor in
            guard try step(cursor) else { throw StoreError.corruptData }
            return sqlite3_column_int64(cursor, 0)
        }
    }

    private func decode<T: Decodable>(_ cursor: OpaquePointer) throws -> T {
        guard let bytes = sqlite3_column_blob(cursor, 0) else { throw StoreError.corruptData }
        let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(cursor, 0)))
        do { return try decoder.decode(T.self, from: data) }
        catch { throw StoreError.corruptData }
    }

    private func payloads<T: Decodable>(_ sql: String, _ arguments: [Binding], as: T.Type) throws -> [T] {
        try statement(sql, arguments) { cursor in
            var rows: [T] = []
            while try step(cursor) { rows.append(try decode(cursor)) }
            return rows
        }
    }
}

// Compatibility persistence during the record-by-record rollout. These rows
// and their recovery history are NOT v2 operations and are never uploaded as
// a journal. Remote writes retain their origin and cannot become local work.
extension LocalRecordStore {
    struct KVChange: Codable, Equatable {
        let key: String
        let before: RemoteEntry?
        let after: RemoteEntry
        let origin: KVStore.WriteOrigin
    }

    func legacyFingerprint() throws -> String? {
        try queue.sync { try metadata("legacy-fingerprint") }
    }

    /// Baseline rows and the import marker commit together. A crash before
    /// commit leaves an unimported database that can safely retry the import.
    func importLegacy(_ rows: [String: RemoteEntry], fingerprint: String) throws {
        try queue.sync {
            try transaction {
                if let previous = try metadata("legacy-fingerprint") {
                    guard previous == fingerprint else { throw StoreError.staleRevision }
                    return
                }
                guard try scalar("SELECT count(*) FROM kv_entries") == 0 else { throw StoreError.corruptData }
                for key in rows.keys.sorted() {
                    try run("INSERT INTO kv_entries VALUES (?, ?)", [.text(key), .data(try encoder.encode(rows[key]!))])
                }
                try run("INSERT INTO metadata VALUES ('legacy-fingerprint', ?)", [.text(fingerprint)])
            }
        }
    }

    func legacySnapshot() throws -> [String: RemoteEntry] {
        try queue.sync {
            try statement("SELECT payload, key FROM kv_entries") { cursor in
                var rows: [String: RemoteEntry] = [:]
                while try step(cursor) {
                    guard let bytes = sqlite3_column_text(cursor, 1) else { throw StoreError.corruptData }
                    rows[String(cString: bytes)] = try decode(cursor)
                }
                return rows
            }
        }
    }

    func commitLegacy(_ key: String, entry: RemoteEntry, expected: RemoteEntry?, origin: KVStore.WriteOrigin) throws -> [String: RemoteEntry] {
        guard !key.isEmpty, !key.contains("\0"), !entry.modifiedAt.isEmpty else { throw StoreError.invalidRecord }
        return try queue.sync {
            try transaction {
                guard try metadata("legacy-fingerprint") != nil else { throw StoreError.corruptData }
                let before = try payloads("SELECT payload FROM kv_entries WHERE key = ?", [.text(key)], as: RemoteEntry.self).first
                guard before == expected else { throw StoreError.staleRevision }
                if before == entry { return [:] }
                let change = KVChange(key: key, before: before, after: entry, origin: origin)
                try run("INSERT INTO kv_entries VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                        [.text(key), .data(try encoder.encode(entry))])
                try run("INSERT INTO kv_history (payload) VALUES (?)", [.data(try encoder.encode(change))])
                var companions: [String: RemoteEntry] = [:]
                if origin == .local && !key.hasPrefix("anjadhe:channel:") {
                    let dirtyKey = "anjadhe:channel:dirty", baseKey = "anjadhe:channel:base"
                    func map(_ key: String) throws -> [String: JSONValue] {
                        let row = try payloads("SELECT payload FROM kv_entries WHERE key = ?", [.text(key)], as: RemoteEntry.self).first
                        guard let row, !row.deleted else { return [:] }
                        guard let value = row.value?.objectValue else { throw StoreError.corruptData }
                        return value
                    }
                    var dirty = try map(dirtyKey), base = try map(baseKey)
                    if dirty[key] == nil { base[key] = .string(before?.modifiedAt ?? KVStore.epoch) }
                    dirty[key] = .string(entry.modifiedAt)
                    for (name, value) in [(dirtyKey, dirty), (baseKey, base)] {
                        let row = RemoteEntry(value: .object(value), deleted: false, modifiedAt: entry.modifiedAt)
                        try run("INSERT INTO kv_entries VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                                [.text(name), .data(try encoder.encode(row))])
                        companions[name] = row
                    }
                }
                return companions
            }
        }
    }

    func legacyHistory() throws -> [KVChange] {
        try queue.sync {
            try payloads("SELECT payload FROM kv_history ORDER BY sequence", [], as: KVChange.self)
        }
    }
}
