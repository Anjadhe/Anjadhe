import Foundation
import CryptoKit

public struct ChatCheckpoint {
    public let turn: JSONValue
    public let request: JSONValue?
    fileprivate let changes: [String: JSONValue]
    fileprivate let expected: [String: RemoteEntry]
}

/// Persistence adapter only. The JS turn core decides phases, requests, tools,
/// approvals and claims. Credentials never enter JS or the journal.
@MainActor public final class ChatTurnStore {
    public static let keys = RecordWriter.keys + ["app_agent-conversations", "app_device-turns", "app_thread-panels"]
    private let core: SharedCore
    public init(core: SharedCore = SharedCore()) { self.core = core }

    public func prepare(_ event: JSONValue, in store: KVStore) async throws -> ChatCheckpoint {
        let before = store.exportValues(Self.keys)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var blobs: [String: JSONValue] = [:], versions: [String: JSONValue] = [:]
        for key in Self.keys {
            let bare = String(key.dropFirst(4))
            if let entry = before[key] {
                versions[bare] = .string(SHA256.hash(data: try encoder.encode(entry)).map { String(format: "%02x", $0) }.joined())
                if !entry.deleted { blobs[bare] = entry.value ?? .null }
            }
        }
        blobs["_versions"] = .object(versions)
        let result = try await core.call(.chatTransition, arguments: [.object(blobs), event])
        guard result["ok"]?.boolValue == true else {
            throw RecordWriter.Failure.rejected(result["error"]?.stringValue ?? "Couldn’t advance this turn.")
        }
        guard let values = result["changes"]?.objectValue, let turn = result["turn"] else { throw RecordWriter.Failure.invalidResult }
        let changes = Dictionary(uniqueKeysWithValues: values.map { ("app_" + $0.key, $0.value) })
        guard Set(changes.keys).isSubset(of: Set(Self.keys)) else { throw RecordWriter.Failure.invalidResult }
        return ChatCheckpoint(turn: turn, request: result["request"] == .null ? nil : result["request"], changes: changes, expected: before)
    }
    public func commit(_ checkpoint: ChatCheckpoint, to store: KVStore) throws {
        try store.setBatch(checkpoint.changes, expected: checkpoint.expected, readKeys: Self.keys, now: KVStore.nowISO())
    }
}
