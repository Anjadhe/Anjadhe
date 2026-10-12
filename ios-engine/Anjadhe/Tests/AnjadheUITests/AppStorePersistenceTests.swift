import XCTest
import Combine
import AnjadheCore
@testable import AnjadheUI

final class AppStorePersistenceTests: XCTestCase {
    @MainActor func testActionReviewSaveFailureRetryAndDoubleTap() async throws {
        let store = AppStore()
        let model = RecordActionModel()
        await model.review(operation: "commitment.create", args: ["fields": .object(["title": .string("Pay tuition")])], store: store)
        let receipt = try XCTUnwrap(model.draft?.receipt)
        XCTAssertEqual(store.revision, 0)
        XCTAssertTrue(store.kv.snapshot().isEmpty)
        store.kv.commitBatch = { _, _, _ in throw TransactionalStore.Failure.notReady }
        XCTAssertFalse(model.approve(store: store))
        XCTAssertFalse(model.saved)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(store.revision, 0)
        XCTAssertEqual(model.draft?.receipt, receipt)
        store.kv.commitBatch = nil
        XCTAssertTrue(model.approve(store: store))
        XCTAssertEqual(store.revision, 1)
        XCTAssertEqual(store.items("record-receipts", "items"), [receipt])
        XCTAssertFalse(model.approve(store: store))
        XCTAssertEqual(store.items("commitments", "items").count, 1)
    }

    @MainActor func testChangedRecordsRequireFreshReviewAndCancelWritesNothing() async throws {
        let store = AppStore()
        let model = RecordActionModel()
        await model.review(operation: "sender.create", args: ["name": .string("School")], store: store)
        XCTAssertNotNil(model.draft)
        XCTAssertTrue(store.saveBlob("senders", ["senders": .object([:]), "otherField": .string("Keep")]))
        XCTAssertFalse(model.approve(store: store))
        XCTAssertTrue(model.stale)
        XCTAssertFalse(model.approve(store: store))
        model.edit()
        XCTAssertNil(model.draft)
        XCTAssertTrue(store.items("record-receipts", "items").isEmpty)
        await model.review(operation: "sender.create", args: ["name": .string("School")], store: store)
        XCTAssertTrue(model.approve(store: store))
        XCTAssertEqual(store.blob("senders")["otherField"], .string("Keep"))
    }

    @MainActor
    func testRuntimeTaskAndNotePersistAndEarlyWriteCannotReplaceExistingData() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-ui-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = try TransactionalStore(directory: directory)
        let seed = KVStore()
        disk.attach(to: seed, rows: try disk.snapshot())
        XCTAssertTrue(seed.set("app_notes", .object(["notes": .array([.object(["id": .string("existing")])])]), now: KVStore.nowISO()))
        let store = AppStore.persistent(directory: directory)
        XCTAssertEqual(store.addItem("notes", "notes", ["title": .string("too early")]), "")
        XCTAssertTrue(store.kv.snapshot().isEmpty)
        let ready = expectation(description: "loaded")
        store.whenHydrated { ready.fulfill() }
        await fulfillment(of: [ready], timeout: 5)
        XCTAssertNil(store.loadError)
        let note = store.addItem("notes", "notes", ["title": .string("New note")])
        let task = store.addItem("schedule", "scheduleItems", ["title": .string("New task")])
        XCTAssertFalse(note.isEmpty)
        XCTAssertFalse(task.isEmpty)
        XCTAssertTrue(store.patchItem("notes", "notes", id: note, ["content": .string("offline body")]))
        // No lifecycle flush or sync is needed to see the committed edits.
        let recovered = try TransactionalStore(directory: directory).snapshot()
        XCTAssertEqual(recovered["app_notes"]?.value?["notes"]?.arrayValue?.count, 2)
        XCTAssertEqual(recovered["app_notes"]?.value?["notes"]?.arrayValue?.first?["content"], .string("offline body"))
        XCTAssertEqual(recovered["app_schedule"]?.value?["scheduleItems"]?.arrayValue?.first?["id"], .string(task))
        let matches = try await store.searchLocal("offl bod")
        XCTAssertEqual(matches.map { $0.value["id"] }, [.string(note)])
        for query in ["\"", "*", "OR", "title:New", "(", "\n"] {
            _ = try await store.searchLocal(query)
        }
        XCTAssertTrue(store.deleteItem("notes", "notes", id: note))
        let deletedMatches = try await store.searchLocal("offl bod")
        XCTAssertTrue(deletedMatches.isEmpty)
        XCTAssertEqual(try TransactionalStore(directory: directory).snapshot()["app_notes"]?.value?["notes"]?.arrayValue?.count, 1)
    }

    @MainActor
    func testFailedLoadDoesNotHydrateOrWriteAndRetryKeepsWaiters() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-ui-corrupt-\(UUID().uuidString)")
        let folder = directory.appendingPathComponent("Anjadhe")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = folder.appendingPathComponent("anjadhe-store.json")
        let damaged = Data("broken".utf8)
        try damaged.write(to: file)
        let store = AppStore.persistent(directory: directory)
        let failed = expectation(description: "load failure")
        let subscription = store.$loadError.compactMap { $0 }.first().sink { _ in failed.fulfill() }
        let ready = expectation(description: "recovered")
        store.whenHydrated { ready.fulfill() }
        await fulfillment(of: [failed], timeout: 5)
        XCTAssertFalse(store.hydrated)
        XCTAssertFalse(store.saveBlob("notes", ["notes": .array([])]))
        XCTAssertEqual(try Data(contentsOf: file), damaged)
        try Data("{}".utf8).write(to: file)
        store.retryLoading()
        await fulfillment(of: [ready], timeout: 5)
        XCTAssertTrue(store.hydrated)
        XCTAssertNil(store.loadError)
        withExtendedLifetime(subscription) {}
    }

    func testFailedDraftKeepsAllFieldsAndDoesNotPublishSuccess() {
        let store = AppStore()
        let id = store.addItem("notes", "notes", ["title": .string("old"), "content": .string("old body")])
        let revision = store.revision
        store.kv.commit = { _, _, _, _ in throw LocalRecordStore.StoreError.database(13) }
        let draft = LocalEditDraft()
        draft.stage("title", .string("new title"))
        XCTAssertFalse(draft.save { store.patchItem("notes", "notes", id: id, $0) })
        XCTAssertTrue(draft.failed)
        XCTAssertFalse(draft.hasSaved)
        XCTAssertEqual(store.revision, revision)
        XCTAssertEqual(store.findItem("notes", "notes", id: id)?["title"], .string("old"))
        XCTAssertNotNil(store.saveError)
        draft.stage("content", .string("new body"))
        XCTAssertFalse(store.deleteItem("notes", "notes", id: id))
        store.kv.commit = nil
        XCTAssertTrue(draft.save { store.patchItem("notes", "notes", id: id, $0) })
        XCTAssertTrue(draft.fields.isEmpty)
        XCTAssertFalse(draft.failed)
        XCTAssertTrue(draft.hasSaved)
        XCTAssertEqual(store.findItem("notes", "notes", id: id)?["title"], .string("new title"))
        XCTAssertEqual(store.findItem("notes", "notes", id: id)?["content"], .string("new body"))
    }

}
