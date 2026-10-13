import XCTest
import AnjadheCore
@testable import AnjadheUI

@MainActor final class ThreadStoreTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONValue.parse(String(contentsOf: root.appendingPathComponent("fixtures/mobile-panels/records.json"), encoding: .utf8))
    }
    private func store(_ blobs: JSONValue) throws -> AppStore {
        let store = AppStore()
        for (key, value) in try XCTUnwrap(blobs.objectValue) { XCTAssertTrue(store.saveBlob(key, try XCTUnwrap(value.objectValue))) }
        return store
    }
    private var day: Date { Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 12))! }

    func testNativePanelAndReadToolAgreeWithoutWriting() async throws {
        let blobs = try XCTUnwrap(fixture()["blobs"])
        let store = try store(blobs), threads = ThreadStore()
        let before = store.kv.snapshot()
        await threads.focus("sender:fitness", store: store, now: day)
        XCTAssertNil(threads.error)
        XCTAssertEqual(threads.home(for: "task:run"), "sender:fitness")
        XCTAssertEqual(threads.home(for: "sender:old-fitness"), "sender:fitness")
        let panel = try await SharedCore().call(.threadPanel, arguments: [blobs, .string("sender:fitness"), .string("2026-10-12")])
        XCTAssertEqual(threads.thread("task:run")?["panel"], panel["blocks"])
        XCTAssertEqual(store.kv.snapshot(), before, "Opening a native panel never saves or executes anything")
        let router = Router()
        router.threadHome = { threads.home(for: $0) }
        XCTAssertTrue(router.openRecordLink("anjadhe://task/run"))
        XCTAssertEqual(router.path(for: .threads), [.thread("sender:fitness")])
    }

    func testMalformedPanelRecordsKeepPreviousProjectionAndReportFailure() async throws {
        let blobs = try XCTUnwrap(fixture()["blobs"])
        let store = try store(blobs), threads = ThreadStore()
        await threads.focus("sender:fitness", store: store, now: day)
        let lastGood = threads.threads
        var records = store.items("commitments", "items")
        var goal = try XCTUnwrap(records[0].objectValue)
        goal["log"] = .object(["2026-10-11": .object(["invalid": .bool(true)])])
        records[0] = .object(goal)
        XCTAssertTrue(store.saveItems("commitments", "items", records))
        let saved = store.kv.snapshot()
        await threads.refresh(store, now: day)
        XCTAssertNotNil(threads.error)
        XCTAssertEqual(threads.threads, lastGood)
        XCTAssertEqual(store.kv.snapshot(), saved, "A failed read never resets or repairs records")
    }

    func testPanelArrangementIsPartOfTheNativeTurnReadSet() async throws {
        let blobs = try XCTUnwrap(fixture()["blobs"])
        let store = try store(blobs), writer = ChatTurnStore()
        let event = try JSONValue.parse(#"{"id":"read-panel","kind":"start","conversation":"panel-chat","thread":"nenva","text":"Read the panel","model":"test-only"}"#)
        let first = try await writer.prepare(event, in: store.kv)
        try writer.commit(first, to: store.kv)
        let drive = try await writer.prepare(.object(["id": .string("read-panel"), "kind": .string("drive")]), in: store.kv)
        XCTAssertTrue(store.saveBlob("thread-panels", ["byKey": .object([:])]))
        XCTAssertThrowsError(try writer.commit(drive, to: store.kv), "A changed arrangement invalidates a prepared read")
        XCTAssertEqual(store.blob("device-turns")["runs"]?["read-panel"]?["phase"], .string("ready"))
    }
}
