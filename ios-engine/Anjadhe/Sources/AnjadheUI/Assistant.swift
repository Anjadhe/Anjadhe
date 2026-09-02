import SwiftUI
import Combine
import AnjadheCore

// Assistant (root). Chat with the assistant that runs on the paired Mac —
// the product spine, on the phone. The transcript IS the synced conversation
// blob (`agent-conversations`, channel:'mobile'): sends go over the
// encrypted channel (SyncCoordinator.sendChat), the Mac runs the full
// assistant and pushes the reply back (chat-reply), and the same reply rides
// sync — so a dropped socket loses nothing, it just arrives with the next
// sync. Local optimistic bubbles cover the gap between a send and the synced
// copy of the conversation catching up. Port of mobile/screens/assistant.js.

public final class ChatState: ObservableObject {
    static let sessionGap: TimeInterval = 3 * 60 * 60   // mirrors MobileChannel on the Mac
    static let replyTimeout: TimeInterval = 5 * 60      // stop the spinner; the run may still land via sync

    struct Entry: Identifiable {
        let id = UUID()
        let role: String
        let content: String
        let at: Date
        var error = false
    }
    struct Pending { let at: Date; var acked = false }

    /// Optimistic entries not yet caught up by the synced conversation.
    @Published var thread: [Entry] = []
    @Published var pending: Pending?
    /// "New chat" tapped — the next send starts a new conversation.
    @Published var startFresh = false
    @Published var freshAt: Date?
    @Published var draft = ""

    private let store: AppStore
    private let sync: SyncCoordinator
    private var pendingTimer: Timer?
    private var bag = Set<AnyCancellable>()

    public init(store: AppStore, sync: SyncCoordinator) {
        self.store = store
        self.sync = sync
        // Replies land whatever screen is open.
        sync.chat.receive(on: DispatchQueue.main).sink { [weak self] ev in
            guard let self = self else { return }
            switch ev.kind {
            case "chat-ack":
                if self.pending != nil { self.pending?.acked = true }
            case "chat-reply":
                self.clearPending()
                self.thread.append(Entry(role: "assistant", content: ev.text, at: Date()))
            case "chat-error":
                self.clearPending()
                self.thread.append(Entry(role: "assistant", content: ev.text.isEmpty ? "Something went wrong." : ev.text, at: Date(), error: true))
            default:
                break
            }
        }.store(in: &bag)
    }

    // MARK: data

    /// The newest synced conversation on the mobile channel.
    func currentConv() -> JSONValue? {
        let convs = store.blob("agent-conversations")["conversations"]?.arrayValue ?? []
        var latest: JSONValue?
        for c in convs where c["channel"]?.stringValue == "mobile" {
            if latest == nil || (c["updatedAt"]?.stringValue ?? "") > (latest?["updatedAt"]?.stringValue ?? "") {
                latest = c
            }
        }
        return latest
    }

    private static func date(_ iso: String?) -> Date {
        iso.flatMap { DateLogic.parseISO($0) } ?? Date(timeIntervalSince1970: 0)
    }

    func inSession(_ conv: JSONValue?) -> Bool {
        guard let conv = conv else { return false }
        let at = Self.date(conv["updatedAt"]?.stringValue ?? conv["createdAt"]?.stringValue)
        return Date().timeIntervalSince(at) <= Self.sessionGap
    }

    /// Drop optimistic entries the synced conversation has caught up with, and
    /// clear the pending spinner once the reply is in the transcript. Two
    /// catch-up signals, both needed: the timestamp AND content identity (a
    /// pushed chat-reply arrives AFTER the conv's updatedAt stamp).
    func reconcile(_ conv: JSONValue?) {
        guard let conv = conv else { return }
        let syncedAt = Self.date(conv["updatedAt"]?.stringValue)
        let msgs = conv["messages"]?.arrayValue ?? []
        let tail = msgs.suffix(12)
        func inConv(_ m: Entry) -> Bool {
            tail.contains { $0["role"]?.stringValue == m.role && $0["content"]?.stringValue == m.content }
        }
        let kept = thread.filter { m in
            if m.at <= syncedAt { return false }
            if !m.error && inConv(m) { return false }
            return true
        }
        if kept.count != thread.count { thread = kept }
        if let p = pending, syncedAt > p.at, let last = msgs.last, last["role"]?.stringValue == "assistant" {
            clearPending()
        }
        // "New chat" holds the view empty until the fresh conversation the Mac
        // creates for it syncs in — then it becomes the transcript.
        if startFresh, let f = freshAt, Self.date(conv["createdAt"]?.stringValue) > f {
            startFresh = false
        }
    }

    func clearPending() {
        pending = nil
        pendingTimer?.invalidate()
        pendingTimer = nil
    }

    // MARK: sending

    /// Returns false when nothing was sent (empty, already pending, not
    /// paired, or no live channel — the last shows a toast via `onRefused`).
    @discardableResult
    func send(_ text: String, onRefused: @escaping (String) -> Void) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, pending == nil, sync.paired else { return false }
        let conv = currentConv()
        var convId: String? = nil
        var fresh = false
        if startFresh { fresh = true }
        else if let c = conv, inSession(c) { convId = c["id"]?.stringValue }

        // Optimistic: show the message now; roll it back if the channel is down.
        let entry = Entry(role: "user", content: t, at: Date())
        thread.append(entry)
        pending = Pending(at: Date())
        draft = ""
        pendingTimer?.invalidate()
        pendingTimer = Timer.scheduledTimer(withTimeInterval: Self.replyTimeout, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.pending != nil else { return }
                self.clearPending()
                self.thread.append(Entry(role: "assistant",
                    content: "No reply yet — the run may still be going on your Mac. The answer will sync in when it finishes.",
                    at: Date(), error: true))
            }
        }
        sync.sendChat(t, convId: convId, fresh: fresh) { [weak self] ok in
            guard let self = self, !ok else { return }
            self.clearPending()
            self.thread.removeAll { $0.id == entry.id }
            self.draft = t
            onRefused("Not connected to your Mac yet — retrying")
        }
        return true
    }

    func newChat() {
        clearPending()
        thread = []
        startFresh = true
        freshAt = Date()
    }
}

// MARK: - Screen

struct AssistantView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var chat: ChatState
    @FocusState private var focused: Bool

    private struct Bubble: Identifiable {
        let id: String
        let role: String
        let content: String
        let error: Bool
    }

    private var statusLine: String {
        if !sync.paired { return "Runs on your Mac" }
        switch sync.state {
        case "idle", "syncing":
            return sync.transport == "direct" ? "Connected to your Mac on this network" : "Connected to your Mac via encrypted relay"
        case "connecting": return "Connecting to your Mac…"
        default: return "Offline — your Mac is unreachable"
        }
    }

    private func bubbles() -> [Bubble] {
        let latest = chat.currentConv()
        let conv = chat.startFresh ? nil : latest
        var out: [Bubble] = []
        if let conv = conv {
            for (i, m) in (conv["messages"]?.arrayValue ?? []).enumerated() {
                guard let role = m["role"]?.stringValue, role == "user" || role == "assistant",
                      let content = m["content"]?.stringValue,
                      !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                out.append(Bubble(id: "c\(i)", role: role, content: content, error: false))
            }
        }
        for m in chat.thread { out.append(Bubble(id: m.id.uuidString, role: m.role, content: m.content, error: m.error)) }
        return out
    }

    var body: some View {
        let _ = store.revision
        let msgs = bubbles()
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ScreenHead("Assistant", sub: statusLine) {
                            HeadAction(symbol: "plus", label: "New chat") { chat.newChat() }
                        }
                        if !sync.paired {
                            notPaired
                        } else {
                            transcript(msgs)
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                .onChange(of: msgs.count) { _ in withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
                .onChange(of: chat.pending?.acked) { _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
            composer
        }
        .background(Theme.bg)
        .rootScreen("Assistant")
        // Reconcile the optimistic thread against the synced conversation
        // whenever the store changes — off the render pass, so it never
        // publishes from inside a view update.
        .onReceive(store.$revision) { _ in chat.reconcile(chat.currentConv()) }
        .onAppear { chat.reconcile(chat.currentConv()); applyCompose() }
        .onChange(of: router.composeFocusToken) { _ in applyCompose() }
    }

    private func applyCompose() {
        if let p = router.composePrefill {
            chat.draft = p
            router.composePrefill = nil
            focused = true
        } else if router.composeFocusToken > 0 && lastFocusToken != router.composeFocusToken {
            focused = true
        }
        lastFocusToken = router.composeFocusToken
    }
    @State private var lastFocusToken = 0

    private var notPaired: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Chat with your assistant — the same one as on your Mac, with your tasks, notes, and tools. It runs on your Mac; this phone reaches it over an encrypted connection only you hold the keys to.")
                .font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(label: "Pair with your Mac") { router.open(app: "settings") }
        }
        .themedCard()
    }

    @ViewBuilder private func transcript(_ msgs: [Bubble]) -> some View {
        if msgs.isEmpty && chat.pending == nil {
            EmptyText("Ask anything — your tasks, your notes, your day. Answers come from your Mac.")
                .padding(.top, 6)
        }
        ForEach(msgs) { m in
            if m.role == "user" {
                HStack {
                    Spacer(minLength: 48)
                    Text(m.content)
                        .font(.system(size: 15.5))
                        .foregroundStyle(Theme.bg)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.text))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                HStack {
                    Group {
                        if m.error {
                            Text(m.content).font(.system(size: 15)).foregroundStyle(Theme.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            MarkdownView(text: m.content)
                                .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(m.error ? Theme.danger.opacity(0.4) : Theme.border))
                    Spacer(minLength: 24)
                }
            }
        }
        if let p = chat.pending {
            HStack {
                Text(p.acked ? "Your Mac is thinking…" : "Reaching your Mac…")
                    .font(.system(size: 15)).italic().foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.border))
                Spacer(minLength: 24)
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask your assistant…", text: $chat.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 16))
                    .focused($focused)
                    .disabled(!sync.paired)
                    .onSubmit { doSend() }
                    .submitLabel(.send)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.border))
                Button(action: doSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Theme.bg)
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(Theme.text))
                        .opacity(canSend ? 1 : 0.4)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.bg)
        }
    }

    private var canSend: Bool {
        sync.paired && chat.pending == nil && !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func doSend() {
        guard canSend else { return }
        chat.send(chat.draft) { msg in router.showToast(msg) }
    }
}
