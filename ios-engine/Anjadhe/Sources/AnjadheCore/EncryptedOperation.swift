import Foundation
import CryptoKit

/// Experimental cloud-operation envelope, matching js/sync/encrypted-operation.
/// E1 Authorize the pinned sender and epoch, then verify before releasing text.
/// E2 Dataset/writer/sequence are bound by AEAD, signature and plaintext checks.
/// E3 Retries reuse durably stored ciphertext; production seal uses random nonces.
/// E4 Decryption has no storage/receipt/execution side effects. Call the merge
///    inbox only after this succeeds. Enrollment and key custody are separate.
public enum EncryptedOperation {
    public enum Failure: Error { case invalidEnvelope }
    private static let maximum = 1_048_576
    private static let signatureDomain = Data("nenva-sync-signature-v2\n".utf8)
    private static func writerKey(_ datasetKey: Data, envelope: JSONValue) -> SymmetricKey {
        // Header validation precedes this helper. Separate writer/epoch keys
        // keep independently generated nonces out of a shared AES key space.
        let info = "nenva-sync-writer-v2\n\(envelope["datasetId"]!.stringValue!)\n\(positive(envelope["membershipEpoch"])!)\n\(envelope["deviceId"]!.stringValue!)\n"
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: datasetKey),
            salt: Data("nenva-sync-key-v2\n".utf8), info: Data(info.utf8), outputByteCount: 32)
    }
    private static func positive(_ value: JSONValue?) -> Int? {
        guard let number = value?.numberValue, number.isFinite, number > 0,
              number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
        return Int(number)
    }
    private static func header(_ value: JSONValue) throws -> Data {
        guard value["protocolVersion"]?.numberValue == 2,
              let dataset = value["datasetId"]?.stringValue, RecordMerge.token(dataset),
              let writer = value["deviceId"]?.stringValue, RecordMerge.token(writer),
              let epoch = positive(value["membershipEpoch"]), let sequence = positive(value["sequence"]) else { throw Failure.invalidEnvelope }
        return Data("nenva-sync-operation-v2\n\(dataset)\n\(epoch)\n\(writer)\n\(sequence)\n".utf8)
    }
    private static func encode(_ data: Data) -> JSONValue {
        .string(data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""))
    }
    private static func decode(_ value: JSONValue?, minimum: Int, maximum: Int) throws -> Data {
        guard let value = value?.stringValue, !value.isEmpty, value.utf8.count <= (maximum * 4 + 2) / 3,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw Failure.invalidEnvelope }
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), (minimum...maximum).contains(data.count), encode(data) == .string(value) else { throw Failure.invalidEnvelope }
        return data
    }

    public static func seal(_ operation: JSONValue, datasetKey: Data, signingSeed: Data) throws -> JSONValue {
        try seal(operation, datasetKey: datasetKey, signingSeed: signingSeed, nonce: AES.GCM.Nonce())
    }
    // Internal deterministic overload is only for cross-language test vectors.
    static func seal(_ operation: JSONValue, datasetKey: Data, signingSeed: Data, nonce: AES.GCM.Nonce) throws -> JSONValue {
        guard datasetKey.count == 32, signingSeed.count == 32 else { throw Failure.invalidEnvelope }
        let aad = try header(operation)
        let parsed = try RecordMerge.parse(operation, datasetID: operation["datasetId"]!.stringValue!, epoch: positive(operation["membershipEpoch"])!)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let plaintext = try encoder.encode(parsed.raw)
        guard plaintext.count <= maximum else { throw Failure.invalidEnvelope }
        guard nonce.withUnsafeBytes({ $0.count }) == 12 else { throw Failure.invalidEnvelope }
        let sealed = try AES.GCM.seal(plaintext, using: writerKey(datasetKey, envelope: operation), nonce: nonce, authenticating: aad)
        let nonceData = nonce.withUnsafeBytes { Data($0) }
        let signature = try Curve25519.Signing.PrivateKey(rawRepresentation: signingSeed)
            .signature(for: signatureDomain + aad + nonceData + sealed.ciphertext + sealed.tag)
        return .object([
            "protocolVersion": .number(2), "datasetId": operation["datasetId"]!, "membershipEpoch": operation["membershipEpoch"]!,
            "deviceId": operation["deviceId"]!, "sequence": operation["sequence"]!, "nonce": encode(nonceData),
            "ciphertext": encode(sealed.ciphertext), "tag": encode(sealed.tag), "signature": encode(signature)
        ])
    }

    public static func open(_ envelope: JSONValue, datasetID: String, membershipEpoch: Int,
                            datasetKey: Data, authorizedWriters: [String: Data]) throws -> JSONValue {
        let aad = try header(envelope)
        let keys: Set<String> = ["protocolVersion", "datasetId", "membershipEpoch", "deviceId", "sequence", "nonce", "ciphertext", "tag", "signature"]
        guard let object = envelope.objectValue, Set(object.keys) == keys,
              envelope["datasetId"]?.stringValue == datasetID, positive(envelope["membershipEpoch"]) == membershipEpoch,
              let writer = envelope["deviceId"]?.stringValue, let sender = authorizedWriters[writer], sender.count == 32,
              datasetKey.count == 32 else { throw Failure.invalidEnvelope }
        let nonce = try decode(envelope["nonce"], minimum: 12, maximum: 12)
        let ciphertext = try decode(envelope["ciphertext"], minimum: 1, maximum: maximum)
        let tag = try decode(envelope["tag"], minimum: 16, maximum: 16)
        let signature = try decode(envelope["signature"], minimum: 64, maximum: 64)
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: sender)
        guard publicKey.isValidSignature(signature, for: signatureDomain + aad + nonce + ciphertext + tag) else { throw Failure.invalidEnvelope }
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
        let plaintext = try AES.GCM.open(sealed, using: writerKey(datasetKey, envelope: envelope), authenticating: aad)
        guard String(data: plaintext, encoding: .utf8) != nil else { throw Failure.invalidEnvelope }
        let operation = try JSONDecoder().decode(JSONValue.self, from: plaintext)
        let parsed = try RecordMerge.parse(operation, datasetID: datasetID, epoch: membershipEpoch)
        guard parsed.writer == writer, parsed.sequence == positive(envelope["sequence"]) else { throw Failure.invalidEnvelope }
        return parsed.raw
    }
}
