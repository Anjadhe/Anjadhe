import Foundation
import CryptoKit
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
// SQLite and the shared encoder are accessed only on the private serial queue.
// Public decryption helpers use their own encoder before entering that queue.
public final class LocalRecordStore: @unchecked Sendable {
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
    private static let schemaVersion = 5
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
                    if version < 3 {
                        try execute("""
                        CREATE TABLE kv_collections (key TEXT PRIMARY KEY, field TEXT NOT NULL, item_count INTEGER NOT NULL CHECK(item_count >= 0));
                        CREATE TABLE kv_items (
                            key TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
                            payload BLOB NOT NULL, PRIMARY KEY(key, id)
                        );
                        CREATE INDEX kv_items_order ON kv_items(key, position);
                        CREATE TABLE kv_collection_baselines (key TEXT PRIMARY KEY, payload BLOB NOT NULL);
                        CREATE VIRTUAL TABLE kv_search USING fts5(
                            key UNINDEXED, id UNINDEXED, text, tokenize='unicode61'
                        );
                        PRAGMA user_version = 3;
                        """)
                    }
                    if version < 4 {
                        try execute("""
                        CREATE TABLE merge_datasets (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, writer TEXT NOT NULL);
                        CREATE TABLE merge_operations (
                            dataset TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL,
                            type TEXT NOT NULL, id TEXT NOT NULL, applied INTEGER NOT NULL,
                            local INTEGER NOT NULL, payload BLOB NOT NULL,
                            PRIMARY KEY(dataset, writer, sequence)
                        );
                        CREATE INDEX merge_pending ON merge_operations(dataset, applied, writer, sequence);
                        CREATE INDEX merge_record_history ON merge_operations(dataset, type, id, applied);
                        CREATE TABLE merge_frontiers (dataset TEXT NOT NULL, writer TEXT NOT NULL,
                            sequence INTEGER NOT NULL, PRIMARY KEY(dataset, writer));
                        CREATE TABLE merge_records (dataset TEXT NOT NULL, type TEXT NOT NULL,
                            id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(dataset, type, id));
                        PRAGMA user_version = 4;
                        """)
                    }
                    if version < 5 {
                        try execute("""
                        CREATE TABLE merge_envelopes (dataset TEXT NOT NULL, writer TEXT NOT NULL,
                            sequence INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(dataset, writer, sequence));
                        CREATE TABLE merge_crypto (dataset TEXT PRIMARY KEY, key_digest BLOB NOT NULL, signing_public_key BLOB NOT NULL);
                        CREATE TABLE merge_delivery (dataset TEXT PRIMARY KEY, cursor TEXT NOT NULL, uploaded INTEGER NOT NULL);
                        INSERT INTO merge_delivery SELECT id, '', 0 FROM merge_datasets;
                        PRAGMA user_version = 5;
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
                        "SELECT sequence, payload FROM kv_history LIMIT 0",
                        "SELECT key, field, item_count FROM kv_collections LIMIT 0",
                        "SELECT key, id, position, payload FROM kv_items LIMIT 0",
                        "SELECT key, payload FROM kv_collection_baselines LIMIT 0",
                        "SELECT key, id, text FROM kv_search LIMIT 0",
                        "SELECT id, epoch, writer FROM merge_datasets LIMIT 0",
                        "SELECT dataset, writer, sequence, type, id, applied, local, payload FROM merge_operations LIMIT 0",
                        "SELECT dataset, writer, sequence FROM merge_frontiers LIMIT 0",
                        "SELECT dataset, type, id, payload FROM merge_records LIMIT 0",
                        "SELECT dataset, writer, sequence, payload FROM merge_envelopes LIMIT 0",
                        "SELECT dataset, key_digest, signing_public_key FROM merge_crypto LIMIT 0",
                        "SELECT dataset, cursor, uploaded FROM merge_delivery LIMIT 0"
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

// Record-granular backing for the task/note compatibility facade. C1: exact
// JSON, ordering and unknown fields survive normalization. C2: malformed or
// duplicate identities stay in the original blob, never silently disappear.
// C3: item changes, metadata, recovery deltas, index and dirty flags commit in
// the caller's single transaction. This is local recovery, not a v2 outbox.
extension LocalRecordStore {
    struct CollectionItem: Codable, Equatable {
        let id: String
        let position: Int
        let value: JSONValue
    }
    struct CollectionDelta: Codable, Equatable {
        let id: String
        let before: CollectionItem?
        let after: CollectionItem?
    }
    private struct CollectionPartition {
        let field: String
        let header: RemoteEntry
        let items: [CollectionItem]
    }
    private func sameBytes<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
        try encoder.encode(a) == encoder.encode(b)
    }
    private func partitionCollection(_ key: String, entry: RemoteEntry) -> CollectionPartition? {
        let fields = ["app_notes": "notes", "app_schedule": "scheduleItems"]
        guard let field = fields[key], !entry.deleted, var object = entry.value?.objectValue,
              let values = object[field]?.arrayValue else { return nil }
        var ids = Set<String>(), items: [CollectionItem] = []
        for (position, value) in values.enumerated() {
            guard let id = value["id"]?.stringValue, !id.isEmpty, !id.contains("\0"),
                  id.utf8.count <= 512, ids.insert(id).inserted else { return nil }
            items.append(CollectionItem(id: id, position: position, value: value))
        }
        object.removeValue(forKey: field)
        return CollectionPartition(field: field,
            header: RemoteEntry(value: .object(object), deleted: false, modifiedAt: entry.modifiedAt), items: items)
    }
    private func collectionField(_ key: String) throws -> String? {
        try statement("SELECT field, item_count FROM kv_collections WHERE key = ?", [.text(key)]) { cursor in
            guard try step(cursor) else { return nil }
            guard let bytes = sqlite3_column_text(cursor, 0) else { throw StoreError.corruptData }
            let field = String(cString: bytes)
            guard (key == "app_notes" && field == "notes") || (key == "app_schedule" && field == "scheduleItems") else { throw StoreError.corruptData }
            let expected = sqlite3_column_int64(cursor, 1)
            let actual = try statement("SELECT count(*) FROM kv_items WHERE key = ?", [.text(key)]) { count in
                guard try step(count) else { throw StoreError.corruptData }
                return sqlite3_column_int64(count, 0)
            }
            guard expected >= 0, actual == expected else { throw StoreError.corruptData }
            return field
        }
    }
    private func collectionItems(_ key: String) throws -> [CollectionItem] {
        try statement("SELECT payload, id, position FROM kv_items WHERE key = ? ORDER BY position", [.text(key)]) { cursor in
            var items: [CollectionItem] = []
            while try step(cursor) {
                let value: JSONValue = try decode(cursor)
                guard let bytes = sqlite3_column_text(cursor, 1) else { throw StoreError.corruptData }
                let id = String(cString: bytes), position = Int(sqlite3_column_int64(cursor, 2))
                guard value["id"]?.stringValue == id, position == items.count else { throw StoreError.corruptData }
                items.append(CollectionItem(id: id, position: position, value: value))
            }
            return items
        }
    }
    private func expandCollection(_ key: String, entry: RemoteEntry) throws -> RemoteEntry {
        guard let field = try collectionField(key) else { return entry }
        guard !entry.deleted, var object = entry.value?.objectValue, object[field] == nil else { throw StoreError.corruptData }
        object[field] = .array(try collectionItems(key).map(\.value))
        return RemoteEntry(value: .object(object), deleted: false, modifiedAt: entry.modifiedAt)
    }
    @discardableResult
    private func writeCollection(_ key: String, partition: CollectionPartition?) throws -> [CollectionDelta]? {
        let previous = try collectionItems(key), next = partition?.items ?? []
        if previous.isEmpty && partition == nil { return nil }
        let old = Dictionary(uniqueKeysWithValues: previous.map { ($0.id, $0) })
        let new = Dictionary(uniqueKeysWithValues: next.map { ($0.id, $0) })
        var changes: [CollectionDelta] = []
        for id in Set(old.keys).union(new.keys).sorted() {
            let before = old[id], after = new[id]
            if try sameBytes(before, after) { continue }
            changes.append(CollectionDelta(id: id, before: before, after: after))
            if let after {
                try run("""
                    INSERT INTO kv_items VALUES (?, ?, ?, ?) ON CONFLICT(key, id)
                    DO UPDATE SET position=excluded.position, payload=excluded.payload
                    """, [.text(key), .text(id), .integer(Int64(after.position)), .data(try encoder.encode(after.value))])
            } else {
                try run("DELETE FROM kv_items WHERE key = ? AND id = ?", [.text(key), .text(id)])
            }
            if try !sameBytes(before?.value, after?.value) {
                try run("DELETE FROM kv_search WHERE key = ? AND id = ?", [.text(key), .text(id)])
                if let after { try indexCollectionItem(key, item: after) }
            }
        }
        if let partition {
            try run("INSERT INTO kv_collections VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET field=excluded.field, item_count=excluded.item_count",
                    [.text(key), .text(partition.field), .integer(Int64(next.count))])
        } else {
            try run("DELETE FROM kv_collections WHERE key = ?", [.text(key)])
        }
        return changes
    }
    private func indexCollectionItem(_ key: String, item: CollectionItem) throws {
        let value = item.value
        let text = [value["title"]?.stringValue ?? "", RecordText.markdown(value["content"]?.stringValue ?? ""),
                    RecordText.markdown(value["description"]?.stringValue ?? "")].joined(separator: "\n")
        try run("INSERT INTO kv_search (key, id, text) VALUES (?, ?, ?)", [.text(key), .text(item.id), .text(text)])
    }
    /// Invoked off the main thread during open. Preserve a complete baseline
    /// before atomically splitting each collection. Existing history stays.
    func normalizeLegacyCollections() throws {
        try queue.sync {
            try transaction {
                for key in ["app_notes", "app_schedule"] {
                    guard try collectionField(key) == nil,
                          let entry = try payloads("SELECT payload FROM kv_entries WHERE key = ?", [.text(key)], as: RemoteEntry.self).first,
                          let partition = partitionCollection(key, entry: entry) else { continue }
                    try run("INSERT OR IGNORE INTO kv_collection_baselines VALUES (?, ?)", [.text(key), .data(try encoder.encode(entry))])
                    try writeCollection(key, partition: partition)
                    try run("UPDATE kv_entries SET payload = ? WHERE key = ?", [.data(try encoder.encode(partition.header)), .text(key)])
                }
            }
        }
    }
    public struct CollectionSearchHit: Equatable {
        public let key: String
        public let value: JSONValue
        public init(key: String, value: JSONValue) { self.key = key; self.value = value }
    }
    /// Bounded literal token-prefix search. Query operators remain plain text.
    public func searchCollections(_ query: String, limit: Int = 40) throws -> [CollectionSearchHit] {
        try validateLimit(limit)
        let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return [] }
        let match = words.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"*" }.joined(separator: " AND ")
        return try queue.sync {
            var hits = try statement("""
                SELECT i.payload, i.key FROM kv_search JOIN kv_items i
                ON i.key = kv_search.key AND i.id = kv_search.id
                WHERE kv_search MATCH ? ORDER BY rank, i.key, i.id LIMIT ?
                """, [.text(match), .integer(Int64(limit))]) { cursor in
                var hits: [CollectionSearchHit] = []
                while try step(cursor) {
                    guard let bytes = sqlite3_column_text(cursor, 1) else { throw StoreError.corruptData }
                    hits.append(CollectionSearchHit(key: String(cString: bytes), value: try decode(cursor)))
                }
                return hits
            }
            // A malformed legacy collection is preserved as a blob. Search
            // it off-thread too, so normalization never hides valid records
            // just because a different row has a missing/duplicate identity.
            for key in ["app_notes", "app_schedule"] where hits.count < limit {
                guard try collectionField(key) == nil,
                      let row = try payloads("SELECT payload FROM kv_entries WHERE key = ?", [.text(key)], as: RemoteEntry.self).first,
                      !row.deleted else { continue }
                let field = key == "app_notes" ? "notes" : "scheduleItems"
                for value in row.value?[field]?.arrayValue ?? [] {
                    guard let id = value["id"]?.stringValue, !id.isEmpty,
                          !hits.contains(where: { $0.key == key && $0.value["id"]?.stringValue == id }) else { continue }
                    let text = [value["title"]?.stringValue ?? "", RecordText.markdown(value["content"]?.stringValue ?? ""),
                                RecordText.markdown(value["description"]?.stringValue ?? "")].joined(separator: " ").lowercased()
                    if words.allSatisfy({ text.contains($0.lowercased()) }) {
                        hits.append(CollectionSearchHit(key: key, value: value))
                        if hits.count == limit { break }
                    }
                }
            }
            return hits
        }
    }
}

// Experimental v2 storage seam. Never fed by the v1 WebView or KV adapter.
// M1 Received operations, projections and applied receipts commit together.
// M2 Identical delivery is harmless; a reused dot with changed bytes fails.
// M3 Missing/unsupported operations persist without advancing receipts.
// M4 Only explicitly authored local operations appear in the outbox.
// M5 No receipt, record or replay invokes a model, scheduler or action.
extension LocalRecordStore {
    public struct MergeReceipt: Equatable {
        public let frontier: [String: Int]
        public let applied: Int
        public let pending: Int
    }

    /// Enrollment/key verification belongs to the future pairing layer.
    /// This seam only installs an explicit immutable local dataset identity.
    public func createMergeDataset(_ id: String, writer: String, epoch: Int = 1) throws {
        guard RecordMerge.token(id), RecordMerge.token(writer), epoch > 0,
              epoch <= 9_007_199_254_740_991 else { throw StoreError.invalidRecord }
        try queue.sync {
            try transaction {
                try run("INSERT OR IGNORE INTO merge_datasets VALUES (?, ?, ?)", [.text(id), .integer(Int64(epoch)), .text(writer)])
                guard try mergeWriter(id, epoch: epoch) == writer else { throw StoreError.staleRevision }
                try run("INSERT OR IGNORE INTO merge_delivery VALUES (?, '', 0)", [.text(id)])
            }
        }
    }

    /// The transport must authenticate/decrypt and authorize the sender
    /// before calling this API. A returned frontier is durably applied, not
    /// merely downloaded. Unknown schemas remain pending through restart.
    public func ingestMergeOperations(_ operations: [JSONValue], datasetID: String, epoch: Int = 1) throws -> MergeReceipt {
        try queue.sync {
            try transaction {
                let writer = try mergeWriter(datasetID, epoch: epoch)
                return try ingestMergeLocked(operations, dataset: datasetID, epoch: epoch, writer: writer, local: false)
            }
        }
    }

    /// Operation identity, local outbox and materialized record share one
    /// commit. The expected frontier prevents authoring against unseen state.
    public func appendMergeMutation(datasetID: String, epoch: Int = 1, type: String, id: String,
                                    mutation: JSONValue, expectedFrontier: [String: Int]) throws -> JSONValue {
        try queue.sync {
            try transaction {
                let writer = try mergeWriter(datasetID, epoch: epoch)
                let frontier = try mergeFrontierLocked(datasetID)
                guard frontier == expectedFrontier else { throw StoreError.staleRevision }
                let last = frontier[writer] ?? 0
                guard last < 9_007_199_254_740_991 else { throw StoreError.invalidRecord }
                let operation: JSONValue = .object([
                    "protocolVersion": .number(2), "schemaVersion": .number(1),
                    "datasetId": .string(datasetID), "membershipEpoch": .number(Double(epoch)),
                    "deviceId": .string(writer), "sequence": .number(Double(last + 1)),
                    "dependencies": .object(frontier.mapValues { .number(Double($0)) }),
                    "recordType": .string(type), "recordId": .string(id), "mutation": mutation
                ])
                guard try RecordMerge.parse(operation, datasetID: datasetID, epoch: epoch).supported else { throw StoreError.invalidRecord }
                _ = try ingestMergeLocked([operation], dataset: datasetID, epoch: epoch, writer: writer, local: true)
                return operation
            }
        }
    }

    public func mergeFrontier(datasetID: String, epoch: Int = 1) throws -> [String: Int] {
        try queue.sync {
            _ = try mergeWriter(datasetID, epoch: epoch)
            return try mergeFrontierLocked(datasetID)
        }
    }
    public func mergedRecord(datasetID: String, type: String, id: String) throws -> JSONValue? {
        try queue.sync {
            try payloads("SELECT payload FROM merge_records WHERE dataset = ? AND type = ? AND id = ?",
                         [.text(datasetID), .text(type), .text(id)], as: JSONValue.self).first
        }
    }
    /// Retained until the future peer-receipt/checkpoint contract proves safe
    /// reclamation. Remote delivery can never add a locally authored entry.
    public func mergeOutbox(datasetID: String, after: Int = 0, limit: Int = 100) throws -> [JSONValue] {
        try validateLimit(limit)
        guard after >= 0 else { throw StoreError.invalidLimit }
        return try queue.sync {
            try payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND local = 1 AND sequence > ? ORDER BY sequence LIMIT ?",
                         [.text(datasetID), .integer(Int64(after)), .integer(Int64(limit))], as: JSONValue.self)
        }
    }

    /// Seal once, commit before returning uploadable bytes, and reuse that
    /// exact envelope after retry/restart. Cached corruption or changed keys
    /// fail closed; never silently replace an already published identity.
    /// Keys come from authenticated enrollment, not downloaded metadata.
    public func encryptedMergeOutbox(datasetID: String, epoch: Int = 1, datasetKey: Data,
                                     signingSeed: Data, after: Int = 0, limit: Int = 100) throws -> [JSONValue] {
        guard after >= 0, (1...256).contains(limit), datasetKey.count == 32, signingSeed.count == 32 else {
            throw StoreError.invalidLimit
        }
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: signingSeed).publicKey.rawRepresentation
        return try queue.sync {
            try transaction {
                let writer = try mergeWriter(datasetID, epoch: epoch)
                // Pin the first explicit encryption context for this immutable
                // dataset epoch. A later page cannot silently switch keys merely
                // because no envelope on that page has been cached yet.
                let keyDigest = Data(SHA256.hash(data: datasetKey))
                try run("INSERT OR IGNORE INTO merge_crypto VALUES (?, ?, ?)", [.text(datasetID), .data(keyDigest), .data(publicKey)])
                let matchingKeys = try statement("SELECT count(*) FROM merge_crypto WHERE dataset = ? AND key_digest = ? AND signing_public_key = ?",
                    [.text(datasetID), .data(keyDigest), .data(publicKey)]) { cursor in
                        guard try step(cursor) else { throw StoreError.corruptData }
                        return sqlite3_column_int(cursor, 0) == 1
                    }
                guard matchingKeys else { throw StoreError.staleRevision }
                var result: [JSONValue] = [], bytes = 0, plaintextBytes = 0
                var sequence = after
                // Bound decoding as well as the returned page. Loading 256
                // maximum-size notes first would exceed a phone's memory budget.
                for _ in 0..<limit {
                    guard let operation = try payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND writer = ? AND local = 1 AND sequence > ? ORDER BY sequence LIMIT 1",
                        [.text(datasetID), .text(writer), .integer(Int64(sequence))], as: JSONValue.self).first else { break }
                    let parsed = try RecordMerge.parse(operation, datasetID: datasetID, epoch: epoch)
                    sequence = parsed.sequence
                    guard parsed.writer == writer else { throw StoreError.corruptData }
                    let identity: [Binding] = [.text(datasetID), .text(writer), .integer(Int64(parsed.sequence))]
                    let cached = try payloads("SELECT payload FROM merge_envelopes WHERE dataset = ? AND writer = ? AND sequence = ?", identity, as: JSONValue.self).first
                    let envelope = try cached ?? EncryptedOperation.seal(operation, datasetKey: datasetKey, signingSeed: signingSeed)
                    let opened = try EncryptedOperation.open(envelope, datasetID: datasetID, membershipEpoch: epoch,
                        datasetKey: datasetKey, authorizedWriters: [writer: publicKey])
                    guard try RecordMerge.equivalent(opened, operation) else { throw StoreError.corruptData }
                    let data = try encoder.encode(envelope)
                    // Keep pages bounded even when individual notes are large.
                    let plaintextSize = try encoder.encode(operation).count
                    if bytes + data.count > 12_582_912 || plaintextBytes + plaintextSize > 8_388_608 { break }
                    plaintextBytes += plaintextSize
                    bytes += data.count
                    if cached == nil {
                        try run("INSERT INTO merge_envelopes VALUES (?, ?, ?, ?)", identity + [.data(data)])
                    }
                    result.append(envelope)
                }
                return result
            }
        }
    }

    /// Authenticate the entire bounded delivery before a single inbox write.
    /// The applied receipt is returned only after the merge transaction commits.
    public func ingestEncryptedMergeOperations(_ envelopes: [JSONValue], datasetID: String, epoch: Int = 1,
                                               datasetKey: Data, authorizedWriters: [String: Data]) throws -> MergeReceipt {
        let operations = try decryptMergeBatch(envelopes, datasetID: datasetID, epoch: epoch, datasetKey: datasetKey, authorizedWriters: authorizedWriters)
        return try ingestMergeOperations(operations, datasetID: datasetID, epoch: epoch)
    }

    private func decryptMergeBatch(_ envelopes: [JSONValue], datasetID: String, epoch: Int,
                                   datasetKey: Data, authorizedWriters: [String: Data]) throws -> [JSONValue] {
        guard envelopes.count <= 256 else { throw StoreError.invalidLimit }
        let encoder = JSONEncoder()
        var bytes = 0, operations: [JSONValue] = []
        for envelope in envelopes {
            let size = try encoder.encode(envelope).count
            bytes += size
            guard size <= 1_400_000, bytes <= 12_582_912 else { throw StoreError.invalidLimit }
            operations.append(try EncryptedOperation.open(envelope, datasetID: datasetID, membershipEpoch: epoch,
                datasetKey: datasetKey, authorizedWriters: authorizedWriters))
        }
        return operations
    }

    public struct MergeDeliveryState: Equatable {
        public let cursor: String
        public let uploadedSequence: Int
    }
    public func mergeDeliveryState(datasetID: String, epoch: Int = 1) throws -> MergeDeliveryState {
        try queue.sync {
            _ = try mergeWriter(datasetID, epoch: epoch)
            return try mergeDeliveryLocked(datasetID)
        }
    }
    private func mergeDeliveryLocked(_ dataset: String) throws -> MergeDeliveryState {
        try statement("SELECT cursor, uploaded FROM merge_delivery WHERE dataset = ?", [.text(dataset)]) { cursor in
            guard try step(cursor), let text = sqlite3_column_text(cursor, 0) else { throw StoreError.corruptData }
            let uploaded = sqlite3_column_int64(cursor, 1)
            guard uploaded >= 0, uploaded <= 9_007_199_254_740_991 else { throw StoreError.corruptData }
            return MergeDeliveryState(cursor: String(cString: text), uploadedSequence: Int(uploaded))
        }
    }

    /// A download cursor only advances with durable pending operations and
    /// applied state in the same transaction. It is never an applied receipt.
    public func ingestEncryptedMergePage(_ envelopes: [JSONValue], datasetID: String, epoch: Int = 1,
                                         datasetKey: Data, authorizedWriters: [String: Data],
                                         expectedCursor: String, nextCursor: String) throws -> MergeReceipt {
        guard expectedCursor.utf8.count <= 2048, nextCursor.utf8.count <= 2048,
              !expectedCursor.contains("\0"), !nextCursor.contains("\0"),
              envelopes.isEmpty || !nextCursor.utf8.elementsEqual(expectedCursor.utf8) else { throw StoreError.invalidRecord }
        let operations = try decryptMergeBatch(envelopes, datasetID: datasetID, epoch: epoch, datasetKey: datasetKey, authorizedWriters: authorizedWriters)
        return try queue.sync {
            try transaction {
                let writer = try mergeWriter(datasetID, epoch: epoch)
                guard try mergeDeliveryLocked(datasetID).cursor.utf8.elementsEqual(expectedCursor.utf8) else { throw StoreError.staleRevision }
                let receipt = try ingestMergeLocked(operations, dataset: datasetID, epoch: epoch, writer: writer, local: false)
                try run("UPDATE merge_delivery SET cursor = ? WHERE dataset = ?", [.text(nextCursor), .text(datasetID)])
                return receipt
            }
        }
    }

    /// Call only after authenticated storage acknowledges this complete page.
    /// This marker tracks cloud storage, not peer application or safe deletion.
    public func confirmMergeUpload(datasetID: String, epoch: Int = 1, expectedSequence: Int, through: Int) throws {
        guard expectedSequence >= 0, through > expectedSequence, through <= 9_007_199_254_740_991 else { throw StoreError.invalidRecord }
        try queue.sync {
            try transaction {
                let writer = try mergeWriter(datasetID, epoch: epoch)
                guard try mergeDeliveryLocked(datasetID).uploadedSequence == expectedSequence else { throw StoreError.staleRevision }
                let count = try statement("SELECT count(*) FROM merge_envelopes WHERE dataset = ? AND writer = ? AND sequence > ? AND sequence <= ?",
                    [.text(datasetID), .text(writer), .integer(Int64(expectedSequence)), .integer(Int64(through))]) { cursor in
                        guard try step(cursor) else { throw StoreError.corruptData }
                        return sqlite3_column_int64(cursor, 0)
                    }
                guard count == Int64(through - expectedSequence) else { throw StoreError.invalidRecord }
                try run("UPDATE merge_delivery SET uploaded = ? WHERE dataset = ?", [.integer(Int64(through)), .text(datasetID)])
            }
        }
    }

    private func mergeWriter(_ dataset: String, epoch: Int) throws -> String {
        try statement("SELECT writer, epoch FROM merge_datasets WHERE id = ?", [.text(dataset)]) { cursor in
            guard try step(cursor), sqlite3_column_int64(cursor, 1) == Int64(epoch),
                  let writer = sqlite3_column_text(cursor, 0) else { throw StoreError.invalidRecord }
            return String(cString: writer)
        }
    }
    private func mergeFrontierLocked(_ dataset: String) throws -> [String: Int] {
        try statement("SELECT writer, sequence FROM merge_frontiers WHERE dataset = ?", [.text(dataset)]) { cursor in
            var frontier: [String: Int] = [:]
            while try step(cursor) {
                guard let writer = sqlite3_column_text(cursor, 0) else { throw StoreError.corruptData }
                frontier[String(cString: writer)] = Int(sqlite3_column_int64(cursor, 1))
            }
            return frontier
        }
    }
    private func ingestMergeLocked(_ operations: [JSONValue], dataset: String, epoch: Int, writer: String, local: Bool) throws -> MergeReceipt {
        guard operations.count <= 256 else { throw StoreError.invalidLimit }
        var bytes = 0
        for raw in operations {
            let operation = try RecordMerge.parse(raw, datasetID: dataset, epoch: epoch)
            let data = try encoder.encode(raw)
            bytes += data.count
            guard data.count <= 1_048_576, bytes <= 8_388_608 else { throw StoreError.invalidLimit }
            let existing = try payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND writer = ? AND sequence = ?",
                                        [.text(dataset), .text(operation.writer), .integer(Int64(operation.sequence))], as: JSONValue.self).first
            if let existing {
                guard try RecordMerge.equivalent(existing, raw) else { throw RecordMerge.Failure.reusedIdentity }
                continue
            }
            // A remote peer may echo our known dots, but cannot mint a new
            // operation under this install's writer identity.
            guard local || operation.writer != writer else { throw StoreError.invalidRecord }
            try run("INSERT INTO merge_operations VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
                    [.text(dataset), .text(operation.writer), .integer(Int64(operation.sequence)),
                     .text(operation.type), .text(operation.recordID), .integer(local ? 1 : 0), .data(data)])
        }
        let pendingBytes = try statement("SELECT coalesce(sum(length(payload)), 0) FROM merge_operations WHERE dataset = ? AND applied = 0", [.text(dataset)]) { cursor in
            guard try step(cursor) else { throw StoreError.corruptData }
            return sqlite3_column_int64(cursor, 0)
        }
        guard pendingBytes <= 25_165_824 else { throw StoreError.invalidLimit }
        let pending: [JSONValue] = try payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND applied = 0 ORDER BY writer, sequence LIMIT 4353",
                                               [.text(dataset)], as: JSONValue.self)
        guard pending.count <= 4352 else { throw StoreError.invalidLimit }
        var remaining = try pending.map { try RecordMerge.parse($0, datasetID: dataset, epoch: epoch) }
        var frontier = try mergeFrontierLocked(dataset), progress = true, applied = 0
        var changed: [String: [RecordMerge.Operation]] = [:]
        func history(_ operation: RecordMerge.Operation) throws -> [RecordMerge.Operation] {
            if let cached = changed[operation.key] { return cached }
            return try payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND type = ? AND id = ? AND applied = 1 ORDER BY writer, sequence",
                [.text(dataset), .text(operation.type), .text(operation.recordID)], as: JSONValue.self)
                .map { try RecordMerge.parse($0, datasetID: dataset, epoch: epoch) }
        }
        while progress {
            progress = false
            var index = 0
            while index < remaining.count {
                let operation = remaining[index]
                guard operation.supported, (frontier[operation.writer] ?? 0) == operation.sequence - 1,
                      operation.dependencies.allSatisfy({ (frontier[$0.key] ?? 0) >= $0.value }) else { index += 1; continue }
                let previous = try history(operation)
                try RecordMerge.validateReady(operation, lookup: { author, sequence in
                    let row = try self.payloads("SELECT payload FROM merge_operations WHERE dataset = ? AND writer = ? AND sequence = ? AND applied = 1",
                        [.text(dataset), .text(author), .integer(Int64(sequence))], as: JSONValue.self).first
                    return try row.map { try RecordMerge.parse($0, datasetID: dataset, epoch: epoch) }
                }, observedDelete: { previous.contains { $0.kind == "delete" && operation.observes($0) } })
                changed[operation.key] = previous + [operation]
                try run("UPDATE merge_operations SET applied = 1 WHERE dataset = ? AND writer = ? AND sequence = ?",
                        [.text(dataset), .text(operation.writer), .integer(Int64(operation.sequence))])
                frontier[operation.writer] = operation.sequence
                try run("INSERT INTO merge_frontiers VALUES (?, ?, ?) ON CONFLICT(dataset, writer) DO UPDATE SET sequence=excluded.sequence",
                        [.text(dataset), .text(operation.writer), .integer(Int64(operation.sequence))])
                remaining.remove(at: index); applied += 1; progress = true
            }
        }
        guard remaining.count <= 4096 else { throw StoreError.invalidLimit }
        for history in changed.values {
            let first = history[0], record = try RecordMerge.materialize(history)
            try run("INSERT INTO merge_records VALUES (?, ?, ?, ?) ON CONFLICT(dataset, type, id) DO UPDATE SET payload=excluded.payload",
                    [.text(dataset), .text(first.type), .text(first.recordID), .data(try encoder.encode(record))])
        }
        return MergeReceipt(frontier: frontier, applied: applied, pending: remaining.count)
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
        // When present, before/after contain only collection metadata. Item
        // deltas retain exact records and positions, including removed rows.
        var beforeCollection: String? = nil
        var afterCollection: String? = nil
        var items: [CollectionDelta]? = nil
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
                    let key = String(cString: bytes)
                    rows[key] = try expandCollection(key, entry: decode(cursor))
                }
                return rows
            }
        }
    }

    func commitLegacy(_ key: String, entry: RemoteEntry, expected: RemoteEntry?, origin: KVStore.WriteOrigin) throws -> [String: RemoteEntry] {
        try commitLegacyBatch([key: entry], expected: expected.map { [key: $0] } ?? [:], readKeys: [key], origin: origin)
        return [:]
    }

    /// Validate the complete read set before making any changes; SQLite rolls
    /// back records, indexes and history together if any later write fails.
    func commitLegacyBatch(_ changes: [String: RemoteEntry], expected: [String: RemoteEntry], readKeys: [String], origin: KVStore.WriteOrigin = .local) throws {
        let keys = Set(readKeys)
        guard Set(changes.keys).isSubset(of: keys), Set(expected.keys).isSubset(of: keys),
              keys.allSatisfy({ !$0.isEmpty && !$0.contains("\0") }),
              changes.values.allSatisfy({ !$0.modifiedAt.isEmpty }) else { throw StoreError.invalidRecord }
        try queue.sync {
            try transaction {
                guard try metadata("legacy-fingerprint") != nil else { throw StoreError.corruptData }
                var storedRows: [String: RemoteEntry] = [:]
                for key in keys.sorted() {
                    let stored = try payloads("SELECT payload FROM kv_entries WHERE key = ?", [.text(key)], as: RemoteEntry.self).first
                    let before = try stored.map { try expandCollection(key, entry: $0) }
                    guard try sameBytes(before, expected[key]) else { throw StoreError.staleRevision }
                    storedRows[key] = stored
                }
                for key in changes.keys.sorted() {
                    let entry = changes[key]!
                    if try sameBytes(expected[key], entry) { continue }
                    let previousField = try collectionField(key)
                    let next = partitionCollection(key, entry: entry)
                    var change = KVChange(key: key, before: storedRows[key], after: next?.header ?? entry, origin: origin)
                    change.beforeCollection = previousField
                    change.afterCollection = next?.field
                    change.items = try writeCollection(key, partition: next)
                    try run("INSERT INTO kv_entries VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                            [.text(key), .data(try encoder.encode(change.after))])
                    try run("INSERT INTO kv_history (payload) VALUES (?)", [.data(try encoder.encode(change))])
                }
            }
        }
    }

    func legacyHistory() throws -> [KVChange] {
        try queue.sync {
            try payloads("SELECT payload FROM kv_history ORDER BY sequence", [], as: KVChange.self)
        }
    }
}
