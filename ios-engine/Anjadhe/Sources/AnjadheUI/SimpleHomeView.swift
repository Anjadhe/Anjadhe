import SwiftUI
import AnjadheCore

// The phone's simple home (2026-09-20) — the companion to the desktop's
// Simple home (docs/SIMPLE_EXPERIENCE.md), built on the same idea: the
// assistant's door, then the few things that actually want you, and nothing
// else. It is PRESENTATION ONLY, like the Mac's: same data, same blobs,
// same screens underneath.
//
// WHAT IS HERE AND WHAT IS NOT. The desktop reads live in-process state —
// the permission queue, running task runs, PromptFeed. The phone has three
// lanes (this file's sections are lane 1: synced blobs), so the split is by
// where the truth lives:
//
//   * On your radar, From your routines, the journal nudge and the
//     shortcuts are LOCAL. They paint from the store immediately and work
//     with the Mac asleep.
//   * Needs you and Ongoing work are live Mac state and cannot be synced;
//     they arrive with the Mac-served `home` view, cached-first, and the
//     page says "waiting to hear from your Mac" rather than claiming quiet
//     it cannot vouch for.
//
// A request may be ANSWERED here when the Mac says so, and the Mac decides
// that twice: once to draw the buttons, once again before it settles (see
// MobileViews._phoneAnswerable). A plan is approvable only because the plan
// itself travels with the row and is drawn on the card — approving steps
// you were never shown is not consent.
//
// The composer stays a DOOR rather than an inline field: a keyboard-raising
// composer on a scrolling home is worse on a phone, and the Assistant root
// is one tap away. That is a deliberate divergence from the Mac.

/// Which home the phone shows. A PREFERENCE, not a feature flag — and per
/// device, like the theme: presentation, and two phones may reasonably want
/// different answers. ABSENT MEANS ON, so only an explicit "off" restores
/// the full home; a default experience has to be one you can leave.
public enum SimpleExperience {
    public static let key = "simple-experience"

    public static var isOn: Bool {
        UserDefaults.standard.string(forKey: key) != "off"
    }

    public static func setOn(_ on: Bool) {
        UserDefaults.standard.set(on ? "on" : "off", forKey: key)
    }
}

/// How long the Mac-served half stays fresh. Short: it is the queue of
/// things waiting on you, and a stale one is worse than a slow one.
private let HOME_TTL: TimeInterval = 2 * 60

struct SimpleHomeView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var views: MacViews
    /// Requests answered on this screen, so the card can show the outcome
    /// immediately instead of waiting for the next refresh. In-memory: the
    /// truth is the Mac's, and the next `home` view replaces this.
    @State private var answered: [String: String] = [:]
    @State private var answering: Set<String> = []
    @State private var answerError: [String: String] = [:]

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        if h < 12 { return "Good morning" }
        if h < 18 { return "Good afternoon" }
        return "Good evening"
    }

    /// Fixed, not frequency-ranked. The Mac ranks by its own per-Mac usage
    /// counts; the phone keeps none, and inventing a second ranking would
    /// give the two shells different answers about "your apps". A row you
    /// aim at by muscle memory must not reshuffle anyway — the same call the
    /// desktop's nav makes.
    private static let shortcutIds = ["tasks", "calendar", "notes", "journal", "fyi"]

    var body: some View {
        let _ = store.revision
        let _ = views.revision
        // Cached-first: whatever the Mac last told us paints at once and the
        // refresh happens behind it. Never a spinner over the page — the
        // local sections below owe nothing to the Mac.
        let snap = views.view("home", ttl: HOME_TTL)
        let needsYou = snap.data?["needsYou"]?.arrayValue ?? []
        let working = snap.data?["working"]?.arrayValue ?? []
        let radar = SimpleHome.radar(events: store.items("calendar", "events"),
                                     tasks: store.items("schedule", "scheduleItems"))
        let updates = SimpleHome.routineUpdates(notes: store.items("notes", "notes"))
        let nudge = SimpleHome.journalNudgeDue(entries: store.items("journal", "entries"))
        let shortcuts = AppCatalog.launcher(store).filter { Self.shortcutIds.contains($0.id) }

        let _ = LaunchTrace.mark("home body")
        return ScreenColumn(spacing: 20) {
            ScreenHead(greeting, greeting: true) {
                HeadAction(symbol: "square.grid.2x2", label: "All apps") { router.open(app: "apps") }
                HomeSyncAction()
                HeadAction(symbol: "gearshape", label: "Settings") { router.open(app: "settings") }
            }

            AskDoor(label: "Ask your assistant…") { router.openCompose() }

            if !needsYou.isEmpty {
                section("Needs you", note: staleNote(snap)) {
                    VStack(spacing: 10) {
                        ForEach(Array(needsYou.enumerated()), id: \.offset) { _, item in
                            attentionCard(item)
                        }
                    }
                }
            }

            if !radar.isEmpty {
                section("On your radar") {
                    CardList {
                        ForEach(Array(radar.enumerated()), id: \.offset) { i, row in
                            RowView(row.title, sub: row.meta.isEmpty ? nil : row.meta, last: i == radar.count - 1)
                                .onTapGesture { router.open(app: row.kind == "event" ? "calendar" : "tasks") }
                        }
                    }
                }
            }

            if !updates.isEmpty {
                section("From your routines") {
                    CardList {
                        ForEach(Array(updates.enumerated()), id: \.element.id) { i, u in
                            RowView(u.title,
                                    // The post's own words, extracted — never a
                                    // sentence written about the post.
                                    sub: u.failed ? "Did not finish"
                                        : PlainText.preview(u.content, id: u.id, stamp: u.stamp, max: 70),
                                    last: i == updates.count - 1) {
                                Text(DateLogic.relDate(u.stamp))
                                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                            }
                            .onTapGesture { router.push(.feedItem(u.id)) }
                        }
                    }
                }
            }

            if !working.isEmpty {
                section("Ongoing work") {
                    CardList {
                        ForEach(Array(working.enumerated()), id: \.offset) { i, t in
                            RowView(t["title"]?.stringValue ?? "Work in progress",
                                    sub: t["message"]?.stringValue,
                                    last: i == working.count - 1)
                        }
                    }
                }
            }

            shortcutRow(shortcuts, nudge: nudge)

            if radar.isEmpty && updates.isEmpty && needsYou.isEmpty && working.isEmpty {
                // Honest about WHY it is empty. "Nothing needs you" is a
                // claim about the Mac, and we can only make it if the Mac
                // has actually answered.
                EmptyText(!sync.paired ? "Pair with your Mac in Settings to see your day here."
                          : snap.data != nil ? "Nothing needs you right now."
                          : "Waiting to hear from your Mac.")
            }
        }
        .rootScreen("Home")
    }

    @ViewBuilder private func section<C: View>(_ title: String, note: String? = nil,
                                               @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                SectionLabel(title)
                Spacer(minLength: 0)
                if let note = note {
                    Text(note).font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                }
            }
            content()
        }
    }

    /// Say how old the Mac's answer is, but only when it is old enough to
    /// matter — a fresh queue needs no apology, and a line that always says
    /// something is a line nobody reads.
    private func staleNote(_ snap: MacViews.Snapshot) -> String? {
        guard let at = snap.at else { return nil }
        if snap.error != nil { return "Could not reach your Mac · " + MacViews.agoLabel(at) }
        return Date().timeIntervalSince(at) > HOME_TTL ? MacViews.agoLabel(at) : nil
    }

    /// One request for judgment.
    ///
    /// Allow/Deny appear only when the MAC said this one may be answered
    /// from here (`answerable`), and that flag is a hint for the buttons
    /// alone: the Mac asks itself the same question again before it settles
    /// anything, so nothing here is load-bearing for the decision. What the
    /// phone may never do is widen a grant — there is no session or always,
    /// by construction, because no scope is sent.
    private func attentionCard(_ item: JSONValue) -> some View {
        let id = item["id"]?.stringValue ?? ""
        let answerable = item["answerable"]?.boolValue ?? false
        let outcome = answered[id]
        let busy = answering.contains(id)
        return VStack(alignment: .leading, spacing: 8) {
            Text(item["title"]?.stringValue ?? "A decision for you")
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            let message = item["message"]?.stringValue ?? ""
            if !message.isEmpty {
                Text(message).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The plan, when there is one. It is not decoration: the Mac
            // only lets a plan be approved from here BECAUSE it travels
            // with the row, so this IS the consent, not a preview of it.
            if let plan = item["plan"]?.arrayValue, !plan.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(plan.enumerated()), id: \.offset) { i, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1)")
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Theme.textTertiary)
                                .frame(width: 16, alignment: .trailing)
                            Text(step.stringValue ?? "")
                                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, 8).padding(.horizontal, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.bg))
            }

            if let outcome = outcome {
                Text(outcome).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textSecondary)
            } else if let err = answerError[id] {
                Text(err).font(.system(size: 13)).foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            } else if answerable {
                let isPlan = !(item["plan"]?.arrayValue?.isEmpty ?? true)
                HStack(spacing: 8) {
                    answerButton(isPlan ? "Run it" : "Allow", filled: true, busy: busy) {
                        answer(id, approved: true, isPlan: isPlan)
                    }
                    answerButton("Not now", filled: false, busy: busy) {
                        answer(id, approved: false, isPlan: isPlan)
                    }
                    Spacer(minLength: 0)
                    // A permission is granted once and only once; a plan is
                    // a one-off act and needs no such promise.
                    if !isPlan {
                        Text("Just this once").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                    }
                }
            } else {
                // Named honestly: this is not a failure, it is a decision
                // that wants the Mac in front of you.
                Text("Open on your Mac to answer this one")
                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .themedCard(padding: 14)
    }

    private func answerButton(_ label: String, filled: Bool, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 14, weight: .semibold))
                .foregroundStyle(filled ? Theme.bg : Theme.text)
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(Capsule().fill(filled ? Theme.text : Theme.surface))
                .overlay(Capsule().strokeBorder(filled ? Color.clear : Theme.border))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.5 : 1)
    }

    /// Send the answer and let the Mac decide. Note what is NOT sent: no
    /// scope. The Mac settles at "once" and nothing the phone says can
    /// widen that.
    private func answer(_ id: String, approved: Bool, isPlan: Bool) {
        guard !id.isEmpty, !answering.contains(id) else { return }
        answering.insert(id)
        answerError[id] = nil
        views.request("home-answer", params: ["id": .string(id), "approved": .bool(approved)]) { result in
            answering.remove(id)
            switch result {
            case .success:
                answered[id] = approved
                    ? (isPlan ? "Running on your Mac." : "Allowed — your Mac is carrying on.")
                    : (isPlan ? "Stopped." : "Declined.")
                // The queue has moved on; ask for it again.
                views.refresh("home")
            case .failure(let err):
                answerError[id] = err.localizedDescription
            }
        }
    }

    /// The shortcuts, led by the journal nudge when one is due — and
    /// Journal's own shortcut steps aside while it is there, so there is
    /// only ever one door (the desktop rule).
    @ViewBuilder private func shortcutRow(_ apps: [AppEntry], nudge: Bool) -> some View {
        let shown = apps.filter { !(nudge && $0.id == "journal") }
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if nudge {
                    pill("Log journal", symbol: "book.closed", accent: true) { router.open(app: "journal") }
                }
                ForEach(shown, id: \.id) { app in
                    pill(app.label, symbol: app.symbol, accent: false) { router.open(app: app.id) }
                }
                pill("Routine results", symbol: "doc.text", accent: false) { router.open(app: "feed") }
            }
            .padding(.vertical, 2)
        }
    }

    private func pill(_ label: String, symbol: String, accent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 12))
                Text(label).font(.system(size: 14, weight: .medium))
            }
            .foregroundStyle(accent ? Theme.bg : Theme.text)
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(Capsule().fill(accent ? Theme.text : Theme.surface))
            .overlay(Capsule().strokeBorder(accent ? Color.clear : Theme.border))
        }
        .buttonStyle(.plain)
    }
}
