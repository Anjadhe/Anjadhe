import Foundation

/// Explicit adapter for an already enrolled, bootstrapped dataset. It does not
/// enroll, start delivery, import private chats or activate received conversations.
/// Shared JS creates the plan; SQLite commits the local snapshot and all dots.
public struct ConversationSyncDraft {
    fileprivate let mutations: [JSONValue]
    fileprivate let entry: RemoteEntry
    fileprivate let expected: RemoteEntry?
    fileprivate let frontier: [String: Int]
    fileprivate let datasetID: String
    fileprivate let epoch: Int
}

public actor ConversationSyncWriter {
    private let core = SharedCore()
    private let store: LocalRecordStore
    private let datasetID: String
    private let epoch: Int
    public init(store: LocalRecordStore, datasetID: String, epoch: Int = 1) {
        self.store = store; self.datasetID = datasetID; self.epoch = epoch
    }
    public func prepare(_ conversations: JSONValue) async throws -> ConversationSyncDraft {
        let before = try store.legacySnapshot()["app_agent-conversations"]
        let frontier = try store.mergeFrontier(datasetID: datasetID, epoch: epoch)
        let records = try store.mergedConversations(datasetID: datasetID, epoch: epoch)
        let result = try await core.call(.conversationSyncPlan, arguments: [
            before?.value ?? .object(["conversations": .array([])]), conversations, .array(records)
        ])
        guard let mutations = result["mutations"]?.arrayValue, let value = result["value"] else { throw LocalRecordStore.StoreError.invalidRecord }
        return ConversationSyncDraft(mutations: mutations, entry: RemoteEntry(value: value, deleted: false, modifiedAt: KVStore.nowISO()),
                                     expected: before, frontier: frontier, datasetID: datasetID, epoch: epoch)
    }
    public func commit(_ draft: ConversationSyncDraft) throws {
        guard draft.datasetID == datasetID, draft.epoch == epoch else { throw LocalRecordStore.StoreError.invalidRecord }
        try store.commitConversationBatch(draft.mutations, entry: draft.entry, expected: draft.expected,
                                          datasetID: datasetID, epoch: epoch, expectedFrontier: draft.frontier)
    }
    /// Read-only projection. Calling this never saves a compatibility blob or
    /// schedules a turn; conflicts and orphaned branches remain explicit.
    public func projection() async throws -> JSONValue {
        try await core.call(.conversationSyncProject, arguments: [.array(store.mergedConversations(datasetID: datasetID, epoch: epoch))])
    }
}
