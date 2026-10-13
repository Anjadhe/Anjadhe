import XCTest
@testable import AnjadheCore

final class KVStoreTests: XCTestCase {
    func testCommittedCacheAndTombstones() {
        let store = KVStore()
        XCTAssertTrue(store.set("record", .string("kept"), now: "one"))
        let before = store.snapshot()
        store.commit = { _, _, _, _ in throw LocalRecordStore.StoreError.database(13) }
        XCTAssertFalse(store.set("record", .string("lost"), now: "two"))
        XCTAssertFalse(store.delete("record", now: "two"))
        XCTAssertEqual(store.snapshot(), before)
        store.commit = nil
        XCTAssertTrue(store.delete("record", now: "three"))
        XCTAssertNil(store.get("record"))
        XCTAssertEqual(store.snapshot()["record"]?.deleted, true)
    }
    func testHydrationNeverReplacesAnEdit() {
        let store = KVStore()
        store.set("record", .string("new"), now: "two")
        store.hydrate(["record": .init(value: .string("old"), deleted: false, modifiedAt: "one")])
        XCTAssertEqual(store.get("record"), .string("new"))
    }
}
