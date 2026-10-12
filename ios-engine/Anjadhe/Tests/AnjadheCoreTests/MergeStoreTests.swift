import XCTest
import CSQLite
import CryptoKit
@testable import AnjadheCore
#if os(macOS)
import Darwin
#endif

final class MergeStoreTests: XCTestCase {
    private var directory: URL!
    private var url: URL { directory.appendingPathComponent("merge.sqlite") }
    override func setUpWithError() throws {
        directory = ProcessInfo.processInfo.environment["NENVA_MERGE_CRASH"].map(URL.init(fileURLWithPath:))
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("nenva-merge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func open() throws -> LocalRecordStore {
        let store = try LocalRecordStore(databaseURL: url)
        try store.createMergeDataset("fixture", writer: "phone")
        return store
    }
    private func sql(_ query: String) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        let result = sqlite3_exec(db, query, nil, nil, nil)
        guard result == SQLITE_OK else { throw LocalRecordStore.StoreError.database(result) }
    }
    private func edit(_ text: String) -> JSONValue { .object(["kind": .string("edit"), "fields": .object(["content": .string(text)])]) }
    private func remote(_ writer: String = "mac", sequence: Int = 1, dependencies: [String: JSONValue] = [:]) -> JSONValue {
        .object(["protocolVersion": .number(2), "schemaVersion": .number(1), "datasetId": .string("fixture"),
                 "membershipEpoch": .number(1), "deviceId": .string(writer), "sequence": .number(Double(sequence)),
                 "dependencies": .object(dependencies), "recordType": .string("note"), "recordId": .string("n"), "mutation": edit("remote")])
    }

    func testLargeNotesRespectEncryptedPageByteBudget() throws {
        let store = try open(), key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
        for i in 0..<12 {
            _ = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n\(i)",
                mutation: edit(String(repeating: "x", count: 900_000)), expectedFrontier: i == 0 ? [:] : ["phone": i])
        }
        let first = try store.encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed, limit: 256)
        XCTAssertGreaterThan(first.count, 0)
        XCTAssertLessThan(first.count, 12)
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(first).count, 12_582_912)
        let last = try XCTUnwrap(first.last?["sequence"]?.numberValue)
        let rest = try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed, after: Int(last))
        XCTAssertEqual(first.count + rest.count, 12)
        XCTAssertEqual(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed, limit: 256), first)
    }

    func testSharedFixturesSurviveDuplicateDeliveryPartitionsAndReopen() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixtures = try XCTUnwrap(JSONDecoder().decode(JSONValue.self,
            from: Data(contentsOf: root.appendingPathComponent("fixtures/record-merge/cases.json"))).arrayValue)
        for fixture in fixtures {
            let name = try XCTUnwrap(fixture["name"]?.stringValue)
            let operations = try XCTUnwrap(fixture["operations"]?.arrayValue)
            let destination = directory.appendingPathComponent(UUID().uuidString + ".sqlite")
            func reopened() throws -> LocalRecordStore {
                let store = try LocalRecordStore(databaseURL: destination)
                try store.createMergeDataset("fixture", writer: "phone")
                return store
            }
            if fixture["error"]?.boolValue == true {
                let store = try reopened()
                XCTAssertThrowsError(try store.ingestMergeOperations(operations, datasetID: "fixture"), name)
                XCTAssertEqual(try store.mergeFrontier(datasetID: "fixture"), [:], name)
                continue
            }
            var received: [JSONValue] = []
            for operation in operations.reversed() {
                received.append(operation)
                let store = try reopened()
                let receipt = try store.ingestMergeOperations([operation, operation], datasetID: "fixture")
                let expected = try RecordMerge.reduce(received, datasetID: "fixture")
                XCTAssertEqual(receipt.frontier, expected["frontier"]?.objectValue?.mapValues { Int($0.numberValue!) }, name)
                XCTAssertTrue(try store.mergeOutbox(datasetID: "fixture").isEmpty, name)
            }
            let store = try reopened(), expected = try XCTUnwrap(fixture["expected"])
            let settled = try store.ingestMergeOperations([], datasetID: "fixture")
            XCTAssertEqual(settled.frontier, expected["frontier"]?.objectValue?.mapValues { Int($0.numberValue!) }, name)
            XCTAssertEqual(settled.pending, expected["pending"]?.arrayValue?.count, name)
            for record in expected["records"]?.arrayValue ?? [] {
                let actual = try store.mergedRecord(datasetID: "fixture", type: record["type"]!.stringValue!, id: record["id"]!.stringValue!)
                let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                XCTAssertEqual(try encoder.encode(actual), try encoder.encode(record), name)
            }
        }
    }

    func testLocalIdentityOutboxAndStaleSaveAreAtomic() throws {
        let store = try open()
        let local = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("phone"), expectedFrontier: [:])
        XCTAssertEqual(local["sequence"], .number(1))
        XCTAssertEqual(try open().mergeOutbox(datasetID: "fixture"), [local])
        XCTAssertThrowsError(try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("stale"), expectedFrontier: [:]))
        _ = try store.ingestMergeOperations([remote(), local], datasetID: "fixture")
        XCTAssertEqual(try store.mergeOutbox(datasetID: "fixture"), [local])
        let frontier = try store.mergeFrontier(datasetID: "fixture")
        let resolved = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("resolved"), expectedFrontier: frontier)
        XCTAssertEqual(resolved["dependencies"], .object(["phone": .number(1), "mac": .number(1)]))
        XCTAssertEqual(try store.mergedRecord(datasetID: "fixture", type: "note", id: "n")?["conflicts"]?["fields"], .array([]))
        XCTAssertEqual(try store.mergeOutbox(datasetID: "fixture", after: 1), [resolved])
        XCTAssertThrowsError(try store.createMergeDataset("fixture", writer: "different"))
        XCTAssertThrowsError(try store.ingestMergeOperations([remote("phone", sequence: 3, dependencies: ["phone": .number(2)])], datasetID: "fixture"))
    }

    func testProjectionFailureCannotLeaveAReceiptOrConsumeAnIdentity() throws {
        let store = try open()
        try sql("CREATE TRIGGER fail_projection BEFORE INSERT ON merge_records BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try store.ingestMergeOperations([remote()], datasetID: "fixture"))
        XCTAssertEqual(try open().mergeFrontier(datasetID: "fixture"), [:])
        XCTAssertThrowsError(try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("local"), expectedFrontier: [:]))
        XCTAssertTrue(try store.mergeOutbox(datasetID: "fixture").isEmpty)
        try sql("DROP TRIGGER fail_projection")
        let saved = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("retry"), expectedFrontier: [:])
        XCTAssertEqual(saved["sequence"], .number(1))
        XCTAssertEqual(try store.ingestMergeOperations([remote()], datasetID: "fixture").applied, 1)
    }

    func testGapsDoNotAdvanceAndReusedIdentityCannotChangeProjection() throws {
        let store = try open(), second = remote(sequence: 2, dependencies: ["mac": .number(1)])
        let waiting = try store.ingestMergeOperations([second], datasetID: "fixture")
        XCTAssertEqual(waiting.frontier, [:]); XCTAssertEqual(waiting.pending, 1)
        let resumed = try open().ingestMergeOperations([remote()], datasetID: "fixture")
        XCTAssertEqual(resumed.frontier, ["mac": 2]); XCTAssertEqual(resumed.applied, 2)
        var changed = second.objectValue!; changed["mutation"] = edit("different")
        XCTAssertThrowsError(try store.ingestMergeOperations([.object(changed)], datasetID: "fixture"))
        XCTAssertEqual(try store.mergedRecord(datasetID: "fixture", type: "note", id: "n")?["fields"]?["content"]?["value"], .string("remote"))
    }

    func testVersionFourUpgradePreservesExistingMergeHistoryAndStartsDeliveryAtZero() throws {
        var old: LocalRecordStore? = try open()
        let local = try old!.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("saved"), expectedFrontier: [:])
        _ = try old!.ingestMergeOperations([remote()], datasetID: "fixture")
        let record = try old!.mergedRecord(datasetID: "fixture", type: "note", id: "n")
        old = nil
        try sql("DROP TABLE merge_envelopes; DROP TABLE merge_crypto; DROP TABLE merge_delivery; PRAGMA user_version = 4")
        let upgraded = try open()
        XCTAssertEqual(try upgraded.mergeFrontier(datasetID: "fixture"), ["phone": 1, "mac": 1])
        XCTAssertEqual(try upgraded.mergeOutbox(datasetID: "fixture"), [local])
        XCTAssertEqual(try upgraded.mergedRecord(datasetID: "fixture", type: "note", id: "n"), record)
        let state = try upgraded.mergeDeliveryState(datasetID: "fixture")
        XCTAssertEqual(state.cursor, ""); XCTAssertEqual(state.uploadedSequence, 0)
        XCTAssertEqual(try upgraded.encryptedMergeOutbox(datasetID: "fixture", datasetKey: Data(repeating: 1, count: 32), signingSeed: Data(repeating: 2, count: 32)).count, 1)
    }

    func testEncryptedDeliverySurvivesRestartAndOutOfOrderWithoutRemoteUploads() throws {
        let sender = try open(), key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
        let first = try sender.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("first"), expectedFrontier: [:])
        let second = try sender.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("second"), expectedFrontier: ["phone": 1])
        let page = try sender.encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed)
        XCTAssertEqual(page.count, 2)
        XCTAssertEqual(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed), page)
        XCTAssertEqual(try sender.encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed, after: 1), [page[1]])
        let receiverURL = directory.appendingPathComponent("receiver.sqlite")
        func receiver() throws -> LocalRecordStore {
            let store = try LocalRecordStore(databaseURL: receiverURL)
            try store.createMergeDataset("fixture", writer: "mac")
            return store
        }
        let waiting = try receiver().ingestEncryptedMergeOperations([page[1]], datasetID: "fixture", datasetKey: key, authorizedWriters: ["phone": publicKey])
        XCTAssertEqual(waiting.frontier, [:]); XCTAssertEqual(waiting.pending, 1)
        let received = try receiver().ingestEncryptedMergeOperations([page[0], page[1]], datasetID: "fixture", datasetKey: key, authorizedWriters: ["phone": publicKey])
        XCTAssertEqual(received.frontier, ["phone": 2]); XCTAssertEqual(received.pending, 0)
        XCTAssertEqual(try receiver().ingestEncryptedMergeOperations(page, datasetID: "fixture", datasetKey: key, authorizedWriters: ["phone": publicKey]).applied, 0)
        XCTAssertEqual(try receiver().mergedRecord(datasetID: "fixture", type: "note", id: "n"), try sender.mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        XCTAssertTrue(try receiver().mergeOutbox(datasetID: "fixture").isEmpty)
        XCTAssertEqual(try sender.mergeOutbox(datasetID: "fixture"), [first, second])
    }

    func testEncryptionPersistenceFailureAndWrongKeysCannotReplaceCachedPayload() throws {
        let store = try open(), key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
        _ = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("local"), expectedFrontier: [:])
        try sql("CREATE TRIGGER fail_envelope BEFORE INSERT ON merge_envelopes BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try store.encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed))
        XCTAssertEqual(try open().mergeFrontier(datasetID: "fixture"), ["phone": 1])
        try sql("DROP TRIGGER fail_envelope")
        let page = try store.encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed)
        XCTAssertThrowsError(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: Data(repeating: 3, count: 32), signingSeed: seed))
        XCTAssertThrowsError(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: Data(repeating: 4, count: 32)))
        XCTAssertEqual(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed), page)
        _ = try store.appendMergeMutation(datasetID: "fixture", type: "note", id: "n", mutation: edit("next"), expectedFrontier: ["phone": 1])
        XCTAssertThrowsError(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: Data(repeating: 3, count: 32), signingSeed: seed, after: 1))
        XCTAssertThrowsError(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: Data(repeating: 4, count: 32), after: 1))
        XCTAssertEqual(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed, after: 1).count, 1)
        try sql("UPDATE merge_envelopes SET payload = X'7b7d'")
        XCTAssertThrowsError(try open().encryptedMergeOutbox(datasetID: "fixture", datasetKey: key, signingSeed: seed))
    }

    func testCursorFailureRollsBackInboxProjectionAndAppliedReceipt() throws {
        let store = try open(), key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
        let signer = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
        let page = [try EncryptedOperation.seal(remote(), datasetKey: key, signingSeed: seed)]
        try sql("CREATE TRIGGER fail_cursor BEFORE UPDATE ON merge_delivery BEGIN SELECT RAISE(ABORT, 'test'); END")
        XCTAssertThrowsError(try store.ingestEncryptedMergePage(page, datasetID: "fixture", datasetKey: key, authorizedWriters: ["mac": signer], expectedCursor: "", nextCursor: "page-1"))
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").cursor, "")
        XCTAssertEqual(try open().mergeFrontier(datasetID: "fixture"), [:])
        XCTAssertNil(try store.mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        try sql("DROP TRIGGER fail_cursor")
        XCTAssertEqual(try store.ingestEncryptedMergePage(page, datasetID: "fixture", datasetKey: key, authorizedWriters: ["mac": signer], expectedCursor: "", nextCursor: "page-1").applied, 1)
        XCTAssertThrowsError(try store.ingestEncryptedMergePage([], datasetID: "fixture", datasetKey: key, authorizedWriters: ["mac": signer], expectedCursor: "", nextCursor: "page-2"))
        XCTAssertEqual(try open().mergeDeliveryState(datasetID: "fixture").cursor, "page-1")
        XCTAssertThrowsError(try store.confirmMergeUpload(datasetID: "fixture", expectedSequence: 0, through: 1))
    }

    func testInvalidEncryptedBatchLeavesNoPartialRecordsOrReceipt() throws {
        let store = try open(), key = Data(repeating: 1, count: 32), seed = Data(repeating: 2, count: 32)
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
        let good = try EncryptedOperation.seal(remote(), datasetKey: key, signingSeed: seed)
        var bad = try EncryptedOperation.seal(remote(sequence: 2, dependencies: ["mac": .number(1)]), datasetKey: key, signingSeed: seed).objectValue!
        bad["signature"] = .string(String(repeating: "A", count: 86))
        XCTAssertThrowsError(try store.ingestEncryptedMergeOperations([good, .object(bad)], datasetID: "fixture", datasetKey: key, authorizedWriters: ["mac": publicKey]))
        XCTAssertEqual(try open().mergeFrontier(datasetID: "fixture"), [:])
        XCTAssertNil(try store.mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        XCTAssertThrowsError(try store.ingestEncryptedMergeOperations([good], datasetID: "fixture", epoch: 2, datasetKey: key, authorizedWriters: ["mac": publicKey]))
        XCTAssertThrowsError(try store.ingestEncryptedMergeOperations([good], datasetID: "fixture", datasetKey: key, authorizedWriters: [:]))
        XCTAssertEqual(try store.ingestEncryptedMergeOperations([good], datasetID: "fixture", datasetKey: key, authorizedWriters: ["mac": publicKey]).applied, 1)
    }

    #if os(macOS)
    func testCommittedMergeSurvivesProcessExitBeforeSendingReceipt() throws {
        if ProcessInfo.processInfo.environment["NENVA_MERGE_CRASH"] != nil {
            let store = try open()
            _ = try store.ingestMergeOperations([remote()], datasetID: "fixture")
            withExtendedLifetime(store) { _exit(0) }
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["-XCTest", "AnjadheCoreTests.MergeStoreTests/testCommittedMergeSurvivesProcessExitBeforeSendingReceipt", Bundle(for: Self.self).bundlePath]
        var environment = ProcessInfo.processInfo.environment
        environment["NENVA_MERGE_CRASH"] = directory.path
        child.environment = environment
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run(); child.waitUntilExit(); XCTAssertEqual(child.terminationStatus, 0)
        let recovered = try open()
        XCTAssertEqual(try recovered.mergeFrontier(datasetID: "fixture"), ["mac": 1])
        XCTAssertNotNil(try recovered.mergedRecord(datasetID: "fixture", type: "note", id: "n"))
        XCTAssertEqual(try recovered.ingestMergeOperations([remote()], datasetID: "fixture").applied, 0)
    }
    #endif
}
