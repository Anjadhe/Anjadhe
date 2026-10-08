import SwiftUI
import AnjadheCore

// One Memory heading on the phone (2026-10-08, by request: "make the settings
// like list items which shows the details in a new page with ability
// add/update/delete there"). The facts under the heading, starred first; a
// tap opens the fact to change its words, star it or remove it, and Add
// files a new one here. Writes go to the synced `memory` blob in
// MemoryManager's own shape (js/agent/memory-manager.js: text ≤ 240, the old
// words kept as `was`, `updatedAt` the last-confirmed clock), and the Mac
// reloads it (MemoryManager._reload). The phone's three-way merge keeps a
// Mac edit and a phone edit to different facts both.

enum MemoryWrites {
    static let textMax = 240

    private static func clean(_ s: String) -> String {
        let one = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return String(one.prefix(textMax))
    }

    private static func newId() -> String {
        let t = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let r = String(Int.random(in: 0..<1_679_616), radix: 36)
        return "fact_" + t + r
    }

    private static func write(_ store: AppStore, _ change: (inout [JSONValue]) -> Void) {
        var blob = store.blob("memory")
        var facts = blob["facts"]?.arrayValue ?? []
        change(&facts)
        blob["facts"] = .array(facts)
        store.saveBlob("memory", blob)
    }

    /// Add a fact under `heading`. The same words again re-confirm the one
    /// already kept (MemoryManager M2). Returns false for empty text.
    @discardableResult
    static func add(_ store: AppStore, heading: String, text: String, starred: Bool) -> Bool {
        let t = clean(text)
        guard !t.isEmpty else { return false }
        let now = KVStore.nowISO()
        write(store) { facts in
            if let i = facts.firstIndex(where: { ($0["text"]?.stringValue ?? "").lowercased() == t.lowercased() }),
               var o = facts[i].objectValue {
                o["updatedAt"] = .string(now)
                if starred { o["starred"] = .bool(true) }
                facts[i] = .object(o)
                return
            }
            facts.insert(.object([
                "id": .string(newId()), "text": .string(t), "heading": .string(heading),
                "source": .string("phone"), "starred": .bool(starred),
                "createdAt": .string(now), "updatedAt": .string(now),
            ]), at: 0)
        }
        return true
    }

    @discardableResult
    static func edit(_ store: AppStore, id: String, text: String, starred: Bool) -> Bool {
        let t = clean(text)
        guard !t.isEmpty else { return false }
        write(store) { facts in
            guard let i = facts.firstIndex(where: { $0["id"]?.stringValue == id }), var o = facts[i].objectValue else { return }
            let old = o["text"]?.stringValue ?? ""
            if old != t {
                o["was"] = .object(["text": .string(old), "at": o["updatedAt"] ?? .null])
                o["text"] = .string(t)
            }
            o["starred"] = .bool(starred)
            o["updatedAt"] = .string(KVStore.nowISO())
            facts[i] = .object(o)
        }
        return true
    }

    static func remove(_ store: AppStore, id: String) {
        write(store) { facts in facts.removeAll { $0["id"]?.stringValue == id } }
    }
}

/// What the editor sheet is open on: a new fact, or one already kept.
private struct FactDraft: Identifiable {
    let id: String          // "new" or the fact's id
    var text: String
    var starred: Bool
    var isNew: Bool { id == "new" }
}

struct MemoryPageView: View {
    let heading: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @State private var draft: FactDraft?

    var body: some View {
        let _ = store.revision
        let group = MemoryFacts(store: store).groups.first { $0.id == heading }
        let label = group?.label ?? MemoryFacts.headings.first { $0.0 == heading }?.1 ?? "Memory"
        let facts = group?.facts ?? []
        ScreenColumn(spacing: 18) {
            ScreenHead(label) {
                HeadAction(symbol: "plus", label: "Add") { draft = FactDraft(id: "new", text: "", starred: false) }
            }
            if facts.isEmpty {
                EmptyText("Nothing here yet. Tap + to add something nenva should remember, or tell it in a chat.")
            } else {
                CardList {
                    ForEach(Array(facts.enumerated()), id: \.offset) { i, f in
                        row(f, last: i == facts.count - 1)
                    }
                }
                Text("Tap a line to change or remove it.")
                    .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
            }
        }
        .pushedScreen()
        .sheet(item: $draft) { d in
            FactEditor(draft: d, headingLabel: label) { text, starred in
                let ok = d.isNew
                    ? MemoryWrites.add(store, heading: heading, text: text, starred: starred)
                    : MemoryWrites.edit(store, id: d.id, text: text, starred: starred)
                if ok { sync.triggerSync(); router.showToast(d.isNew ? "Remembered" : "Saved") }
                return ok
            } onDelete: {
                MemoryWrites.remove(store, id: d.id)
                sync.triggerSync()
                router.showToast("Forgotten")
            }
        }
    }

    private func row(_ f: JSONValue, last: Bool) -> some View {
        let text = f["text"]?.stringValue ?? ""
        let id = f["id"]?.stringValue ?? ""
        let starred = f["starred"]?.boolValue == true
        return Button {
            draft = FactDraft(id: id, text: text, starred: starred)
        } label: {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    if starred {
                        Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(Theme.textTertiary)
                            .padding(.top, 5)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(text).font(.system(size: 15)).foregroundStyle(Theme.text)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if MemoryFacts.isStale(f), let at = f["updatedAt"]?.stringValue {
                            Text("As of " + DateLogic.relDate(at)).font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textQuaternary).padding(.top, 4)
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .contentShape(Rectangle())
                if !last { Divider().padding(.leading, 14) }
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Copy") { copyToPasteboard(text) }
            Button("Ask nenva about this") { router.openCompose(prefill: "About what you remember, “\(text)”: ") }
        }
    }
}

/// Add or change one fact: its words, a star, and Remove for a kept one.
private struct FactEditor: View {
    let draft: FactDraft
    let headingLabel: String
    let onSave: (String, Bool) -> Bool
    let onDelete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var starred = false
    @State private var confirmDelete = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScreenColumn(spacing: 16) {
                ScreenHead(draft.isNew ? "Add to \(headingLabel)" : headingLabel)
                TextField("Something nenva should remember", text: $text, axis: .vertical)
                    .lineLimit(3...8)
                    .font(.system(size: 16))
                    .focused($focused)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                Text("\(text.count)/\(MemoryWrites.textMax)")
                    .font(.system(size: 12)).foregroundStyle(text.count > MemoryWrites.textMax ? Theme.danger : Theme.textTertiary)
                Toggle(isOn: $starred) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Starred").font(.system(size: 16)).foregroundStyle(Theme.text)
                        Text("nenva keeps it in mind in every chat").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                PrimaryButton(label: draft.isNew ? "Add" : "Save") {
                    if onSave(text, starred) { dismiss() }
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !draft.isNew {
                    DangerButton(label: "Remove") { confirmDelete = true }
                }
            }
            .background(Theme.bg)
            .navigationTitle("").inlineNavTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.text)
        .onAppear {
            text = draft.text; starred = draft.starred
            if draft.isNew { focused = true }
        }
        .alert("Remove this?", isPresented: $confirmDelete) {
            Button("Remove", role: .destructive) { onDelete(); dismiss() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("nenva will stop remembering it, here and on your Mac.")
        }
    }
}
