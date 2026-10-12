import SwiftUI
import AnjadheCore

// MARK: - Toast

struct ToastView: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Theme.detailFont.weight(.medium))
            .foregroundStyle(Theme.bg)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Capsule().fill(Theme.text))
    }
}

// MARK: - Shared screen pieces (the old mobile.css vocabulary, in SwiftUI)

/// The big serif screen heading + optional secondary line, with optional
/// trailing action buttons (the `.screen-head` / `.head-actions` pattern).
struct ScreenHead<Actions: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    var sub: String? = nil
    var greeting = false
    @ViewBuilder var actions: () -> Actions

    init(_ title: String, sub: String? = nil, greeting: Bool = false, @ViewBuilder actions: @escaping () -> Actions) {
        self.title = title; self.sub = sub; self.greeting = greeting; self.actions = actions
    }

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).displayStyle(greeting ? 34 : 30)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let s = sub, !s.isEmpty {
                    Text(s).font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
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
                .frame(width: Theme.minimumTouchTarget, height: Theme.minimumTouchTarget)
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
            if let c = count { Text("\(c)").font(.caption.weight(.medium)).foregroundStyle(Theme.textTertiary) }
        }
        .padding(.bottom, 2)
    }
}

/// The bordered card that holds rows separated by hairlines (`.card.list`) —
/// a white sheet on the ground.
struct CardList<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(spacing: 0) { content() }
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

/// One list row: title + optional sub, optional trailing text, hairline under.
struct RowView<Leading: View, Trailing: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
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
            HStack(alignment: .top, spacing: 12) {
                leading()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? "Untitled" : title)
                        .font(Theme.rowFont)
                        .strikethrough(done)
                        .foregroundStyle(done ? Theme.textTertiary : Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let s = sub, !s.isEmpty {
                        Text(s).font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if typeSize.isAccessibilitySize { trailing() }
                }
                Spacer(minLength: 8)
                if !typeSize.isAccessibilitySize { trailing() }
            }
            .frame(minHeight: Theme.minimumTouchTarget, alignment: .leading)
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

/// Italic tertiary empty-state line (`.empty`).
struct EmptyText: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text).italic().font(Theme.bodyFont).foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Full-width inverted primary button, a pill (`.btn-primary`).
struct PrimaryButton: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(Theme.actionFont)
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .padding(.horizontal, Theme.md)
                .frame(minHeight: Theme.minimumTouchTarget)
                .background(Capsule().fill(Theme.accent))
                .foregroundStyle(Color.white)
        }
        .buttonStyle(.plain)
    }
}

/// Full-width outlined secondary button, a pill (`.btn-secondary`).
struct SecondaryButton: View {
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(Theme.bodyFont.weight(.medium))
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .padding(.horizontal, Theme.md)
                .frame(minHeight: Theme.minimumTouchTarget)
                .background(Capsule().fill(Theme.surface))
                .overlay(Capsule().strokeBorder(Theme.border))
                .foregroundStyle(Theme.text)
        }
        .buttonStyle(.plain)
    }
}

/// A screen's scrolling column with the standard padding (the `#screen` column).
///
/// The stack is LAZY (2026-09-20). It was a plain `VStack`, which builds and
/// lays out every row a screen hands it before the first frame — so opening
/// Notes with a real library built hundreds of rows to show a dozen, and the
/// push visibly stalled. `LazyVStack` builds what is on screen and the rest
/// as they scroll in. Sections still appear in the order given; the only
/// thing that changes is WHEN their rows are realised.
struct ScreenColumn<Content: View>: View {
    var spacing: CGFloat = 22
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: spacing) { content() }
                .frame(maxWidth: Theme.readingWidth, alignment: .leading)
                .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 32)
                .frame(maxWidth: .infinity)
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
