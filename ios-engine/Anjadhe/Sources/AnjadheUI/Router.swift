import SwiftUI
import Combine
import AnjadheCore

// Navigation for the native shell. The function bar holds Now · Chats ·
// Memory · Settings; apps and records are pushed on the root that opened
// them. Switching roots preserves their stacks; tapping the active root
// returns to its top. Jobs and search remain secondary destinations.

/// Every pushable screen. Apps by id (see `AppCatalog`), records by id.
public enum Route: Hashable {
    case app(String)
    case task(String), note(String), prompt(String)
    case goal(String), feedItem(String)
    case insight(String)
    // Portfolio is an app with pages of its own (2026-09-21).
    // Each case carries one Hashable id and the screen looks the record up,
    // which is the rule every case above follows.
    case portfolioScope(String)          // "all" or an account id
    case ticker(String)
    case strategy(String)                // "" is the list
    case portfolioProperty(String)
    case portfolioLiability(String)
    // Tasks carries BOTH nav dimensions (2026-09-22): the time slice and the
    // optional other scope (a tag, a project, a source). They cross on the
    // Mac — "this week, tagged home" is one request — so a screen that held
    // only one of them could not ask for it.
    case tasksScope(String, String?)     // slice, group key
    // The nenva shell (2026-10-02): a job's page, and the chat list.
    case job(String)
    case chats
    // The fold (2026-10-08, the desktop's Now · Chats · Memory · Settings):
    // one conversation (the chat itself, pushed on Chats), the Memory doors,
    // and a folder from mail and texts (the Mac's MatterPage).
    case conversation
    case matter(String)
    case settingsPage(String)
    case file(String)                    // a file in the Mac's Documents
    case memoryPage(String)              // one Memory heading: its facts, editable            // mac · model · email · about · advanced
}

/// Now · Chats · Memory · Settings (2026-10-08, the desktop's nav since
/// 2026-10-07). `assistant` is Chats, `apps` is Memory; Jobs and Search have
/// no slot of their own (a job rides its chat's row, Search sits in
/// Memory's head) and keep their stacks only for old doors.
public enum RootTab: String, CaseIterable { case home, assistant, jobs, apps, search, settings }

public final class Router: ObservableObject {
    @Published public var tab: RootTab = .home
    @Published public var homePath: [Route] = []
    @Published public var assistantPath: [Route] = []
    @Published public var appsPath: [Route] = []
    @Published public var jobsPath: [Route] = []
    @Published public var searchPath: [Route] = []
    @Published public var settingsPath: [Route] = []

    /// A brief confirmation toast (Shell renders it).
    @Published public var toast: String?
    /// The Home/Projects composer doors: text carried into the Assistant
    /// root plus a token that asks the composer to take focus.
    @Published public var composePrefill: String?
    @Published public var composeFocusToken: Int = 0
    /// The assistant's composer has the keyboard (2026-09-21). The function
    /// bar stands down while it does: a chat with a composer AND a nav bar
    /// stacked under the keyboard is three bars deep, and the reading
    /// surface is what the screen is for.
    @Published public var composerFocused = false

    private var toastTimer: Timer?

    public init() {}

    public var path: [Route] {
        get { path(for: tab) }
        set { setPath(newValue, for: tab) }
    }
    public func path(for t: RootTab) -> [Route] {
        switch t {
        case .home: return homePath
        case .assistant: return assistantPath
        case .apps: return appsPath
        case .jobs: return jobsPath
        case .search: return searchPath
        case .settings: return settingsPath
        }
    }
    public func setPath(_ p: [Route], for t: RootTab) {
        switch t {
        case .home: homePath = p
        case .assistant: assistantPath = p
        case .apps: appsPath = p
        case .jobs: jobsPath = p
        case .search: searchPath = p
        case .settings: settingsPath = p
        }
    }
    /// A binding to the current tab's stack, for `NavigationStack(path:)`.
    public func binding(for t: RootTab) -> Binding<[Route]> {
        Binding(get: { self.path(for: t) }, set: { self.setPath($0, for: t) })
    }

    /// Switching roots preserves the destination's stack. Tapping the active
    /// root again returns to its top; merely changing tabs must not erase a
    /// record's route (MOBILE_UX.md).
    public func root(_ t: RootTab) {
        if tab == t { setPath([], for: t) }
        tab = t
    }
    /// Push a screen on the current root.
    public func push(_ r: Route) {
        switch r {
        case .note(let id), .task(let id): if id.isEmpty { return }
        default: break
        }
        path.append(r)
    }
    public func open(app id: String) {
        // Settings is a root now; a door to it switches tabs.
        if id == "settings" { root(.settings); return }
        push(.app(id))
    }

    /// Show the current conversation (ChatState already holds which one):
    /// Chats with the chat pushed on its list.
    public func showConversation() {
        assistantPath = [.conversation]
        tab = .assistant
    }
    public func pop() { if !path.isEmpty { path.removeLast() } }
    public func popToRoot() { path = [] }

    /// The Home composer door: carry text in and focus the Assistant input.
    public func openCompose(prefill: String? = nil) {
        if let p = prefill { composePrefill = p }
        composeFocusToken += 1
        showConversation()
    }

    /// A chat STARTED from a card or a Today row (2026-10-02): a new
    /// conversation, sent at once, answered on this phone. Distinct from
    /// `openCompose(prefill:)`, which only fills the box.
    @Published public var startChatText: String?
    public func startChat(_ text: String) {
        startChatText = text
        composeFocusToken += 1
        showConversation()
    }

    public func showToast(_ text: String) {
        toast = text
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 1.7, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.toast = nil }
        }
    }

    // MARK: Record links — anjadhe://<type>/<id> (the desktop RecordLinks vocabulary)

    /// Open the screen that shows a record; types the phone has no screen for
    /// (goal-less ids, email, insight, …) get an honest toast instead of a
    /// dead tap. Returns false when the URL is not an anjadhe record link.
    @discardableResult
    public func openRecordLink(_ url: String) -> Bool {
        let s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = s.range(of: "^anjadhe://([a-zA-Z-]+)/(.+)$", options: .regularExpression) else { return false }
        let body = String(s[r])
        let parts = body.dropFirst("anjadhe://".count).split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return true }
        let type = parts[0].lowercased()
        let id = parts[1].removingPercentEncoding ?? parts[1]
        switch type {
        case "task": push(.task(id))
        case "note": push(.note(id))
        case "event": push(.app("calendar"))
        case "routine": push(.prompt(id))
        case "goal", "project": push(.goal(id))
        case "insight", "email": push(.insight(id))
        case "matter": push(.matter(id))
        default: showToast("Open this one on your Mac")
        }
        return true
    }

    /// A tapped link inside model-written content: record links open the
    /// record's own screen; everything else opens outside the app.
    public func handleLink(_ url: URL) {
        if openRecordLink(url.absoluteString) { return }
        openURL(url.absoluteString)
    }
}

// MARK: - App catalog (the launcher grid order and the synced-config mapping)

public struct AppEntry: Identifiable {
    public let id: String        // phone id (route id)
    public let label: String
    public let symbol: String    // SF Symbol
    public let desktopId: String?  // registry id on the Mac (nil = no desktop counterpart)
}

public enum AppCatalog {
    /// Launcher grid order — mirrors the old mobile/app.js `apps` list.
    public static let apps: [AppEntry] = [
        AppEntry(id: "tasks", label: "Tasks", symbol: "checklist", desktopId: "actions"),
        AppEntry(id: "goals", label: "Projects", symbol: "scope", desktopId: "goals"),
        AppEntry(id: "notes", label: "Text Documents", symbol: "note.text", desktopId: "notes"),
        AppEntry(id: "calendar", label: "Calendar", symbol: "calendar", desktopId: "calendar"),
        AppEntry(id: "fyi", label: "Insights", symbol: "envelope", desktopId: "fyi"),
        AppEntry(id: "portfolio", label: "Finance", symbol: "chart.bar", desktopId: "portfolio"),
        AppEntry(id: "prompts", label: "Routines", symbol: "text.bubble", desktopId: "prompts"),
        AppEntry(id: "feed", label: "Feed", symbol: "doc.text", desktopId: nil),
    ]

    public static func entry(_ id: String) -> AppEntry? { apps.first { $0.id == id } }

    /// The launcher list under the SYNCED config: an app uninstalled on the
    /// Mac is gone (the desktop's not-loaded law); a hidden one is skipped
    /// unless a query names it (hiding declutters, never disables — the ⌘K
    /// bargain). `query` filters by label.
    public static func launcher(_ store: AppStore, query: String = "") -> [AppEntry] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let hidden = Set((store.blob("hidden-apps")["apps"]?.arrayValue ?? []).compactMap { $0.stringValue })
        let uninstalled = Set((store.blob("bundled-apps")["uninstalled"]?.arrayValue ?? []).compactMap { $0.stringValue })
        return apps.filter { a in
            if let d = a.desktopId, uninstalled.contains(d) { return false }
            if let d = a.desktopId, hidden.contains(d), q.isEmpty { return false }
            if !q.isEmpty, !a.label.lowercased().contains(q) { return false }
            return true
        }
    }
}

// MARK: - Capture: create a record, then open its editor (each app's own +)

public enum Capture {
    public static func newNote(_ store: AppStore) -> Route {
        .note(store.addItem("notes", "notes", ["title": .string(""), "content": .string(""), "tags": .array([]), "pinned": .bool(false)]))
    }
    public static func newTask(_ store: AppStore) -> Route {
        .task(store.addItem("schedule", "scheduleItems", [
            "title": .string(""), "startTime": .string(""), "endTime": .null, "notifyBefore": .number(0),
            "repeat": .string("none"), "dayOfWeek": .null, "repeatDays": .array([]),
            "scheduledDate": .string(DateLogic.todayStr()), "reminderDaysBefore": .array([]), "lastCompletedDate": .null,
        ]))
    }
}
