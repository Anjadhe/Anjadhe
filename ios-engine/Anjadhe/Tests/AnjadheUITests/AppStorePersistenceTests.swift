import XCTest
import Combine
import AnjadheCore
@testable import AnjadheUI

final class AppStorePersistenceTests: XCTestCase {
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
        XCTAssertTrue(store.deleteItem("notes", "notes", id: note))
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

    func testPopulatedPairingAndRePairingAreRefusedWithoutChangingData() {
        let store = AppStore()
        store.addItem("notes", "notes", ["title": .string("phone only")])
        let sync = SyncCoordinator(store: store)
        sync.pair(offerText: "unused")
        XCTAssertNotNil(sync.lastPairError)
        XCTAssertEqual(store.items("notes", "notes").count, 1)
        store.kv.set("anjadhe:channel:synced-once", .bool(true), now: KVStore.nowISO())
        sync.pair(offerText: "unused")
        XCTAssertNotNil(sync.lastPairError, "a leftover synced-once flag must not allow destructive re-pairing")
        let empty = SyncCoordinator(store: AppStore())
        empty.pair(offerText: "unused")
        XCTAssertNil(empty.lastPairError)
    }
}
