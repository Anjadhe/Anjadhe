import Foundation
import AnjadheCore

/// The views this phone can build by ITSELF when the Mac cannot answer
/// (docs/MOBILE_NATIVE.md "M5", phase 2). `MacViews.localBuilder` calls
/// `build` only then: the Mac is asked first whenever it is reachable, and
/// its answer replaces a phone-built one the moment it arrives. Each answer
/// has the same JSON shape as the Mac's `js/agent/mobile-views.js`, so the
/// screens draw it unchanged and say only that it was built here.
///
/// What is here, and why only this:
///   • tasks / task / tasks-action — synced blobs; TaskList.swift is a port
///     pinned to the desktop by a shared golden file (TaskListParityTests).
///   • news-saved — the synced reading list.
///   • news / news-article — see PhoneNews.swift.
///   • portfolio / -tickers / -ticker / -strategy / -news / -action — see
///     PhoneFolio.swift; the holdings maths is PortfolioLogic.swift, pinned
///     by PortfolioParityTests (M5 phase 3).
/// Not here: insights (the mailbox is the Mac's), home (live Mac state).
struct PhoneViews {
    let store: AppStore
    let chat: ChatState

    struct Failure: LocalizedError {
        let message: String
        init(_ m: String) { message = m }
        var errorDescription: String? { message }
    }

    /// False when this view cannot be built on the phone (the caller then
    /// shows the Mac's own failure).
    func build(_ view: String, _ params: [String: JSONValue]?,
               _ done: @escaping (Result<JSONValue, Error>) -> Void) -> Bool {
        let p = params ?? [:]
        switch view {
        case "tasks":
            done(.success(TaskList.view(slice: p["slice"]?.stringValue, group: p["group"]?.stringValue, taskContext())))
        case "task":
            let id = p["id"]?.stringValue ?? ""
            if let d = TaskList.detail(id: id, updates: updates(for: "task:\(id)"), taskContext()) { done(.success(d)) }
            else { done(.failure(Failure("That task is gone."))) }
        case "tasks-action":
            done(tasksAction(p))
        case "news-saved":
            done(.success(newsSaved()))
        case "news", "news-article", "news-action":
            return PhoneNews(store: store, chat: chat).build(view, p, done)
        case "portfolio", "portfolio-tickers", "portfolio-ticker", "portfolio-strategy", "portfolio-news", "portfolio-action":
            return PhoneFolio(store: store).build(view, p, done)
        default:
            return false
        }
        return true
    }

    // MARK: tasks

    private func taskContext() -> TaskList.Context {
        TaskList.Context(items: store.items("schedule", "scheduleItems"),
                         goals: store.items("goals", "goals"),
                         links: store.items("links", "links"),
                         today: DateLogic.todayStr())
    }

    /// UpdateStore.listFor(key, {limit: 20}), in the view's `updates` shape.
    private func updates(for key: String) -> [JSONValue] {
        store.items("updates", "updates")
            .filter { $0["key"]?.stringValue == key }
            .sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
            .prefix(20)
            .map { u in .object(["id": u["id"] ?? .null,
                                 "at": u["at"] ?? u["createdAt"] ?? .null,
                                 "text": .string(String((u["text"]?.stringValue ?? "").prefix(2000)))]) }
    }

    /// The checkbox, written to the synced blob here (the Mac's version runs
    /// its own `toggleComplete`; `TaskList.setDone` ports it). It uploads
    /// with the next sync.
    private func tasksAction(_ p: [String: JSONValue]) -> Result<JSONValue, Error> {
        let action = p["action"]?.stringValue ?? ""
        let id = p["id"]?.stringValue ?? ""
        guard action == "complete" || action == "uncomplete" else { return .failure(Failure("unknown action")) }
        var items = store.items("schedule", "scheduleItems")
        guard let i = items.firstIndex(where: { $0["id"]?.stringValue == id }) else { return .failure(Failure("That task is gone.")) }
        let now = Date()
        items[i] = TaskList.setDone(items[i], done: action == "complete", today: DateLogic.todayStr(),
                                    now: KVStore.nowISO(), nowMs: now.timeIntervalSince1970 * 1000)
        store.saveItems("schedule", "scheduleItems", items)
        return .success(.object(["ok": .bool(true), "action": .string(action), "id": .string(id),
                                 "task": TaskList.row(items[i], taskContext())]))
    }

    // MARK: saved news (MobileViews._newsSaved)

    private func newsSaved() -> JSONValue {
        // A bare array, not an object — read the raw value.
        let saved = store.kv.get("app_news-saved")?.arrayValue ?? []
        func str(_ v: JSONValue?, _ max: Int = 10_000) -> String { String((v?.stringValue ?? "").prefix(max)) }
        let rows: [JSONValue] = saved.prefix(300).compactMap { it -> JSONValue? in
            let title = str(it["title"], 200), url = str(it["url"])
            guard !title.isEmpty || !url.isEmpty else { return nil }
            return .object([
                "url": .string(url), "openUrl": .string(str(it["openUrl"])),
                "title": .string(title), "source": .string(str(it["source"], 60)),
                "sourceUrl": .string(str(it["sourceUrl"], 300)), "topic": .string(str(it["topic"])),
                "publishedAt": it["publishedAt"] ?? .null, "savedAt": it["savedAt"] ?? .null,
                "updated": .bool(PhoneNews.isUpdate(it)),
            ])
        }
        return .object(["at": .number(Date().timeIntervalSince1970 * 1000), "items": .array(rows)])
    }
}
