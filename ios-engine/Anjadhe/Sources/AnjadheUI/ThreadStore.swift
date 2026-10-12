import Foundation
import AnjadheCore

/// Swift holds display values, not another implementation of thread rules.
@MainActor final class ThreadStore: ObservableObject {
    @Published private(set) var threads: [JSONValue] = []
    @Published private(set) var due: [JSONValue] = []
    @Published private(set) var error: String?
    private let core = SharedCore()
    private var generation = 0
    func refresh(_ store: AppStore) async {
        guard store.hydrated else { return }
        generation += 1
        let ticket = generation
        let records: JSONValue = .object([
            "senders": .object(store.blob("senders")), "matters": .object(store.blob("matters")),
            "commitments": .object(store.blob("commitments")), "conversations": .object(store.blob("agent-conversations"))
        ])
        do {
            let result = try await core.call(.snapshot, arguments: [records, .string(DateLogic.todayStr())])
            guard ticket == generation, !Task.isCancelled else { return }
            threads = result["threads"]?.arrayValue ?? []
            due = result["due"]?.arrayValue ?? []
            error = nil
        } catch is CancellationError { }
        catch { if ticket == generation { self.error = "Couldn’t read your threads. Your saved records are unchanged." } }
    }
    func thread(_ id: String) -> JSONValue? { threads.first { $0["key"]?.stringValue == id } }
}
