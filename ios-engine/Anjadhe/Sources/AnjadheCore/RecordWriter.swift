import Foundation

/// A checked draft is immutable between review and commit. Its snapshots and
/// changes cannot be constructed by a UI or a model response.
public struct RecordDraft {
    public let receipt: JSONValue?
    public let record: JSONValue?
    public let unchanged: Bool
    public let replay: Bool
    fileprivate let changes: [String: JSONValue]
    fileprivate let expected: [String: RemoteEntry]
}

/// Swift hosts persistence; all record judgment stays in the shared JS rules.
@MainActor
public final class RecordWriter {
    public enum Failure: Error, LocalizedError {
        case rejected(String), invalidResult
        public var errorDescription: String? {
            switch self {
            case .rejected(let message): return message
            case .invalidResult: return "Couldn’t check this action. Nothing was changed."
            }
        }
    }
    public static let keys = ["app_commitments", "app_matters", "app_senders", "app_record-receipts"]
    private let core: SharedCore
    public init(core: SharedCore = SharedCore()) { self.core = core }

    public func prepare(_ command: JSONValue, in store: KVStore) async throws -> RecordDraft {
        let before = store.exportValues(Self.keys)
        let blobs = Dictionary(uniqueKeysWithValues: before.compactMap { key, entry -> (String, JSONValue)? in
            guard !entry.deleted, let value = entry.value else { return nil }
            return (String(key.dropFirst(4)), value)
        })
        let result = try await core.call(.prepareRecords, arguments: [.object(blobs), command])
        guard result["ok"]?.boolValue == true else {
            throw Failure.rejected(result["error"]?.stringValue ?? "Couldn’t check this action.")
        }
        guard let raw = result["changes"]?.objectValue else { throw Failure.invalidResult }
        let changes = Dictionary(uniqueKeysWithValues: raw.map { ("app_" + $0.key, $0.value) })
        guard Set(changes.keys).isSubset(of: Set(Self.keys)) else { throw Failure.invalidResult }
        return RecordDraft(receipt: result["receipt"], record: result["record"],
                           unchanged: result["unchanged"]?.boolValue == true, replay: result["replay"]?.boolValue == true,
                           changes: changes, expected: before)
    }

    /// Call only from an explicit approval action. Retain the same draft if
    /// persistence fails: retrying never reruns judgment or creates new ids.
    public func commit(_ draft: RecordDraft, to store: KVStore) throws {
        try store.setBatch(draft.changes, expected: draft.expected, readKeys: Self.keys, now: KVStore.nowISO())
    }
}
