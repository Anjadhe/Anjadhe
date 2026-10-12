import SwiftUI
import AnjadheCore

public enum RootTab: String, CaseIterable { case now, threads, memory, settings }
public enum Route: Hashable {
    case thread(String), threadInfo(String), conversation(String), note(String), documents, memoryPage(String), ai, lock
}
public final class Router: ObservableObject {
    @Published public var tab: RootTab = .now
    @Published private var paths: [RootTab: [Route]] = [:]
    @Published public var toast: String?
    public var canLeave: () -> Bool = { true }
    private var toastTimer: Timer?
    public init() {}
    public func path(for tab: RootTab) -> [Route] { paths[tab] ?? [] }
    public func setPath(_ value: [Route], for tab: RootTab) { if canLeave() { paths[tab] = value } }
    public func binding(for tab: RootTab) -> Binding<[Route]> {
        Binding(get: { self.path(for: tab) }, set: { self.setPath($0, for: tab) })
    }
    public func root(_ next: RootTab) { guard canLeave() else { return }; if tab == next { paths[next] = [] }; tab = next }
    public func push(_ route: Route) {
        guard canLeave() else { return }
        if case .note(let id) = route, id.isEmpty { return }
        paths[tab, default: []].append(route)
    }
    public func pop() { guard canLeave() else { return }; if !(paths[tab] ?? []).isEmpty { paths[tab]?.removeLast() } }
    public func showToast(_ text: String) {
        toast = text; toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.toast = nil }
        }
    }
    @discardableResult public func openRecordLink(_ text: String) -> Bool {
        guard let url = URL(string: text), url.scheme == "anjadhe" else { return false }
        let id = String(url.path.dropFirst())
        guard !id.isEmpty else { return true }
        switch url.host {
        case "note": push(.note(id))
        case "sender", "matter": push(.thread(id))
        case "commitment", "task": push(.thread("task:" + id))
        default: showToast("This record cannot be opened in this build yet.")
        }
        return true
    }
    public func handleLink(_ url: URL) { if !openRecordLink(url.absoluteString) { openURL(url.absoluteString) } }
}
public enum Capture {
    public static func newNote(_ store: AppStore) -> Route {
        .note(store.addItem("notes", "notes", ["title": .string(""), "content": .string(""), "tags": .array([]), "pinned": .bool(false)]))
    }
}
