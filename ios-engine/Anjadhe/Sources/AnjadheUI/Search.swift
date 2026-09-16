import SwiftUI
import AnjadheCore

// Search (a root) and the Apps launcher (a pushed screen) — ports of the old
// mobile/screens/search.js and apps.js.

/// The rounded search box (`.apps-search`): magnifier + field on Theme.surface.
struct SearchField: View {
    let placeholder: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Theme.textTertiary)
            TextField(placeholder, text: $text)
                .font(.system(size: 16))
                .foregroundStyle(Theme.text)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(Theme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

// MARK: - Search (root)

struct SearchView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var query = ""

    private struct Hit: Identifiable {
        let id: String
        let title: String
        let sub: String
        let route: Route
    }

    private func bookmarkDomain(_ url: String) -> String {
        var s = url.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return "" }
        if s.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) == nil { s = "https://" + s }
        guard let host = URL(string: s)?.host else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    private var hits: [Hit] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        func has(_ s: String?) -> Bool { (s ?? "").lowercased().contains(q) }
        func id(_ v: JSONValue) -> String { v["id"]?.stringValue ?? "" }
        var out: [Hit] = []
        for n in store.items("notes", "notes") {
            let hay = ((n["title"]?.stringValue ?? "") + " " + stripHTML(n["content"]?.stringValue ?? "", 100_000)).lowercased()
            if hay.contains(q) {
                let t = n["title"]?.stringValue ?? ""
                out.append(Hit(id: "note:" + id(n), title: t.isEmpty ? "Untitled" : t, sub: "Note", route: .note(id(n))))
            }
        }
        for e in store.items("journal", "entries") {
            if stripHTML(e["content"]?.stringValue ?? "", 100_000).lowercased().contains(q) {
                let when = DateLogic.relDate(e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? "")
                out.append(Hit(id: "journal:" + id(e), title: when.isEmpty ? "Entry" : when, sub: "Journal", route: .journal(id(e))))
            }
        }
        for t in store.items("schedule", "scheduleItems") where has(t["title"]?.stringValue) {
            let title = t["title"]?.stringValue ?? ""
            out.append(Hit(id: "task:" + id(t), title: title.isEmpty ? "Untitled" : title, sub: "Task", route: .task(id(t))))
        }
        for b in store.items("bookmarks", "bookmarks") where has(b["title"]?.stringValue) || has(b["url"]?.stringValue) {
            let title = b["title"]?.stringValue ?? ""
            let dom = bookmarkDomain(b["url"]?.stringValue ?? "")
            out.append(Hit(id: "bookmark:" + id(b), title: title.isEmpty ? (dom.isEmpty ? "Untitled" : dom) : title, sub: "Bookmark", route: .bookmark(id(b))))
        }
        for p in store.items("prompts", "prompts") where has(p["title"]?.stringValue) || has(p["body"]?.stringValue) {
            let title = p["title"]?.stringValue ?? ""
            out.append(Hit(id: "prompt:" + id(p), title: title.isEmpty ? "Untitled" : title, sub: "Routine", route: .prompt(id(p))))
        }
        return Array(out.prefix(40))
    }

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let results = hits
        ScreenColumn {
            ScreenHead("Search")
            VStack(alignment: .leading, spacing: 14) {
                SearchField(placeholder: "Search everything…", text: $query)
                if q.isEmpty {
                    EmptyText("Type to search your notes, journal and tasks.")
                } else if results.isEmpty {
                    EmptyText("No matches.")
                } else {
                    CardList {
                        ForEach(Array(results.enumerated()), id: \.element.id) { i, hit in
                            Button { router.push(hit.route) } label: {
                                RowView(hit.title, sub: hit.sub, last: i == results.count - 1)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .rootScreen("Search")
    }
}

// MARK: - Apps launcher (pushed)

struct AppsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var query = ""

    private let cols = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        let apps = AppCatalog.launcher(store, query: query)
        ScreenColumn {
            ScreenHead("Apps")
            VStack(alignment: .leading, spacing: 16) {
                SearchField(placeholder: "Search apps…", text: $query)
                if apps.isEmpty {
                    EmptyText("No apps match.")
                } else {
                    LazyVGrid(columns: cols, spacing: 18) {
                        ForEach(apps) { app in tile(app) }
                    }
                }
            }
        }
        .pushedScreen()
    }

    /// One app tile: a thin-bordered rounded square with a monochrome glyph and
    /// the app name beneath — the Minimal Book Theme, launcher-style.
    private func tile(_ app: AppEntry) -> some View {
        Button { router.open(app: app.id) } label: {
            VStack(spacing: 8) {
                Image(systemName: app.symbol)
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity).frame(height: 76)
                    .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                Text(app.label).font(.caption).foregroundStyle(Theme.text).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }
}
