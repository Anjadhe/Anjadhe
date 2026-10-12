import XCTest
import AnjadheCore
@testable import AnjadheUI

@MainActor final class ChatSessionTests: XCTestCase {
    private let credential = DeviceCloudCredential(apiKey: "test-only-never-sent", baseURL: CloudClient.defaultBase)
    private func settle(_ chat: ChatSession) async throws {
        for _ in 0..<300 {
            if !chat.running { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("The turn did not settle")
    }
    private func start(_ chat: ChatSession, _ store: AppStore) async -> Bool {
        await chat.begin(conversation: "test-chat", thread: "nenva", text: "Add a task to pay tuition", source: false,
                         model: "nenva-cloud", credential: credential, store: store)
    }
    private var proposal: JSONValue {
        try! JSONValue.parse(#"{"tool_calls":[{"function":{"name":"add_commitment","arguments":"{\"title\":\"Pay tuition\",\"date\":\"2026-10-20\"}"}}]}"#)
    }

    func testNoInferenceBeforeUserTurnAndDispatchAreDurable() async throws {
        let store = AppStore()
        var calls = 0
        let chat = ChatSession { _, _ in calls += 1; return .object(["content": .string("Hello")]) }
        store.kv.commitBatch = { _, _, _ in throw TransactionalStore.Failure.notReady }
        let started = await start(chat, store)
        XCTAssertFalse(started)
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(chat.pendingSave)
        XCTAssertTrue(store.kv.snapshot().isEmpty)
    }

    func testFailedResponseSaveRetriesWithoutRepeatingInference() async throws {
        let store = AppStore()
        var calls = 0
        let chat = ChatSession { _, _ in
            calls += 1
            let phase = store.blob("device-turns")["runs"]?.objectValue?.values.first?["phase"]
            XCTAssertEqual(phase, .string("requesting"), "Dispatch marker must be durable first")
            XCTAssertEqual(store.items("agent-conversations", "conversations").first?["messages"]?.arrayValue?.count, 1)
            if calls == 1 {
                store.kv.commitBatch = { _, _, _ in throw TransactionalStore.Failure.notReady }
                return .object(["content": .string("I can help you plan it.")])
            }
            return .object(["content": .string(#"{"claims":[],"asked":[]}"#)])
        }
        let started = await start(chat, store); XCTAssertTrue(started)
        try await settle(chat)
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(chat.pendingSave)
        XCTAssertEqual(chat.turn("test-chat", store: store)?["phase"], .string("requesting"))
        store.kv.commitBatch = nil
        await chat.retrySaving(credential: credential, store: store)
        try await settle(chat)
        XCTAssertEqual(calls, 2, "One answer call and one distinct claim-check call; the answer is reused")
        XCTAssertEqual(chat.turn("test-chat", store: store)?["phase"], .string("complete"))
        XCTAssertEqual(store.items("agent-conversations", "conversations").first?["messages"]?.arrayValue?.count, 2)
    }

    func testApprovalCommitsWithTurnResultAndRetryDoesNotDuplicate() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-chat-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = try TransactionalStore(directory: directory), kv = KVStore()
        disk.attach(to: kv, rows: try disk.snapshot())
        let store = AppStore(kv: kv)
        var calls = 0
        let proposal = self.proposal
        let chat = ChatSession { _, _ in
            calls += 1
            return calls == 1 ? proposal : .object(["content": .string(calls == 2 ? "Added Pay tuition." : #"{"claims":[],"asked":[]}"#)])
        }
        let started = await start(chat, store); XCTAssertTrue(started)
        try await settle(chat)
        XCTAssertEqual(chat.turn("test-chat", store: store)?["phase"], .string("approval"))
        XCTAssertTrue(store.items("commitments", "items").isEmpty)
        let persistence = kv.commitBatch
        kv.commitBatch = { _, _, _ in throw TransactionalStore.Failure.notReady }
        await chat.act("approve", conversation: "test-chat", credential: credential, store: store)
        XCTAssertTrue(chat.pendingSave)
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(store.items("commitments", "items").isEmpty)
        kv.commitBatch = persistence
        await chat.retrySaving(credential: credential, store: store)
        try await settle(chat)
        XCTAssertEqual(store.items("commitments", "items").count, 1)
        XCTAssertEqual(store.items("record-receipts", "items").count, 1)
        XCTAssertEqual(calls, 3)
        let reopened = try TransactionalStore(directory: directory)
        let rows = try reopened.snapshot()
        XCTAssertEqual(rows["app_commitments"]?.value?["items"]?.arrayValue?.count, 1)
        XCTAssertEqual(rows["app_agent-conversations"]?.value?["conversations"]?.arrayValue?.first?["messages"]?.arrayValue?.count, 2)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(rows), as: UTF8.self).contains(credential.apiKey))
    }

    func testApprovalReopensAfterRelaunchAndRejectsAnOldReview() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nenva-approval-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = try TransactionalStore(directory: directory), kv = KVStore()
        disk.attach(to: kv, rows: try disk.snapshot())
        let store = AppStore(kv: kv), proposal = self.proposal
        let chat = ChatSession { _, _ in proposal }
        let started = await start(chat, store); XCTAssertTrue(started)
        try await settle(chat)
        let reopenedDisk = try TransactionalStore(directory: directory), reopenedKV = KVStore()
        reopenedDisk.attach(to: reopenedKV, rows: try reopenedDisk.snapshot())
        let reopened = AppStore(kv: reopenedKV)
        let fresh = ChatSession { _, _ in XCTFail("A stale review must not call AI"); return .null }
        XCTAssertEqual(fresh.turn("test-chat", store: reopened)?["phase"], .string("approval"))
        XCTAssertTrue(reopened.saveBlob("matters", ["matters": .object([:]), "edited": .bool(true)]))
        await fresh.act("approve", conversation: "test-chat", credential: credential, store: reopened)
        XCTAssertFalse(fresh.pendingSave)
        XCTAssertNotNil(fresh.error)
        XCTAssertTrue(reopened.items("commitments", "items").isEmpty)
        await fresh.act("review", conversation: "test-chat", credential: credential, store: reopened)
        try await settle(fresh)
        XCTAssertEqual(fresh.turn("test-chat", store: reopened)?["phase"], .string("approval"))
        XCTAssertNil(fresh.error)
    }

    func testFollowUpReadsTheSavedCommitmentWithoutAnotherWrite() async throws {
        let store = AppStore()
        XCTAssertTrue(store.saveItems("commitments", "items", [.object([
            "id": .string("fee"), "title": .string("Pay tuition"), "state": .string("open"),
            "when": .object(["date": .string("2026-10-20")]), "repeat": .object(["rule": .string("none")])
        ])]))
        var calls = 0
        let chat = ChatSession { request, _ in
            calls += 1
            if calls == 1 { return try JSONValue.parse(#"{"tool_calls":[{"function":{"name":"get_commitment","arguments":"{\"id\":\"fee\"}"}}]}"#) }
            if calls == 2 {
                let message = request["messages"]?.arrayValue?.last
                XCTAssertEqual(message?["role"], .string("tool"))
                XCTAssertTrue(message?["content"]?.stringValue?.contains("2026-10-20") == true)
                return .object(["content": .string("Tuition is due October 20.")])
            }
            return .object(["content": .string(#"{"claims":[],"asked":[]}"#)])
        }
        let started = await chat.begin(conversation: "follow-up", thread: "nenva", text: "When is tuition due?", source: false, model: "nenva-cloud", credential: credential, store: store)
        XCTAssertTrue(started); try await settle(chat)
        XCTAssertEqual(chat.turn("follow-up", store: store)?["phase"], .string("complete"))
        XCTAssertEqual(store.items("commitments", "items").count, 1)
        XCTAssertTrue(store.items("record-receipts", "items").isEmpty)
    }

    func testStopRecordsCancellationWithoutRetryingTheRequest() async throws {
        let store = AppStore()
        var calls = 0
        let chat = ChatSession { _, _ in
            calls += 1
            try await Task.sleep(nanoseconds: 60_000_000_000)
            return .object(["content": .string("Too late")])
        }
        let started = await start(chat, store); XCTAssertTrue(started)
        for _ in 0..<100 where calls == 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(calls, 1)
        await chat.stop(conversation: "test-chat", store: store)
        try await settle(chat)
        XCTAssertEqual(chat.turn("test-chat", store: store)?["phase"], .string("stopped"))
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(chat.pendingSave)
        XCTAssertTrue(store.items("record-receipts", "items").isEmpty)
    }

    func testDeclineAndUncertainNetworkDoNotWriteOrAutomaticallyRetry() async throws {
        let store = AppStore()
        var calls = 0
        let proposal = self.proposal
        let chat = ChatSession { _, _ in calls += 1; return proposal }
        let started = await start(chat, store); XCTAssertTrue(started)
        try await settle(chat)
        await chat.act("decline", conversation: "test-chat", credential: nil, store: store)
        XCTAssertTrue(store.items("commitments", "items").isEmpty)
        XCTAssertEqual(calls, 1)
        let failing = ChatSession { _, _ in calls += 1; throw URLError(.timedOut) }
        let second = await start(failing, store); XCTAssertTrue(second)
        try await settle(failing)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(failing.turn("test-chat", store: store)?["phase"], .string("interrupted"))
        // Recreating the UI has no work-on-load hook and cannot spend again.
        let relaunched = ChatSession { _, _ in XCTFail("No automatic resume"); return .null }
        XCTAssertEqual(relaunched.turn("test-chat", store: store)?["phase"], .string("interrupted"))
        XCTAssertFalse(relaunched.running)
    }
}
