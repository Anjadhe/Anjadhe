import XCTest
@testable import AnjadheCore

final class KVStoreTests: XCTestCase {
    func testSetGetDelete() {
        let s = KVStore()
        XCTAssertNil(s.get("a"))
        s.set("a", .string("x"), now: "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(s.get("a"), .string("x"))
        XCTAssertTrue(s.has("a"))
        s.delete("a", now: "2026-06-18T11:00:00.000Z")
        XCTAssertNil(s.get("a"))
        XCTAssertFalse(s.has("a"))
    }

    func testManifestAndLocalModifiedAt() {
        let s = KVStore()
        XCTAssertEqual(s.localModifiedAt("missing"), KVStore.epoch)
        s.set("a", .number(1), now: "2026-06-18T10:00:00.000Z")
        s.delete("b", now: "2026-06-18T09:00:00.000Z")
        let m = s.exportManifest()
        XCTAssertEqual(m["a"], "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(m["b"], "2026-06-18T09:00:00.000Z") // tombstone timestamp
    }

    func testApplyRemoteSetIsLastWriterWins() {
        let s = KVStore()
        s.set("a", .string("local"), now: "2026-06-18T10:00:00.000Z")

        // Older remote is ignored.
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: .string("old"), deleted: false, modifiedAt: "2026-06-18T09:00:00.000Z")
        ]), 0)
        XCTAssertEqual(s.get("a"), .string("local"))

        // Strictly-newer remote wins.
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: .string("new"), deleted: false, modifiedAt: "2026-06-18T11:00:00.000Z")
        ]), 1)
        XCTAssertEqual(s.get("a"), .string("new"))

        // Newer delete tombstones it (keeps the Mac's timestamp).
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: nil, deleted: true, modifiedAt: "2026-06-18T12:00:00.000Z")
        ]), 1)
        XCTAssertNil(s.get("a"))
        XCTAssertEqual(s.localModifiedAt("a"), "2026-06-18T12:00:00.000Z")
    }

    func testFirstSyncAdoptsMacData() {
        // Empty local store + remote set => phone adopts the Mac's data.
        let s = KVStore()
        let applied = s.applyRemoteSet([
            "notes": RemoteEntry(value: .object(["notes": .array([])]), deleted: false, modifiedAt: "2026-06-18T10:00:00.000Z")
        ])
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(s.exportValues(["notes"])["notes"]?.modifiedAt, "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(s.exportValues(["notes"])["notes"]?.deleted, false)
    }

    func testPersistHookFires() {
        let s = KVStore()
        var writes: [String] = []
        s.persist = { key, entry in writes.append("\(key):\(entry.deleted ? "del" : "set")") }
        s.set("a", .number(1), now: "2026-06-18T10:00:00.000Z")
        s.delete("a", now: "2026-06-18T11:00:00.000Z")
        s.applyRemote("b", value: .bool(true), modifiedAt: "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(writes, ["a:set", "a:del", "b:set"])
    }

    func testDiskStoreRoundTrip() throws {
        // A unique temp dir so the test is isolated and repeatable.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("anjadhe-disktest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Write through one store, flush, then load into a fresh store.
        let kv1 = KVStore()
        let disk1 = DiskStore(directory: dir)
        disk1.attach(to: kv1)
        kv1.set("schedule", try JSONValue.parse(#"{"scheduleItems":[{"id":"t1"}]}"#), now: "2026-06-18T10:00:00.000Z")
        kv1.set("anjadhe:channel:identity", .string("pub-hex"), now: "2026-06-18T10:01:00.000Z")
        kv1.delete("old", now: "2026-06-18T10:02:00.000Z")
        disk1.flushNow()

        let rows = DiskStore(directory: dir).load()
        XCTAssertEqual(rows["schedule"]?.value?["scheduleItems"]?.arrayValue?.count, 1)
        XCTAssertEqual(rows["anjadhe:channel:identity"]?.value, .string("pub-hex")) // pairing survives
        XCTAssertEqual(rows["old"]?.deleted, true)                                  // tombstone survives

        let kv2 = KVStore()
        DiskStore(directory: dir).attach(to: kv2)
        XCTAssertEqual(kv2.get("anjadhe:channel:identity"), .string("pub-hex"))
        XCTAssertNil(kv2.get("old"))
    }

    func testRoundTripJSONValue() throws {
        let v = try JSONValue.parse(#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#)
        let data = try JSONEncoder().encode(v)
        let again = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(v, again)
        XCTAssertEqual(v["a"], .number(1))
        XCTAssertEqual(v["b"]?.arrayValue?.count, 3)
    }
}

// MARK: - Asynchronous hydration (2026-09-20)
//
// Launch stopped blocking on decoding the store file, which introduces a
// window where the app is running and the data is not there yet. Three
// things must hold in that window, and each of them is a way to lose data
// if it doesn't.
//
// `DiskStore`'s own flags are single-queue state — `.main` in the app,
// where every caller already is. SwiftPM runs XCTest bodies OFF the main
// thread and does not service the main queue while they run, so these
// tests inject a serial queue instead (`applyQueue`) and drive the window
// with one `sync` block: the hydration callback is a block on that same
// queue and therefore cannot land in the middle of it.

extension KVStoreTests {
    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("anjadhe-async-\(UUID().uuidString)", isDirectory: true)
    }

    /// Seed a store file with `rows` and return its directory.
    private func seeded(_ rows: [(String, JSONValue)]) -> URL {
        let dir = tempDir()
        let q = DispatchQueue(label: "seed")
        q.sync {
            let kv = KVStore()
            let disk = DiskStore(directory: dir, applyQueue: q)
            disk.attach(to: kv)
            for (k, v) in rows { kv.set(k, v, now: "2026-09-19T10:00:00.000Z") }
            disk.flushNow()
        }
        return dir
    }

    /// Wait until the file on disk satisfies `until`, or give up.
    private func waitForFile(_ dir: URL, _ until: ([String: RemoteEntry]) -> Bool) -> [String: RemoteEntry] {
        let deadline = Date().addingTimeInterval(5)
        var rows: [String: RemoteEntry] = [:]
        repeat {
            rows = DiskStore(directory: dir).load()
            if until(rows) { return rows }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return rows
    }

    /// The baseline: it does load.
    func testAttachAsyncLoadsTheStore() {
        let dir = seeded([("notes", .string("from disk"))])
        defer { try? FileManager.default.removeItem(at: dir) }

        let kv = KVStore()
        let q = DispatchQueue(label: "apply")
        // Held on purpose: `attachAsync` keeps only a weak self, so a
        // DiskStore left as a temporary is deallocated mid-load and the
        // hydration never lands. (`AppStore.persistent` retains it before
        // attaching for exactly this reason.)
        let disk = DiskStore(directory: dir, applyQueue: q)
        let done = expectation(description: "hydrated")
        q.sync { disk.attachAsync(to: kv) { done.fulfill() } }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(kv.get("notes"), .string("from disk"))
    }

    /// A write made while the file is still loading must SURVIVE the load.
    /// Anything already in the cache was written by this session, so it is
    /// newer than the disk by construction.
    func testAWriteDuringHydrationIsNotClobbered() {
        let dir = seeded([("notes", .string("old")), ("other", .string("untouched"))])
        defer { try? FileManager.default.removeItem(at: dir) }

        let kv = KVStore()
        let q = DispatchQueue(label: "apply")
        let disk = DiskStore(directory: dir, applyQueue: q)
        let done = expectation(description: "hydrated")
        q.sync {
            disk.attachAsync(to: kv) { done.fulfill() }
            kv.set("notes", .string("typed just now"), now: "2026-09-20T09:00:00.000Z")
        }
        wait(for: [done], timeout: 5)

        XCTAssertEqual(kv.get("notes"), .string("typed just now"))
        XCTAssertEqual(kv.get("other"), .string("untouched")) // the rest still arrives
    }

    /// And a save asked for in that window must not write the FRACTION of
    /// the store that happens to be in memory — it is owed, and paid once
    /// the load lands.
    func testNoPartialStoreIsWrittenDuringHydration() {
        let dir = seeded((0..<20).map { ("k\($0)", JSONValue.number(Double($0))) })
        defer { try? FileManager.default.removeItem(at: dir) }

        let kv = KVStore()
        let q = DispatchQueue(label: "apply")
        let disk = DiskStore(directory: dir, applyQueue: q)
        let done = expectation(description: "hydrated")
        let duringWindow: Int = q.sync {
            disk.attachAsync(to: kv) { done.fulfill() }
            kv.set("fresh", .string("x"), now: "2026-09-20T09:00:00.000Z")
            disk.flushNow() // would have truncated the file to one key
            return DiskStore(directory: dir).load().count
        }
        XCTAssertEqual(duringWindow, 20, "the file must be untouched while loading")
        wait(for: [done], timeout: 5)

        // The owed save runs on arrival, after the usual debounce.
        let rows = waitForFile(dir) { $0["fresh"] != nil }
        XCTAssertEqual(rows.count, 21, "both the loaded rows and the new write")
        XCTAssertEqual(rows["fresh"]?.value, .string("x"))
        XCTAssertEqual(rows["k19"]?.value, .number(19))
    }
}

extension KVStoreTests {
    /// The hazard the write guard exists for: a blob written from an EMPTY
    /// read, before the file lands, must not end up replacing the real one.
    /// `hydrateNowIfNeeded` completes the load first, so the write is built
    /// on the truth.
    func testAWriteBeforeHydrationSeesTheRealData() {
        let dir = seeded([("app_notes", .object(["notes": .array([.object(["id": .string("existing")])])]))])
        defer { try? FileManager.default.removeItem(at: dir) }

        let kv = KVStore()
        let q = DispatchQueue(label: "apply")
        let disk = DiskStore(directory: dir, applyQueue: q)
        let done = expectation(description: "hydrated")
        q.sync {
            disk.attachAsync(to: kv) { done.fulfill() }
            // What a screen would do: read, append, write — except the file
            // has not landed, so the read would be empty.
            disk.hydrateNowIfNeeded()
            var notes = kv.get("app_notes")?["notes"]?.arrayValue ?? []
            notes.append(.object(["id": .string("added")]))
            kv.set("app_notes", .object(["notes": .array(notes)]), now: "2026-09-20T09:00:00.000Z")
        }
        wait(for: [done], timeout: 5)

        let ids = (kv.get("app_notes")?["notes"]?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }
        XCTAssertEqual(ids, ["existing", "added"], "the existing note must survive the write")

        let rows = waitForFile(dir) { ($0["app_notes"]?.value?["notes"]?.arrayValue?.count ?? 0) == 2 }
        XCTAssertEqual((rows["app_notes"]?.value?["notes"]?.arrayValue ?? []).count, 2, "and on disk too")
    }

    /// Completing the load early must still fire the hydration callback, and
    /// only once — waiters (the JS mirror handoff) depend on it.
    func testHydrationCallbackFiresExactlyOnce() {
        let dir = seeded([("k", .string("v"))])
        defer { try? FileManager.default.removeItem(at: dir) }

        let kv = KVStore()
        let q = DispatchQueue(label: "apply")
        let disk = DiskStore(directory: dir, applyQueue: q)
        var calls = 0
        let done = expectation(description: "hydrated")
        q.sync {
            disk.attachAsync(to: kv) { calls += 1; done.fulfill() }
            disk.hydrateNowIfNeeded()   // beats the background load
            disk.hydrateNowIfNeeded()   // and is idempotent
        }
        wait(for: [done], timeout: 5)
        // Give the background apply its chance to double-fire.
        let settled = expectation(description: "settled")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 5)
        XCTAssertEqual(q.sync { calls }, 1)
        XCTAssertEqual(kv.get("k"), .string("v"))
    }
}
