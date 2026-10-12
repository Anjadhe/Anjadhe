import XCTest
import CSQLite
@testable import AnjadheCore

final class ConversationSyncTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-conversation-sync-\(UUID().uuidString)")
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func open() throws -> TransactionalStore {
        let store = try TransactionalStore(directory: directory)
        try store.records.createMergeDataset("fixture", writer: "phone")
        return store
    }
    private func snapshot(_ text: String = "Tuition deadline?") -> JSONValue {
        .object(["conversations": .array([
            .object(["id": .string("chat"), "title": .string("School"), "createdAt": .string("2026-10-12"),
                     "messages": .array([.object(["id": .string("u"), "role": .string("user"), "content": .string(text), "timestamp": .string("2026-10-12")])])])
        ])])
    }
    private func sql(_ query: String, file: URL) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK); defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, query, nil, nil, nil), SQLITE_OK)
    }
    func testLateSaveFailureRollsBackEveryOperationAndRetriesAfterReopen() async throws {
        let store = try open(), writer = ConversationSyncWriter(store: store.records, datasetID: "fixture")
        let draft = try await writer.prepare(snapshot())
        try sql("CREATE TRIGGER fail_conversation BEFORE INSERT ON kv_entries BEGIN SELECT RAISE(ABORT, 'fixture'); END", file: store.databaseURL)
        do { try await writer.commit(draft); XCTFail("Must roll back all dots") } catch { }
        XCTAssertEqual(try store.records.mergeFrontier(datasetID: "fixture"), [:])
        XCTAssertTrue(try store.records.mergeOutbox(datasetID: "fixture").isEmpty)
        XCTAssertTrue(try store.snapshot().isEmpty)
        try sql("DROP TRIGGER fail_conversation", file: store.databaseURL)
        try await writer.commit(draft)
        let reopened = try open()
        XCTAssertEqual(try reopened.records.mergeFrontier(datasetID: "fixture"), ["phone": 2])
        XCTAssertEqual(try reopened.records.mergeOutbox(datasetID: "fixture").count, 2)
        XCTAssertEqual(try reopened.snapshot()["app_agent-conversations"]?.value, snapshot())
        let projection = try await ConversationSyncWriter(store: reopened.records, datasetID: "fixture").projection()
        XCTAssertEqual(projection["conversations"]?.arrayValue?.first?["messages"]?.arrayValue?.first?["content"], .string("Tuition deadline?"))
        do { try await writer.commit(draft); XCTFail("An old draft cannot duplicate operations") }
        catch LocalRecordStore.StoreError.staleRevision { }
    }
    func testPrivateConversationsAreExcludedBeforePersistenceAndEncryption() async throws {
        let store = try open(), writer = ConversationSyncWriter(store: store.records, datasetID: "fixture")
        var value = snapshot().objectValue!
        value["conversations"] = .array(value["conversations"]!.arrayValue! + [.object([
            "private": .bool(true), "messages": .array([.object(["content": .string("PRIVATE_NEVER_SYNC")])])
        ])])
        let draft = try await writer.prepare(.object(value)); try await writer.commit(draft)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(store.snapshot()), as: UTF8.self).contains("PRIVATE_NEVER_SYNC"))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(store.records.mergeOutbox(datasetID: "fixture")), as: UTF8.self).contains("PRIVATE_NEVER_SYNC"))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(store.records.legacyHistory()), as: UTF8.self).contains("PRIVATE_NEVER_SYNC"))
    }
    func testChangedLocalSnapshotAndUnseenRemoteRevisionRejectDrafts() async throws {
        let store = try open(), writer = ConversationSyncWriter(store: store.records, datasetID: "fixture")
        let first = try await writer.prepare(snapshot()); try await writer.commit(first)
        let edited = try await writer.prepare(snapshot("A changed question"))
        let key = "app_agent-conversations", before = try store.snapshot()[key]!
        try store.records.commitLegacyBatch([key: RemoteEntry(value: before.value, deleted: false, modifiedAt: "a later save")], expected: [key: before], readKeys: [key])
        do { try await writer.commit(edited); XCTFail("Stale local snapshot must reject") }
        catch LocalRecordStore.StoreError.staleRevision { }
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 2)
        let remote = try JSONValue.parse(#"{"protocolVersion":2,"schemaVersion":1,"datasetId":"fixture","membershipEpoch":1,"deviceId":"mac","sequence":1,"dependencies":{"phone":2},"recordType":"conversation","recordId":"chat","mutation":{"kind":"edit","fields":{"title":"Remote title"}}}"#)
        _ = try store.records.ingestMergeOperations([remote], datasetID: "fixture")
        do { _ = try await writer.prepare(snapshot("A changed question")); XCTFail("Unseen remote title requires reconciliation") }
        catch SharedCore.Failure.executionFailed { }
        XCTAssertEqual(try store.records.mergeOutbox(datasetID: "fixture").count, 2)
    }
}
