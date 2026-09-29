import SwiftUI
import AnjadheCore

// Search (a root) and the Apps launcher (a pushed screen) — ports of the old
// mobile/screens/search.js and apps.js.

/// How long the search field waits after the last keystroke before it
/// actually searches. Short enough to feel immediate, long enough that
/// typing a word is one pass over the data rather than five.
let SEARCH_DEBOUNCE: TimeInterval = 0.22

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
    /// What `hits` actually searches. The field updates `query` on every
    /// keystroke for responsiveness; this trails it by `SEARCH_DEBOUNCE`, so
    /// a burst of typing runs ONE search instead of one per character.
    @State private var settled = ""
    @State private var debounceToken = 0

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

    /// Every match for the settled query.
    ///
    /// This used to strip the HTML off EVERY note and journal entry on every
    /// keystroke — four regular expressions per record, ~4 MB of markup,
    /// 346 ms measured on a Mac and worse on a phone, all inside `body`.
    /// `PlainText.contains` scans the raw markup first and converts only a
    /// candidate, and what it does convert it caches; the field debounces on
    /// top, so a burst of typing costs one pass, not one per character.
    private var hits: [Hit] {
        let q = settled.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        func has(_ s: String?) -> Bool { (s ?? "").lowercased().contains(q) }
        func id(_ v: JSONValue) -> String { v["id"]?.stringValue ?? "" }
        func stamp(_ v: JSONValue) -> String {
            v["modifiedAt"]?.stringValue ?? v["updatedAt"]?.stringValue ?? v["createdAt"]?.stringValue ?? ""
        }
        var out: [Hit] = []
        for n in store.items("notes", "notes") {
            let t = n["title"]?.stringValue ?? ""
            if t.lowercased().contains(q)
                || PlainText.contains(n["content"]?.stringValue ?? "", needle: q, id: "note:" + id(n), stamp: stamp(n)) {
                out.append(Hit(id: "note:" + id(n), title: t.isEmpty ? "Untitled" : t, sub: "Note", route: .note(id(n))))
            }
        }
        for e in store.items("journal", "entries") {
            if PlainText.contains(e["content"]?.stringValue ?? "", needle: q, id: "journal:" + id(e), stamp: stamp(e)) {
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
                    .onChange(of: query) { typed in
                        debounceToken += 1
                        let token = debounceToken
                        // Clearing the field should empty the results at once
                        // — there is nothing to compute.
                        if typed.trimmingCharacters(in: .whitespaces).isEmpty { settled = ""; return }
                        DispatchQueue.main.asyncAfter(deadline: .now() + SEARCH_DEBOUNCE) {
                            if token == debounceToken { settled = typed }
                        }
                    }
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
        .onAppear(perform: prewarmIndex)
    }

    /// Convert every note and journal body for search while the user is
    /// still reaching for the keyboard — the first query has to read them
    /// all once, and this is a better moment than after a keystroke. Runs
    /// off the main thread; a second call skips what is already converted.
    private func prewarmIndex() {
        func stamp(_ v: JSONValue) -> String {
            v["modifiedAt"]?.stringValue ?? v["updatedAt"]?.stringValue ?? v["createdAt"]?.stringValue ?? ""
        }
        var bodies: [(html: String, id: String, stamp: String)] = []
        for n in store.items("notes", "notes") {
            bodies.append((n["content"]?.stringValue ?? "", "note:" + (n["id"]?.stringValue ?? ""), stamp(n)))
        }
        for e in store.items("journal", "entries") {
            bodies.append((e["content"]?.stringValue ?? "", "journal:" + (e["id"]?.stringValue ?? ""), stamp(e)))
        }
        PlainText.prewarm(bodies)
    }
}

// MARK: - Apps launcher (a root tab since 2026-09-21)

struct AppsView: View {
    /// The Apps tab hides its nav bar like every root; a pushed copy must
    /// keep its Back button, or it is a dead end.
    var asRoot = true
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
        .modifier(AppsChrome(asRoot: asRoot))
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

/// Root or pushed — the only difference is the nav bar.
private struct AppsChrome: ViewModifier {
    let asRoot: Bool
    func body(content: Content) -> some View {
        Group {
            if asRoot { content.rootScreen("Apps") } else { content.pushedScreen() }
        }
    }
}
