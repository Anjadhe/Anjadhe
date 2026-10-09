import XCTest
import CSQLite
@testable import AnjadheCore
#if os(macOS)
import Darwin
#endif

final class LocalRecordStoreTests: XCTestCase {
    private var directory: URL!
    private var url: URL { directory.appendingPathComponent("records.sqlite") }

    override func setUpWithError() throws {
        if let path = ProcessInfo.processInfo.environment["NENVA_RECORD_STORE_CRASH_TEST"] {
            directory = URL(fileURLWithPath: path).deletingLastPathComponent()
            return
        }
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-records-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private func sql(_ text: String) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        let code = sqlite3_exec(db, text, nil, nil, nil)
        guard code == SQLITE_OK else { throw LocalRecordStore.StoreError.database(code) }
    }

    func testTaskAndNoteSurviveReopenWithoutLifecycleFlush() throws {
        let store = try LocalRecordStore(databaseURL: url)
        let task = try store.save(type: "task", id: "t1", value: .object(["title": .string("Book dentist")]),
                                  searchText: "Book dentist", expectedRevision: nil)
        let note = try store.save(type: "note", id: "n1", value: .object(["body": .string("Questions for dentist")]),
                                  searchText: "Questions for dentist", expectedRevision: nil)
        // A separate connection sees committed data while the first store is
        // still alive. No lifecycle callback, debounce wait or explicit flush.
        let reopened = try LocalRecordStore(databaseURL: url)
        XCTAssertEqual(try reopened.record(type: "task", id: "t1"), task)
        XCTAssertEqual(try reopened.record(type: "note", id: "n1"), note)
        let changes = try reopened.changes()
        XCTAssertEqual(changes.map(\.record), [task, note])
        XCTAssertEqual(Set(changes.map(\.id)).count, 2)
        XCTAssertEqual(changes.first?.writerID, changes.last?.writerID)
        XCTAssertEqual(try reopened.search("dentist").count, 2)
    }

    #if os(macOS)
    func testCommittedDataSurvivesAbruptProcessExit() throws {
        let childKey = "NENVA_RECORD_STORE_CRASH_TEST"
        if let path = ProcessInfo.processInfo.environment[childKey] {
            let store = try LocalRecordStore(databaseURL: URL(fileURLWithPath: path))
            try store.save(type: "task", id: "t", value: .string("Dentist"),
                           searchText: "Dentist", expectedRevision: nil)
            try store.save(type: "note", id: "n", value: .string("Dentist questions"),
                           searchText: "Dentist questions", expectedRevision: nil)
            // Exit while the connection is alive: no destructors, SQLite
            // close/checkpoint, lifecycle flush, or XCTest teardown.
            withExtendedLifetime(store) { _exit(0) }
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["-XCTest", "AnjadheCoreTests.LocalRecordStoreTests/testCommittedDataSurvivesAbruptProcessExit",
                           Bundle(for: Self.self).bundlePath]
        var environment = ProcessInfo.processInfo.environment
        environment[childKey] = url.path
        child.environment = environment
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        child.waitUntilExit()
        XCTAssertEqual(child.terminationStatus, 0)
        let recovered = try LocalRecordStore(databaseURL: url)
        XCTAssertEqual(try recovered.record(type: "task", id: "t")?.value, .string("Dentist"))
        XCTAssertEqual(try recovered.record(type: "note", id: "n")?.value, .string("Dentist questions"))
        XCTAssertEqual(try recovered.changes().map(\.sequence), [1, 2])
        XCTAssertEqual(try recovered.search("Dentist").count, 2)
    }
    #endif

    func testUpdateRetainsBeforeImageAndWriterAcrossRestart() throws {
        var store: LocalRecordStore? = try LocalRecordStore(databaseURL: url)
        let original = try store!.save(type: "note", id: "n", value: .string("old"), searchText: "old",
                                      expectedRevision: nil, modifiedAt: "2030-01-01T00:00:00.000Z")
        let firstChange = try XCTUnwrap(store!.changes().first)
        store = nil
        let reopened = try LocalRecordStore(databaseURL: url)
        let edited = try reopened.save(type: "note", id: "n", value: .string("new"), searchText: "new",
                                      expectedRevision: original.revision, modifiedAt: "2020-01-01T00:00:00.000Z")
        let changes = try reopened.changes(after: firstChange.sequence)
        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(changes.first?.before, original)
        XCTAssertEqual(changes.first?.record, edited)
        XCTAssertEqual(changes.first?.writerID, firstChange.writerID)
        XCTAssertGreaterThan(edited.revision, original.revision, "wall-clock skew cannot rewind local revisions")
        XCTAssertTrue(try reopened.search("old").isEmpty)
        XCTAssertEqual(try reopened.search("new").map(\.id), ["n"])
    }

    func testLateOutboxFailureRollsBackRecordSearchAndSequence() throws {
        let store = try LocalRecordStore(databaseURL: url)
        let original = try store.save(type: "note", id: "n", value: .string("original"),
                                      searchText: "original", expectedRevision: nil)
        // Fail AFTER records and local_changes have both been written, before
        // commit. This represents an I/O/quota failure in a later transaction step.
        try sql("""
            CREATE TRIGGER reject_sequence BEFORE UPDATE ON metadata
            WHEN NEW.key = 'sequence'
            BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
            """)
        XCTAssertThrowsError(try store.save(type: "note", id: "n", value: .string("lost"),
                                           searchText: "lost", expectedRevision: original.revision))
        XCTAssertEqual(try store.record(type: "note", id: "n"), original)
        XCTAssertEqual(try store.changes().count, 1)
        XCTAssertTrue(try store.search("lost").isEmpty)
        XCTAssertEqual(try store.search("original").count, 1)
        try sql("DROP TRIGGER reject_sequence")
        let next = try store.save(type: "note", id: "n", value: .string("saved"),
                                  searchText: "saved", expectedRevision: original.revision)
        XCTAssertEqual(next.revision, original.revision + 1)
    }

    func testStaleEditorCannotReplaceAnotherConnectionsEdit() throws {
        let first = try LocalRecordStore(databaseURL: url)
        let original = try first.save(type: "task", id: "t", value: .string("initial"),
                                      searchText: "initial", expectedRevision: nil)
        let second = try LocalRecordStore(databaseURL: url)
        let changed = try second.save(type: "task", id: "t", value: .string("new"),
                                     searchText: "new", expectedRevision: original.revision)
        XCTAssertThrowsError(try first.save(type: "task", id: "t", value: .string("stale"),
                                           searchText: "stale", expectedRevision: original.revision)) {
            XCTAssertEqual($0 as? LocalRecordStore.StoreError, .staleRevision)
        }
        XCTAssertEqual(try first.record(type: "task", id: "t"), changed)
        XCTAssertEqual(try first.changes().count, 2)
    }

    func testDeletionSurvivesReopenAndRequiresExplicitRestore() throws {
        let store = try LocalRecordStore(databaseURL: url)
        let original = try store.save(type: "note", id: "n", value: .null,
                                      searchText: "searchable", expectedRevision: nil)
        XCTAssertFalse(original.deleted, "JSON null is a live value, not a tombstone")
        let tombstone = try store.delete(type: "note", id: "n", expectedRevision: original.revision)
        let reopened = try LocalRecordStore(databaseURL: url)
        XCTAssertEqual(try reopened.record(type: "note", id: "n"), tombstone)
        XCTAssertTrue(try reopened.records(type: "note").isEmpty)
        XCTAssertTrue(try reopened.search("searchable").isEmpty)
        XCTAssertEqual(try reopened.changes().last?.before, original)
        XCTAssertThrowsError(try reopened.save(type: "note", id: "n", value: .string("stale"),
                                              searchText: "stale", expectedRevision: nil))
        let restored = try reopened.save(type: "note", id: "n", value: .string("restored"),
                                         searchText: "restored", expectedRevision: tombstone.revision)
        XCTAssertFalse(restored.deleted)
        XCTAssertEqual(try reopened.changes().count, 3)
    }

    func testUnchangedSaveAndIndexRebuildDoNotCreateWork() throws {
        let store = try LocalRecordStore(databaseURL: url)
        let original = try store.save(type: "note", id: "n", value: .string("தமிழ் café"),
                                      searchText: "தமிழ் café", expectedRevision: nil)
        let same = try store.save(type: "note", id: "n", value: original.value!,
                                  searchText: original.searchText, expectedRevision: original.revision)
        XCTAssertEqual(same, original)
        try store.rebuildSearch()
        XCTAssertEqual(try store.changes().count, 1)
        XCTAssertEqual(try store.search("தமிழ்").map(\.id), ["n"])
        XCTAssertEqual(try store.search("cafe").map(\.id), ["n"])
    }

    func testScopedSearchTreatsInputAsTextAndPagesAreBounded() throws {
        let store = try LocalRecordStore(databaseURL: url)
        for id in ["a", "b", "c"] {
            try store.save(type: "note", id: id, value: .string("Dentist"), searchText: "Dentist", expectedRevision: nil)
        }
        try store.save(type: "task", id: "a", value: .string("Dentist"), searchText: "Dentist", expectedRevision: nil)
        XCTAssertEqual(try store.search("dentist", type: "note", limit: 2).count, 2)
        XCTAssertEqual(try store.records(type: "note", afterID: "a", limit: 1).map(\.id), ["b"])
        XCTAssertEqual(try store.changes(after: 2, limit: 1).map(\.sequence), [3])
        XCTAssertTrue(try store.search("dentist OR missing").isEmpty)
        XCTAssertNoThrow(try store.search("\" OR * : ()"))
        XCTAssertThrowsError(try store.records(type: "note", limit: -1))
        XCTAssertThrowsError(try store.changes(limit: 501))
        XCTAssertThrowsError(try store.search("dentist", limit: 0))
    }

    func testCorruptFileAndFutureSchemaNeverBecomeAnEmptyStore() throws {
        let bytes = Data("this is not a database".utf8)
        try bytes.write(to: url)
        XCTAssertThrowsError(try LocalRecordStore(databaseURL: url))
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        try FileManager.default.removeItem(at: url)
        var store: LocalRecordStore? = try LocalRecordStore(databaseURL: url)
        try store!.save(type: "note", id: "n", value: .string("keep"), searchText: "keep", expectedRevision: nil)
        store = nil
        try sql("PRAGMA user_version = 99")
        XCTAssertThrowsError(try LocalRecordStore(databaseURL: url)) {
            XCTAssertEqual($0 as? LocalRecordStore.StoreError, .unsupportedSchema(99))
        }
        try sql("PRAGMA user_version = 2")
        XCTAssertEqual(try LocalRecordStore(databaseURL: url).record(type: "note", id: "n")?.value, .string("keep"))
    }

    func testUnreadableRecordThrowsInsteadOfDisappearing() throws {
        let store = try LocalRecordStore(databaseURL: url)
        try store.save(type: "note", id: "n", value: .string("keep"), searchText: "keep", expectedRevision: nil)
        try sql("UPDATE records SET payload = X'FF' WHERE id = 'n'")
        XCTAssertThrowsError(try store.record(type: "note", id: "n")) {
            XCTAssertEqual($0 as? LocalRecordStore.StoreError, .corruptData)
        }
        XCTAssertThrowsError(try store.records(type: "note"))
        XCTAssertThrowsError(try store.rebuildSearch())
        XCTAssertEqual(try store.changes().count, 1)
    }

    func testVersionOneUpgradeKeepsRecordAndJournal() throws {
        var store: LocalRecordStore? = try LocalRecordStore(databaseURL: url)
        let record = try store!.save(type: "note", id: "n", value: .string("keep"), searchText: "keep", expectedRevision: nil)
        store = nil
        try sql("DROP TABLE kv_entries; DROP TABLE kv_history; PRAGMA user_version = 1")
        let upgraded = try LocalRecordStore(databaseURL: url)
        XCTAssertEqual(try upgraded.record(type: "note", id: "n"), record)
        XCTAssertEqual(try upgraded.changes().map(\.record), [record])
        XCTAssertTrue(try upgraded.legacySnapshot().isEmpty)
    }
}
