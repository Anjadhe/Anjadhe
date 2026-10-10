import SwiftUI
import AnjadheCore

/// Retain all unsaved fields across failed writes and subsequent typing.
/// Retrying a body edit must not lose a title whose earlier save failed.
final class LocalEditDraft: ObservableObject {
    @Published private(set) var fields: [String: JSONValue] = [:]
    @Published private(set) var failed = false
    @Published private(set) var hasSaved = false

    func stage(_ field: String, _ value: JSONValue) { fields[field] = value }

    @discardableResult
    func save(using commit: ([String: JSONValue]) -> Bool) -> Bool {
        guard !fields.isEmpty else { return true }
        guard commit(fields) else { failed = true; return false }
        fields = [:]
        failed = false
        hasSaved = true
        return true
    }
}

struct LocalSaveStatus: View {
    @ObservedObject var draft: LocalEditDraft
    let retry: () -> Void

    var body: some View {
        if !draft.fields.isEmpty || draft.hasSaved {
            HStack {
                Text(draft.failed ? "Not saved" : draft.fields.isEmpty ? "Saved on this iPhone" : "Saving…")
                    .font(Theme.detailFont)
                    .foregroundStyle(draft.failed ? Theme.danger : Theme.textSecondary)
                Spacer()
                if draft.failed {
                    Button("Retry", action: retry).font(Theme.actionFont)
                        .frame(minHeight: Theme.minimumTouchTarget)
                }
            }
            .accessibilityElement(children: .contain)
        }
    }
}
