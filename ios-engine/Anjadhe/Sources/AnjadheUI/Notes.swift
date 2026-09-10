import SwiftUI
import AnjadheCore

// Notes — a list and a rich-text editor (port of mobile/screens/notes.js).
// Content is stored as HTML, the same format the Mac's RichEditor produces;
// RichEditorView edits it directly so formatting round-trips.

struct NotesView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var notes: [JSONValue] {
        store.items("notes", "notes").sorted {
            let ap = $0["pinned"]?.boolValue ?? false, bp = $1["pinned"]?.boolValue ?? false
            if ap != bp { return ap }
            return ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "")
        }
    }

    var body: some View {
        let list = notes
        ScreenColumn {
            ScreenHead("Notes", sub: "\(list.count) \(list.count == 1 ? "note" : "notes")") {
                HeadAction(symbol: "plus", label: "New note") { router.push(Capture.newNote(store)) }
            }
            if list.isEmpty {
                EmptyText("No notes yet. Tap + to write one.")
            } else {
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, n in
                        let id = n["id"]?.stringValue ?? ""
                        let preview = stripHTML(n["content"]?.stringValue ?? "", 72)
                        RowView(n["title"]?.stringValue ?? "", sub: preview.isEmpty ? "Empty note" : preview, last: i == list.count - 1,
                                leading: {
                                    if n["pinned"]?.boolValue == true {
                                        Image(systemName: "star.fill").font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                                    }
                                },
                                trailing: {
                                    Text(DateLogic.relDate(n["modifiedAt"]?.stringValue ?? "")).font(.caption2).foregroundStyle(Theme.textTertiary)
                                })
                            .onTapGesture { if !id.isEmpty { router.push(.note(id)) } }
                    }
                }
            }
        }
        .pushedScreen()
    }
}

struct NoteEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var title = ""; @State private var html = ""; @State private var pinned = false; @State private var loaded = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if store.findItem("notes", "notes", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                VStack(spacing: 0) {
                    TextField("Title", text: $title, axis: .vertical).lineLimit(1...4)
                        .font(Theme.display(22)).foregroundStyle(Theme.text)
                        .padding(.horizontal, 18).padding(.top, 10)
                        .onChange(of: title) { store.patchItem("notes", "notes", id: id, ["title": .string($0)]) }
                    Divider().padding(.top, 10)
                    RichEditorView(html: $html, placeholder: "Write…")
                        .onChange(of: html) { store.patchItem("notes", "notes", id: id, ["content": .string($0)]) }
                }
            }
        }
        .pushedScreen()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { pinned.toggle(); store.patchItem("notes", "notes", id: id, ["pinned": .bool(pinned)]) } label: { Image(systemName: pinned ? "star.fill" : "star") }
                    .accessibilityLabel("Pin")
                Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Delete")
            }
        }
        .alert("Delete this note?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("notes", "notes", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            guard !loaded, let n = store.findItem("notes", "notes", id: id) else { return }
            loaded = true
            title = n["title"]?.stringValue ?? ""; html = n["content"]?.stringValue ?? ""; pinned = n["pinned"]?.boolValue ?? false
        }
    }
}
