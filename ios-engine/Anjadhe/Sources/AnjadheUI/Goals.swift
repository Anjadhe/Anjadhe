import SwiftUI
import AnjadheCore

// Projects — the desktop Goals app (labels-only law: the app id stays `goals`,
// the storage key stays `goals`). Read + light touches on the phone: browse by
// group, see a project's linked tasks (the synced `links` blob), mark
// complete. CREATION stays a conversation — the door is "Ask your assistant",
// not a form. Port of the old mobile/screens/goals.js.

private let UNGROUPED = "Ungrouped"

private func goalGroup(_ g: JSONValue) -> String {
    let name = (g["group"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? UNGROUPED : name
}

private func goalTitle(_ g: JSONValue) -> String {
    let t = g["title"]?.stringValue ?? ""
    return t.isEmpty ? "Untitled" : t
}

private func goalCompleted(_ g: JSONValue) -> Bool { g["status"]?.stringValue == "completed" }

private func goalTargetOverdue(_ g: JSONValue) -> Bool {
    guard let td = g["targetDate"]?.stringValue, !td.isEmpty else { return false }
    return !goalCompleted(g) && td < DateLogic.todayStr()
}

private func toggleGoalDone(_ store: AppStore, _ g: JSONValue) {
    guard let id = g["id"]?.stringValue else { return }
    store.patchItem("goals", "goals", id: id, ["status": .string(goalCompleted(g) ? "not-started" : "completed")])
}

// MARK: - List

struct GoalsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var showDone = false

    private var all: [JSONValue] { store.items("goals", "goals").filter { $0["status"]?.stringValue != "draft" } }

    var body: some View {
        let goals = all
        let active = goals.filter { !goalCompleted($0) }
        let done = goals.filter { goalCompleted($0) }
        // Groups in first-seen order, Ungrouped last — the desktop's rule.
        var names: [String] = []
        var hasUngrouped = false
        for g in active {
            let n = goalGroup(g)
            if n == UNGROUPED { hasUngrouped = true; continue }
            if !names.contains(n) { names.append(n) }
        }
        if hasUngrouped { names.append(UNGROUPED) }

        return ScreenColumn {
            ScreenHead("Projects", sub: "\(active.count) active" + (done.isEmpty ? "" : " · \(done.count) completed"))
            if goals.isEmpty {
                EmptyText("No projects yet — start one with your assistant.")
            } else {
                ForEach(names, id: \.self) { name in
                    let inGroup = active.filter { goalGroup($0) == name }
                    if !inGroup.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            if names.count > 1 || name != UNGROUPED { SectionLabel(name) }
                            goalList(inGroup)
                        }
                    }
                }
                if !done.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Button { showDone.toggle() } label: {
                            Text((showDone ? "Hide" : "Show") + " completed (\(done.count))")
                                .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary)
                        }
                        .buttonStyle(.plain)
                        if showDone { goalList(done) }
                    }
                }
            }
            AskDoor(label: "Start a project with your assistant…") {
                router.openCompose(prefill: "I want to start a new project: ")
            }
        }
        .pushedScreen()
    }

    private func goalList(_ items: [JSONValue]) -> some View {
        CardList {
            ForEach(Array(items.enumerated()), id: \.element) { i, g in
                goalRow(g, last: i == items.count - 1)
            }
        }
    }

    private func goalRow(_ g: JSONValue, last: Bool) -> some View {
        let id = g["id"]?.stringValue ?? ""
        let overdue = goalTargetOverdue(g)
        var sub: String? = nil
        if let td = g["targetDate"]?.stringValue, !td.isEmpty {
            sub = (overdue ? "Target passed " : "Target ") + DateLogic.relDate(td)
        }
        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                CheckButton(on: goalCompleted(g)) { toggleGoalDone(store, g) }
                Button { router.push(.goal(id)) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(goalTitle(g)).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(2)
                        if let s = sub {
                            Text(s).font(.system(size: 13)).foregroundStyle(overdue ? Theme.danger : Theme.textTertiary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            if !last { Divider().padding(.leading, 14) }
        }
    }
}

// MARK: - Detail

struct GoalDetail: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private static func subLine(_ g: JSONValue) -> String {
        var parts = [goalGroup(g)]
        if let td = g["targetDate"]?.stringValue, !td.isEmpty { parts.append("target " + DateLogic.relDate(td)) }
        if goalCompleted(g) { parts.append("completed") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        let goal = store.findItem("goals", "goals", id: id)
        ScreenColumn {
            if let g = goal {
                let title = goalTitle(g)
                ScreenHead(title, sub: Self.subLine(g))

                if let desc = g["description"]?.stringValue, !desc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(desc).font(.system(size: 15)).foregroundStyle(Theme.textSecondary).lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }

                let tasks = store.linkedItems("goals", id, targetApp: "schedule", blobKey: "schedule", arrayKey: "scheduleItems")
                    .sorted { ($0["scheduledDate"]?.stringValue ?? "9999") < ($1["scheduledDate"]?.stringValue ?? "9999") }
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Tasks")
                    if tasks.isEmpty {
                        EmptyText("No linked tasks.")
                    } else {
                        CardList {
                            ForEach(Array(tasks.enumerated()), id: \.element) { i, t in
                                let tid = t["id"]?.stringValue ?? ""
                                let sd = t["scheduledDate"]?.stringValue ?? ""
                                Button { router.push(.task(tid)) } label: {
                                    RowView(t["title"]?.stringValue ?? "", sub: sd.isEmpty ? nil : DateLogic.relDate(sd),
                                            done: ScheduleLogic.taskResolved(t), last: i == tasks.count - 1)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }

                VStack(spacing: 12) {
                    AskDoor(label: "Ask about this project…") {
                        router.openCompose(prefill: "About my project \"\(title)\": ")
                    }
                    PrimaryButton(label: goalCompleted(g) ? "Reopen project" : "Mark completed") { toggleGoalDone(store, g) }
                }
            } else {
                EmptyText("This project is no longer here.")
            }
        }
        .pushedScreen()
    }
}
