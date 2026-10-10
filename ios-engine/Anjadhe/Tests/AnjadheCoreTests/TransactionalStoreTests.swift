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

    func testFreshInstallCommitsDirtyAndOriginalBaseWithItsRecord() throws {
        let (disk, kv) = try open()
        var observedDurable = false
        kv.onLocalWrite = { key, _ in
            observedDurable = (try? disk.snapshot()[key]?.value) == .string("first")
        }
        XCTAssertTrue(kv.set("app_notes", .string("first"), now: stamp))
        XCTAssertTrue(observedDurable)
        XCTAssertEqual(kv.get("anjadhe:channel:dirty")?["app_notes"], .string(stamp))
        XCTAssertEqual(kv.get("anjadhe:channel:base")?["app_notes"], .string(KVStore.epoch))
        XCTAssertTrue(kv.set("app_notes", .string("second"), now: "later"))
        let (_, reopened) = try open()
        XCTAssertEqual(reopened.get("anjadhe:channel:dirty")?["app_notes"], .string("later"))
        XCTAssertEqual(reopened.get("anjadhe:channel:base")?["app_notes"], .string(KVStore.epoch))
        XCTAssertEqual(try disk.records.legacyHistory().map(\.origin), [.local, .local])
    }

    func testHistoryFailureRollsBackDataAndDoesNotPublishOrUpload() throws {
        _ = try seed()
        let (disk, kv) = try open(), before = kv.snapshot()
        try sql("CREATE TRIGGER fail_history BEFORE INSERT ON kv_history BEGIN SELECT RAISE(ABORT, 'test'); END")
        var uploads = 0, failures = 0
        kv.onLocalWrite = { _, _ in uploads += 1 }
        kv.onLocalDelete = { _ in uploads += 1 }
        kv.onWriteFailure = { _ in failures += 1 }
        XCTAssertFalse(kv.set("app_notes", .string("must not land"), now: stamp))
        XCTAssertFalse(kv.delete("app_schedule", now: stamp))
        XCTAssertEqual(kv.snapshot(), before)
        XCTAssertEqual(try disk.snapshot(), before)
        XCTAssertTrue(try disk.records.legacyHistory().isEmpty)
        XCTAssertEqual(uploads, 0)
        XCTAssertEqual(failures, 2)
        try sql("DROP TRIGGER fail_history")
        XCTAssertTrue(kv.set("app_notes", .string("retry"), now: stamp))
        XCTAssertEqual(uploads, 1)
    }

    func testFailedRemoteApplyIsNotCountedAndSuccessfulRemoteCreatesNoUpload() throws {
        let (disk, kv) = try open()
        var uploads = 0
        kv.onLocalWrite = { _, _ in uploads += 1 }
        try sql("CREATE TRIGGER fail_remote BEFORE INSERT ON kv_history BEGIN SELECT RAISE(ABORT, 'test'); END")
        let row = RemoteEntry(value: .string("peer"), deleted: false, modifiedAt: stamp)
        XCTAssertEqual(kv.applyRemoteSet(["app_notes": row]), 0)
        XCTAssertNil(kv.get("app_notes"))
        try sql("DROP TRIGGER fail_remote")
        XCTAssertEqual(kv.applyRemoteSet(["app_notes": row]), 1)
        XCTAssertEqual(uploads, 0)
        XCTAssertNil(kv.get("anjadhe:channel:dirty"))
        XCTAssertEqual(try disk.records.legacyHistory().map(\.origin), [.remote])
    }

    func testDirtyMarkerFailureRollsBackRecordAndHistoryTogether() throws {
        let (disk, kv) = try open()
        try sql("CREATE TRIGGER fail_dirty BEFORE INSERT ON kv_entries WHEN NEW.key = 'anjadhe:channel:dirty' BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertFalse(kv.set("app_notes", .string("must not land"), now: stamp))
        XCTAssertTrue(kv.snapshot().isEmpty)
        XCTAssertTrue(try disk.snapshot().isEmpty)
        XCTAssertTrue(try disk.records.legacyHistory().isEmpty)
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

    func testDamagedSQLiteDoesNotFallbackToLegacyAndResetIsRefused() throws {
        _ = try seed()
        do {
            let (disk, kv) = try open()
            XCTAssertFalse(kv.purge(keepPrefix: "anjadhe:channel:"))
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
        XCTAssertEqual(recovered.get("anjadhe:channel:dirty")?["app_notes"], .string(stamp))
        XCTAssertEqual(recovered.get("anjadhe:channel:base")?["app_notes"], .string(stamp))
    }
    #endif
}
