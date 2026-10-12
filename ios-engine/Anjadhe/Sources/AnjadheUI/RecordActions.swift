import SwiftUI
import AnjadheCore

/// The action's phase lives independently of a SwiftUI body recomputation.
/// In particular Retry saving reuses the exact checked draft and action id.
@MainActor final class RecordActionModel: ObservableObject {
    @Published private(set) var draft: RecordDraft?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var stale = false
    @Published private(set) var saved = false
    let id = UUID().uuidString
    private let writer = RecordWriter()

    func review(operation: String, args: [String: JSONValue], store: AppStore) async {
        guard !busy, !saved, store.hydrated else { return }
        busy = true; error = nil; stale = false
        defer { busy = false }
        do {
            draft = try await writer.prepare(.object([
                "id": .string(id), "operation": .string(operation), "args": .object(args)
            ]), in: store.kv)
        } catch { self.error = error.localizedDescription }
    }
    func edit() { guard !saved, !busy else { return }; draft = nil; error = nil; stale = false }
    @discardableResult func approve(store: AppStore) -> Bool {
        guard !busy, !saved, !stale, let draft else { return false }
        do { try store.commit(draft, using: writer); saved = true; error = nil; return true }
        catch LocalRecordStore.StoreError.staleRevision {
            stale = true
            error = "Your records changed after this review. Review the latest version before saving."
        }
        catch { self.error = "Couldn’t save this action. Nothing was changed. Retry saving when storage is available." }
        return false
    }
}

enum RecordAction: Identifiable {
    case thread
    case commitment(sender: String?)
    case completion(id: String, done: Bool)
    case undo(ledger: String)
    var id: String {
        switch self {
        case .thread: return "thread"
        case .commitment(let sender): return "new:\(sender ?? "reminders")"
        case .completion(let id, let done): return "done:\(id):\(done)"
        case .undo(let ledger): return "undo:\(ledger)"
        }
    }
    var title: String {
        switch self {
        case .thread: return "New thread"
        case .commitment: return "Add commitment"
        case .completion(_, let done): return done ? "Mark done" : "Reopen commitment"
        case .undo: return "Undo change"
        }
    }
    var immediateReview: Bool {
        switch self { case .completion, .undo: return true; default: return false }
    }
}

struct RecordActionSheet: View {
    let action: RecordAction
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var router: Router
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = RecordActionModel()
    @State private var title = ""
    @State private var note = ""
    @State private var scheduled = false
    @State private var day = Date()

    private var request: (String, [String: JSONValue]) {
        switch action {
        case .thread: return ("sender.create", ["name": .string(title), "allGood": .string(note)])
        case .commitment(let sender):
            var args: [String: JSONValue] = ["fields": .object([
                "title": .string(title), "note": .string(note),
                "when": scheduled ? .object(["date": .string(DateLogic.todayStr(day))]) : .null
            ])]
            if let sender { args["sender"] = .string(sender) }
            return ("commitment.create", args)
        case .completion(let id, let done):
            return ("commitment.done", ["target": .string(id), "done": .bool(done), "day": .string(DateLogic.todayStr())])
        case .undo(let ledger): return ("commitment.undo", ["target": .string(ledger)])
        }
    }
    private func review() async { let (op, args) = request; await model.review(operation: op, args: args, store: store) }
    var body: some View {
        NavigationStack {
            Form {
                if let draft = model.draft {
                    Section("Review") {
                        Text(draft.receipt?["label"]?.stringValue ?? "No change needed").font(.headline)
                        Text(draft.record?["title"]?.stringValue ?? draft.record?["name"]?.stringValue ?? draft.receipt?["title"]?.stringValue ?? "")
                        if let text = draft.record?["note"]?.stringValue, !text.isEmpty { Text(text) }
                        if let text = draft.record?["allGood"]?.stringValue, !text.isEmpty { Text(text) }
                        if let date = draft.record?["when"]?["date"]?.stringValue { LabeledContent("Date", value: date) }
                        if let state = draft.record?["state"]?.stringValue { LabeledContent("Status", value: state.capitalized) }
                        if case .completion(_, _) = action, draft.record?["repeat"]?["rule"]?.stringValue != "none" {
                            Text("For today’s occurrence only.").font(.footnote)
                        }
                    }
                    Button(model.error == nil ? "Save change" : "Retry saving") {
                        if model.approve(store: store) {
                            router.showToast(draft.unchanged ? "No change needed" : draft.receipt?["label"]?.stringValue ?? "Saved")
                            dismiss()
                        }
                    }.disabled(model.stale || model.saved)
                    Button(model.stale ? "Review latest records" : "Back to editing") {
                        model.edit()
                        if action.immediateReview { Task { await review() } }
                    }
                } else if !action.immediateReview {
                    Section {
                        TextField("Name", text: $title)
                        TextField(action.id == "thread" ? "All good means…" : "Details", text: $note, axis: .vertical).lineLimit(3...8)
                        if case .commitment = action {
                            Toggle("Add a date", isOn: $scheduled)
                            if scheduled { DatePicker("Date", selection: $day, displayedComponents: .date) }
                        }
                    }
                    Button("Review change") { Task { await review() } }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                } else if !model.busy {
                    Button("Review change") { Task { await review() } }
                }
                if model.busy { ProgressView("Checking…") }
                if let error = model.error { Text(error).foregroundStyle(Theme.danger).accessibilityLabel(error) }
            }
            .scrollContentBackground(.hidden).background(Theme.bg)
            .navigationTitle(action.title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { if action.immediateReview && model.draft == nil { await review() } }
        }.interactiveDismissDisabled(model.busy || model.error != nil)
    }
}
