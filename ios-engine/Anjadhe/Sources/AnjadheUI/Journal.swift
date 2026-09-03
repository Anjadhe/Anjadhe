import SwiftUI
import AnjadheCore

// Journal — dated entries with a mood and a reflective editor (port of
// mobile/screens/journal.js). Content is HTML, edited in place.

private let JOURNAL_MOODS = ["great", "good", "okay", "low", "rough"]

private func journalWhen(_ e: JSONValue) -> String {
    e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? ""
}

struct JournalView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var entries: [JSONValue] {
        store.items("journal", "entries").sorted { journalWhen($0) > journalWhen($1) }
    }

    var body: some View {
        let list = entries
        ScreenColumn {
            ScreenHead("Journal", sub: "\(list.count) \(list.count == 1 ? "entry" : "entries")") {
                HeadAction(symbol: "plus", label: "New entry") { router.push(Capture.newJournalEntry(store)) }
            }
            if list.isEmpty {
                EmptyText("No entries yet. Tap + to begin.")
            } else {
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, e in
                        let id = e["id"]?.stringValue ?? ""
                        let preview = stripHTML(e["content"]?.stringValue ?? "", 76)
                        let when = DateLogic.relDate(journalWhen(e))
                        RowView(when.isEmpty ? "Entry" : when, sub: preview.isEmpty ? "Empty entry" : preview, last: i == list.count - 1,
                                trailing: {
                                    if let m = e["mood"]?.stringValue, !m.isEmpty {
                                        Text(m).font(.caption2).foregroundStyle(Theme.textSecondary)
                                            .padding(.horizontal, 8).padding(.vertical, 2)
                                            .background(Capsule().fill(Theme.surface))
                                            .overlay(Capsule().strokeBorder(Theme.border))
                                    }
                                })
                            .onTapGesture { if !id.isEmpty { router.push(.journal(id)) } }
                    }
                }
            }
        }
        .pushedScreen()
    }
}

struct JournalEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var html = ""; @State private var mood = ""; @State private var dateLine = ""; @State private var loaded = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if store.findItem("journal", "entries", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        if !dateLine.isEmpty {
                            Text(dateLine).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                        }
                        HStack(spacing: 6) {
                            ForEach(JOURNAL_MOODS, id: \.self) { m in
                                Button(m) {
                                    mood = (mood == m) ? "" : m
                                    store.patchItem("journal", "entries", id: id, ["mood": .string(mood)])
                                }
                                .font(.caption).frame(maxWidth: .infinity).padding(.vertical, 7)
                                .background(mood == m ? Theme.text : Theme.surface)
                                .foregroundStyle(mood == m ? Theme.bg : Theme.textSecondary)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(mood == m ? Theme.text : Theme.border))
                            }
                        }.buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 12)
                    Divider()
                    RichEditorView(html: $html, placeholder: "How was today?")
                        .onChange(of: html) { store.patchItem("journal", "entries", id: id, ["content": .string($0)]) }
                }
            }
        }
        .pushedScreen()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Delete")
            }
        }
        .alert("Delete this entry?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("journal", "entries", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            guard !loaded, let e = store.findItem("journal", "entries", id: id) else { return }
            loaded = true
            html = e["content"]?.stringValue ?? ""; mood = e["mood"]?.stringValue ?? ""
            if let d = DateLogic.parseISO(journalWhen(e)) {
                let f = DateFormatter(); f.dateFormat = "EEEE, MMMM d"; dateLine = f.string(from: d)
            }
        }
    }
}
