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

    /// The answer as it is being written (2026-09-21).
    ///
    /// Deliberately NOT an entry in `thread`: `reconcile` culls thread
    /// entries by timestamp and by content identity against the synced
    /// transcript, and a half-written answer matches neither — it would be
    /// left behind as a duplicate under the real one. This is a separate
    /// buffer that the final `chat-reply` replaces outright.
    @Published var streaming: String = ""
    /// The last `seq` seen. A gap means frames were lost across a reconnect,
    /// and a partial answer with a hole in it is worse than none — so the
    /// buffer is dropped and the screen falls back to "thinking…" until the
    /// authoritative reply lands.
    private var streamSeq = 0
    private var streamBroken = false

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
            case "chat-delta":
                guard self.pending != nil else { break }
                self.pending?.acked = true
                if let s = ev.seq {
                    if s != self.streamSeq + 1 { self.streamBroken = true }
                    self.streamSeq = s
                }
                if !self.streamBroken { self.streaming += ev.text }
                // Real evidence of life, stronger than the ack: push the
                // give-up timer out so a long answer is never interrupted by
                // "No reply yet" while it is visibly arriving.
                self.armPendingTimer()
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
        streaming = ""
        streamSeq = 0
        streamBroken = false
        pendingTimer?.invalidate()
        pendingTimer = nil
    }

    /// (Re)arm the give-up timer. Every delta pushes it out — the run is
    /// visibly alive, and the timeout exists for silence, not for slowness.
    func armPendingTimer() {
        pendingTimer?.invalidate()
        pendingTimer = Timer.scheduledTimer(withTimeInterval: Self.replyTimeout, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.pending != nil else { return }
                let partial = self.streaming
                self.clearPending()
                // A partial answer is worth keeping: the run may well have
                // finished on the Mac and the reply will sync in, but what
                // was already written should not vanish off the screen.
                if !partial.isEmpty {
                    self.thread.append(Entry(role: "assistant", content: partial, at: Date()))
                }
                self.thread.append(Entry(role: "assistant",
                    content: "No reply yet — the run may still be going on your Mac. The answer will sync in when it finishes.",
                    at: Date(), error: true))
            }
        }
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
        armPendingTimer()
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
            switch sync.via ?? sync.transport {
            case "lan", "direct": return "Connected to your Mac on this network"
            case "tailscale": return "Connected to your Mac through Tailscale"
            default: return "Connected to your Mac via encrypted relay"
            }
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
                // A streaming answer grows without changing the message
                // COUNT, so it would otherwise write itself off the bottom
                // of the screen. Follow its length instead.
                .onChange(of: chat.streaming.count) { _ in proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
            composer
        }
        .background(Theme.bg)
        .rootScreen("Assistant")
        // The function bar stands down while the keyboard is up: a composer,
        // a nav bar and the keyboard is three bars deep, and the transcript
        // is what the screen is for.
        .onChange(of: focused) { f in router.composerFocused = f }
        .onDisappear { router.composerFocused = false }
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

    /// The transcript, in the shape a chat app has settled on (2026-09-21,
    /// by request: "similar to how the chat page is designed for apps like
    /// claude or chatgpt").
    ///
    /// The one change that does most of the work: an ASSISTANT answer is no
    /// longer a bubble. It is prose, full width, on the page — bubbles on
    /// both sides halve the reading width and make a long answer look like a
    /// text message, which is the opposite of what it is. The USER's turn
    /// stays a bubble, right-aligned, because a short instruction reads well
    /// as one and it is what tells the two apart at a glance.
    @ViewBuilder private func transcript(_ msgs: [Bubble]) -> some View {
        if msgs.isEmpty && chat.pending == nil {
            emptyState
        }
        ForEach(msgs) { m in
            if m.role == "user" {
                HStack {
                    Spacer(minLength: 56)
                    Text(m.content)
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.bg)
                        .padding(.horizontal, 15).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.text))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .padding(.top, 6)
            } else {
                answer(m.content, error: m.error, streaming: false)
            }
        }
        // The answer as it arrives. Same renderer as a finished one, so the
        // text does not reflow when the run ends and the real message
        // replaces it.
        if chat.pending != nil {
            if !chat.streaming.isEmpty {
                answer(chat.streaming, error: false, streaming: true)
            } else {
                thinking
            }
        }
    }

    /// One assistant turn: prose, a caret while it is being written, and a
    /// copy button once it is finished.
    @ViewBuilder private func answer(_ text: String, error: Bool, streaming: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if error {
                Text(text)
                    .font(.system(size: 16)).foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(alignment: .bottom, spacing: 0) {
                    MarkdownView(text: text)
                        .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
                        .textSelection(.enabled)
                    if streaming { Caret() }
                }
            }
            if !streaming && !error {
                Button {
                    copyToPasteboard(text)
                    router.showToast("Copied")
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.vertical, 2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy answer")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }

    /// Before the first token: the Mac may be loading a model, calling a
    /// tool or thinking. Three dots say "alive" without claiming progress.
    private var thinking: some View {
        HStack(spacing: 8) {
            TypingDots()
            Text(chat.pending?.acked == true ? "Working on your Mac" : "Reaching your Mac")
                .font(.system(size: 14)).foregroundStyle(Theme.textTertiary)
            Spacer()
        }
        .padding(.vertical, 4)
    }

    /// Nothing said yet. A greeting and a few openers — static, because a
    /// suggestion that costs a model call is a suggestion that arrives after
    /// you have already started typing.
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What can I help with?")
                .displayStyle(26)
                .padding(.top, 10)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.openers, id: \.self) { o in
                    Button {
                        chat.draft = o
                        focused = true
                    } label: {
                        HStack(spacing: 10) {
                            Text(o).font(.system(size: 15)).foregroundStyle(Theme.text)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.left")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Theme.textQuaternary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                    }
                    .buttonStyle(.plain)
                }
            }
            Text("Answers come from your Mac.")
                .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
        }
    }

    private static let openers = [
        "What needs me today?",
        "Summarise my unread email",
        "What did I write about last week?",
        "Add a task for tomorrow morning",
    ]

    /// The composer: one pill with the send button inside it, the shape every
    /// chat app has converged on. It grows to five lines and then scrolls.
    private var composer: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.6)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message your assistant…", text: $chat.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 16))
                    .focused($focused)
                    .disabled(!sync.paired)
                    .submitLabel(.send)
                    .padding(.leading, 16)
                    .padding(.vertical, 10)
                Button(action: doSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(canSend ? Theme.bg : Theme.textQuaternary)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(canSend ? Theme.text : Theme.surfaceHover))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .padding(.trailing, 5)
                .padding(.bottom, 4)
            }
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Theme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(focused ? Theme.borderHover : Theme.border)
            )
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
        .background(Theme.bg)
    }

    private var canSend: Bool {
        sync.paired && chat.pending == nil && !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func doSend() {
        guard canSend else { return }
        chat.send(chat.draft) { msg in router.showToast(msg) }
    }
}

// MARK: - Small animated pieces

/// The block caret that trails a streaming answer. A steady blink is the
/// oldest "still writing" signal there is, and it costs one animation.
private struct Caret: View {
    @State private var on = true
    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Theme.text)
            .frame(width: 2, height: 17)
            .padding(.leading, 3)
            .opacity(on ? 1 : 0)
            .animation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true), value: on)
            .onAppear { on = false }
    }
}

/// Three dots, before the first token arrives.
private struct TypingDots: View {
    @State private var phase = 0.0
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Theme.textTertiary)
                    .frame(width: 6, height: 6)
                    .opacity(0.35 + 0.65 * max(0, cos(phase - Double(i) * 0.7)))
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                phase = .pi * 2
            }
        }
    }
}
