import XCTest
import CSQLite
@testable import AnjadheCore
#if os(macOS)
import Darwin
#endif

final class TransactionalStoreTests: XCTestCase {
    private var directory: URL!
    private var folder: URL { directory.appendingPathComponent("Anjadhe") }
    private var legacy: URL { folder.appendingPathComponent("anjadhe-store.json") }
    private var database: URL { folder.appendingPathComponent("anjadhe.sqlite") }
    private let stamp = "2026-10-09T12:00:00.000Z"

    override func setUpWithError() throws {
        if let path = ProcessInfo.processInfo.environment["NENVA_KV_CRASH_TEST"] {
            directory = URL(fileURLWithPath: path)
        } else {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-migration-\(UUID().uuidString)")
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private func seed() throws -> [String: RemoteEntry] {
        let rows: [String: RemoteEntry] = [
            "app_notes": .init(value: .object(["notes": .array([.object(["id": .string("n"), "title": .string("Keep me")])])]), deleted: false, modifiedAt: stamp),
            "app_schedule": .init(value: .object(["scheduleItems": .array([.object(["id": .string("t")])])]), deleted: false, modifiedAt: stamp),
            "anjadhe:channel:identity": .init(value: .string("private-device-key-fixture"), deleted: false, modifiedAt: stamp),
            "anjadhe:channel:pairing": .init(value: .object(["peer": .string("peer-fixture")]), deleted: false, modifiedAt: stamp),
            "anjadhe:channel:synced-once": .init(value: .bool(true), deleted: false, modifiedAt: stamp),
            "unknown-future-key": .init(value: .null, deleted: false, modifiedAt: stamp),
            "deleted": .init(value: nil, deleted: true, modifiedAt: stamp)
        ]
        try JSONEncoder().encode(rows).write(to: legacy)
        return rows
    }
    private func open() throws -> (TransactionalStore, KVStore) {
        let disk = try TransactionalStore(directory: directory)
        let kv = KVStore()
        disk.attach(to: kv, rows: try disk.snapshot())
        return (disk, kv)
    }
    private func sql(_ query: String) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(database.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        let code = sqlite3_exec(db, query, nil, nil, nil)
        if code != SQLITE_OK { throw LocalRecordStore.StoreError.database(code) }
    }

    private func count(_ query: String) throws -> Int {
        var db: OpaquePointer?, cursor: OpaquePointer?
        XCTAssertEqual(sqlite3_open(database.path, &db), SQLITE_OK)
        defer { sqlite3_finalize(cursor); sqlite3_close(db) }
        XCTAssertEqual(sqlite3_prepare_v2(db, query, -1, &cursor, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_step(cursor), SQLITE_ROW)
        return Int(sqlite3_column_int64(cursor, 0))
    }

    @MainActor func testSharedActionCommitsReceiptAndRecordsTogetherAndRetriesWithoutRejudging() async throws {
        let (disk, kv) = try open()
        let writer = RecordWriter()
        let command = try JSONValue.parse(#"{"id":"write-1","operation":"commitment.create","args":{"fields":{"title":"Pay the school","when":{"date":"2026-10-20"}}}}"#)
        let draft = try await writer.prepare(command, in: kv)
        XCTAssertTrue(kv.snapshot().isEmpty, "A preview cannot publish writes")
        // Fail the second key, after commitments have already been written
        // inside the transaction, to verify rollback of the whole batch.
        try sql("CREATE TRIGGER fail_receipt BEFORE INSERT ON kv_entries WHEN NEW.key = 'app_record-receipts' BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try writer.commit(draft, to: kv))
        XCTAssertTrue(kv.snapshot().isEmpty)
        XCTAssertTrue(try disk.snapshot().isEmpty)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_history"), 0)
        try sql("DROP TRIGGER fail_receipt")
        try writer.commit(draft, to: kv)
        let saved = try disk.snapshot()
        XCTAssertEqual(saved["app_commitments"]?.value?["items"]?.arrayValue?.count, 1)
        XCTAssertEqual(saved["app_record-receipts"]?.value?["items"]?.arrayValue?.first, draft.receipt)
        let reopened = try open().1
        XCTAssertEqual(reopened.snapshot(), saved)
        let replay = try await writer.prepare(command, in: reopened)
        XCTAssertTrue(replay.replay)
        try writer.commit(replay, to: reopened)
        XCTAssertEqual(try disk.snapshot(), saved)
        XCTAssertThrowsError(try writer.commit(draft, to: kv), "Double approval cannot execute twice")
    }

    @MainActor func testSharedActionRejectsStaleReadOnlyDependenciesAndKeepsOtherRecords() async throws {
        let (_, kv) = try open()
        let writer = RecordWriter()
        let command = try JSONValue.parse(#"{"id":"write-2","operation":"sender.create","args":{"name":"School"}}"#)
        let draft = try await writer.prepare(command, in: kv)
        // A second opener edits a read-only dependency absent at preparation.
        let (_, other) = try open()
        XCTAssertTrue(other.set("app_matters", .object(["unknown": .string("keep")]), now: stamp))
        XCTAssertThrowsError(try writer.commit(draft, to: kv))
        XCTAssertNil(kv.get("app_senders"))
        let reopened = try open().1
        XCTAssertEqual(reopened.get("app_matters")?["unknown"], .string("keep"))
        XCTAssertNil(reopened.get("app_record-receipts"))
    }

    func testBatchCannotFallBackToPartialSingleKeyCommits() throws {
        let kv = KVStore()
        var writes = 0
        kv.commit = { _, _, _, _ in writes += 1; return [:] }
        XCTAssertThrowsError(try kv.setBatch(["a": .bool(true), "b": .bool(true)], expected: [:], readKeys: ["a", "b"], now: stamp))
        XCTAssertEqual(writes, 0)
        XCTAssertTrue(kv.snapshot().isEmpty)
    }

    func testCollectionEditWritesOneItemAndCompactRecoveryDelta() throws {
        let (disk, kv) = try open()
        var notes: [JSONValue] = (0..<200).map { i in .object([
            "id": .string("n\(i)"), "title": .string("Note \(i)"),
            "content": .string(String(repeating: "original ", count: 500)),
            "unknown": .object(["keep": .bool(true)])
        ]) }
        func blob() -> JSONValue { .object(["notes": .array(notes), "futureMetadata": .null]) }
        XCTAssertTrue(kv.set("app_notes", blob(), now: stamp))
        try sql("CREATE TABLE updated_items (id TEXT); CREATE TRIGGER count_items AFTER UPDATE ON kv_items BEGIN INSERT INTO updated_items VALUES (NEW.id); END")
        var edited = notes[93].objectValue!
        edited["content"] = .string("<p>Travel vaccination appointment</p>")
        notes[93] = .object(edited)
        XCTAssertTrue(kv.set("app_notes", blob(), now: "later"))
        XCTAssertEqual(try count("SELECT count(*) FROM updated_items"), 1)
        XCTAssertLessThan(try count("SELECT length(payload) FROM kv_history ORDER BY sequence DESC LIMIT 1"), 10_000)
        XCTAssertLessThan(try count("SELECT length(payload) FROM kv_entries WHERE key = 'app_notes'"), 200)
        XCTAssertEqual(try disk.records.legacyHistory().last?.items?.map(\.id), ["n93"])
        XCTAssertEqual(try disk.search("vaccin appoint").map { $0.value["id"] }, [.string("n93")])
        XCTAssertEqual(try open().1.get("app_notes"), blob())
        XCTAssertEqual(try disk.records.changes().count, 0, "compatibility deltas cannot become a v2 outbox")
    }

    func testNormalizedReorderAndDeletePreserveRecovery() throws {
        _ = try seed()
        let (disk, kv) = try open()
        let a: JSONValue = .object(["id": .string("a"), "title": .string("alpha")])
        let b: JSONValue = .object(["id": .string("b"), "content": .string("bravo")])
        func blob(_ items: [JSONValue]) -> JSONValue { .object(["notes": .array(items), "extra": .string("retain")]) }
        XCTAssertTrue(kv.set("app_notes", blob([a, b]), now: "one"))
        XCTAssertTrue(kv.set("app_notes", blob([b, a]), now: "two"))
        XCTAssertEqual(try open().1.get("app_notes"), blob([b, a]))
        XCTAssertEqual(try disk.records.legacyHistory().last?.origin, .local)
        XCTAssertTrue(kv.set("app_notes", blob([b]), now: "three"))
        let delta = try XCTUnwrap(disk.records.legacyHistory().last?.items?.first { $0.id == "a" })
        XCTAssertEqual(delta.before?.value, a)
        XCTAssertNil(delta.after)
        XCTAssertTrue(try disk.search("alpha").isEmpty)
        XCTAssertTrue(kv.delete("app_notes", now: "four"))
        XCTAssertTrue(try disk.search("bravo").isEmpty)
        XCTAssertEqual(try open().0.snapshot()["app_notes"]?.deleted, true)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_collection_baselines"), 2)
    }

    func testJournalFailureRollsBackRecordIndexAndDirtyMarkers() throws {
        _ = try seed()
        let (disk, kv) = try open(), before = kv.snapshot()
        try sql("CREATE TRIGGER fail_history BEFORE INSERT ON kv_history BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertFalse(kv.set("app_notes", .object(["notes": .array([.object(["id": .string("n"), "title": .string("new")])])]), now: "later"))
        XCTAssertEqual(kv.snapshot(), before)
        XCTAssertEqual(try disk.snapshot(), before)
        XCTAssertTrue(try disk.records.legacyHistory().isEmpty)
        XCTAssertEqual(try disk.search("Keep").count, 1)
    }

    func testMalformedCollectionStaysExactThenCanBecomeNormalized() throws {
        let (disk, kv) = try open()
        let duplicate: JSONValue = .object(["id": .string("same"), "content": .string("keep")])
        let blob: JSONValue = .object(["notes": .array([duplicate, duplicate, .null]), "future": .bool(true)])
        XCTAssertTrue(kv.set("app_notes", blob, now: stamp))
        XCTAssertEqual(try open().1.get("app_notes"), blob)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_collections"), 0)
        XCTAssertTrue(kv.set("app_notes", .object(["notes": .array([duplicate])]), now: "later"))
        XCTAssertEqual(try count("SELECT count(*) FROM kv_items"), 1)
        XCTAssertEqual(try disk.records.legacyHistory().last?.before?.value, blob)
        XCTAssertTrue(kv.set("app_notes", .null, now: "third"))
        XCTAssertEqual(try count("SELECT count(*) FROM kv_items"), 0)
        XCTAssertEqual(try open().1.get("app_notes"), .null)
    }

    func testNormalizedStaleWriteWithIdenticalTimestampsIsRejected() throws {
        _ = try seed()
        let (_, first) = try open(), (_, stale) = try open()
        let updated: JSONValue = .object(["notes": .array([.object(["id": .string("n"), "content": .string("changed")])])])
        XCTAssertTrue(first.set("app_notes", updated, now: stamp))
        XCTAssertFalse(stale.set("app_notes", .object(["notes": .array([])]), now: stamp))
        XCTAssertEqual(try open().1.get("app_notes"), updated)
    }

    func testCollectionUpgradeFailureKeepsBaselineAndRetries() throws {
        let rows = try seed()
        // Stop between JSON import and collection normalization.
        let records = try LocalRecordStore(databaseURL: database)
        try records.importLegacy(rows, fingerprint: "test")
        try sql("CREATE TRIGGER fail_split BEFORE INSERT ON kv_items WHEN NEW.key = 'app_schedule' BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try records.normalizeLegacyCollections())
        XCTAssertEqual(try records.legacySnapshot(), rows)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_collection_baselines"), 0)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_items"), 0)
        try sql("DROP TRIGGER fail_split")
        try records.normalizeLegacyCollections()
        XCTAssertEqual(try records.legacySnapshot(), rows)
        XCTAssertEqual(try count("SELECT count(*) FROM kv_collection_baselines"), 2)
        XCTAssertEqual(try records.searchCollections("Keep").count, 1)
        XCTAssertTrue(try records.legacyHistory().isEmpty)
    }

    func testVersionTwoCollectionUpgradePreservesExactPayloadAndHistory() throws {
        let rows = try seed()
        let records = try LocalRecordStore(databaseURL: database)
        try records.importLegacy(rows, fingerprint: "test")
        try sql("DROP TABLE kv_collections; DROP TABLE kv_items; DROP TABLE kv_collection_baselines; DROP TABLE kv_search; DROP TABLE merge_datasets; DROP TABLE merge_operations; DROP TABLE merge_frontiers; DROP TABLE merge_records; DROP TABLE merge_envelopes; DROP TABLE merge_crypto; DROP TABLE merge_delivery; PRAGMA user_version = 2")
        let upgraded = try LocalRecordStore(databaseURL: database)
        try upgraded.normalizeLegacyCollections()
        XCTAssertEqual(try upgraded.legacySnapshot(), rows)
        XCTAssertTrue(try upgraded.legacyHistory().isEmpty)
        XCTAssertEqual(try count("PRAGMA user_version"), 5)
    }

    func testMissingOrCorruptNormalizedRecordDoesNotSilentlyDisappear() throws {
        _ = try seed()
        let (disk, _) = try open()
        try sql("DELETE FROM kv_items WHERE key = 'app_notes'")
        XCTAssertThrowsError(try disk.snapshot())
        XCTAssertThrowsError(try open())
    }

    func testMigrationPreservesEveryKeyOriginalAndBackupAndDoesNotRepeat() throws {
        let rows = try seed(), bytes = try Data(contentsOf: legacy)
        let (disk, kv) = try open()
        XCTAssertEqual(kv.snapshot(), rows)
        XCTAssertEqual(try Data(contentsOf: disk.backupURL), bytes)
        XCTAssertTrue(try disk.records.legacyHistory().isEmpty)
        XCTAssertTrue(kv.set("app_notes", .string("new phone edit"), now: stamp))
        let (_, reopened) = try open()
        XCTAssertEqual(reopened.get("app_notes"), .string("new phone edit"))
        XCTAssertEqual(try Data(contentsOf: legacy), bytes)
        XCTAssertEqual(try Data(contentsOf: disk.backupURL), bytes)
    }

    func testFreshInstallCommitsRecordAndHistory() throws {
        let (disk, kv) = try open()
        XCTAssertTrue(kv.set("app_notes", .string("first"), now: stamp))
        XCTAssertEqual(try disk.snapshot()["app_notes"]?.value, .string("first"))
        XCTAssertNil(kv.get("anjadhe:channel:dirty"))
        XCTAssertNil(kv.get("anjadhe:channel:base"))
        XCTAssertTrue(kv.set("app_notes", .string("second"), now: "later"))
        let (_, reopened) = try open()
        XCTAssertEqual(try disk.records.legacyHistory().map(\.origin), [.local, .local])
    }

    func testHistoryFailureRollsBackDataAndDoesNotPublishOrUpload() throws {
        _ = try seed()
        let (disk, kv) = try open(), before = kv.snapshot()
        try sql("CREATE TRIGGER fail_history BEFORE INSERT ON kv_history BEGIN SELECT RAISE(ABORT, 'test'); END")
        var failures = 0
        kv.onWriteFailure = { _ in failures += 1 }
        XCTAssertFalse(kv.set("app_notes", .string("must not land"), now: stamp))
        XCTAssertFalse(kv.delete("app_schedule", now: stamp))
        XCTAssertEqual(kv.snapshot(), before)
        XCTAssertEqual(try disk.snapshot(), before)
        XCTAssertTrue(try disk.records.legacyHistory().isEmpty)
        XCTAssertEqual(failures, 2)
        try sql("DROP TRIGGER fail_history")
        XCTAssertTrue(kv.set("app_notes", .string("retry"), now: stamp))
    }

    func testFailedImportRollsBackAllRowsAndCanRetry() throws {
        let rows = try seed()
        _ = try LocalRecordStore(databaseURL: database)
        try sql("CREATE TRIGGER fail_import BEFORE INSERT ON kv_entries WHEN NEW.key = 'deleted' BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try TransactionalStore(directory: directory))
        let core = try LocalRecordStore(databaseURL: database)
        XCTAssertNil(try core.legacyFingerprint())
        XCTAssertTrue(try core.legacySnapshot().isEmpty)
        try sql("DROP TRIGGER fail_import")
        XCTAssertEqual(try TransactionalStore(directory: directory).snapshot(), rows)
    }

    func testCorruptLegacyNeverBecomesEmptyOrOverwritten() throws {
        let bytes = Data("truncated JSON".utf8)
        try bytes.write(to: legacy)
        XCTAssertThrowsError(try TransactionalStore(directory: directory))
        XCTAssertEqual(try Data(contentsOf: legacy), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("anjadhe-store.pre-sqlite.json").path))
    }

    func testLegacyWriterAfterCutoverIsDetectedAndBothCopiesStay() throws {
        _ = try seed()
        let (disk, kv) = try open()
        XCTAssertTrue(kv.set("app_notes", .string("sqlite edit"), now: stamp))
        let changed = Data("old-version-edit".utf8)
        try changed.write(to: legacy)
        XCTAssertThrowsError(try TransactionalStore(directory: directory))
        XCTAssertEqual(try Data(contentsOf: legacy), changed)
        XCTAssertEqual(try disk.snapshot()["app_notes"]?.value, .string("sqlite edit"))
    }

    func testDamagedSQLiteDoesNotFallbackToLegacy() throws {
        _ = try seed()
        do {
            let (disk, kv) = try open()
            XCTAssertEqual(kv.snapshot(), try disk.snapshot())
            try sql("UPDATE kv_entries SET payload = X'FF' WHERE key = 'app_notes'")
        }
        let disk = try TransactionalStore(directory: directory)
        XCTAssertThrowsError(try disk.snapshot())
    }

    func testTwoOpenersCannotSilentlyReplaceUnseenChanges() throws {
        _ = try seed()
        let (_, first) = try open(), (_, second) = try open()
        XCTAssertTrue(first.set("app_notes", .string("first"), now: stamp))
        XCTAssertFalse(second.set("app_notes", .string("stale"), now: stamp))
        XCTAssertEqual(try open().1.get("app_notes"), .string("first"))
    }

    #if os(macOS)
    func testRuntimeWriteSurvivesExitBeforeAnySyncCallback() throws {
        let childKey = "NENVA_KV_CRASH_TEST"
        if ProcessInfo.processInfo.environment[childKey] != nil {
            let (disk, kv) = try open()
            guard kv.set("app_notes", .string("saved before death"), now: stamp),
                  kv.delete("app_schedule", now: stamp) else { _exit(2) }
            withExtendedLifetime((disk, kv)) { _exit(0) }
        }
        _ = try seed()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["-XCTest", "AnjadheCoreTests.TransactionalStoreTests/testRuntimeWriteSurvivesExitBeforeAnySyncCallback", Bundle(for: Self.self).bundlePath]
        var environment = ProcessInfo.processInfo.environment
        environment[childKey] = directory.path
        child.environment = environment
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run(); child.waitUntilExit()
        XCTAssertEqual(child.terminationStatus, 0)
        let (_, recovered) = try open()
        XCTAssertEqual(recovered.get("app_notes"), .string("saved before death"))
        XCTAssertTrue(recovered.exportValues(["app_schedule"])["app_schedule"]?.deleted == true)
    }
    #endif
}
