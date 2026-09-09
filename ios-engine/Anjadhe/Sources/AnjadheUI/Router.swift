import SwiftUI
import Combine
import AnjadheCore

// Navigation for the native shell — the port of the old mobile/app.js
// router. The function bar holds VERBS (Home · Assistant · ＋ · Search), not
// apps, so it never grows; apps and records are PUSHED screens on top of the
// root they were opened from, and a function-bar tap returns to that root
// with an empty stack.

/// Every pushable screen. Apps by id (see `AppCatalog`), records by id.
public enum Route: Hashable {
    case app(String)
    case task(String), note(String), journal(String), bookmark(String), prompt(String)
    case goal(String), feedItem(String)
    case insight(String)
    case wellnessLog(String)
}

public enum RootTab: String, CaseIterable { case home, assistant, search }

public final class Router: ObservableObject {
    @Published public var tab: RootTab = .home
    @Published public var homePath: [Route] = []
    @Published public var assistantPath: [Route] = []
    @Published public var searchPath: [Route] = []

    /// A brief confirmation toast (Shell renders it).
    @Published public var toast: String?
    /// The Home/Projects composer doors: text carried into the Assistant
    /// root plus a token that asks the composer to take focus.
    @Published public var composePrefill: String?
    @Published public var composeFocusToken: Int = 0
    /// The ＋ capture sheet.
    @Published public var showCapture = false

    private var toastTimer: Timer?

    public init() {}

    public var path: [Route] {
        get { path(for: tab) }
        set { setPath(newValue, for: tab) }
    }
    public func path(for t: RootTab) -> [Route] {
        switch t { case .home: return homePath; case .assistant: return assistantPath; case .search: return searchPath }
    }
    public func setPath(_ p: [Route], for t: RootTab) {
        switch t { case .home: homePath = p; case .assistant: assistantPath = p; case .search: searchPath = p }
    }
    /// A binding to the current tab's stack, for `NavigationStack(path:)`.
    public func binding(for t: RootTab) -> Binding<[Route]> {
        Binding(get: { self.path(for: t) }, set: { self.setPath($0, for: t) })
    }

    /// A function-bar tap: switch to a root, no back stack.
    public func root(_ t: RootTab) {
        setPath([], for: t)
        tab = t
    }
    /// Push a screen on the current root.
    public func push(_ r: Route) { path.append(r) }
    public func open(app id: String) { push(.app(id)) }
    public func pop() { if !path.isEmpty { path.removeLast() } }
    public func popToRoot() { path = [] }

    /// The Home composer door: carry text in and focus the Assistant input.
    public func openCompose(prefill: String? = nil) {
        if let p = prefill { composePrefill = p }
        composeFocusToken += 1
        root(.assistant)
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
        case "journal": push(.journal(id))
        case "event": push(.app("calendar"))
        case "bookmark": push(.bookmark(id))
        case "routine": push(.prompt(id))
        case "goal", "project": push(.goal(id))
        case "insight", "email": push(.insight(id))
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
        AppEntry(id: "notes", label: "Notes", symbol: "note.text", desktopId: "notes"),
        AppEntry(id: "journal", label: "Journal", symbol: "book.closed", desktopId: "journal"),
        AppEntry(id: "calendar", label: "Calendar", symbol: "calendar", desktopId: "calendar"),
        AppEntry(id: "wellness", label: "Wellness", symbol: "heart", desktopId: "wellness"),
        AppEntry(id: "fyi", label: "Email AI", symbol: "envelope", desktopId: "fyi"),
        AppEntry(id: "news", label: "News", symbol: "newspaper", desktopId: "news"),
        AppEntry(id: "portfolio", label: "Portfolio", symbol: "chart.bar", desktopId: "portfolio"),
        AppEntry(id: "prompts", label: "Routines", symbol: "text.bubble", desktopId: "prompts"),
        AppEntry(id: "feed", label: "Feed", symbol: "doc.text", desktopId: nil),
        AppEntry(id: "bookmarks", label: "Bookmarks", symbol: "bookmark", desktopId: "bookmarks"),
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

// MARK: - Capture (the ＋ sheet): create a record, then open its editor

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
    public static func newJournalEntry(_ store: AppStore) -> Route {
        .journal(store.addItem("journal", "entries", ["content": .string(""), "mood": .string(""), "tags": .array([]), "date": .string(KVStore.nowISO())]))
    }
    public static func newBookmark(_ store: AppStore) -> Route {
        .bookmark(store.addItem("bookmarks", "bookmarks", [
            "title": .string(""), "url": .string(""), "description": .string(""), "group": .null, "notes": .string(""), "tags": .array([]),
        ]))
    }
}
