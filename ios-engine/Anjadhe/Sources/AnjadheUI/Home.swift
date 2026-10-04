import SwiftUI
import AnjadheCore

// Home (the `today` root — id stays `today`, label "Home"). The companion's
// heart: the assistant door, today's tasks to check off, and the last things
// you were writing. Reads come from the synced blobs; the port of
// mobile/screens/today.js.

struct HomeView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var sync: SyncCoordinator

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        if h < 12 { return "Good morning" }
        if h < 18 { return "Good afternoon" }
        return "Good evening"
    }
    private var dateLine: String {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return f.string(from: Date())
    }

    private struct ContinueItem: Identifiable {
        let id: String
        let route: Route
        let title: String
        let sub: String
        let at: String
    }

    private var todayTasks: [JSONValue] {
        store.items("schedule", "scheduleItems")
            .filter { ScheduleLogic.taskDueToday($0) && !ScheduleLogic.taskResolved($0) }
            .sorted { ($0["startTime"]?.stringValue ?? "99:99") < ($1["startTime"]?.stringValue ?? "99:99") }
    }

    /// The three most recent notes/journal entries.
    ///
    /// Order first, convert last. This used to build a preview for EVERY
    /// note and journal entry and then throw all but three away — four
    /// regular expressions over ~4 MB of stored HTML, inside `body`, on
    /// every render, which measured 269 ms on a Mac and worse on a phone.
    /// Only the rows that survive the sort are converted now (and
    /// `PlainText` caches even those), which is the same three strings for
    /// a thousandth of the work.
    private var continueItems: [ContinueItem] {
        struct Candidate { let id: String; let route: Route; let title: String; let at: String; let html: String }
        var out: [Candidate] = []
        for n in store.items("notes", "notes") {
            guard let id = n["id"]?.stringValue else { continue }
            let at = n["modifiedAt"]?.stringValue ?? n["createdAt"]?.stringValue ?? ""
            guard !at.isEmpty else { continue }
            let title = n["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled"
            out.append(Candidate(id: "note:" + id, route: .note(id), title: title, at: at,
                                 html: n["content"]?.stringValue ?? ""))
        }
        for e in store.items("journal", "entries") {
            guard let id = e["id"]?.stringValue else { continue }
            let at = e["modifiedAt"]?.stringValue ?? e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? ""
            guard !at.isEmpty else { continue }
            let when = DateLogic.relDate(e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? "")
            out.append(Candidate(id: "journal:" + id, route: .journal(id), title: when.isEmpty ? "Entry" : when,
                                 at: at, html: e["content"]?.stringValue ?? ""))
        }
        return out.sorted { $0.at > $1.at }.prefix(3).map { c in
            let sub = PlainText.preview(c.html, id: c.id, stamp: c.at, max: 60)
            let empty = c.id.hasPrefix("journal:") ? "Empty entry" : "Empty note"
            return ContinueItem(id: c.id, route: c.route, title: c.title,
                                sub: sub.isEmpty ? empty : sub, at: c.at)
        }
    }

    var body: some View {
        // Reading `revision` keeps the screen live on every sync-applied write.
        let _ = store.revision
        let tasks = todayTasks
        let resume = continueItems
        ScreenColumn {
            ScreenHead(greeting, sub: dateLine, greeting: true) {
                HomeSyncAction()
                HeadAction(symbol: "gearshape", label: "Settings") { router.open(app: "settings") }
            }

            AskDoor(label: "Ask your assistant…") { router.openCompose() }

            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Today")
                if tasks.isEmpty {
                    EmptyText("Nothing scheduled — enjoy the space.")
                } else {
                    CardList {
                        ForEach(Array(tasks.enumerated()), id: \.offset) { i, t in
                            let id = t["id"]?.stringValue ?? ""
                            let time = t["startTime"]?.stringValue ?? ""
                            RowView(t["title"]?.stringValue ?? "Untitled",
                                    sub: time.isEmpty ? nil : DateLogic.fmtTime(time),
                                    last: i == tasks.count - 1) {
                                CheckButton(on: false) { toggleTask(id) }
                            } trailing: { EmptyView() }
                            .onTapGesture { if !id.isEmpty { router.push(.task(id)) } }
                        }
                    }
                }
            }

            if !resume.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Continue")
                    CardList {
                        ForEach(Array(resume.enumerated()), id: \.element.id) { i, r in
                            RowView(r.title, sub: r.sub, last: i == resume.count - 1) {
                                Text(DateLogic.relDate(r.at)).font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                            }
                            .onTapGesture { router.push(r.route) }
                        }
                    }
                }
            }
        }
        .rootScreen("Home")
    }

    private func toggleTask(_ id: String) {
        guard let t = store.findItem("schedule", "scheduleItems", id: id) else { return }
        let done = ScheduleLogic.taskResolved(t)
        store.patchItem("schedule", "scheduleItems", id: id,
                        ["lastCompletedDate": done ? .null : .string(DateLogic.todayStr())])
    }
}

/// The sync-status head action: the JS `.head-sync` button. Monochrome —
/// state is carried by weight and a small dot, never a color.
struct HomeSyncAction: View {
    @EnvironmentObject var sync: SyncCoordinator
    @State private var spin = false
    /// Busy is shown only after it has lasted a moment: a sync round-trip
    /// on the home network takes well under a second, and spinning the icon
    /// for each one read as the app being stuck in a loop.
    @State private var showBusy = false

    private var viaWord: String {
        switch sync.via {
        case "lan": return "on this network"
        case "tailscale": return "through Tailscale"
        case "relay": return "through the encrypted relay"
        default: return ""
        }
    }
    private var label: String {
        switch sync.state {
        case "syncing": return "Syncing with your Mac \(viaWord)…"
        case "idle": return "In sync \(viaWord) — tap to sync now"
        case "connecting": return "Connecting to your Mac…"
        case "error": return "Sync failed — tap to retry"
        default: return "Offline — tap to retry"
        }
    }
    private var quiet: Bool { sync.state == "offline" || sync.state == "error" }
    private var busy: Bool { sync.state == "syncing" || sync.state == "connecting" }
    /// The dot on the icon says HOW the phone reaches the Mac (2026-09-08):
    /// green = the Mac's own relay (this network or Tailscale), amber = the
    /// hosted relay, red = a failed sync, gray = offline, hollow = connecting.
    /// State colour only, on the semantic palette (Minimal Book).
    private var dotColor: Color? {
        switch sync.state {
        case "idle", "syncing":
            switch sync.via {
            case "lan", "tailscale": return Theme.success
            case "relay": return Theme.warning
            default: return nil
            }
        case "error": return Theme.danger
        case "offline": return Theme.textTertiary
        default: return nil
        }
    }

    var body: some View {
        Button { sync.triggerSync() } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(quiet ? Theme.textTertiary : Theme.text)
                    .rotationEffect(.degrees(showBusy && spin ? 360 : 0))
                    .animation(showBusy ? .linear(duration: 1.2).repeatForever(autoreverses: false) : .default, value: spin)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Theme.surface))
                    .overlay(Circle().strokeBorder(Theme.border))
                if let c = dotColor {
                    Circle().fill(c).frame(width: 8, height: 8)
                        .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 1.5))
                        .offset(x: -2, y: 2)
                } else if sync.state == "connecting" {
                    Circle().strokeBorder(Theme.textTertiary, lineWidth: 1.5).frame(width: 8, height: 8)
                        .background(Circle().fill(Theme.bg))
                        .offset(x: -2, y: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .onAppear { updateBusy() }
        .onChange(of: sync.state) { _ in updateBusy() }
    }

    private func updateBusy() {
        if busy {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                guard busy else { return }
                showBusy = true
                spin = true
            }
        } else {
            showBusy = false
            spin = false
        }
    }
}
