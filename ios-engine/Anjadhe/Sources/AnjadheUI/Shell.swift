import SwiftUI
import AnjadheCore

struct Shell: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: AppStore
    @StateObject private var threads = ThreadStore()
    @StateObject private var chat = ChatSession()
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
                tab(.now, "Now", "sun.max")
                tab(.threads, "Threads", "bubble.left.and.bubble.right")
                tab(.memory, "Memory", "books.vertical")
                tab(.settings, "Settings", "gearshape")
            }.padding(.vertical, 6).background(Theme.navWash)
            }
        }
        .background(Theme.bg).environmentObject(threads).environmentObject(chat)
        .overlay(alignment: .bottom) { if let text = router.toast { ToastView(text: text).padding(.bottom, 70) } }
        .task(id: store.revision) { await threads.refresh(store) }
        .onChange(of: scenePhase) { phase in
            if phase == .background, chat.running, let conversation = chat.activeConversation {
                Task { await chat.stop(conversation: conversation, store: store) }
            }
        }
    }
    @ViewBuilder private var root: some View {
        switch router.tab {
        case .now: NowView()
        case .threads: ThreadsView()
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
                Text(title).font(.caption2)
            }.frame(maxWidth: .infinity).frame(minHeight: Theme.minimumTouchTarget)
                .foregroundStyle(router.tab == tab ? Theme.text : Theme.textSecondary)
        }.buttonStyle(.plain).accessibilityAddTraits(router.tab == tab ? .isSelected : [])
    }
}

struct NowView: View {
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    var body: some View {
        ScreenColumn {
            ScreenHead("Now", sub: Date().formatted(date: .complete, time: .omitted))
            if let error = threads.error { EmptyText(error) }
            else if threads.due.isEmpty { EmptyText("No commitments due in your saved records.") }
            else {
                CardList {
                    ForEach(Array(threads.due.enumerated()), id: \.offset) { _, row in
                        Button { router.push(.thread(row["key"]?.stringValue ?? "")) } label: {
                            RowView(row["title"]?.stringValue ?? "", sub: row["when"]?.stringValue)
                        }.buttonStyle(.plain)
                    }
                }
            }
            Text("Calendar connections and background updates are not available in this build yet.")
                .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
        }.rootScreen("Now")
    }
}

struct ThreadsView: View {
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    @State private var query = ""
    @State private var action: RecordAction?
    var body: some View {
        ScreenColumn {
            ScreenHead("Threads") {
                HeadAction(symbol: "plus", label: "New thread") { action = .thread }
            }
            TextField("Search threads", text: $query).textFieldStyle(.roundedBorder)
            if let error = threads.error { EmptyText(error) }
            CardList {
                ForEach(Array(threads.threads.filter { query.isEmpty || ($0["title"]?.stringValue ?? "").localizedCaseInsensitiveContains(query) }.enumerated()), id: \.offset) { _, row in
                    Button { router.push(.thread(row["key"]?.stringValue ?? "")) } label: {
                        RowView(row["title"]?.stringValue ?? "", sub: row["preview"]?.stringValue) {
                            Image(systemName: "chevron.right").font(.caption)
                        }
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
        store.items("agent-conversations", "conversations").filter { $0["todayKey"]?.stringValue == id && $0["private"]?.boolValue != true }.sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }.first?["id"]?.stringValue ?? newConversation
    }
    @State private var action: RecordAction?
    @EnvironmentObject var threads: ThreadStore
    @EnvironmentObject var router: Router
    var body: some View {
        ScreenColumn(spacing: 16) {
            if let row = threads.thread(id) {
                ScreenHead(row["title"]?.stringValue ?? "Thread", sub: row["facts"]?.stringValue) {
                    HeadAction(symbol: "info.circle", label: "Thread info") { router.push(.threadInfo(id)) }
                }
                TimelineView(items: row["items"]?.arrayValue ?? [])
                ForEach(Array((row["conversations"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, conversation in
                    Button { router.push(.conversation(conversation["id"]?.stringValue ?? "")) } label: {
                        RowView(conversation["title"]?.stringValue ?? "Conversation")
                    }.buttonStyle(.plain)
                }
                if id == "sender:reminders" || id.hasPrefix("sender:") {
                    Button("Add commitment") { action = .commitment(sender: id == "sender:reminders" ? nil : id) }
                }
                if id == "nenva" {
                    Button("New conversation") { router.push(.conversation(UUID().uuidString)) }
                }
            } else { EmptyText("This thread is not available on this iPhone.") }
        }.pushedScreen().safeAreaInset(edge: .bottom) {
            if id != "nenva" { ChatComposer(conversation: conversationID, thread: id) }
        }.sheet(item: $action) { RecordActionSheet(action: $0) }
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
    var body: some View {
        ScreenColumn {
            if let row = threads.thread(id) {
                ScreenHead(row["title"]?.stringValue ?? "Thread info", sub: row["facts"]?.stringValue)
                ForEach(["open", "upcoming", "facts", "settled"], id: \.self) { section in
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
