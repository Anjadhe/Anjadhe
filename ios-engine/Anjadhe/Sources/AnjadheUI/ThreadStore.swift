import Foundation
import AnjadheCore

/// Swift holds display values, not another implementation of thread rules.
@MainActor final class ThreadStore: ObservableObject {
    @Published private(set) var threads: [JSONValue] = []
    @Published private(set) var allThreads: [JSONValue] = []
    private var homes: [String: JSONValue] = [:]
    @Published private(set) var schedule: JSONValue = .object([:])
    @Published private(set) var error: String?
    private let core = SharedCore()
    private var generation = 0
    private var focusedThread: String?
    func focus(_ id: String, store: AppStore, now: Date = Date()) async {
        focusedThread = id
        await refresh(store, now: now)
    }
    func refresh(_ store: AppStore, now: Date = Date()) async {
        guard store.hydrated else { return }
        generation += 1
        let ticket = generation
        let records: JSONValue = .object([
            "senders": .object(store.blob("senders")), "matters": .object(store.blob("matters")),
            "commitments": .object(store.blob("commitments")), "conversations": .object(store.blob("agent-conversations")),
            "thread-panels": .object(store.blob("thread-panels"))
        ])
        do {
            let requested: JSONValue = .object(["panelKeys": .array(focusedThread.map { [.string($0)] } ?? [])])
            let result = try await core.call(.snapshot, arguments: [records, .string(DateLogic.todayStr(now)), .number(now.timeIntervalSince1970 * 1000), requested])
            guard ticket == generation, !Task.isCancelled else { return }
            threads = result["threads"]?.arrayValue ?? []
            allThreads = threads + (result["otherThreads"]?.arrayValue ?? [])
            homes = result["homes"]?.objectValue ?? [:]
            schedule = result["schedule"] ?? .object([:])
            error = nil
        } catch is CancellationError { }
        catch { if ticket == generation { self.error = "Couldn’t read your threads. Your saved records are unchanged." } }
    }
    func home(for id: String) -> String { homes[id]?.stringValue ?? id }
    func thread(_ id: String) -> JSONValue? { allThreads.first { $0["key"]?.stringValue == home(for: id) } }
}
