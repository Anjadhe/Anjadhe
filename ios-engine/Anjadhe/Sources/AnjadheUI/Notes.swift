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
    @StateObject private var draft = LocalEditDraft()

    private func stage(_ field: String, _ value: JSONValue, delay: TimeInterval = PendingWrites.delay) {
        guard loaded else { return }
        if draft.fields[field] == nil, store.findItem("notes", "notes", id: id)?[field] == value { return }
        draft.stage(field, value)
        PendingWrites.shared.schedule("note:\(id)", after: delay) { saveDraft() }
    }

    @discardableResult private func saveDraft() -> Bool {
        draft.save { store.patchItem("notes", "notes", id: id, $0) }
    }

    var body: some View {
        Group {
            if store.findItem("notes", "notes", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                VStack(spacing: 0) {
                    LocalSaveStatus(draft: draft) { saveDraft() }.padding(.horizontal, 18)
                    TextField("Title", text: $title, axis: .vertical).lineLimit(1...4)
                        .displayStyle(22)
                        .padding(.horizontal, 18).padding(.top, 10)
                        .onChange(of: title) { stage("title", .string($0)) }
                    Divider().padding(.top, 10)
                    RichEditorView(html: $html, placeholder: "Write…")
                        .onChange(of: html) { stage("content", .string($0), delay: PendingWrites.shortDelay) }
                }
            }
        }
        .pushedScreen()
        .navigationBarBackButtonHidden(!draft.fields.isEmpty)
        .onDisappear { PendingWrites.shared.flushAll() }
        .toolbar {
            if !draft.fields.isEmpty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { if saveDraft() { router.pop() } }
                }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { pinned.toggle(); draft.stage("pinned", .bool(pinned)); saveDraft() } label: { Image(systemName: pinned ? "star.fill" : "star") }
                    .accessibilityLabel("Pin")
                Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Delete")
            }
        }
        .alert("Delete this note?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                PendingWrites.shared.flush("note:\(id)")
                if store.deleteItem("notes", "notes", id: id) { router.pop() }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            guard !loaded, let n = store.findItem("notes", "notes", id: id) else { return }
            loaded = true
            title = n["title"]?.stringValue ?? ""; html = n["content"]?.stringValue ?? ""; pinned = n["pinned"]?.boolValue ?? false
        }
    }
}
