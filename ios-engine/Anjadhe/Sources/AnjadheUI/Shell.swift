import SwiftUI
import AnjadheCore

struct Shell: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: AppStore
    @StateObject private var threads = ThreadStore()
    @StateObject private var chat = ChatSession()
    @State private var threadQuery = ""
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        VStack(spacing: 0) {
            NavigationStack(path: router.binding(for: router.tab)) {
                root.navigationDestination(for: Route.self) { route in
                    switch route {
                    case .thread(let id): ThreadView(id: id)
                    case .threadInfo(let id): ThreadInfoView(id: id)
                    case .conversation(let id): ConversationView(id: id)
                    case .note(let id): NoteEditor(id: id)
                    case .documents: NotesView()
                    case .memoryPage(let id): MemoryFactsView(id: id)
                    case .ai: DeviceSetupView().pushedScreen()
                    case .lock: ScreenColumn { ScreenHead("Lock nenva"); LockSettingsCard() }.pushedScreen()
                    }
                }
            }.id(router.tab)
            if router.path(for: router.tab).isEmpty {
            HStack(spacing: 0) {
                tab(.threads, "Threads", "bubble.left.and.bubble.right")
                tab(.memory, "Memory", "books.vertical")
                tab(.settings, "Settings", "gearshape")
            }.padding(.vertical, 6).background(Theme.navWash)
            }
        }
        .background(Theme.bg).environmentObject(threads).environmentObject(chat)
        .overlay(alignment: .bottom) { if let text = router.toast { ToastView(text: text).padding(.bottom, 70) } }
        .task(id: store.revision) { await threads.refresh(store) }
        .onAppear { router.threadHome = { threads.home(for: $0) } }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            Task { await threads.refresh(store) }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await threads.refresh(store) } }
            if phase == .background, chat.running, let conversation = chat.activeConversation {
                Task { await chat.stop(conversation: conversation, store: store) }
            }
        }
    }
    @ViewBuilder private var root: some View {
        switch router.tab {
        case .threads: ThreadsView(query: $threadQuery)
        case .memory: MemoryView()
        case .settings: SettingsView()
        }
    }
    private func tab(_ tab: RootTab, _ title: String, _ symbol: String) -> some View {
        Button { PendingWrites.shared.flushAll(); router.root(tab) } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 19))
                    .frame(width: 54, height: 28)
                    .background(Capsule().fill(router.tab == tab ? Theme.accentSoft : .clear))
                Text(title).font(.caption).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }.frame(maxWidth: .infinity).frame(minHeight: Theme.minimumTouchTarget)
                .foregroundStyle(router.tab == tab ? Theme.text : Theme.textSecondary)
        }.buttonStyle(.plain).accessibilityAddTraits(router.tab == tab ? .isSelected : [])
    }
}

struct ThreadsView: View {
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    @Binding var query: String
    @State private var action: RecordAction?
    var body: some View {
        ScreenColumn {
            ScreenHead("Threads") {
                HeadAction(symbol: "square.and.pencil", label: "New conversation") { router.push(.conversation(UUID().uuidString)) }
                Menu {
                    Button { action = .thread } label: { Label("New thread", systemImage: "plus") }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }.accessibilityLabel("Thread actions")
            }
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary)
                TextField("Search threads", text: $query).font(Theme.bodyFont)
                    .autocorrectionDisabled().accessibilityLabel("Search threads")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44) }
                        .buttonStyle(.plain).accessibilityLabel("Clear search")
                }
            }.padding(.horizontal, 12).frame(minHeight: 48).background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            if let error = threads.error { EmptyText(error) }
            let rows = threads.threads.filter { row in
                query.isEmpty || ["title", "preview", "facts"].contains { (row[$0]?.stringValue ?? "").localizedCaseInsensitiveContains(query) }
            }
            if rows.isEmpty && !query.isEmpty { EmptyText("No threads match “\(query)”.") }
            LazyVStack(spacing: 0) {
                ForEach(rows, id: \.threadKey) { row in
                    Button { router.push(.thread(row["key"]?.stringValue ?? "")) } label: {
                        ThreadListRow(row: row)
                    }.buttonStyle(.plain)
                }
            }
        }.rootScreen("Threads").sheet(item: $action) { RecordActionSheet(action: $0) }
    }
}

struct ThreadView: View {
    let id: String
    @EnvironmentObject private var store: AppStore
    @State private var newConversation = UUID().uuidString
    private var conversationID: String {
        if id == "nenva" { return threads.thread(id)?["conversationId"]?.stringValue ?? newConversation }
        return store.items("agent-conversations", "conversations").filter { $0["todayKey"]?.stringValue == id && $0["private"]?.boolValue != true }.sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }.first?["id"]?.stringValue ?? newConversation
    }
    @State private var action: RecordAction?
    @State private var atBottom = true
    @State private var positioned = false
    @State private var newMessages = false
    @State private var panelOpen = false
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var chat: ChatSession
    private var items: [JSONValue] { threads.thread(id)?["items"]?.arrayValue ?? [] }
    var body: some View {
        ScrollViewReader { scroll in
        ScreenColumn(spacing: 16) {
            if let row = threads.thread(id) {
                ScreenHead(row["title"]?.stringValue ?? "Thread") {
                    if !(row["panel"]?.arrayValue ?? []).isEmpty {
                        HeadAction(symbol: "chart.xyaxis.line", label: "What this thread is tracking") { panelOpen = true }
                    }
                    HeadAction(symbol: "info.circle", label: "Thread info") { router.push(.threadInfo(id)) }
                }
                if id == "nenva" { ThreadDayView(schedule: threads.schedule) }
                if let error = threads.error { EmptyText(error) }
                if items.isEmpty {
                    EmptyText(id == "nenva" ? "Ask me anything, or tell me what you’d like to keep track of." : "This is where you can talk about \(row["title"]?.stringValue ?? "this thing").")
                }
                TimelineView(items: items)
                if id == "sender:reminders" || id.hasPrefix("sender:") {
                    Button("Add commitment") { action = .commitment(sender: id == "sender:reminders" ? nil : id) }
                }
            } else { EmptyText("This thread is not available on this iPhone.") }
            Color.clear.frame(height: 1).id("thread-bottom")
                .onAppear { atBottom = true; newMessages = false }
                .onDisappear { atBottom = false }
        }.onChange(of: items.count) { _ in
            if !positioned || atBottom { scroll.scrollTo("thread-bottom", anchor: .bottom); positioned = true }
            else { newMessages = true }
        }.onChange(of: threads.thread(id)?["panel"]?.arrayValue?.count ?? 0) { count in
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            if count > 0 && arguments.contains("--preview-mobile-threads") && arguments.contains("--preview-mobile-panel") { panelOpen = true }
            #endif
        }.onChange(of: chat.running) { running in
            // Sending is an explicit request to return to this turn. Passive
            // updates while reading earlier messages leave the position alone.
            if running && chat.activeConversation == conversationID { scroll.scrollTo("thread-bottom", anchor: .bottom) }
        }.overlay(alignment: .bottomTrailing) {
            if newMessages {
                Button("New messages") { scroll.scrollTo("thread-bottom", anchor: .bottom); newMessages = false }
                    .font(Theme.actionFont).frame(minHeight: 44).padding(.horizontal, 16)
                    .background(Capsule().fill(Theme.surface)).padding(12)
            }
        }.pushedScreen().safeAreaInset(edge: .bottom) {
            ChatComposer(conversation: conversationID, thread: id).id(conversationID)
        }.sheet(item: $action) { RecordActionSheet(action: $0) }
            .sheet(isPresented: $panelOpen) { ThreadPanelView(id: id) }
            .task(id: id) { await threads.focus(id, store: store) }
        }
    }
}

struct TimelineView: View {
    let items: [JSONValue]
    var body: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            let mine = item["side"]?.stringValue == "me"
            HStack {
                if mine { Spacer(minLength: 28) }
                Group {
                    if item["md"]?.boolValue == true { MarkdownView(text: item["text"]?.stringValue ?? "") }
                    else { Text(item["text"]?.stringValue ?? "").font(Theme.bodyFont) }
                }.textSelection(.enabled)
                    .padding(14).background(mine ? Theme.accentSoft : Theme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
                if !mine { Spacer(minLength: 28) }
            }
        }
    }
}

struct ConversationView: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var chat: ChatSession
    @State private var positioned = false
    @State private var timeline: [JSONValue] = []
    @State private var error: String?
    var body: some View {
        ScrollViewReader { scroll in
        ScreenColumn {
            ScreenHead("Conversation")
            if let error { EmptyText(error) }
            TimelineView(items: timeline)
            Color.clear.frame(height: 1).id("conversation-bottom")
        }.onChange(of: timeline.count) { _ in
            if !positioned || chat.activeConversation == id { scroll.scrollTo("conversation-bottom", anchor: .bottom); positioned = true }
        }.pushedScreen().safeAreaInset(edge: .bottom) {
            ChatComposer(conversation: id, thread: store.findItem("agent-conversations", "conversations", id: id)?["todayKey"]?.stringValue ?? "nenva")
        }.task(id: store.revision) {
            guard let conversation = store.findItem("agent-conversations", "conversations", id: id), conversation["private"]?.boolValue != true else { return }
            do { timeline = try await SharedCore().call(.senderTimeline, arguments: [.null, .array([]), conversation]).arrayValue ?? [] }
            catch { self.error = "Couldn’t open this conversation." }
        }
        }
    }
}

struct ThreadInfoView: View {
    let id: String
    @State private var action: RecordAction?
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    var body: some View {
        ScreenColumn {
            if let row = threads.thread(id) {
                ScreenHead(row["title"]?.stringValue ?? "Thread info", sub: row["facts"]?.stringValue)
                if id == "nenva" {
                    PrimaryButton(label: "New conversation") { router.push(.conversation(UUID().uuidString)) }
                    SectionLabel("Conversations")
                    let history = (row["conversations"]?.arrayValue ?? []).sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }
                    if history.isEmpty { EmptyText("Your saved conversations will appear here.") }
                    ForEach(history, id: \.recordID) { conversation in
                        Button { router.push(.conversation(conversation["id"]?.stringValue ?? "")) } label: {
                            RowView(conversation["title"]?.stringValue ?? "Conversation", sub: DateLogic.relDate(conversation["updatedAt"]?.stringValue ?? ""))
                        }.buttonStyle(.plain)
                    }
                }
                ForEach(["open", "facts", "settled"], id: \.self) { section in
                    let rows = row["info"]?[section]?.arrayValue ?? []
                    if !rows.isEmpty {
                        SectionLabel(section.capitalized)
                        CardList {
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, item in
                                RowView(item["title"]?.stringValue ?? item["label"]?.stringValue ?? "", sub: item["value"]?.stringValue ?? item["date"]?.stringValue ?? item["status"]?.stringValue ?? item["facts"]?.stringValue)
                                if ["open", "settled"].contains(section), item["type"]?.stringValue == "commitment", let key = item["key"]?.stringValue, key.hasPrefix("task:") {
                                    Button(item["done"]?.boolValue == true ? "Reopen" : "Mark done") {
                                        action = .completion(id: String(key.dropFirst(5)), done: item["done"]?.boolValue != true)
                                    }.padding(.horizontal, 16).padding(.bottom, 12)
                                }
                            }
                        }
                    }
                }
                let receipts = store.items("record-receipts", "items").filter { receipt in
                    receipt["threadKey"]?.stringValue == id ||
                    (row["info"]?["open"]?.arrayValue ?? []).contains { $0["key"]?.stringValue == "task:" + (receipt["target"]?.stringValue ?? "") } ||
                    (row["info"]?["settled"]?.arrayValue ?? []).contains { $0["key"]?.stringValue == "task:" + (receipt["target"]?.stringValue ?? "") }
                }
                if !receipts.isEmpty {
                    SectionLabel("Recent changes")
                    ForEach(Array(receipts.suffix(10).reversed().enumerated()), id: \.offset) { _, receipt in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(receipt["label"]?.stringValue ?? "Saved")
                            Text(receipt["title"]?.stringValue ?? "").font(Theme.detailFont)
                            if let ledger = receipt["ledgerId"]?.stringValue,
                               store.items("commitments", "ledger").contains(where: { $0["id"]?.stringValue == ledger && ($0["undone"] == nil || $0["undone"] == .null) }) {
                                Button("Undo") { action = .undo(ledger: ledger) }
                            }
                        }.padding(.vertical, 8)
                    }
                }
            } else { EmptyText("This thread is not available on this iPhone.") }
        }.pushedScreen().sheet(item: $action) { RecordActionSheet(action: $0) }
    }
}
