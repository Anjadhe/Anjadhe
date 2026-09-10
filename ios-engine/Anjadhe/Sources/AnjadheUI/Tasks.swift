import SwiftUI
import AnjadheCore

// Tasks — grouped Overdue / Today / Upcoming / No date / Done today with
// completion, and the task editor (port of mobile/screens/tasks.js).
// Reads/writes the synced `schedule` blob (`scheduleItems`).

// MARK: shared bits (used by the editors in this batch)

func fieldLabel(_ t: String) -> some View {
    Text(t).font(.caption).foregroundStyle(Theme.textSecondary)
}

/// "yyyy-MM-dd" <-> Date (local).
enum DateStr {
    static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()
    static func toDate(_ s: String) -> Date { fmt.date(from: s) ?? Date() }
    static func toStr(_ d: Date) -> String { fmt.string(from: d) }
}
enum TimeStr {
    static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f }()
    static func toDate(_ s: String) -> Date { fmt.date(from: s) ?? (Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()) }
    static func toStr(_ d: Date) -> String { fmt.string(from: d) }
}

/// Toggle a task's done state (shared by Tasks, Calendar and Home rows). A
/// one-time task is done once it has any completion date (the desktop rule,
/// `ScheduleLogic.taskResolved`); a repeating one is done for today only.
func toggleTaskDone(_ t: JSONValue, _ store: AppStore) {
    guard let id = t["id"]?.stringValue else { return }
    let done = ScheduleLogic.taskResolved(t)
    store.patchItem("schedule", "scheduleItems", id: id, ["lastCompletedDate": done ? .null : .string(DateLogic.todayStr())])
}

// MARK: Tasks list

struct TasksView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var tasks: [JSONValue] { store.items("schedule", "scheduleItems") }

    private struct Group { let label: String; let danger: Bool; let items: [JSONValue] }

    private func groups() -> [Group] {
        let today = DateLogic.todayStr()
        var overdue: [JSONValue] = [], todayG: [JSONValue] = [], upcoming: [JSONValue] = [], noDate: [JSONValue] = [], done: [JSONValue] = []
        for t in tasks {
            let oneTime = ScheduleLogic.isOneTime(t)
            // A one-time task completed (or skipped) on any earlier day is
            // finished — the desktop folds it under Completed; here it leaves
            // the list. Only today's completions stay visible, under Done today.
            if oneTime && ScheduleLogic.taskResolved(t) {
                if ScheduleLogic.taskDoneToday(t) { done.append(t) }
                continue
            }
            if ScheduleLogic.taskDueToday(t) {
                if ScheduleLogic.taskDoneToday(t) { done.append(t) } else { todayG.append(t) }
            } else if oneTime {
                let sd = t["scheduledDate"]?.stringValue ?? ""
                if sd.isEmpty { noDate.append(t) }
                else if sd < today { overdue.append(t) }
                else if sd > today { upcoming.append(t) }
            }
        }
        func byTime(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["startTime"]?.stringValue ?? "99:99") < (b["startTime"]?.stringValue ?? "99:99") }
        func byDate(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["scheduledDate"]?.stringValue ?? "") < (b["scheduledDate"]?.stringValue ?? "") }
        func byTitle(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["title"]?.stringValue ?? "") < (b["title"]?.stringValue ?? "") }
        return [Group(label: "Overdue", danger: true, items: overdue.sorted(by: byDate)),
                Group(label: "Today", danger: false, items: todayG.sorted(by: byTime)),
                Group(label: "Upcoming", danger: false, items: upcoming.sorted(by: byDate)),
                Group(label: "No date", danger: false, items: noDate.sorted(by: byTitle)),
                Group(label: "Done today", danger: false, items: done.sorted(by: byTime))]
    }

    private var subline: String? {
        guard !tasks.isEmpty else { return nil }
        let left = groups().first { $0.label == "Today" }?.items.count ?? 0
        return left > 0 ? "\(left) left today" : "All clear for today"
    }

    var body: some View {
        let gs = groups().filter { !$0.items.isEmpty }
        ScreenColumn {
            ScreenHead("Tasks", sub: subline) {
                HeadAction(symbol: "plus", label: "New task") { router.push(Capture.newTask(store)) }
            }
            if tasks.isEmpty {
                EmptyText("No tasks yet. Tap + to add one.")
            } else {
                ForEach(gs, id: \.label) { g in
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(g.label, danger: g.danger, count: g.items.count)
                        CardList {
                            ForEach(Array(g.items.enumerated()), id: \.offset) { i, t in
                                taskRow(t, last: i == g.items.count - 1)
                            }
                        }
                    }
                }
            }
        }
        .pushedScreen()
    }

    private func taskRow(_ t: JSONValue, last: Bool) -> some View {
        let done = ScheduleLogic.taskResolved(t)
        let id = t["id"]?.stringValue ?? ""
        var parts: [String] = []
        if (t["repeat"]?.stringValue ?? "none") == "none", let sd = t["scheduledDate"]?.stringValue, !sd.isEmpty, sd != DateLogic.todayStr() {
            parts.append(DateLogic.relDate(sd))
        }
        if let st = t["startTime"]?.stringValue, !st.isEmpty { parts.append(DateLogic.fmtTime(st)) }
        return RowView(t["title"]?.stringValue ?? "", sub: parts.joined(separator: " · "), done: done, last: last,
                       leading: { CheckButton(on: done) { toggleTaskDone(t, store) } },
                       trailing: { EmptyView() })
            .onTapGesture { if !id.isEmpty { router.push(.task(id)) } }
    }
}

// MARK: Task editor

struct TaskEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var title = ""; @State private var notes = ""
    @State private var repeatMode = "none"
    @State private var date = Date(); @State private var time = ""
    @State private var dayOfWeek = 0; @State private var customDays: Set<Int> = []
    @State private var notify = 0; @State private var reminders: Set<Int> = []
    @State private var loaded = false
    @State private var confirmDelete = false

    private let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private func patch(_ f: [String: JSONValue]) { store.patchItem("schedule", "scheduleItems", id: id, f) }

    var body: some View {
        Group {
            if store.findItem("schedule", "scheduleItems", id: id) == nil && !loaded {
                ScreenColumn { EmptyText("This item is gone.") }
            } else {
                form
            }
        }
        .pushedScreen()
        .onAppear(perform: load)
        .alert("Delete this task?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("schedule", "scheduleItems", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var form: some View {
        Form {
            Section { fieldLabel("Task"); TextField("What needs doing?", text: $title, axis: .vertical).lineLimit(1...5).onChange(of: title) { patch(["title": .string($0)]) } }
            Section { fieldLabel("Notes (optional)"); TextField("Add details", text: $notes, axis: .vertical).lineLimit(2...4).onChange(of: notes) { patch(["description": .string($0)]) } }

            Section {
                Picker("Repeat", selection: $repeatMode) {
                    ForEach([("none", "Once"), ("daily", "Every day"), ("weekdays", "Weekdays"), ("weekly", "Weekly"), ("monthly", "Monthly"), ("annually", "Annually"), ("custom", "Custom days")], id: \.0) { Text($0.1).tag($0.0) }
                }.onChange(of: repeatMode) { v in
                    var f: [String: JSONValue] = ["repeat": .string(v)]
                    // Seed a weekday so a weekly task actually fires (desktop defaults to Sunday).
                    if v == "weekly" { f["dayOfWeek"] = .number(Double(dayOfWeek)) }
                    patch(f)
                }

                if repeatMode == "none" || repeatMode == "monthly" || repeatMode == "annually" {
                    DatePicker(repeatMode == "monthly" ? "Day of month" : repeatMode == "annually" ? "Date each year" : "Date", selection: $date, displayedComponents: .date)
                        .onChange(of: date) { patch(["scheduledDate": .string(DateStr.toStr($0))]) }
                }
                if repeatMode == "weekly" {
                    Picker("Day of week", selection: $dayOfWeek) { ForEach(0..<7, id: \.self) { Text(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][$0]).tag($0) } }
                        .onChange(of: dayOfWeek) { patch(["dayOfWeek": .number(Double($0))]) }
                }
                if repeatMode == "custom" {
                    fieldLabel("On these days")
                    HStack {
                        ForEach(0..<7, id: \.self) { d in
                            Button(weekdays[d]) {
                                if customDays.contains(d) { customDays.remove(d) } else { customDays.insert(d) }
                                patch(["repeatDays": .array(customDays.sorted().map { .number(Double($0)) })])
                            }
                            .font(.caption2).frame(maxWidth: .infinity).padding(.vertical, 6)
                            .background(customDays.contains(d) ? Theme.text : Theme.surface)
                            .foregroundStyle(customDays.contains(d) ? Theme.bg : Theme.textSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }.buttonStyle(.plain)
                }
            }

            Section {
                HStack {
                    fieldLabel("Time (optional)")
                    Spacer()
                    DatePicker("", selection: Binding(get: { TimeStr.toDate(time) }, set: { time = TimeStr.toStr($0); patch(["startTime": .string(time)]) }), displayedComponents: .hourAndMinute).labelsHidden()
                    if !time.isEmpty {
                        Button { time = ""; patch(["startTime": .string("")]) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textTertiary) }.buttonStyle(.plain)
                    }
                }
                Picker("Notify", selection: $notify) {
                    ForEach([(0, "At start time"), (5, "5 min before"), (10, "10 min before"), (15, "15 min before"), (30, "30 min before")], id: \.0) { Text($0.1).tag($0.0) }
                }.onChange(of: notify) { patch(["notifyBefore": .number(Double($0))]) }

                if repeatMode == "none" {
                    fieldLabel("Advance reminders")
                    HStack {
                        ForEach([(1, "1 day"), (2, "2 days"), (3, "3 days"), (5, "5 days"), (7, "1 week")], id: \.0) { (v, lbl) in
                            Button(lbl) {
                                if reminders.contains(v) { reminders.remove(v) } else { reminders.insert(v) }
                                patch(["reminderDaysBefore": .array(reminders.sorted(by: >).map { .number(Double($0)) })])
                            }
                            .font(.caption2).frame(maxWidth: .infinity).padding(.vertical, 6)
                            .background(reminders.contains(v) ? Theme.text : Theme.surface)
                            .foregroundStyle(reminders.contains(v) ? Theme.bg : Theme.textSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }.buttonStyle(.plain)
                }
            }

            Section { DangerButton(label: "Delete task") { confirmDelete = true } }
        }
        .scrollContentBackground(.hidden).background(Theme.bg)
        .compactForm()
    }

    private func load() {
        guard !loaded, let t = store.findItem("schedule", "scheduleItems", id: id) else { return }
        loaded = true
        title = t["title"]?.stringValue ?? ""; notes = t["description"]?.stringValue ?? ""
        repeatMode = t["repeat"]?.stringValue ?? "none"
        date = DateStr.toDate(t["scheduledDate"]?.stringValue ?? DateLogic.todayStr())
        time = t["startTime"]?.stringValue ?? ""
        dayOfWeek = Int(t["dayOfWeek"]?.numberValue ?? 0)
        customDays = Set((t["repeatDays"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
        notify = Int(t["notifyBefore"]?.numberValue ?? 0)
        reminders = Set((t["reminderDaysBefore"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
    }
}
