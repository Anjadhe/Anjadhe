import SwiftUI
import Combine
import AnjadheCore

// When the Mac cannot be reached and the user chose a model for the phone
// (synced `phone-ai`), the phone answers by itself on that model — read-only,
// signed with the model's name, and handed back to the Mac with the next
// message it answers (docs/MOBILE_NATIVE.md "M5", laws P1-P5 in
// AnjadheCore/PhoneAI.swift; the loop is PhoneAgent.swift).
//
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
    /// A message sent to a Mac that looked connected but never acked: the
    /// socket was dead. With a phone model chosen, answer here instead.
    static let ackTimeout: TimeInterval = 12
    /// How long a send waits for a reconnecting channel before deciding the
    /// Mac is away (P1). Long enough for a foreground reconnect on the LAN.
    static let reachWait: TimeInterval = 4

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
    /// Set while THIS phone is writing the answer (the Mac is away): the
    /// model's name, for the "thinking" line (P2).
    @Published var answeringOnPhone: String?
    /// Approvals the Mac is asking this phone for (2026-09-25): a step in a
    /// phone turn that needs the user's OK. Pushed as `chat-ask`, re-read
    /// from the Mac's `chat-asks` view on every reconnect, removed when
    /// answered here or settled elsewhere (`chat-ask-done`).
    @Published var asks: [JSONValue] = []
    /// Tells the user an approval is waiting when they are on another screen
    /// (AppRoot wires it to the router's toast).
    public var onNewAsk: ((String) -> Void)?

    private let store: AppStore
    private let sync: SyncCoordinator
    private var pendingTimer: Timer?
    private var ackTimer: Timer?
    private var phoneRun: Task<Void, Never>?
    private var lastMacSend: (text: String, entryId: UUID)?
    private var fetchingKey = false
    private var bag = Set<AnyCancellable>()

    public init(store: AppStore, sync: SyncCoordinator) {
        self.store = store
        self.sync = sync
        // Replies land whatever screen is open.
        sync.chat.receive(on: DispatchQueue.main).sink { [weak self] ev in
            guard let self = self else { return }
            if ev.kind == "chat-ask" || ev.kind == "chat-ask-done" { self.noteAsk(ev); return }
            // The phone is writing this answer itself; a late Mac push for an
            // earlier send must not clear its spinner.
            if self.answeringOnPhone != nil { return }
            switch ev.kind {
            case "chat-ack":
                if self.pending != nil { self.pending?.acked = true; self.ackTimer?.invalidate() }
            case "chat-delta":
                guard self.pending != nil else { break }
                self.pending?.acked = true
                self.ackTimer?.invalidate()
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
                // The channel is up but the app is not running there: that is
                // the Mac being away too (P1).
                if ev.text.hasPrefix("nenva is not open"), let sent = self.lastMacSend, self.phoneReady {
                    self.clearPending()
                    self.thread.removeAll { $0.id == sent.entryId }
                    self.runOnPhone(sent.text)
                    return
                }
                self.clearPending()
                self.thread.append(Entry(role: "assistant", content: ev.text.isEmpty ? "Something went wrong." : ev.text, at: Date(), error: true))
            default:
                break
            }
        }.store(in: &bag)
        // Fetch or drop the nenva Cloud key as the choice and the connection
        // change (P4): a choice made on either device, a Mac that just came
        // back, a choice turned off.
        sync.$state.receive(on: DispatchQueue.main).sink { [weak self] state in
            DispatchQueue.main.async {
                self?.syncCloudKey()
                if state == "idle" { self?.refreshAsks() }
            }
        }.store(in: &bag)
        store.$revision.debounce(for: .seconds(1), scheduler: DispatchQueue.main).sink { [weak self] _ in
            self?.syncCloudKey()
        }.store(in: &bag)
    }

    // MARK: approvals from the Mac

    private func noteAsk(_ ev: SyncCoordinator.ChatEvent) {
        guard let ask = ev.ask, let id = ask["askId"]?.stringValue, !id.isEmpty else { return }
        if ev.kind == "chat-ask-done" {
            asks.removeAll { $0["askId"]?.stringValue == id }
            return
        }
        guard !asks.contains(where: { $0["askId"]?.stringValue == id }) else { return }
        asks.append(ask)
        // A run waiting on the user is not silent; the give-up timer is for
        // silence. It re-arms when the answer goes back.
        if pending != nil { pending?.acked = true; pendingTimer?.invalidate() }
        onNewAsk?("Your Mac needs your OK for a step — open Assistant")
    }

    /// Re-read what the Mac is still asking (a push can be missed while the
    /// phone was not connected).
    func refreshAsks() {
        guard sync.paired else { return }
        sync.requestView("chat-asks") { [weak self] result in
            guard let self = self, case .success(let data) = result else { return }
            let fresh = data["asks"]?.arrayValue ?? []
            let known = Set(self.asks.compactMap { $0["askId"]?.stringValue })
            self.asks = fresh
            if fresh.contains(where: { !known.contains($0["askId"]?.stringValue ?? "") }) {
                if self.pending != nil { self.pending?.acked = true; self.pendingTimer?.invalidate() }
                self.onNewAsk?("Your Mac needs your OK for a step — open Assistant")
            }
        }
    }

    /// Answer one ask. `scope` is "once" | "session" | "always".
    func answer(_ ask: JSONValue, approved: Bool, scope: String, onFail: @escaping (String) -> Void) {
        guard let id = ask["askId"]?.stringValue else { return }
        sync.answerAsk(id, approved: approved, scope: scope) { [weak self] ok in
            guard let self = self else { return }
            if ok {
                self.asks.removeAll { $0["askId"]?.stringValue == id }
                if self.pending != nil && self.asks.isEmpty { self.armPendingTimer() }
            } else {
                onFail("Not connected to your Mac — try again in a moment")
            }
        }
    }

    // MARK: the phone's own model (MOBILE_NATIVE.md M5, laws in AnjadheCore/PhoneAI.swift)

    /// The model the user chose for the phone, or nil (off).
    var choice: PhoneModelChoice? { PhoneModelChoice.from(store.blob("phone-ai")) }

    /// A choice AND the key to use it.
    var phoneReady: Bool { choice != nil && CloudCredentials.load() != nil }

    var macLive: Bool { sync.paired && (sync.state == "idle" || sync.state == "syncing") }

    /// Keep the Keychain in step with the choice: fetch the key from the Mac
    /// when a choice exists and none is held; drop it when the choice is off.
    func syncCloudKey() {
        let held = CloudCredentials.load()
        // The key serves two choices, both the user's: a phone model, and
        // headlines through nenva Cloud (the Mac's News route, carried in
        // its last News answer — PhoneNews). Neither → no key on the phone.
        let newsViaCloud = MacViews.storedAnswer("news")?["route"]?.stringValue == "connect"
        guard choice != nil || newsViaCloud else {
            if held != nil { CloudCredentials.clear() }
            return
        }
        guard held == nil, macLive, !fetchingKey else { return }
        fetchingKey = true
        sync.requestView("cloud-access") { [weak self] result in
            self?.fetchingKey = false
            guard case .success(let data) = result, let key = data["apiKey"]?.stringValue, !key.isEmpty else { return }
            let base = data["baseUrl"]?.stringValue ?? CloudClient.defaultBase
            CloudCredentials.save(.init(apiKey: key, baseURL: base))
            self?.objectWillChange.send()
        }
    }

    /// Is the Mac there? Waits briefly for a channel that is reconnecting.
    @MainActor func macReachable() async -> Bool {
        guard sync.paired else { return false }
        if macLive { return true }
        if sync.state == "offline" || sync.state == "error" { sync.onForeground() }
        let deadline = Date().addingTimeInterval(Self.reachWait)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if macLive { return true }
        }
        return false
    }

    /// What the screen shows: the current mobile conversation's turns (the
    /// shared, record-merged list — the phone's own answers are in it,
    /// signed), unless "New chat" is holding the view empty.
    func transcript() -> [PhoneThread.Message] {
        startFresh ? [] : PhoneThread.messages(currentConv())
    }

    /// Write one conversation back into the shared list. Only that record
    /// changes; the upload marks the key as changed here, and the Mac MERGES
    /// it (main.js handleSyncManifest `dirty`, _mergeConversation) — so a
    /// turn the Mac added meanwhile survives beside ours.
    private func saveConversation(_ conv: [String: JSONValue]) {
        var blob = store.blob("agent-conversations")
        var list = blob["conversations"]?.arrayValue ?? []
        let id = conv["id"]?.stringValue
        if let i = list.firstIndex(where: { $0["id"]?.stringValue == id }) { list[i] = .object(conv) }
        else { list.insert(.object(conv), at: 0) }
        blob["conversations"] = .array(list)
        store.saveBlob("agent-conversations", blob)
    }

    /// Answer on this phone (P1-P3): the turn goes into the shared mobile
    /// conversation — the current one while in session, else a new one —
    /// and the answer streams, then lands signed with the model's name.
    func runOnPhone(_ text: String) {
        guard let choice = choice, let cred = CloudCredentials.load() else { return }
        let now = KVStore.nowISO()
        var conv: [String: JSONValue]
        if !startFresh, let cur = currentConv(), inSession(cur), let o = cur.objectValue {
            conv = o
        } else {
            let title = "Phone: " + String(text.prefix(48)) + (text.count > 48 ? "…" : "")
            conv = ["id": .string("conv_\(Int(Date().timeIntervalSince1970 * 1000))_\(String(UUID().uuidString.prefix(4)).lowercased())"),
                    "title": .string(title), "channel": .string("mobile"),
                    "createdAt": .string(now), "updatedAt": .string(now), "messages": .array([])]
        }
        startFresh = false
        conv = PhoneThread.appending(conv, ["role": .string("user"), "content": .string(text),
                                            "metadata": .object(["answeredOn": .string("phone")])], now: now)
        saveConversation(conv)

        pendingTimer?.invalidate(); ackTimer?.invalidate()
        pending = Pending(at: Date(), acked: true)
        streaming = ""
        answeringOnPhone = choice.displayName
        let history = PhoneThread.history(.object(conv))
        let agent = PhoneAgent(store: store, client: CloudClient(apiKey: cred.apiKey, baseURL: cred.baseURL), choice: choice)
        let convId = conv["id"]?.stringValue
        phoneRun = Task { @MainActor [weak self] in
            do {
                let answer = try await agent.answer(history: history) { slice in
                    DispatchQueue.main.async {
                        guard let self = self, self.answeringOnPhone != nil else { return }
                        if let s = slice { self.streaming += s } else { self.streaming = "" }
                    }
                }
                guard let self = self else { return }
                // Re-read: a sync may have merged Mac turns in while we wrote.
                let latest = (self.store.blob("agent-conversations")["conversations"]?.arrayValue ?? [])
                    .first { $0["id"]?.stringValue == convId }?.objectValue ?? conv
                self.saveConversation(PhoneThread.appending(latest, [
                    "role": .string("assistant"), "content": .string(answer),
                    "metadata": .object(["answeredOn": .string("phone"), "model": .string(choice.displayName)])],
                    now: KVStore.nowISO()))
                self.answeringOnPhone = nil
                self.clearPending()
            } catch {
                guard let self = self else { return }
                if (error as? CloudError)?.authFailed == true { CloudCredentials.clear() }
                self.answeringOnPhone = nil
                self.clearPending()
                if !Task.isCancelled {
                    let msg = (error as? CloudError)?.message ?? error.localizedDescription
                    self.thread.append(Entry(role: "assistant", content: "\(choice.displayName) could not answer: \(msg)", at: Date(), error: true))
                }
            }
        }
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
        if answeringOnPhone == nil, let p = pending, syncedAt > p.at, let last = msgs.last, last["role"]?.stringValue == "assistant" {
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
        ackTimer?.invalidate()
        ackTimer = nil
    }

    /// (Re)arm the give-up timer. Every delta pushes it out — the run is
    /// visibly alive, and the timeout exists for silence, not for slowness.
    func armPendingTimer() {
        pendingTimer?.invalidate()
        pendingTimer = Timer.scheduledTimer(withTimeInterval: Self.replyTimeout, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.pending != nil, self.answeringOnPhone == nil else { return }
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

    /// Returns false when nothing was sent (empty, already pending, or
    /// neither the Mac nor a phone model can answer).
    @discardableResult
    func send(_ text: String, onRefused: @escaping (String) -> Void) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, pending == nil, sync.paired || phoneReady else { return false }
        draft = ""
        // Optimistic: the message shows now, while the route is decided.
        let entry = Entry(role: "user", content: t, at: Date())
        thread.append(entry)
        pending = Pending(at: Date())
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            let reachable = await self.macReachable()
            if !reachable && self.phoneReady {
                // The phone conversation carries the message from here.
                self.thread.removeAll { $0.id == entry.id }
                self.runOnPhone(t)
            } else {
                if !reachable && self.choice != nil {
                    onRefused("Your phone gets its nenva Cloud key from your Mac the next time they connect")
                }
                self.sendToMac(t, entry: entry, onRefused: onRefused)
            }
        }
        return true
    }

    private func sendToMac(_ t: String, entry: Entry, onRefused: @escaping (String) -> Void) {
        let conv = currentConv()
        var convId: String? = nil
        var fresh = false
        // One conversation list (P5): whatever the phone answered by itself
        // is already in this conversation, so the Mac simply continues it.
        if startFresh { fresh = true }
        else if let c = conv, inSession(c) { convId = c["id"]?.stringValue }

        // The optimistic entry rolls back if the channel is down.
        lastMacSend = (t, entry.id)
        pending = Pending(at: Date())
        armPendingTimer()
        // A Mac that looked connected but never acks had a dead socket; with
        // a phone model ready, answer here rather than wait five minutes.
        ackTimer?.invalidate()
        ackTimer = Timer.scheduledTimer(withTimeInterval: Self.ackTimeout, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, let p = self.pending, !p.acked, self.phoneReady else { return }
                self.clearPending()
                self.thread.removeAll { $0.id == entry.id }
                self.runOnPhone(t)
            }
        }
        sync.sendChat(t, convId: convId, fresh: fresh) { [weak self] ok in
            guard let self = self, !ok else { return }
            self.clearPending()
            self.thread.removeAll { $0.id == entry.id }
            self.draft = t
            onRefused("Not connected to your Mac yet — retrying")
        }
    }

    func newChat() {
        phoneRun?.cancel()
        answeringOnPhone = nil
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
        var answeredBy: String? = nil
    }

    private var statusLine: String {
        if !sync.paired { return chat.phoneReady ? "Your Mac is away — \(chat.choice?.displayName ?? "nenva Cloud") answers" : "Runs on your Mac" }
        switch sync.state {
        case "idle", "syncing":
            switch sync.via ?? sync.transport {
            case "lan", "direct": return "Connected to your Mac on this network"
            case "tailscale": return "Connected to your Mac through Tailscale"
            default: return "Connected to your Mac via encrypted relay"
            }
        case "connecting": return "Connecting to your Mac…"
        default:
            if chat.phoneReady { return "Your Mac is away — \(chat.choice?.displayName ?? "nenva Cloud") answers" }
            return "Offline — your Mac is unreachable"
        }
    }

    private func bubbles() -> [Bubble] {
        var out: [Bubble] = []
        for (i, m) in chat.transcript().enumerated() {
            out.append(Bubble(id: "c\(i)", role: m.role, content: m.content, error: false, answeredBy: m.answeredBy))
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
                        if !sync.paired && !chat.phoneReady {
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
        .onAppear { chat.reconcile(chat.currentConv()); chat.refreshAsks(); applyCompose() }
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
                answer(m.content, error: m.error, streaming: false, by: m.answeredBy)
            }
        }
        // Approvals the Mac is waiting on — the run is paused on these.
        ForEach(chat.asks.indices, id: \.self) { i in
            AskCard(ask: chat.asks[i]) { approved, scope in
                chat.answer(chat.asks[i], approved: approved, scope: scope) { router.showToast($0) }
            }
        }
        // The answer as it arrives. Same renderer as a finished one, so the
        // text does not reflow when the run ends and the real message
        // replaces it.
        if chat.pending != nil && chat.asks.isEmpty {
            if !chat.streaming.isEmpty {
                answer(chat.streaming, error: false, streaming: true)
            } else {
                thinking
            }
        }
    }

    /// One assistant turn: prose, a caret while it is being written, and a
    /// copy button once it is finished.
    @ViewBuilder private func answer(_ text: String, error: Bool, streaming: Bool, by: String? = nil) -> some View {
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
            // P2: an answer this phone wrote says which model wrote it.
            if let by = by, !streaming, !error {
                Text("Answered on this phone by \(by) while your Mac was away")
                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
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
            Text(chat.answeringOnPhone.map { "Your Mac is away — answering with \($0)" }
                 ?? (chat.pending?.acked == true ? "Working on your Mac" : "Reaching your Mac"))
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
            Text(chat.choice == nil ? "Answers come from your Mac." : "Answers come from your Mac, or from \(chat.choice!.displayName) when your Mac is away.")
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
                    .disabled(!sync.paired && !chat.phoneReady)
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
        (sync.paired || chat.phoneReady) && chat.pending == nil && !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func doSend() {
        guard canSend else { return }
        chat.send(chat.draft) { msg in router.showToast(msg) }
    }
}

// MARK: - An approval card

/// One step the Mac's assistant wants to take for a phone turn, waiting on
/// the user — the Mac's own permission card, phone-sized: the same one-line
/// description, the same note, and the same scopes (a step that asks every
/// time offers "Just this once" only). "Always" is saved on the Mac and
/// revoked there, in Settings.
private struct AskCard: View {
    let ask: JSONValue
    let onAnswer: (Bool, String) -> Void
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PERMISSION NEEDED")
                .font(.system(size: 11, weight: .semibold)).tracking(0.6)
                .foregroundStyle(Theme.textSecondary)
            MarkdownView(text: ask["text"]?.stringValue ?? "")
            if let note = ask["note"]?.stringValue, !note.isEmpty {
                Text(note).font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 8) {
                PrimaryButton(label: "Allow just this once") { send(true, "once") }
                if ask["onceOnly"]?.boolValue != true {
                    SecondaryButton(label: "Allow for this session") { send(true, "session") }
                    SecondaryButton(label: "Always allow (saved on your Mac)") { send(true, "always") }
                }
                Button("Don't allow") { send(false, "once") }
                    .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.danger)
                    .buttonStyle(.plain).padding(.top, 2)
            }
            .disabled(sent)
            .opacity(sent ? 0.5 : 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .themedCard()
    }

    private func send(_ approved: Bool, _ scope: String) {
        sent = true
        onAnswer(approved, scope)
        // A failed send re-enables the buttons (the card stays until the
        // Mac confirms it settled).
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { sent = false }
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
