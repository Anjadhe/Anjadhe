import XCTest
import CryptoKit
@testable import AnjadheCore

final class SyncHTTPTransportTests: XCTestCase {
    private let credential = "nsync_" + String(repeating: "1", count: 64)
    private func response(_ value: JSONValue) throws -> Data { try JSONEncoder().encode(value) }

    func testDedicatedCredentialAndWireContract() async throws {
        var requests: [URLRequest] = []
        let client = try SyncHTTPTransport(credential: credential) { request in
            requests.append(request)
            if request.httpMethod == "GET" { return (try self.response(.object(["envelopes": .array([]), "nextCursor": .string("next"), "hasMore": .bool(false)])), 200) }
            if request.url!.path.hasSuffix("receipts") { return (try self.response(.object(["accepted": .bool(true)])), 200) }
            return (try self.response(.object(["storedThrough": .number(2)])), 200)
        }
        let envelope: JSONValue = .object(["fixture": .bool(true)])
        let stored = try await client.upload(datasetID: "dataset", epoch: 3, envelopes: [envelope])
        XCTAssertEqual(stored, 2)
        let page = try await client.download(datasetID: "dataset", epoch: 3, after: "opaque+/&?")
        XCTAssertEqual(page.nextCursor, "next"); XCTAssertFalse(page.hasMore)
        try await client.acknowledgeApplied(datasetID: "dataset", epoch: 3, frontier: ["phone": 2])
        XCTAssertEqual(requests.count, 3)
        for request in requests {
            XCTAssertEqual(request.url?.host, "api.nenva.co")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Sync-Epoch"), "3")
            XCTAssertFalse(request.url!.absoluteString.contains(credential))
        }
        XCTAssertEqual(requests[0].url?.path, "/v2/sync/datasets/dataset/operations")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(requests[0].httpBody)), .object(["envelopes": .array([envelope])]))
        XCTAssertEqual(URLComponents(url: requests[1].url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "opaque+/&?")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(requests[2].httpBody)), .object(["frontier": .object(["phone": .number(2)])]))
    }

    func testInvalidConfigurationAndUntrustedResponsesFailClosed() async throws {
        for url in ["http://api.nenva.co", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid/?key=value"] {
            XCTAssertThrowsError(try SyncHTTPTransport(baseURL: URL(string: url)!, credential: credential))
        }
        XCTAssertThrowsError(try SyncHTTPTransport(credential: "anck_inference-key"))
        XCTAssertThrowsError(try SyncHTTPTransport(credential: credential + "\n"))
        for body: JSONValue in [.null, .object(["storedThrough": .number(1.5)]), .object(["storedThrough": .number(-1)])] {
            let client = try SyncHTTPTransport(credential: credential) { _ in (try self.response(body), 200) }
            do { _ = try await client.upload(datasetID: "dataset", epoch: 1, envelopes: [.object([:])]); XCTFail("must reject invalid ACK") }
            catch { XCTAssertEqual(error as? SyncHTTPTransport.Failure, .invalidResponse) }
        }
        let client = try SyncHTTPTransport(credential: credential) { _ in (try self.response(.object(["error": .string("echoed-private-content")])), 500) }
        do { _ = try await client.download(datasetID: "dataset", epoch: 1, after: ""); XCTFail("must reject service error") }
        catch { XCTAssertEqual(error as? SyncHTTPTransport.Failure, .service(500, "request_failed")) }
        let quota = try SyncHTTPTransport(credential: credential) { _ in (try self.response(.object(["error": .string("storage_quota")])), 507) }
        do { _ = try await quota.download(datasetID: "dataset", epoch: 1, after: ""); XCTFail("must preserve quota state") }
        catch { XCTAssertEqual(error as? SyncHTTPTransport.Failure, .service(507, "storage_quota")) }
    }

    /// Run with Connect's `node test/sync-native-fixture.js`; its printed
    /// loopback URL goes in NENVA_SYNC_TEST_ENDPOINT. Never contact production.
    func testTwoNativeStoresThroughRealHTTPMailbox() async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["NENVA_SYNC_TEST_ENDPOINT"] else {
            throw XCTSkip("Opt-in Connect loopback integration fixture is not running")
        }
        try await exerciseHTTPMailbox(endpoint: endpoint, macPeer: false)
    }

    /// The app's test:sync-interop runner uploads a Mac operation first, then
    /// launches this peer and finally checks the merged Mac SQLite store.
    func testNativePeerWithMacStore() async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["NENVA_SYNC_MAC_TEST_ENDPOINT"] else {
            throw XCTSkip("Opt-in Mac/Swift loopback integration fixture is not running")
        }
        try await exerciseHTTPMailbox(endpoint: endpoint, macPeer: true)
    }

    private func exerciseHTTPMailbox(endpoint: String, macPeer: Bool) async throws {
        guard let base = URL(string: endpoint), base.scheme == "http", base.host == "127.0.0.1", base.port != nil else {
            XCTFail("Integration fixture must be loopback"); return
        }
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let vector = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("fixtures/encrypted-operation/vector.json")))
        func hex(_ value: JSONValue?) -> Data {
            let text = value!.stringValue!
            return Data(stride(from: 0, to: text.count, by: 2).map { i in
                let a = text.index(text.startIndex, offsetBy: i), b = text.index(a, offsetBy: 2)
                return UInt8(text[a..<b], radix: 16)!
            })
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-http-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let a = try LocalRecordStore(databaseURL: folder.appendingPathComponent("a.sqlite"))
        let b = try LocalRecordStore(databaseURL: folder.appendingPathComponent("b.sqlite"))
        try a.createMergeDataset("fixture", writer: "a"); try b.createMergeDataset("fixture", writer: "b")
        let seedA = hex(vector["signingSeed"]), seedB = Data(repeating: 7, count: 32), key = hex(vector["datasetKey"])
        let senders = ["a": hex(vector["publicKey"]), "b": try Curve25519.Signing.PrivateKey(rawRepresentation: seedB).publicKey.rawRepresentation]
        func transport(_ number: String) throws -> SyncHTTPTransport {
            try SyncHTTPTransport(baseURL: URL(string: "https://fixture.invalid")!, credential: "nsync_" + String(repeating: number, count: 64)) { request in
                var request = request
                var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                url.scheme = base.scheme; url.host = base.host; url.port = base.port
                request.url = url.url
                return try await SyncHTTPTransport.send(request)
            }
        }
        let deliveryA = MergeDeliveryCoordinator(store: a, transport: try transport("1"), datasetID: "fixture", datasetKey: key, signingSeed: seedA, authorizedWriters: senders)
        let deliveryB = MergeDeliveryCoordinator(store: b, transport: try transport("2"), datasetID: "fixture", datasetKey: key, signingSeed: seedB, authorizedWriters: senders)
        func edit(_ content: String) -> JSONValue { .object(["kind": .string("edit"), "fields": .object(["content": .string(content)])]) }
        if !macPeer {
            _ = try a.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("Written on device A"), expectedFrontier: [:])
            _ = try await deliveryA.synchronize()
        }
        _ = try await deliveryB.synchronize()
        let aCount = macPeer ? 9 : 1
        XCTAssertEqual(try b.mergeFrontier(datasetID: "fixture"), ["a": aCount])
        XCTAssertEqual(try b.mergedRecord(datasetID: "fixture", type: "note", id: "n")?["fields"]?["content"]?["value"], .string("Written on device A"))
        _ = try b.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("Edited on device B"), expectedFrontier: ["a": aCount])
        if macPeer {
            try b.importLegacy([:], fingerprint: "synthetic-empty")
            let writer = ConversationSyncWriter(store: b, datasetID: "fixture")
            let received = try await writer.projection()
            XCTAssertEqual(received["conversations"]?.arrayValue?.first?["messages"]?.arrayValue?.first?["content"], .string("When is tuition due?"))
            let local = try JSONValue.parse(#"{"conversations":[{"id":"phone-chat","title":"Phone conversation","createdAt":"2026-10-12","messages":[{"id":"u","role":"user","content":"Written independently on the phone","timestamp":"2026-10-12"}]},{"private":true,"messages":[{"content":"PRIVATE_NEVER_SYNC"}]}]}"#)
            let draft = try await writer.prepare(local); try await writer.commit(draft)
            let senderWriter = SenderSyncWriter(store: b, datasetID: "fixture")
            let threads = try await senderWriter.projection()
            XCTAssertEqual(threads["senders"]?["dental"]?["name"], .string("Your dental"))
            XCTAssertEqual(threads["place"]?["task:visit"]?["sender"], .string("dental"))
            let sender = try JSONValue.parse(#"{"senders":{"music":{"id":"music","name":"Music classes","allGood":"Practice regularly.","state":"active","confirmed":true,"by":"you","createdAt":"2026-10-12"}},"place":{"task:practice":{"sender":"music","by":"you","at":"2026-10-12"}}}"#)
            let senderDraft = try await senderWriter.prepare(sender); try await senderWriter.commit(senderDraft)
            let commitmentWriter = CommitmentSyncWriter(store: b, datasetID: "fixture")
            let commitmentProjection = try await commitmentWriter.projection()
            XCTAssertEqual(commitmentProjection["issues"], .array([]))
            XCTAssertEqual(commitmentProjection["items"]?.arrayValue?.count, 2)
            // This fixture supplies an exact synthetic, common-lineage baseline.
            // Production populated-store bootstrap and inbound reconciliation
            // remain unbuilt; projection alone must never install this snapshot.
            XCTAssertNil(try b.legacySnapshot()["app_commitments"])
            let baseline = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("fixtures/commitment-sync/snapshot.json")))
            try b.commitLegacyBatch(["app_commitments": RemoteEntry(value: baseline, deleted: false, modifiedAt: "fixture-bootstrap")], expected: [:], readKeys: ["app_commitments"], origin: .remote)
            var changed = baseline.objectValue!, items = changed["items"]!.arrayValue!, run = items[1].objectValue!
            var history = run["history"]!.objectValue!; history["2026-10-12"] = .string("done"); run["history"] = .object(history)
            var log = run["log"]!.objectValue!, evening = log["2026-10-12"]!.arrayValue!
            evening.append(try JSONValue.parse(#"{"at":"2026-10-12T19:00:00Z","quote":"Ran 5 km this evening","measures":[{"name":"distance","value":5,"unit":"km"}]}"#))
            log["2026-10-12"] = .array(evening); run["log"] = .object(log); items[1] = .object(run)
            var step = items[0].objectValue!
            step["id"] = .string("phone-step"); step["title"] = .string("Stretch after running")
            step["parent"] = .string("goal"); step["shape"] = .string("task"); step["outcome"] = .null
            step["domain"] = .null; step["aim"] = .null
            items.append(.object(step)); changed["items"] = .array(items)
            let commitmentDraft = try await commitmentWriter.prepare(.object(changed)); try await commitmentWriter.commit(commitmentDraft)
        }
        _ = try await deliveryB.synchronize()
        if macPeer {
            XCTAssertEqual(try b.mergeFrontier(datasetID: "fixture"), ["a": 9, "b": 7])
            XCTAssertEqual(try b.mergedRecord(datasetID: "fixture", type: "note", id: "n")?["fields"]?["content"]?["value"], .string("Edited on device B"))
            XCTAssertEqual(try b.mergeOutbox(datasetID: "fixture").count, 7)
            XCTAssertEqual(try b.mergeDeliveryState(datasetID: "fixture").uploadedSequence, 7)
            return
        }
        _ = try await deliveryA.synchronize()
        XCTAssertEqual(try a.mergeFrontier(datasetID: "fixture"), ["a": 1, "b": 1])
        XCTAssertEqual(try a.mergedRecord(datasetID: "fixture", type: "note", id: "n"), try b.mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        XCTAssertEqual(try a.mergedRecord(datasetID: "fixture", type: "note", id: "n")?["fields"]?["content"]?["value"], .string("Edited on device B"))
        XCTAssertEqual(try a.mergeOutbox(datasetID: "fixture").count, 1)
        XCTAssertEqual(try b.mergeOutbox(datasetID: "fixture").count, 1)
        _ = try await deliveryA.synchronize(); _ = try await deliveryB.synchronize()
        XCTAssertEqual(try a.mergeDeliveryState(datasetID: "fixture").uploadedSequence, 1)
        XCTAssertEqual(try b.mergeDeliveryState(datasetID: "fixture").uploadedSequence, 1)
    }
}
