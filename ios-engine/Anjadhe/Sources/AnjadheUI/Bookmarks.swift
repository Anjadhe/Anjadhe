import SwiftUI
import AnjadheCore

// Bookmarks — saved links; tapping one opens it in the system browser. Add,
// edit and delete here too, all synced (port of mobile/screens/bookmarks.js).

private func bookmarkDomain(_ url: String) -> String {
    var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return "" }
    if s.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) == nil { s = "https://" + s }
    return URL(string: s)?.host?.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) ?? ""
}

struct BookmarksView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var bookmarks: [JSONValue] {
        store.items("bookmarks", "bookmarks").sorted {
            ($0["modifiedAt"]?.stringValue ?? $0["createdAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? $1["createdAt"]?.stringValue ?? "")
        }
    }

    var body: some View {
        let list = bookmarks
        ScreenColumn {
            ScreenHead("Bookmarks", sub: "\(list.count) \(list.count == 1 ? "link" : "links")") {
                HeadAction(symbol: "plus", label: "New bookmark") { router.push(Capture.newBookmark(store)) }
            }
            if list.isEmpty {
                EmptyText("No bookmarks yet. Tap + to add one.")
            } else {
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, b in
                        row(b, last: i == list.count - 1)
                    }
                }
            }
        }
        .pushedScreen()
    }

    private func row(_ b: JSONValue, last: Bool) -> some View {
        let id = b["id"]?.stringValue ?? ""
        let url = b["url"]?.stringValue ?? ""
        let dom = bookmarkDomain(url)
        let title = b["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? (dom.isEmpty ? "Untitled" : dom)
        return RowView(title, sub: dom.isEmpty ? (url.isEmpty ? "No URL" : url) : dom, last: last,
                       leading: {
                           if !dom.isEmpty, let u = URL(string: "https://www.google.com/s2/favicons?domain=\(dom)&sz=64") {
                               AsyncImage(url: u) { $0.resizable() } placeholder: { Color.clear }
                                   .frame(width: 18, height: 18).clipShape(RoundedRectangle(cornerRadius: 4))
                           }
                       },
                       trailing: {
                           Button { if !id.isEmpty { router.push(.bookmark(id)) } } label: {
                               Image(systemName: "pencil").font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                                   .frame(width: 32, height: 32)
                           }
                           .buttonStyle(.plain).accessibilityLabel("Edit bookmark")
                       })
            .onTapGesture {
                if !url.isEmpty { openURL(url) } else if !id.isEmpty { router.push(.bookmark(id)) }
            }
    }
}

struct BookmarkEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var title = ""; @State private var url = ""; @State private var desc = ""; @State private var loaded = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if store.findItem("bookmarks", "bookmarks", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                Form {
                    Section {
                        fieldLabel("Title")
                        TextField("Link title", text: $title, axis: .vertical).lineLimit(1...4)
                            .onChange(of: title) { store.patchItem("bookmarks", "bookmarks", id: id, ["title": .string($0.trimmingCharacters(in: .whitespaces))]) }
                    }
                    Section {
                        fieldLabel("URL")
                        TextField("https://", text: $url).autocorrectionDisabled().urlKeyboard()
                            .onChange(of: url) { store.patchItem("bookmarks", "bookmarks", id: id, ["url": .string($0.trimmingCharacters(in: .whitespaces))]) }
                    }
                    Section {
                        fieldLabel("Description")
                        TextField("Optional note", text: $desc, axis: .vertical).lineLimit(2...4)
                            .onChange(of: desc) { store.patchItem("bookmarks", "bookmarks", id: id, ["description": .string($0.trimmingCharacters(in: .whitespaces))]) }
                    }
                    Section {
                        PrimaryButton(label: "Open link") {
                            let u = url.trimmingCharacters(in: .whitespaces)
                            if u.isEmpty { router.showToast("Add a URL first") } else { openURL(u) }
                        }
                        DangerButton(label: "Delete bookmark") { confirmDelete = true }
                    }
                }
                .scrollContentBackground(.hidden).background(Theme.bg)
                .compactForm()
            }
        }
        .pushedScreen()
        .alert("Delete this bookmark?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("bookmarks", "bookmarks", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            guard !loaded, let b = store.findItem("bookmarks", "bookmarks", id: id) else { return }
            loaded = true
            title = b["title"]?.stringValue ?? ""; url = b["url"]?.stringValue ?? ""; desc = b["description"]?.stringValue ?? ""
        }
    }
}
