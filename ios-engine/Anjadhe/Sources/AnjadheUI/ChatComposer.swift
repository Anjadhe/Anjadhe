import SwiftUI
import AnjadheCore

/// Bottom composer and durable-turn controls. There is no work on appearance:
/// relaunch offers an explicit continuation only for undispatched checkpoints.
struct ChatComposer: View {
    let conversation: String
    let thread: String
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var access: DeviceAccessModel
    @EnvironmentObject private var chat: ChatSession
    @EnvironmentObject private var router: Router
    @State private var text = ""
    @State private var source = false

    private var turn: JSONValue? { chat.turn(conversation, store: store) }
    private var phase: String { turn?["phase"]?.stringValue ?? "" }
    private var active: Bool { chat.running && chat.activeConversation == conversation }
    private var savedSource: Bool { store.findItem("agent-conversations", "conversations", id: conversation)?["untrusted"]?.boolValue == true }
    private var unfinished: Bool { !phase.isEmpty && !["complete", "stopped"].contains(phase) }
    private func act(_ kind: String) { Task { await chat.act(kind, conversation: conversation, credential: access.credentials, store: store) } }
    private func submit(fileSource: Bool = false) {
        guard let model = access.choice?.model, let credential = access.credentials else { return }
        // Keep a pasted excerpt separate from the sender's user conversation.
        // The source review remains readable in nenva after filing.
        let separate = fileSource && thread != "nenva"
        let destination = separate ? UUID().uuidString : conversation
        Task {
            if await chat.begin(conversation: destination, thread: separate ? "nenva" : thread, text: text, source: source || savedSource,
                                model: model, credential: credential, store: store, fileSource: fileSource) { text = "" }
            if separate && chat.activeConversation == destination { router.push(.conversation(destination)) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if chat.activeConversation == conversation, let error = chat.error {
                Text(error).font(Theme.detailFont).foregroundStyle(Theme.danger)
                if chat.pendingSave {
                    Button("Retry saving") { Task { await chat.retrySaving(credential: access.credentials, store: store) } }.disabled(chat.running)
                }
            }
            if active {
                HStack { ProgressView(); Text("Working…").font(Theme.detailFont); Spacer(); Button("Stop") { Task { await chat.stop(conversation: conversation, store: store) } } }
            } else if phase == "approval", let proposal = turn?["proposal"] {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(proposal["draft"]?["receipt"]?["label"]?.stringValue ?? "Review change").font(.headline)
                        Text(proposal["draft"]?["record"]?["title"]?.stringValue ?? "")
                        ForEach(Array((proposal["rows"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, row in
                            let values = row.arrayValue ?? []
                            if values.count == 2 {
                                Text((values[0].stringValue ?? "") + ": " + (values[1].stringValue ?? "")).font(Theme.detailFont)
                            }
                        }
                        if let note = proposal["draft"]?["record"]?["note"]?.stringValue, !note.isEmpty {
                            DisclosureGroup("Full note") { Text(note).textSelection(.enabled).font(Theme.detailFont) }
                        }
                        if proposal["source"]?.boolValue == true,
                           let excerpt = proposal["command"]?["args"]?["source"]?["observation"]?["text"]?.stringValue {
                            DisclosureGroup("Pasted source") { Text(excerpt).textSelection(.enabled).font(Theme.detailFont) }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 240)
                HStack {
                    Button("Save change") { act("approve") }.buttonStyle(.borderedProminent)
                    Button("Decline") { act("decline") }.buttonStyle(.bordered)
                }.disabled(chat.running || chat.pendingSave)
                if chat.error != nil && proposal["source"]?.boolValue != true { Button("Review latest records") { act("review") }.disabled(chat.pendingSave) }
            } else if unfinished {
                Text(phase == "requesting" || phase == "interrupted"
                     ? "This request was interrupted. It may have used AI allowance. It won’t run again automatically."
                     : "This turn has saved progress and is waiting to continue.").font(Theme.detailFont)
                HStack {
                    if ["ready", "tools", "checkReady", "captureReady", "sourceReady"].contains(phase) { Button("Continue") { act("drive") } }
                    Button("End turn") { act("stop") }
                }.disabled(chat.running || chat.pendingSave)
            }
            if let notice = turn?["notice"]?.stringValue, !notice.isEmpty { Text(notice).font(Theme.detailFont).foregroundStyle(Theme.textSecondary) }
            if let destination = turn?["filedThread"]?.stringValue {
                Button("Open saved thread") { router.push(.thread(destination)) }
            }
            if let id = turn?["id"]?.stringValue {
                let receipts = store.items("record-receipts", "items").filter { $0["id"]?.stringValue?.hasPrefix(id + ":") == true }
                ForEach(Array(receipts.enumerated()), id: \.offset) { _, receipt in
                    Label((receipt["label"]?.stringValue ?? "Saved") + ": " + (receipt["title"]?.stringValue ?? ""), systemImage: "checkmark.circle")
                        .font(Theme.detailFont)
                }
                if phase == "complete" && receipts.isEmpty { Text("No record changes saved in this turn.").font(Theme.detailFont).foregroundStyle(Theme.textSecondary) }
            }
            if !unfinished && !active {
                if access.choice == nil {
                    Button("Choose AI in Settings") { router.push(.ai) }
                } else {
                    TextField("Message nenva", text: $text, axis: .vertical).lineLimit(1...5)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("Message nenva")
                    HStack {
                        Toggle("Pasted source", isOn: Binding(get: { source || savedSource }, set: { source = $0 }))
                            .font(Theme.detailFont).disabled(savedSource)
                        Button { submit() } label: { Image(systemName: "arrow.up").frame(width: 44, height: 44) }
                        .buttonStyle(.borderedProminent).accessibilityLabel("Send message")
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.running || chat.pendingSave)
                    }
                    if source || savedSource {
                        Text("Send to discuss this text, or review it for filing into a thread. Nothing is filed until you approve.")
                            .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                        Button("Review for Threads") { submit(fileSource: true) }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 2500 || chat.running || chat.pendingSave)
                        if text.count > 2500 { Text("Use an excerpt of at most 2,500 characters to file.").font(Theme.detailFont) }
                    }
                }
            }
        }.buttonStyle(ChatControlStyle()).controlSize(.large).padding(16).background(Theme.surface)
    }
}

private struct ChatControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle()).opacity(configuration.isPressed ? 0.65 : 1)
    }
}
