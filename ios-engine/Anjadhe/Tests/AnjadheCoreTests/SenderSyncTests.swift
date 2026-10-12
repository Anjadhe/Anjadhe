import XCTest
import CSQLite
@testable import AnjadheCore

final class SenderSyncTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-sender-sync-\(UUID().uuidString)")
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func open() throws -> TransactionalStore {
        let store = try TransactionalStore(directory: directory)
        try store.records.createMergeDataset("fixture", writer: "phone")
        return store
    }
    private func snapshot() throws -> JSONValue {
        try JSONValue.parse(#"{"senders":{"dental":{"id":"dental","name":"Your dental","allGood":"Healthy teeth.","state":"active","confirmed":true,"by":"you","createdAt":"2026-10-12","updatedAt":"2026-10-12"}},"place":{"task:visit":{"sender":"dental","by":"you","at":"2026-10-12"}},"tries":{"local":"LOCAL_ONLY"}}"#)
    }
    private func sql(_ query: String, file: URL) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK); defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, query, nil, nil, nil), SQLITE_OK)
    }
    func testLateSaveFailureRollsBackSenderAndPlacementThenRetries() async throws {
        let store = try open(), writer = SenderSyncWriter(store: store.records, datasetID: "fixture")
        let value = try snapshot(), draft = try await writer.prepare(value)
        try sql("CREATE TRIGGER fail_sender BEFORE INSERT ON kv_entries BEGIN SELECT RAISE(ABORT, 'fixture'); END", file: store.databaseURL)
        do { try await writer.commit(draft); XCTFail("Must roll back the entire snapshot") } catch { }
        XCTAssertEqual(try store.records.mergeFrontier(datasetID: "fixture"), [:])
        XCTAssertTrue(try store.records.mergeOutbox(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.records.mergedSenders(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.snapshot().isEmpty)
        XCTAssertTrue(try store.records.legacyHistory().isEmpty)
        try sql("DROP TRIGGER fail_sender", file: store.databaseURL)
        try await writer.commit(draft)
        let reopened = try open()
        XCTAssertEqual(try reopened.records.mergeFrontier(datasetID: "fixture"), ["phone": 2])
        XCTAssertEqual(try reopened.snapshot()["app_senders"]?.value, value)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(reopened.records.mergeOutbox(datasetID: "fixture")), as: UTF8.self).contains("LOCAL_ONLY"))
        let projection = try await SenderSyncWriter(store: reopened.records, datasetID: "fixture").projection()
        XCTAssertEqual(projection["place"]?["task:visit"]?["sender"], .string("dental"))
        do { try await writer.commit(draft); XCTFail("Replayed draft must reject") }
        catch LocalRecordStore.StoreError.staleRevision { }
    }
    func testStaleSnapshotsAndConcurrentMovesRemainReviewable() async throws {
        let store = try open(), writer = SenderSyncWriter(store: store.records, datasetID: "fixture")
        let first = try await writer.prepare(snapshot()); try await writer.commit(first)
        let draft = try await writer.prepare(snapshot())
        let key = "app_senders", before = try store.snapshot()[key]!
        try store.records.commitLegacyBatch([key: RemoteEntry(value: before.value, deleted: false, modifiedAt: "another save")], expected: [key: before], readKeys: [key])
        do { try await writer.commit(draft); XCTFail("Local changes invalidate a draft") }
        catch LocalRecordStore.StoreError.staleRevision { }
        let next = try await writer.prepare(snapshot())
        let move = try JSONValue.parse(#"{"protocolVersion":2,"schemaVersion":1,"datasetId":"fixture","membershipEpoch":1,"deviceId":"mac","sequence":1,"dependencies":{"phone":2},"recordType":"sender-placement","recordId":"task:visit","mutation":{"kind":"edit","fields":{"placement":{"sender":"missing-thread","by":"you","at":"2026-10-13"}}}}"#)
        let clear = try JSONValue.parse(#"{"protocolVersion":2,"schemaVersion":1,"datasetId":"fixture","membershipEpoch":1,"deviceId":"other","sequence":1,"dependencies":{"phone":2},"recordType":"sender-placement","recordId":"task:visit","mutation":{"kind":"edit","fields":{"placement":null}}}"#)
        _ = try store.records.ingestMergeOperations([move, clear], datasetID: "fixture")
        do { try await writer.commit(next); XCTFail("Peer operations invalidate a draft") }
        catch LocalRecordStore.StoreError.staleRevision { }
        do { _ = try await writer.prepare(snapshot()); XCTFail("Unseen placement requires review") }
        catch SharedCore.Failure.executionFailed { }
        let projection = try await writer.projection()
        XCTAssertNil(projection["place"]?["task:visit"])
        let placement = try XCTUnwrap(projection["placements"]?.arrayValue?.first)
        XCTAssertEqual(placement["versions"]?.arrayValue?.count, 2)
        XCTAssertEqual(placement["needsReview"], .bool(true))
        XCTAssertEqual(placement["missingTargets"], .array([.string("missing-thread")]))
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 2, "Remote data must not author local operations")
        XCTAssertEqual(try store.snapshot()[key]?.value, before.value, "Projection must not install records or execute work")
    }
    func testUnsupportedThreadHistoryRemainsInLocalStore() async throws {
        let store = try open(), key = "app_senders"
        var value = try snapshot().objectValue!
        value["aliases"] = .object(["old": .string("dental")])
        let original = RemoteEntry(value: .object(value), deleted: false, modifiedAt: "2026-10-12")
        try store.records.commitLegacyBatch([key: original], expected: [:], readKeys: [key])
        let writer = SenderSyncWriter(store: store.records, datasetID: "fixture")
        do { _ = try await writer.prepare(.object(value)); XCTFail("Folds require an explicit migration") }
        catch SharedCore.Failure.executionFailed { }
        XCTAssertEqual(try store.snapshot()[key], original)
        XCTAssertTrue(try store.records.mergeOutbox(datasetID: "fixture").isEmpty)
    }
}
