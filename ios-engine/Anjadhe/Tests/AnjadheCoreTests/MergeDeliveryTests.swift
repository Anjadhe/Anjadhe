import XCTest
import CryptoKit
@testable import AnjadheCore

private actor TestMailbox: MergeMailboxTransport {
    enum Failure: Error { case lostResponse }
    var uploads: [[JSONValue]] = []
    var acknowledgments: [[String: Int]] = []
    var downloads: [String] = []
    var incoming: [JSONValue] = []
    var loseUpload = false, loseReceipt = false, invalidACK = false
    var pauseUpload = false
    private var resumeUpload: CheckedContinuation<Void, Never>?
    func releaseUpload() { pauseUpload = false; resumeUpload?.resume(); resumeUpload = nil }
    func configure(incoming: [JSONValue] = [], loseUpload: Bool = false, loseReceipt: Bool = false, invalidACK: Bool = false, pauseUpload: Bool = false) {
        self.incoming = incoming; self.loseUpload = loseUpload; self.loseReceipt = loseReceipt; self.invalidACK = invalidACK
        self.pauseUpload = pauseUpload
    }
    func upload(datasetID: String, epoch: Int, envelopes: [JSONValue]) async throws -> Int {
        uploads.append(envelopes)
        if pauseUpload { await withCheckedContinuation { resumeUpload = $0 } }
        if loseUpload { loseUpload = false; throw Failure.lostResponse }
        return Int(envelopes.last!["sequence"]!.numberValue!) + (invalidACK ? 1 : 0)
    }
    func download(datasetID: String, epoch: Int, after cursor: String) async throws -> MergeMailboxPage {
        downloads.append(cursor)
        return MergeMailboxPage(envelopes: cursor.isEmpty ? incoming : [], nextCursor: "page-1", hasMore: false)
    }
    func acknowledgeApplied(datasetID: String, epoch: Int, frontier: [String: Int]) async throws {
        if loseReceipt { loseReceipt = false; throw Failure.lostResponse }
        acknowledgments.append(frontier)
    }
}

final class MergeDeliveryTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-delivery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func open() throws -> LocalRecordStore {
        let store = try LocalRecordStore(databaseURL: directory.appendingPathComponent("store.sqlite"))
        try store.createMergeDataset("fixture", writer: "phone")
        return store
    }
    private func coordinator(_ mailbox: TestMailbox) throws -> MergeDeliveryCoordinator {
        let signer = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
        return MergeDeliveryCoordinator(store: try open(), transport: mailbox, datasetID: "fixture", datasetKey: key,
            signingSeed: seed, authorizedWriters: ["mac": signer, "phone": signer])
    }
    private func incoming(schema: Int = 1) throws -> JSONValue {
        try EncryptedOperation.seal(.object([
            "protocolVersion": .number(2), "schemaVersion": .number(Double(schema)), "datasetId": .string("fixture"),
            "membershipEpoch": .number(1), "deviceId": .string("mac"), "sequence": .number(1), "dependencies": .object([:]),
            "recordType": .string("note"), "recordId": .string("n"), "mutation": .object(["kind": .string("edit"), "fields": .object(["content": .string("remote")])])
        ]), datasetKey: key, signingSeed: seed)
    }
    private func local() throws {
        _ = try open().appendMergeMutation(datasetID: "fixture", type: "note", id: "local",
            mutation: .object(["kind": .string("edit"), "fields": .object(["content": .string("local")])]), expectedFrontier: [:])
    }

    func testLostUploadResponseRetriesExactEnvelopeAfterRestart() async throws {
        try local()
        let mailbox = TestMailbox(); await mailbox.configure(loseUpload: true)
        do { _ = try await coordinator(mailbox).synchronize(); XCTFail("must surface uncertain upload") } catch TestMailbox.Failure.lostResponse { }
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").uploadedSequence, 0)
        let resumed = try await coordinator(mailbox).synchronize()
        XCTAssertEqual(resumed.uploadedSequence, 1)
        let uploads = await mailbox.uploads
        XCTAssertEqual(uploads.count, 2); XCTAssertEqual(uploads[0], uploads[1])
        XCTAssertEqual(try open().mergeOutbox(datasetID: "fixture").count, 1, "storage ACK never deletes history")
        _ = try await coordinator(mailbox).synchronize()
        let finalUploads = await mailbox.uploads
        XCTAssertEqual(finalUploads.count, 2)
    }

    func testLostAppliedReceiptResumesCursorAndResendsCommittedFrontier() async throws {
        let mailbox = TestMailbox(); await mailbox.configure(incoming: [try incoming()], loseReceipt: true)
        do { _ = try await coordinator(mailbox).synchronize(); XCTFail("must surface receipt failure") } catch TestMailbox.Failure.lostResponse { }
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").cursor, "page-1")
        XCTAssertEqual(try open().mergeFrontier(datasetID: "fixture"), ["mac": 1])
        XCTAssertNotNil(try open().mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        _ = try await coordinator(mailbox).synchronize()
        let downloads = await mailbox.downloads, receipts = await mailbox.acknowledgments
        XCTAssertEqual(downloads, ["", "page-1"]); XCTAssertEqual(receipts, [["mac": 1]])
        XCTAssertTrue(try open().mergeOutbox(datasetID: "fixture").isEmpty)
    }

    func testUnsupportedDownloadedSchemaIsDurableButNotAcknowledgedAsApplied() async throws {
        let mailbox = TestMailbox(); await mailbox.configure(incoming: [try incoming(schema: 99)])
        _ = try await coordinator(mailbox).synchronize()
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").cursor, "page-1")
        XCTAssertEqual(try open().ingestMergeOperations([], datasetID: "fixture").pending, 1)
        let receipts = await mailbox.acknowledgments
        XCTAssertEqual(receipts, [[:]])
    }

    func testConcurrentPassIsRejectedAndCancellationRetriesSavedUpload() async throws {
        try local()
        let mailbox = TestMailbox(); await mailbox.configure(pauseUpload: true)
        let delivery = try coordinator(mailbox)
        let first = Task { try await delivery.synchronize() }
        while await mailbox.uploads.isEmpty { await Task.yield() }
        do { _ = try await delivery.synchronize(); XCTFail("must reject overlapping pass") }
        catch MergeDeliveryCoordinator.Failure.alreadyRunning { }
        first.cancel(); await mailbox.releaseUpload()
        do { _ = try await first.value; XCTFail("must surface cancellation") } catch is CancellationError { }
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").uploadedSequence, 0)
        let retried = try await delivery.synchronize()
        XCTAssertEqual(retried.uploadedSequence, 1)
        let uploads = await mailbox.uploads
        XCTAssertEqual(uploads.count, 2); XCTAssertEqual(uploads[0], uploads[1])
    }

    func testInvalidCloudAcknowledgmentCannotSkipLocalWork() async throws {
        try local()
        let mailbox = TestMailbox(); await mailbox.configure(invalidACK: true)
        do { _ = try await coordinator(mailbox).synchronize(); XCTFail("must reject unexpected ACK") } catch MergeDeliveryCoordinator.Failure.invalidAcknowledgment { }
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").uploadedSequence, 0)
        let downloads = await mailbox.downloads
        XCTAssertTrue(downloads.isEmpty)
    }
}
