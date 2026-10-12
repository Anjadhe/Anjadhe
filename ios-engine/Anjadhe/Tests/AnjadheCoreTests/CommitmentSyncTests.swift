import XCTest
import CSQLite
@testable import AnjadheCore

final class CommitmentSyncTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws { directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-commitment-sync-\(UUID().uuidString)") }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func open() throws -> TransactionalStore {
        let store = try TransactionalStore(directory: directory)
        try store.records.createMergeDataset("fixture", writer: "phone")
        return store
    }
    private func snapshot() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("fixtures/commitment-sync/snapshot.json")))
    }
    private func sql(_ query: String, file: URL) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK); defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, query, nil, nil, nil), SQLITE_OK)
    }
    func testAtomicGoalDaysAndLocalHistorySurviveLateFailureAndRestart() async throws {
        let store = try open(), writer = CommitmentSyncWriter(store: store.records, datasetID: "fixture")
        let value = try snapshot(), draft = try await writer.prepare(value)
        try sql("CREATE TRIGGER fail_commitment BEFORE INSERT ON kv_entries BEGIN SELECT RAISE(ABORT, 'fixture'); END", file: store.databaseURL)
        do { try await writer.commit(draft); XCTFail("Late failure must roll back all operations") } catch { }
        XCTAssertTrue(try store.records.mergeFrontier(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.records.mergeOutbox(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.records.mergedCommitments(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.records.legacyHistory().isEmpty)
        XCTAssertTrue(try store.snapshot().isEmpty)
        try sql("DROP TRIGGER fail_commitment", file: store.databaseURL)
        try await writer.commit(draft)
        let reopened = try open()
        XCTAssertEqual(try reopened.snapshot()["app_commitments"]?.value, value)
        XCTAssertEqual(try reopened.records.mergeFrontier(datasetID: "fixture"), ["phone": 4])
        let wire = try JSONEncoder().encode(reopened.records.mergeOutbox(datasetID: "fixture"))
        XCTAssertFalse(String(decoding: wire, as: UTF8.self).contains("LOCAL_ONLY"))
        let projection = try await CommitmentSyncWriter(store: reopened.records, datasetID: "fixture").projection()
        XCTAssertEqual(projection["issues"], .array([]))
        let run = try XCTUnwrap(projection["items"]?.arrayValue?.first { $0["id"] == .string("run") })
        XCTAssertEqual(run["history"]?["2026-10-11"], .string("done"))
        XCTAssertEqual(run["log"]?["2026-10-11"]?.arrayValue?.first?["quote"], .string("Ran 4 km in 40 minutes"))
        XCTAssertEqual(run["moved"]?["2026-10-12"]?["time"], .string("18:00"))
        do { try await writer.commit(draft); XCTFail("Replayed draft must reject") }
        catch LocalRecordStore.StoreError.staleRevision { }
    }
    func testPreparedDraftPinsLocalSnapshotAndPeerFrontier() async throws {
        let store = try open(), writer = CommitmentSyncWriter(store: store.records, datasetID: "fixture")
        let first = try await writer.prepare(snapshot()); try await writer.commit(first)
        let draft = try await writer.prepare(snapshot()), key = "app_commitments", before = try store.snapshot()[key]!
        try store.records.commitLegacyBatch([key: RemoteEntry(value: before.value, deleted: false, modifiedAt: "another save")], expected: [key: before], readKeys: [key])
        do { try await writer.commit(draft); XCTFail("Local save must invalidate draft") }
        catch LocalRecordStore.StoreError.staleRevision { }
        let next = try await writer.prepare(snapshot())
        let peer = try JSONValue.parse(#"{"protocolVersion":2,"schemaVersion":1,"datasetId":"fixture","membershipEpoch":1,"deviceId":"mac","sequence":1,"dependencies":{"phone":4},"recordType":"commitment","recordId":"run","mutation":{"kind":"edit","fields":{"title":"Run gently"}}}"#)
        _ = try store.records.ingestMergeOperations([peer], datasetID: "fixture")
        do { try await writer.commit(next); XCTFail("Peer change must invalidate draft") }
        catch LocalRecordStore.StoreError.staleRevision { }
        do { _ = try await writer.prepare(snapshot()); XCTFail("Unreconciled peer changes need review") }
        catch SharedCore.Failure.executionFailed { }
        let projection = try await writer.projection()
        XCTAssertEqual(projection["items"]?.arrayValue?.first { $0["id"] == .string("run") }?["title"], .string("Run gently"))
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 4)
        XCTAssertEqual(try store.snapshot()[key]?.value, before.value, "Receipt and projection must not install incoming records")
    }
    func testClearThenReportObservesRetainedDayIdentity() async throws {
        let store = try open(), writer = CommitmentSyncWriter(store: store.records, datasetID: "fixture")
        let value = try snapshot(), first = try await writer.prepare(value); try await writer.commit(first)
        var object = value.objectValue!, items = object["items"]!.arrayValue!, run = items[1].objectValue!
        run["history"] = .object([:])
        var log = run["log"]!.objectValue!; log.removeValue(forKey: "2026-10-11"); run["log"] = .object(log)
        items[1] = .object(run); object["items"] = .array(items)
        let cleared = try await writer.prepare(.object(object)); try await writer.commit(cleared)
        let noChange = try await writer.prepare(.object(object)); try await writer.commit(noChange)
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 5)
        let restored = try await writer.prepare(value); try await writer.commit(restored)
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 6)
        let projection = try await writer.projection()
        XCTAssertEqual(projection["issues"], .array([]))
        XCTAssertEqual(projection["days"]?.arrayValue?.first?["versions"]?.arrayValue?.count, 1)
    }
    func testUnsupportedAttachmentRemainsInLocalStoreWithoutOutbox() async throws {
        let store = try open(), key = "app_commitments"
        var value = try snapshot().objectValue!, items = value["items"]!.arrayValue!, run = items[1].objectValue!
        run["attached"] = .array([.object(["kind": .string("note"), "id": .string("n"), "title": .string("Training notes")])])
        items[1] = .object(run); value["items"] = .array(items)
        let original = RemoteEntry(value: .object(value), deleted: false, modifiedAt: "2026-10-12")
        try store.records.commitLegacyBatch([key: original], expected: [:], readKeys: [key])
        let writer = CommitmentSyncWriter(store: store.records, datasetID: "fixture")
        do { _ = try await writer.prepare(.object(value)); XCTFail("Attachments need their own migration contract") }
        catch SharedCore.Failure.executionFailed { }
        XCTAssertEqual(try store.snapshot()[key], original)
        XCTAssertTrue(try store.records.mergeOutbox(datasetID: "fixture").isEmpty)
    }
}
