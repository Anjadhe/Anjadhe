import SwiftUI
import AnjadheCore

// Routines — the synced prompt library (port of mobile/screens/prompts.js).
// Labeled "Routines" (the desktop's 2026-07-31 rename); the app id stays
// `prompts` and so does the storage key.

struct PromptsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var prompts: [JSONValue] {
        store.items("prompts", "prompts").sorted {
            ($0["modifiedAt"]?.stringValue ?? $0["createdAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? $1["createdAt"]?.stringValue ?? "")
        }
    }

    var body: some View {
        let list = prompts
        ScreenColumn {
            ScreenHead("Routines", sub: "\(list.count) \(list.count == 1 ? "routine" : "routines")") {
                HeadAction(symbol: "plus", label: "New routine") {
                    let id = store.addItem("prompts", "prompts", ["title": .string(""), "body": .string(""), "tags": .array([])])
                    router.push(.prompt(id))
                }
            }
            if list.isEmpty {
                EmptyText("No routines yet. Tap + to add one.")
            } else {
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, p in
                        let id = p["id"]?.stringValue ?? ""
                        let preview = stripHTML(p["body"]?.stringValue ?? "", 72)
                        RowView(p["title"]?.stringValue ?? "", sub: preview.isEmpty ? "Empty routine" : preview, last: i == list.count - 1,
                                trailing: {
                                    Button {
                                        copyToPasteboard(p["body"]?.stringValue ?? ""); router.showToast("Copied")
                                    } label: {
                                        Image(systemName: "doc.on.doc").font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                                            .frame(width: 32, height: 32)
                                    }
                                    .buttonStyle(.plain).accessibilityLabel("Copy")
                                })
                            .onTapGesture { if !id.isEmpty { router.push(.prompt(id)) } }
                    }
                }
            }
        }
        .pushedScreen()
    }
}

struct PromptEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var title = ""; @State private var body_ = ""; @State private var loaded = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if store.findItem("prompts", "prompts", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                Form {
                    TextField("Routine title", text: $title, axis: .vertical).lineLimit(1...4)
                        .font(Theme.display(20)).foregroundStyle(Theme.text)
                        .onChange(of: title) { store.patchItem("prompts", "prompts", id: id, ["title": .string($0)]) }
                    Section {
                        TextField("Write the prompt…", text: $body_, axis: .vertical).lineLimit(6...)
                            .onChange(of: body_) { store.patchItem("prompts", "prompts", id: id, ["body": .string($0)]) }
                    }
                    Section {
                        Button("Copy") { copyToPasteboard(body_); router.showToast("Copied") }.foregroundStyle(Theme.text)
                        DangerButton(label: "Delete routine") { confirmDelete = true }
                    }
                }
                .scrollContentBackground(.hidden).background(Theme.bg)
                .compactForm()
            }
        }
        .pushedScreen()
        .alert("Delete this routine?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("prompts", "prompts", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            guard !loaded, let p = store.findItem("prompts", "prompts", id: id) else { return }
            loaded = true
            title = p["title"]?.stringValue ?? ""; body_ = p["body"]?.stringValue ?? ""
        }
    }
}
