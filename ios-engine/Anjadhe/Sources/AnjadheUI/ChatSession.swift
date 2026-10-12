import Foundation
import Combine
import AnjadheCore

@MainActor final class ChatSession: ObservableObject {
    typealias Transport = (JSONValue, DeviceCloudCredential) async throws -> JSONValue
    @Published private(set) var running = false
    @Published private(set) var error: String?
    @Published private(set) var pendingSave = false
    @Published private(set) var activeConversation: String?
    private let writer = ChatTurnStore()
    private let transport: Transport
    private var retryEvent: JSONValue?
    private var worker: Task<Void, Never>?
    private var stopRequested = false

    init(transport: @escaping Transport = { try await CloudClient.complete($0, credential: $1) }) { self.transport = transport }

    func turn(_ conversation: String, store: AppStore) -> JSONValue? {
        (store.blob("device-turns")["runs"]?.objectValue ?? [:]).values
            .filter { $0["conversation"]?.stringValue == conversation }
            .sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }.first
    }
    private func event(_ kind: String, id: String, fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["kind": .string(kind), "id": .string(id)]) { _, new in new })
    }
    private func save(_ event: JSONValue, store: AppStore) async -> ChatCheckpoint? {
        guard store.hydrated else { error = "Your records are still loading."; return nil }
        do {
            let checkpoint = try await writer.prepare(event, in: store.kv)
            try writer.commit(checkpoint, to: store.kv)
            store.bump(); retryEvent = nil; pendingSave = false; error = nil
            return checkpoint
        } catch let failure as RecordWriter.Failure {
            retryEvent = nil; pendingSave = false; error = failure.localizedDescription
            return nil
        } catch LocalRecordStore.StoreError.staleRevision where event["kind"]?.stringValue == "approve" {
            retryEvent = nil; pendingSave = false; error = "Your records changed. Review this action again."
            return nil
        } catch {
            // Keep the response/event in memory, not a closure that calls AI.
            retryEvent = event; pendingSave = true
            self.error = "Couldn’t save this step. Retry saving to keep the result. No model request will be repeated."
            return nil
        }
    }
    func begin(conversation: String, thread: String, text: String, source: Bool, model: String, credential: DeviceCloudCredential, store: AppStore) async -> Bool {
        guard !running, !pendingSave else { return false }
        running = true; activeConversation = conversation; stopRequested = false
        let id = UUID().uuidString
        let first = await save(event("start", id: id, fields: ["conversation": .string(conversation), "thread": .string(thread),
            "text": .string(text), "untrusted": .bool(source), "model": .string(model)]), store: store)
        running = false
        guard let first else { return false }
        if stopRequested { _ = await save(event("stop", id: id), store: store); return true }
        launch(first, credential: credential, store: store)
        return true
    }
    private func launch(_ checkpoint: ChatCheckpoint, credential: DeviceCloudCredential, store: AppStore) {
        running = true; stopRequested = false
        worker = Task { await pump(checkpoint, credential: credential, store: store) }
    }
    private func pump(_ initial: ChatCheckpoint, credential: DeviceCloudCredential, store: AppStore) async {
        defer { running = false; worker = nil }
        var checkpoint = initial
        guard let id = initial.turn["id"]?.stringValue else { return }
        while !Task.isCancelled {
            if let request = checkpoint.request, let requestId = request["requestId"]?.stringValue {
                // The requesting checkpoint is already durable here.
                let nextEvent: JSONValue
                do {
                    let response = try await transport(request, credential)
                    nextEvent = event("receive", id: id, fields: ["requestId": .string(requestId), "message": response])
                } catch {
                    nextEvent = event(stopRequested ? "stop" : "failed", id: id, fields: ["requestId": .string(requestId)])
                }
                // Cancellation must still record uncertainty; a detached main
                // actor task checkpoints it without inheriting cancellation.
                let saved = await Task { @MainActor in await self.save(nextEvent, store: store) }.value
                guard let saved else { return }
                checkpoint = saved
            } else {
                let phase = checkpoint.turn["phase"]?.stringValue ?? ""
                guard ["ready", "tools", "checkReady", "captureReady"].contains(phase) else { return }
                guard let next = await save(event("drive", id: id), store: store) else { return }
                checkpoint = next
            }
        }
        if stopRequested { _ = await Task { @MainActor in await self.save(self.event("stop", id: id), store: store) }.value }
    }
    func act(_ kind: String, conversation: String, credential: DeviceCloudCredential?, store: AppStore) async {
        guard !running, !pendingSave, let turn = turn(conversation, store: store), let id = turn["id"]?.stringValue else { return }
        guard credential != nil || ["stop", "decline"].contains(kind) else { error = "Choose a model in Settings to continue."; return }
        activeConversation = conversation; running = true; stopRequested = false
        let checkpoint = await save(event(kind, id: id), store: store)
        running = false
        if stopRequested, kind != "stop" { _ = await save(event("stop", id: id), store: store); return }
        if let checkpoint, let credential, kind != "stop" { launch(checkpoint, credential: credential, store: store) }
    }
    func retrySaving(credential: DeviceCloudCredential?, store: AppStore) async {
        guard !running, let retryEvent else { return }
        // A dispatch checkpoint retry needs credentials before committing it,
        // otherwise it would be left marked requesting without being sent.
        guard credential != nil || ["receive", "failed", "stop", "decline"].contains(retryEvent["kind"]?.stringValue ?? "") else {
            error = "Choose a model in Settings, then retry saving."; return
        }
        running = true
        let checkpoint = await save(retryEvent, store: store)
        running = false
        if let checkpoint, let credential { launch(checkpoint, credential: credential, store: store) }
    }
    func stop(conversation: String, store: AppStore) async {
        if running && activeConversation == conversation { stopRequested = true; worker?.cancel() }
        else { await act("stop", conversation: conversation, credential: nil, store: store) }
    }
}
