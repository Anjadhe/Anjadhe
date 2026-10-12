import Foundation

/// Explicit adapter for an already enrolled, bootstrapped dataset. It does not
/// enroll, start delivery or install received thread placements in the live store.
/// Shared JS creates the plan; SQLite commits the local snapshot and all dots.
public struct SenderSyncDraft {
    fileprivate let mutations: [JSONValue]
    fileprivate let entry: RemoteEntry
    fileprivate let expected: RemoteEntry?
    fileprivate let frontier: [String: Int]
    fileprivate let datasetID: String
    fileprivate let epoch: Int
}

public actor SenderSyncWriter {
    private let core = SharedCore()
    private let store: LocalRecordStore
    private let datasetID: String
    private let epoch: Int
    public init(store: LocalRecordStore, datasetID: String, epoch: Int = 1) {
        self.store = store; self.datasetID = datasetID; self.epoch = epoch
    }
    public func prepare(_ senders: JSONValue) async throws -> SenderSyncDraft {
        let before = try store.legacySnapshot()["app_senders"]
        let frontier = try store.mergeFrontier(datasetID: datasetID, epoch: epoch)
        let records = try store.mergedSenders(datasetID: datasetID, epoch: epoch)
        let result = try await core.call(.senderSyncPlan, arguments: [
            before?.value ?? .object(["senders": .object([:]), "place": .object([:])]), senders, .array(records)
        ])
        guard let mutations = result["mutations"]?.arrayValue, let value = result["value"] else { throw LocalRecordStore.StoreError.invalidRecord }
        return SenderSyncDraft(mutations: mutations, entry: RemoteEntry(value: value, deleted: false, modifiedAt: KVStore.nowISO()),
                                     expected: before, frontier: frontier, datasetID: datasetID, epoch: epoch)
    }
    public func commit(_ draft: SenderSyncDraft) throws {
        guard draft.datasetID == datasetID, draft.epoch == epoch else { throw LocalRecordStore.StoreError.invalidRecord }
        try store.commitTypedSnapshot(draft.mutations, entry: draft.entry, expected: draft.expected, key: "app_senders",
                                          datasetID: datasetID, epoch: epoch, expectedFrontier: draft.frontier)
    }
    /// Read-only projection. Calling this never saves a compatibility blob or
    /// schedules work; conflicts and missing placement targets remain explicit.
    public func projection() async throws -> JSONValue {
        try await core.call(.senderSyncProject, arguments: [.array(store.mergedSenders(datasetID: datasetID, epoch: epoch))])
    }
}
