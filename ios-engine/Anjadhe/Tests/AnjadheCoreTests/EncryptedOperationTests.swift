import XCTest
import CryptoKit
@testable import AnjadheCore

final class EncryptedOperationTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("fixtures/encrypted-operation/vector.json")))
    }
    private func hex(_ value: JSONValue?) throws -> Data {
        let text = try XCTUnwrap(value?.stringValue)
        return Data(stride(from: 0, to: text.count, by: 2).map { offset in
            let start = text.index(text.startIndex, offsetBy: offset), end = text.index(start, offsetBy: 2)
            return UInt8(text[start..<end], radix: 16)!
        })
    }
    func testNodeVectorOpensAndSwiftSealsTheSameEnvelope() throws {
        let vector = try fixture(), operation = try XCTUnwrap(vector["operation"]), envelope = try XCTUnwrap(vector["envelope"])
        let key = try hex(vector["datasetKey"]), seed = try hex(vector["signingSeed"]), signer = try hex(vector["publicKey"])
        let opened = try EncryptedOperation.open(envelope, datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer])
        XCTAssertEqual(opened, operation)
        let fixed = try EncryptedOperation.seal(operation, datasetKey: key, signingSeed: seed, nonce: AES.GCM.Nonce(data: Data(0..<12)))
        // CryptoKit may hedge Ed25519 signatures with randomness. Compare
        // the encrypted bytes and verify signatures, never require identical signatures.
        for field in envelope.objectValue!.keys where field != "signature" {
            XCTAssertEqual(fixed[field], envelope[field], field)
        }
        XCTAssertEqual(try EncryptedOperation.open(fixed, datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]), operation)
        let first = try EncryptedOperation.seal(operation, datasetKey: key, signingSeed: seed)
        let second = try EncryptedOperation.seal(operation, datasetKey: key, signingSeed: seed)
        XCTAssertNotEqual(first["nonce"], second["nonce"])
        XCTAssertNotEqual(first["ciphertext"], second["ciphertext"])
        XCTAssertEqual(try EncryptedOperation.open(first, datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]), operation)
    }
    func testTamperWrongScopeRevokedSenderAndWrongKeyAreRejected() throws {
        let vector = try fixture(), envelope = try XCTUnwrap(vector["envelope"]?.objectValue)
        let key = try hex(vector["datasetKey"]), signer = try hex(vector["publicKey"])
        for field in ["nonce", "ciphertext", "tag", "signature"] {
            var changed = envelope
            let text = changed[field]!.stringValue!
            changed[field] = .string((text.first == "A" ? "B" : "A") + text.dropFirst())
            XCTAssertThrowsError(try EncryptedOperation.open(.object(changed), datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]))
            changed[field] = .string(text + "=")
            XCTAssertThrowsError(try EncryptedOperation.open(.object(changed), datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]))
        }
        for (field, value): (String, JSONValue) in [("protocolVersion", .number(1)), ("datasetId", .string("other")), ("membershipEpoch", .number(2)), ("deviceId", .string("b")), ("sequence", .number(2)), ("injected", .string("not signed"))] {
            var changed = envelope; changed[field] = value
            XCTAssertThrowsError(try EncryptedOperation.open(.object(changed), datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]))
        }
        XCTAssertThrowsError(try EncryptedOperation.open(.object(envelope), datasetID: "other", membershipEpoch: 1, datasetKey: key, authorizedWriters: ["a": signer]))
        XCTAssertThrowsError(try EncryptedOperation.open(.object(envelope), datasetID: "fixture", membershipEpoch: 2, datasetKey: key, authorizedWriters: ["a": signer]))
        XCTAssertThrowsError(try EncryptedOperation.open(.object(envelope), datasetID: "fixture", membershipEpoch: 1, datasetKey: key, authorizedWriters: [:]))
        XCTAssertThrowsError(try EncryptedOperation.open(.object(envelope), datasetID: "fixture", membershipEpoch: 1, datasetKey: Data(repeating: 4, count: 32), authorizedWriters: ["a": signer]))
    }
}
