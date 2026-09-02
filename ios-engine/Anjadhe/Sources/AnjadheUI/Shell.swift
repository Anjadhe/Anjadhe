import SwiftUI
import AnjadheCore

// The native shell: one NavigationStack per root (Home · Assistant · Search),
// the function bar beneath (Home · Assistant · ＋ · Search — verbs, not apps),
// the ＋ capture sheet, and the toast. Apps and records are pushed screens
// (`Route`) on the root they were opened from; the bar stays put throughout.

struct Shell: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var store: AppStore

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                content
                FunctionBar()
            }
            .background(Theme.bg.ignoresSafeArea())
            if let t = router.toast {
                ToastView(text: t)
                    .padding(.bottom, 74)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(2)
            }
        }
        .animation(.easeOut(duration: 0.2), value: router.toast)
        .confirmationDialog("", isPresented: $router.showCapture, titleVisibility: .hidden) {
            Button("New note") { router.push(Capture.newNote(store)) }
            Button("New task") { router.push(Capture.newTask(store)) }
            Button("Journal entry") { router.push(Capture.newJournalEntry(store)) }
            Button("Save link") { router.push(Capture.newBookmark(store)) }
            Button("All apps") { router.open(app: "apps") }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder private var content: some View {
        switch router.tab {
        case .home:
            NavigationStack(path: router.binding(for: .home)) {
                HomeView().routeDestinations()
            }
        case .assistant:
            NavigationStack(path: router.binding(for: .assistant)) {
                AssistantView().routeDestinations()
            }
        case .search:
            NavigationStack(path: router.binding(for: .search)) {
                SearchView().routeDestinations()
            }
        }
    }
}

// MARK: - Route → screen

extension View {
    /// Attach the one `Route` destination table to a root.
    func routeDestinations() -> some View {
        self.navigationDestination(for: Route.self) { route in RouteView(route: route) }
    }
}

struct RouteView: View {
    let route: Route
    var body: some View {
        switch route {
        case .app(let id): AppScreen(id: id)
        case .task(let id): TaskEditor(id: id)
        case .note(let id): NoteEditor(id: id)
        case .journal(let id): JournalEditor(id: id)
        case .bookmark(let id): BookmarkEditor(id: id)
        case .prompt(let id): PromptEditor(id: id)
        case .goal(let id): GoalDetail(id: id)
        case .feedItem(let id): FeedDetail(id: id)
        case .insight(let id): InsightDetail(emailId: id)
        case .wellnessLog(let kind): WellnessLogView(kind: kind)
        }
    }
}

/// An app by id (the `AppCatalog` ids plus the two non-launcher screens).
struct AppScreen: View {
    let id: String
    var body: some View {
        switch id {
        case "tasks": TasksView()
        case "goals": GoalsView()
        case "notes": NotesView()
        case "journal": JournalView()
        case "calendar": CalendarView()
        case "wellness": WellnessView()
        case "fyi": FyiView()
        case "news": NewsView()
        case "portfolio": PortfolioView()
        case "prompts": PromptsView()
        case "feed": FeedView()
        case "bookmarks": BookmarksView()
        case "apps": AppsView()
        case "settings": SettingsView()
        default: EmptyText("Open this one on your Mac").padding()
        }
    }
}

// MARK: - Function bar

struct FunctionBar: View {
    @EnvironmentObject var router: Router

    var body: some View {
        HStack(spacing: 0) {
            item(.home, "Home", "house")
            item(.assistant, "Assistant", "sparkles")
            Button { router.showCapture = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.bg)
                    .frame(width: 50, height: 50)
                    .background(Circle().fill(Theme.text))
                    .accessibilityLabel("Create")
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            item(.search, "Search", "magnifyingglass")
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
        .background(Theme.bg.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 0.5) }
    }

    private func item(_ tab: RootTab, _ label: String, _ symbol: String) -> some View {
        let active = router.tab == tab
        return Button { router.root(tab) } label: {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 20, weight: active ? .semibold : .regular))
                Text(label).font(.system(size: 10.5, weight: active ? .semibold : .medium))
            }
            .foregroundStyle(active ? Theme.text : Theme.textTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Toast

struct ToastView: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.bg)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Capsule().fill(Theme.text))
    }
}

// MARK: - Shared screen pieces (the old mobile.css vocabulary, in SwiftUI)

/// The big serif screen heading + optional secondary line, with optional
/// trailing action buttons (the `.screen-head` / `.head-actions` pattern).
struct ScreenHead<Actions: View>: View {
    let title: String
    var sub: String? = nil
    var greeting = false
    @ViewBuilder var actions: () -> Actions

    init(_ title: String, sub: String? = nil, greeting: Bool = false, @ViewBuilder actions: @escaping () -> Actions) {
        self.title = title; self.sub = sub; self.greeting = greeting; self.actions = actions
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.display(greeting ? 30 : 28)).foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let s = sub, !s.isEmpty {
                    Text(s).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) { actions() }
        }
        .padding(.top, 6)
    }
}

extension ScreenHead where Actions == EmptyView {
    init(_ title: String, sub: String? = nil, greeting: Bool = false) {
        self.init(title, sub: sub, greeting: greeting) { EmptyView() }
    }
}

/// A round, quiet icon button for the screen head (`.head-action`).
struct HeadAction: View {
    let symbol: String
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(Theme.text)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.surface))
                .overlay(Circle().strokeBorder(Theme.border))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Uppercase, small, tracked section label (`.section-label`).
struct SectionLabel: View {
    let text: String
    var danger = false
    var count: Int? = nil
    init(_ text: String, danger: Bool = false, count: Int? = nil) { self.text = text; self.danger = danger; self.count = count }
    var body: some View {
        HStack(spacing: 6) {
            Text(text).sectionHeaderStyle().foregroundStyle(danger ? Theme.danger : Theme.textSecondary)
            if let c = count { Text("\(c)").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textTertiary) }
        }
        .padding(.bottom, 2)
    }
}

/// The bordered card that holds rows separated by hairlines (`.card.list`).
struct CardList<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(spacing: 0) { content() }
            .background(Theme.bg)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

/// One list row: title + optional sub, optional trailing text, hairline under.
struct RowView<Leading: View, Trailing: View>: View {
    let title: String
    var sub: String? = nil
    var done = false
    var last = false
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, sub: String? = nil, done: Bool = false, last: Bool = false,
         @ViewBuilder leading: @escaping () -> Leading, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title; self.sub = sub; self.done = done; self.last = last; self.leading = leading; self.trailing = trailing
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                leading()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? "Untitled" : title)
                        .font(.system(size: 16, weight: .medium))
                        .strikethrough(done)
                        .foregroundStyle(done ? Theme.textTertiary : Theme.text)
                        .lineLimit(2)
                    if let s = sub, !s.isEmpty {
                        Text(s).font(.system(size: 13)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
            if !last { Divider().padding(.leading, 14) }
        }
    }
}

extension RowView where Leading == EmptyView, Trailing == EmptyView {
    init(_ title: String, sub: String? = nil, done: Bool = false, last: Bool = false) {
        self.init(title, sub: sub, done: done, last: last, leading: { EmptyView() }, trailing: { EmptyView() })
    }
}
extension RowView where Leading == EmptyView {
    init(_ title: String, sub: String? = nil, done: Bool = false, last: Bool = false, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.init(title, sub: sub, done: done, last: last, leading: { EmptyView() }, trailing: trailing)
    }
}

/// The circular completion check (`.check`).
struct CheckButton: View {
    let on: Bool
    var muted = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(on ? Theme.text : Theme.borderHover, lineWidth: 1.5)
                if on { Circle().fill(Theme.text); Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.bg) }
            }
            .frame(width: 22, height: 22)
            .opacity(muted ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(muted)
        .accessibilityLabel("Complete")
    }
}

/// Italic tertiary empty-state line (`.empty`).
struct EmptyText: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text).italic().font(.system(size: 15)).foregroundStyle(Theme.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The "Ask your assistant…" door — a dashed, quiet button that opens the
/// Assistant root with text carried in (`.home-ask`).
struct AskDoor: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").font(.system(size: 15))
                Text(label).font(.system(size: 15))
                Spacer()
            }
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
        .buttonStyle(.plain)
    }
}

/// Full-width inverted primary button (`.btn-primary`).
struct PrimaryButton: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.text))
                .foregroundStyle(Theme.bg)
        }
        .buttonStyle(.plain)
    }
}

/// Full-width outlined secondary button (`.btn-secondary`).
struct SecondaryButton: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 15, weight: .medium))
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
                .foregroundStyle(Theme.text)
        }
        .buttonStyle(.plain)
    }
}

/// Quiet red text button for destructive actions (`.danger-btn`).
struct DangerButton: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

/// A screen's scrolling column with the standard padding (the `#screen` column).
struct ScreenColumn<Content: View>: View {
    var spacing: CGFloat = 22
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 32)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
    }
}

/// Strip HTML tags, collapse whitespace, truncate — for previews.
func stripHTML(_ s: String, _ max: Int = 80) -> String {
    let noTags = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        .replacingOccurrences(of: "&nbsp;", with: " ", options: .caseInsensitive)
        .replacingOccurrences(of: "&[a-z]+;", with: " ", options: [.regularExpression, .caseInsensitive])
    let collapsed = noTags.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return collapsed.count > max ? String(collapsed.prefix(max)).trimmingCharacters(in: .whitespaces) + "…" : collapsed
}

/// Pushed screens hide the bar title (the content draws its own heading) but
/// keep the system back button, which names the screen we came from.
extension View {
    func pushedScreen() -> some View {
        self.navigationTitle("").inlineNavTitle().background(Theme.bg)
    }
    /// A root screen: hidden nav bar, titled so a pushed screen's Back names it.
    func rootScreen(_ title: String) -> some View {
        self.navigationTitle(title).hiddenNavBar().background(Theme.bg)
    }
}
