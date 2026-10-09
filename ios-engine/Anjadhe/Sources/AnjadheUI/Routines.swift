import SwiftUI
import AnjadheCore

// Routines on the phone (rebuilt 2026-10-02; on Standing chats since
// 2026-10-07): a routine is a Standing CONVERSATION in the synced
// `agent-conversations` blob and its results are run messages in it —
// `StandingChats` hands both out as records (docs/ROUTINES.md).
//
// Read here, made in a conversation: arming a routine always asks and nothing
// is armed untried (ROUTINES.md), so the phone never edits a routine's
// trigger or prompt in a form. "New routine" and "Change it" open a chat that
// runs the desktop's own interview.

enum RoutineList {
    /// Every armed routine, newest activity first (the desktop's Standing list).
    static func routines(_ conversations: [JSONValue]) -> [JSONValue] {
        StandingChats.routines(conversations)
            .filter { $0["prompt"]?["offline"]?.boolValue ?? false }
            .sorted { ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "") }
    }

    /// The posts a routine wrote, newest first.
    static func posts(_ conversations: [JSONValue], routine id: String) -> [JSONValue] {
        StandingChats.runs(conversations).filter { $0["feed"]?["promptId"]?.stringValue == id }
    }

    /// What starts it, in the desktop's words (NotePrompts.triggerLabel /
    /// scheduleLabel): "Every day at 8:00 AM", "When an email arrives …".
    static func trigger(_ note: JSONValue) -> String {
        let p = note["prompt"]
        if let t = p?["trigger"], let type = t["type"]?.stringValue {
            if type == "email" {
                var bits: [String] = []
                if let f = t["from"]?.stringValue, !f.isEmpty { bits.append("from \(f)") }
                if let s = t["subject"]?.stringValue, !s.isEmpty { bits.append("about “\(s)”") }
                if let c = t["contains"]?.stringValue, !c.isEmpty { bits.append("mentioning “\(c)”") }
                return "When an email arrives" + (bits.isEmpty ? "" : " " + bits.joined(separator: ", "))
            }
            if type == "file" { return "When a file arrives in \(t["folder"]?.stringValue ?? "a folder")" }
        }
        let interval = p?["interval"]?.stringValue ?? "daily"
        var label = ["hourly": "Every hour", "6h": "Every 6 hours", "daily": "Every day",
                     "weekdays": "Weekdays", "weekly": "Every week"][interval] ?? "Every day"
        if let time = p?["time"]?.stringValue, !time.isEmpty, interval != "hourly", interval != "6h" {
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
            label += " at " + f.string(from: TimeStr.toDate(time))
        }
        return label
    }

    static func acts(_ note: JSONValue) -> Bool { note["prompt"]?["runMode"]?.stringValue == "task" }
}

struct PromptsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = store.revision
        let notes = store.items("agent-conversations", "conversations")
        let list = RoutineList.routines(notes)
        return ScreenColumn(spacing: 18) {
            ScreenHead("Routines") {
                HeadAction(symbol: "plus", label: "New routine") { router.openCompose(prefill: "Set up a routine that ") }
            }
            if list.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    EmptyText("No routines yet. A routine is work nenva does on its own: each morning, or the moment an email arrives. It reports back here and on Now.")
                    SecondaryButton(label: "Help me set one up") { router.openCompose(prefill: "Help me set up a routine that ") }
                }
            } else {
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, r in
                        let id = r["id"]?.stringValue ?? ""
                        let last = RoutineList.posts(notes, routine: id).first?["createdAt"]?.stringValue
                        RowView(r["title"]?.stringValue ?? "A routine",
                                sub: RoutineList.trigger(r) + (last.map { " · ran " + DateLogic.relDate($0) } ?? ""),
                                last: i == list.count - 1)
                            .onTapGesture { if !id.isEmpty { router.push(.prompt(id)) } }
                    }
                }
            }
        }
        .pushedScreen()
    }
}

/// One routine: what starts it, what it does, what it found.
struct PromptEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = store.revision
        let notes = store.items("agent-conversations", "conversations")
        let note = StandingChats.routines(notes).first { $0["id"]?.stringValue == id }
        let posts = RoutineList.posts(notes, routine: id)
        return ScreenColumn(spacing: 18) {
            if let n = note {
                let title = n["title"]?.stringValue ?? "A routine"
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).displayStyle(26).fixedSize(horizontal: false, vertical: true)
                    Text(RoutineList.trigger(n) + (RoutineList.acts(n) ? " · takes actions" : " · reports back"))
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                }
                .padding(.top, 4)

                let body = (n["content"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !body.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel("What it does")
                        Text(body).font(.system(size: 15)).foregroundStyle(Theme.text).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: Theme.radiusLg).fill(Theme.surface))
                            .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.border))
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Results")
                    if posts.isEmpty {
                        EmptyText("Nothing yet. A run that finds nothing worth saying stays quiet.")
                    } else {
                        CardList {
                            ForEach(Array(posts.prefix(8).enumerated()), id: \.offset) { i, p in
                                let pid = p["id"]?.stringValue ?? ""
                                let failed = !(p["feed"]?["error"]?.stringValue ?? "").isEmpty
                                RowView(DateLogic.relDate(p["createdAt"]?.stringValue ?? ""),
                                        sub: failed ? "Did not finish" : plainPreview(p["content"]?.stringValue ?? "", 80),
                                        last: i == min(posts.count, 8) - 1)
                                    .onTapGesture { if !pid.isEmpty { router.push(.feedItem(pid)) } }
                            }
                        }
                    }
                }

                // Changing a routine is a conversation: the desktop's own
                // interview, which tries the new version before arming it.
                HStack(spacing: 10) {
                    SecondaryButton(label: "Change it") { router.openCompose(prefill: "Change my routine “\(title)”: ") }
                    SecondaryButton(label: "Ask about it") { router.openCompose(prefill: "About my routine “\(title)”: ") }
                }
            } else {
                EmptyText("This routine isn’t on your phone yet. It will appear when your phone next syncs with your Mac.")
            }
        }
        .pushedScreen()
    }
}
