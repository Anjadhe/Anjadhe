#if DEBUG
import SwiftUI
import AnjadheCore

/// Local layout fixture: no files, Keychain, registration, sync or credentials.
/// The model choice draws the composer but cannot authorize a network request.
public struct MobileThreadsPreview: View {
    @StateObject private var store: AppStore
    @StateObject private var access = DeviceAccessModel.preview(registered: true, configured: true)
    @StateObject private var router: Router

    public init(thread: String? = nil) {
        let store = AppStore()
        let today = DateLogic.todayStr()
        let tomorrow = DateLogic.todayStr(Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
        let now = KVStore.nowISO()
        let start = DateLogic.todayStr(Calendar.current.date(byAdding: .day, value: -6, to: Date())!)
        let previous = DateLogic.todayStr(Calendar.current.date(byAdding: .day, value: -1, to: Date())!)
        let senders = try! JSONValue.parse(#"{"senders":{"sender:school":{"id":"sender:school","name":"School payments","allGood":"Every fee paid on time.","state":"active","confirmed":true},"sender:fitness":{"id":"sender:fitness","name":"Run a 10K","allGood":"Build up steadily and enjoy the race.","state":"active","confirmed":true}},"place":{"task:fees":{"sender":"sender:school"},"task:run":{"sender":"sender:fitness"}}}"#)
        store.saveBlob("senders", senders.objectValue!)
        store.saveBlob("commitments", ["items": .array([
            .object(["id": .string("fees"), "title": .string("Pay the music class fee"), "state": .string("open"), "when": .object(["date": .string(today)])]),
            .object(["id": .string("run"), "title": .string("Easy run, 30 minutes"), "state": .string("open"), "when": .object(["date": .string(today), "time": .string("17:30")]), "repeat": .object(["rule": .string("daily")])]),
            .object(["id": .string("milk"), "title": .string("Pick up milk"), "state": .string("open"), "when": .object(["date": .string(tomorrow)])])
        ])])
        store.saveBlob("agent-conversations", ["conversations": .array([
            .object(["id": .string("general"), "todayKey": .string("nenva"), "title": .string("This week"), "updatedAt": .string(now), "messages": .array([
                .object(["role": .string("user"), "content": .string("Help me keep this week manageable."), "timestamp": .string(now)]),
                .object(["role": .string("assistant"), "content": .string("Let’s take it one thing at a time. What would you like to focus on?"), "timestamp": .string(now)])
            ])]),
            .object(["id": .string("school"), "todayKey": .string("sender:school"), "title": .string("Music class"), "updatedAt": .string(now), "messages": .array([
                .object(["role": .string("assistant"), "content": .string("The music class fee is due today. You can see it in Today, or tell me when you’ve paid it."), "timestamp": .string(now)])
            ])])
        ])])
        // Supporting-panel fixtures use the same current store and shared core.
        var commitments = store.items("commitments", "items")
        if let runIndex = commitments.firstIndex(where: { $0["id"] == .string("run") }), var run = commitments[runIndex].objectValue {
            run["parent"] = .string("running-goal")
            run["when"] = .object(["date": .string(start), "time": .string("17:30")])
            run["history"] = .object([start: .string("done"), previous: .string("dropped")])
            commitments[runIndex] = .object(run)
        }
        commitments.append(.object([
            "id": .string("running-goal"), "title": .string("Run a 10K"), "state": .string("open"),
            "aim": .object(["measure": .string("distance"), "target": .number(6.2), "unit": .string("mi"), "dir": .string("up")]),
            "log": .object([
                start: .array([.object(["quote": .string("I ran 2 miles."), "measures": .array([.object(["name": .string("distance"), "value": .number(2), "unit": .string("mi")])])])]),
                previous: .array([.object(["quote": .string("I ran 3.1 miles."), "measures": .array([.object(["name": .string("distance"), "value": .number(3.1), "unit": .string("mi")])])])])
            ])
        ]))
        store.saveItems("commitments", "items", commitments)
        var placements = store.blob("senders")
        var place = placements["place"]?.objectValue ?? [:]
        place["task:running-goal"] = .object(["sender": .string("sender:fitness")])
        var bills: [String: JSONValue] = [:]
        for month in 0..<2 {
            let date = DateLogic.todayStr(Calendar.current.date(byAdding: .month, value: -month, to: Date())!)
            let key = "matter:class-fee-\(month)"
            bills[key] = .object(["id": .string(key), "title": .string("Music class fee"), "state": .string(month == 0 ? "open" : "done"), "amount": .string(month == 0 ? "$125.00" : "$79.50"), "when": .object(["date": .string(date)])])
            place[key] = .object(["sender": .string("sender:school")])
        }
        placements["place"] = .object(place)
        store.saveBlob("senders", placements)
        store.saveBlob("matters", ["matters": .object(bills)])
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--preview-mobile-panel-days") || arguments.contains("--preview-mobile-panel-line") {
            let first = arguments.contains("--preview-mobile-panel-days") ? "days:run" : "progress:line:running-goal:distance"
            store.saveBlob("thread-panels", ["byKey": .object(["sender:fitness": .object([
                "by": .string("you"), "order": .array([.string(first)])
            ])])])
        }
        let router = Router()
        if let thread { router.push(.thread(thread)) }
        _store = StateObject(wrappedValue: store)
        _router = StateObject(wrappedValue: router)
    }
    public var body: some View {
        Shell().environmentObject(store).environmentObject(access).environmentObject(router).tint(Theme.text)
    }
}
#endif
