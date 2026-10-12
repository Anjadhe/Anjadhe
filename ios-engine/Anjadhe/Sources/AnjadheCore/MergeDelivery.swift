import Foundation

/// Transport seam only. A production implementation must authenticate its
/// device/session, bound response bytes and accept uploads idempotently by dot.
/// No HTTP endpoints, background scheduling or key enrollment are implied here.
public protocol MergeMailboxTransport {
    func upload(datasetID: String, epoch: Int, envelopes: [JSONValue]) async throws -> Int
    func download(datasetID: String, epoch: Int, after cursor: String) async throws -> MergeMailboxPage
    func acknowledgeApplied(datasetID: String, epoch: Int, frontier: [String: Int]) async throws
}

public struct MergeMailboxPage {
    public let envelopes: [JSONValue]
    public let nextCursor: String
    public let hasMore: Bool
    public init(envelopes: [JSONValue], nextCursor: String, hasMore: Bool) {
        self.envelopes = envelopes; self.nextCursor = nextCursor; self.hasMore = hasMore
    }
}

/// One bounded foreground pass, tested with an injected durable mailbox.
/// D1 Upload confirmation means cloud storage only, never peer application.
/// D2 Cursor + inbox + projection commit before acknowledging applied state.
/// D3 Lost acknowledgments retry saved ciphertext or committed frontiers.
/// D4 Remote records do not enqueue actions or inference.
public actor MergeDeliveryCoordinator {
    public enum Failure: Error { case alreadyRunning, invalidAcknowledgment, invalidPage, invalidBudget }
    private let store: LocalRecordStore
    private let transport: any MergeMailboxTransport
    private let datasetID: String
    private let epoch: Int
    private let datasetKey: Data
    private let signingSeed: Data
    private let authorizedWriters: [String: Data]
    private var running = false

    /// The caller supplies a trusted membership snapshot. Rotation/revocation
    /// must replace this coordinator; live membership transitions are unbuilt.
    public init(store: LocalRecordStore, transport: any MergeMailboxTransport, datasetID: String, epoch: Int = 1,
                datasetKey: Data, signingSeed: Data, authorizedWriters: [String: Data]) {
        self.store = store; self.transport = transport; self.datasetID = datasetID; self.epoch = epoch
        self.datasetKey = datasetKey; self.signingSeed = signingSeed; self.authorizedWriters = authorizedWriters
    }

    @discardableResult
    public func synchronize(pageBudget: Int = 8) async throws -> LocalRecordStore.MergeDeliveryState {
        guard (1...32).contains(pageBudget) else { throw Failure.invalidBudget }
        guard !running else { throw Failure.alreadyRunning }
        running = true; defer { running = false }
        // Separate bounded budgets ensure a busy local outbox cannot starve
        // incoming work. More work waits for an explicit subsequent pass.
        for _ in 0..<pageBudget {
            try Task.checkCancellation()
            let state = try store.mergeDeliveryState(datasetID: datasetID, epoch: epoch)
            let page = try store.encryptedMergeOutbox(datasetID: datasetID, epoch: epoch, datasetKey: datasetKey,
                signingSeed: signingSeed, after: state.uploadedSequence, limit: 100)
            guard let last = page.last?["sequence"]?.numberValue else { break }
            let acknowledged = try await transport.upload(datasetID: datasetID, epoch: epoch, envelopes: page)
            try Task.checkCancellation()
            guard acknowledged == Int(last) else { throw Failure.invalidAcknowledgment }
            try store.confirmMergeUpload(datasetID: datasetID, epoch: epoch, expectedSequence: state.uploadedSequence, through: acknowledged)
        }
        for _ in 0..<pageBudget {
            try Task.checkCancellation()
            let state = try store.mergeDeliveryState(datasetID: datasetID, epoch: epoch)
            let page = try await transport.download(datasetID: datasetID, epoch: epoch, after: state.cursor)
            try Task.checkCancellation()
            guard !page.hasMore || !page.nextCursor.utf8.elementsEqual(state.cursor.utf8) else { throw Failure.invalidPage }
            let applied = try store.ingestEncryptedMergePage(page.envelopes, datasetID: datasetID, epoch: epoch,
                datasetKey: datasetKey, authorizedWriters: authorizedWriters, expectedCursor: state.cursor, nextCursor: page.nextCursor)
            // Even an empty page re-sends the current frontier, repairing an
            // acknowledgment lost after the previous durable cursor commit.
            try await transport.acknowledgeApplied(datasetID: datasetID, epoch: epoch, frontier: applied.frontier)
            if !page.hasMore { break }
        }
        return try store.mergeDeliveryState(datasetID: datasetID, epoch: epoch)
    }
}
