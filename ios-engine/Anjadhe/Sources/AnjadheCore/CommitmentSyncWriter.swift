import Foundation

/// Opt-in adapter for an enrolled, bootstrapped dataset. The shared JavaScript
/// planner owns record semantics; SQLite saves snapshot and operations together.
/// This never enrolls a device, installs incoming records or starts execution.
public struct CommitmentSyncDraft {
    fileprivate let mutations: [JSONValue]
    fileprivate let entry: RemoteEntry
    fileprivate let expected: RemoteEntry?
    fileprivate let frontier: [String: Int]
    fileprivate let datasetID: String
    fileprivate let epoch: Int
}

public actor CommitmentSyncWriter {
    private let core = SharedCore()
    private let store: LocalRecordStore
    private let datasetID: String
    private let epoch: Int
    public init(store: LocalRecordStore, datasetID: String, epoch: Int = 1) {
        self.store = store; self.datasetID = datasetID; self.epoch = epoch
    }
    public func prepare(_ commitments: JSONValue) async throws -> CommitmentSyncDraft {
        let before = try store.legacySnapshot()["app_commitments"]
        let frontier = try store.mergeFrontier(datasetID: datasetID, epoch: epoch)
        let records = try store.mergedCommitments(datasetID: datasetID, epoch: epoch)
        let result = try await core.call(.commitmentSyncPlan, arguments: [
            before?.value ?? .object(["items": .array([])]), commitments, .array(records)
        ])
        guard let mutations = result["mutations"]?.arrayValue, let value = result["value"] else { throw LocalRecordStore.StoreError.invalidRecord }
        return CommitmentSyncDraft(mutations: mutations, entry: RemoteEntry(value: value, deleted: false, modifiedAt: KVStore.nowISO()),
                                   expected: before, frontier: frontier, datasetID: datasetID, epoch: epoch)
    }
    public func commit(_ draft: CommitmentSyncDraft) throws {
        guard draft.datasetID == datasetID, draft.epoch == epoch else { throw LocalRecordStore.StoreError.invalidRecord }
        try store.commitTypedSnapshot(draft.mutations, entry: draft.entry, expected: draft.expected, key: "app_commitments",
                                      datasetID: datasetID, epoch: epoch, expectedFrontier: draft.frontier)
    }
    public func projection() async throws -> JSONValue {
        try await core.call(.commitmentSyncProject, arguments: [.array(store.mergedCommitments(datasetID: datasetID, epoch: epoch))])
    }
}
