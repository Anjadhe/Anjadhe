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

/// The list is the DESKTOP's, drawn here (2026-09-22).
///
/// It used to be a Swift reimplementation over the synced blob: its own
/// grouping, its own "due today", its own overdue. It could only ever show
/// the subset someone had ported, and it drifted from the Mac the moment
/// either side learned something — recurrence anchors, abandoned
/// occurrences, tags, projects, tasks born from an email. So Tasks joins
/// Portfolio and News on the served-view model: the Mac answers `tasks` with
/// its own groups, rows, counts and scopes (`ScheduleApp.getGroupedItems`,
/// `ActionsApp._navCounts`, `ActionsApp.groupPredicateFor`) and this file
/// draws them. Nothing here works out a date.
///
/// Editing a task does NOT go through the Mac — see `TaskEditor` below. The
/// division is deliberate: reading wants the desktop's whole truth, writing
/// wants to work on a train.
let TASKS_TTL: TimeInterval = 90

struct TasksView: View {
    var slice: String = "today"
    var group: String? = nil

    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var views: MacViews
    @State private var drawerOpen = false

    /// One cache slot per scope, so moving between them keeps each one's rows
    /// and its own "Updated …" stamp.
    private var viewName: String { "tasks:\(slice):\(group ?? "")" }
    private var params: [String: JSONValue] {
        var p: [String: JSONValue] = ["slice": .string(slice)]
        if let g = group { p["group"] = .string(g) }
        return p
    }

    var body: some View {
        let _ = views.revision
        let snap = views.view(viewName, ttl: TASKS_TTL, request: "tasks", params: params)
        let d = snap.data?.objectValue

        ZStack(alignment: .leading) {
            ScreenColumn {
                ScreenHead(title(d), sub: sub(d)) {
                    HeadAction(symbol: "line.3.horizontal", label: "Scopes") {
                        withAnimation(.easeOut(duration: 0.2)) { drawerOpen = true }
                    }
                    HeadAction(symbol: "plus", label: "New task") { router.push(Capture.newTask(store)) }
                    macViewRefreshAction(views, viewName)
                }

                if let d = d {
                    let groups = d["groups"]?.arrayValue ?? []
                    if groups.isEmpty {
                        EmptyText(group == nil ? "Nothing here. Tap + to add a task."
                                              : "Nothing in this scope right now.")
                    }
                    ForEach(Array(groups.enumerated()), id: \.offset) { _, g in
                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel(label(of: g), danger: g["danger"]?.boolValue ?? false,
                                         count: (g["items"]?.arrayValue ?? []).count)
                            CardList {
                                let rows = g["items"]?.arrayValue ?? []
                                ForEach(Array(rows.enumerated()), id: \.offset) { i, t in
                                    taskRow(t, last: i == rows.count - 1)
                                }
                            }
                        }
                    }
                    MacViewUpdatedLine(at: snap.at, error: snap.error)
                } else {
                    EmptyText(snap.loading ? "Asking your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
                }
            }

            if drawerOpen {
                Color.black.opacity(0.25).ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }
                    .transition(.opacity)
                TasksDrawer(data: d, slice: slice, group: group) { pick in
                    withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false }
                    pick()
                }
                .transition(.move(edge: .leading))
            }
        }
        .pushedScreen()
    }

    // MARK: head

    private func title(_ d: [String: JSONValue]?) -> String {
        guard let g = group else { return d?["label"]?.stringValue ?? "Tasks" }
        // A scope names itself the way the Mac named it in the nav.
        let nav = d?["nav"]?.objectValue
        for key in ["tags", "projects", "sources"] {
            for entry in nav?[key]?.arrayValue ?? [] where entry["id"]?.stringValue == g {
                return entry["name"]?.stringValue ?? entry["label"]?.stringValue ?? "Tasks"
            }
        }
        return g.contains(":") ? String(g.split(separator: ":").dropFirst().joined(separator: ":")) : g
    }

    private func sub(_ d: [String: JSONValue]?) -> String? {
        guard let d = d else { return nil }
        let n = (d["groups"]?.arrayValue ?? []).reduce(0) { $0 + ($1["items"]?.arrayValue ?? []).count }
        let scope = group == nil ? (d["label"]?.stringValue ?? "") : (d["label"]?.stringValue ?? "")
        if n == 0 { return scope }
        return "\(scope) · \(n) \(n == 1 ? "task" : "tasks")"
    }

    /// A day group arrives with an ISO date for a label; say it in words.
    private func label(of g: JSONValue) -> String {
        let raw = g["label"]?.stringValue ?? ""
        if g["date"]?.stringValue != nil { return DateLogic.relDate(raw) }
        return raw
    }

    // MARK: rows

    private func taskRow(_ t: JSONValue, last: Bool) -> some View {
        let id = t["id"]?.stringValue ?? ""
        let done = t["done"]?.boolValue ?? false
        var parts: [String] = []
        if let dstr = t["date"]?.stringValue, !dstr.isEmpty, dstr != (t["today"]?.stringValue ?? "") {
            parts.append(DateLogic.relDate(dstr))
        }
        if let time = t["time"]?.stringValue, !time.isEmpty { parts.append(DateLogic.fmtTime(time)) }
        if let rep = t["repeat"]?.stringValue, !rep.isEmpty { parts.append(rep) }
        for p in t["projects"]?.arrayValue ?? [] {
            if let title = p["title"]?.stringValue { parts.append(title) }
        }
        for tag in t["tags"]?.arrayValue ?? [] {
            if let name = tag.stringValue { parts.append("#" + name) }
        }
        return RowView(t["title"]?.stringValue ?? "", sub: parts.joined(separator: " · "), done: done, last: last,
                       leading: { CheckButton(on: done) { setDone(id, !done) } },
                       trailing: { EmptyView() })
            .onTapGesture { if !id.isEmpty { router.push(.task(id)) } }
    }

    /// The checkbox is the one write this screen makes, and it states a
    /// DIRECTION rather than a toggle: the Mac holds the truth about whether
    /// the task is done, and a row that has been on screen for a minute may
    /// not. The list is the Mac's, so it is refetched rather than patched.
    private func setDone(_ id: String, _ done: Bool) {
        guard !id.isEmpty else { return }
        views.request("tasks-action", params: ["action": .string(done ? "complete" : "uncomplete"), "id": .string(id)]) { result in
            switch result {
            case .success: views.refresh(viewName)
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }
}

// MARK: the scopes, which are the desktop's two nav dimensions

private struct TasksDrawer: View {
    let data: [String: JSONValue]?
    let slice: String
    let group: String?
    let onPick: (@escaping () -> Void) -> Void
    @EnvironmentObject var router: Router

    private var nav: [String: JSONValue]? { data?["nav"]?.objectValue }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    section("When")
                    ForEach(Array((nav?["slices"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, s in
                        let id = s["id"]?.stringValue ?? ""
                        row(s["label"]?.stringValue ?? id, count: s["count"]?.numberValue,
                            attention: s["attention"]?.boolValue ?? false,
                            active: id == slice && group == nil) {
                            onPick { router.push(.tasksScope(id, nil)) }
                        }
                    }

                    if let projects = nav?["projects"]?.arrayValue, !projects.isEmpty {
                        section("Projects")
                        ForEach(Array(projects.enumerated()), id: \.offset) { _, p in
                            scopeRow(p, key: "name")
                        }
                    }
                    if let tags = nav?["tags"]?.arrayValue, !tags.isEmpty {
                        section("Tags")
                        ForEach(Array(tags.enumerated()), id: \.offset) { _, t in
                            scopeRow(t, key: "name", prefix: "#")
                        }
                    }
                    if let sources = nav?["sources"]?.arrayValue, !sources.isEmpty {
                        section("Where they came from")
                        ForEach(Array(sources.enumerated()), id: \.offset) { _, s in
                            scopeRow(s, key: "label")
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .frame(width: 270)
        .frame(maxHeight: .infinity)
        .background(Theme.bg)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 0.5) }
    }

    private func section(_ t: String) -> some View {
        Text(t).sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
    }

    /// A scope keeps the WHEN you are already in: "this week, tagged home" is
    /// one request on the Mac, which is the whole point of two dimensions.
    private func scopeRow(_ entry: JSONValue, key: String, prefix: String = "") -> some View {
        let id = entry["id"]?.stringValue ?? ""
        return row(prefix + (entry[key]?.stringValue ?? id), count: entry["count"]?.numberValue,
                   attention: false, active: id == group) {
            onPick { router.push(.tasksScope(slice, id == group ? nil : id)) }
        }
    }

    private func row(_ title: String, count: Double?, attention: Bool, active: Bool, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 0)
                if let c = count, c > 0 {
                    Text("\(Int(c))").font(.system(size: 12, weight: .medium))
                        .foregroundStyle(attention ? Theme.accent : Theme.textTertiary)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(active ? Theme.surfaceHover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm))
            .padding(.horizontal, 6)
        }
        .buttonStyle(.plain)
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
    /// Typed fields write on a debounce (see PendingWrites); a picker or a
    /// toggle is one deliberate act and writes at once.
    private func patchTyped(_ field: String, _ value: JSONValue) {
        PendingWrites.shared.schedule("task:\(id):\(field)") { patch([field: value]) }
    }

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
        .onDisappear { PendingWrites.shared.flushAll() }
        .alert("Delete this task?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { store.deleteItem("schedule", "scheduleItems", id: id); router.pop() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var form: some View {
        Form {
            Section { fieldLabel("Task"); TextField("What needs doing?", text: $title, axis: .vertical).lineLimit(1...5).onChange(of: title) { patchTyped("title", .string($0)) } }
            Section { fieldLabel("Notes (optional)"); TextField("Add details", text: $notes, axis: .vertical).lineLimit(2...4).onChange(of: notes) { patchTyped("description", .string($0)) } }

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

            TaskFromYourMac(id: id)

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

// MARK: what only the Mac knows about this task

/// The fields above are the phone's, written straight to the synced blob so
/// they work with no Mac in reach. These are the ones the Mac alone can
/// answer — which projects the task is linked to, what has been written about
/// it, how its recurring days actually went, where it came from — so they are
/// ASKED for, and simply absent when the Mac is not reachable. That is the
/// honest shape: an editor that still edits, and context that admits when it
/// is not there.
private struct TaskFromYourMac: View {
    let id: String
    @EnvironmentObject var views: MacViews
    @State private var data: [String: JSONValue]?
    @State private var asked = false

    var body: some View {
        Group {
            if let d = data, hasSomething(d) {
                Section {
                    fieldLabel("From your Mac")
                    if let ps = d["projects"]?.arrayValue, !ps.isEmpty {
                        detail("Projects", ps.compactMap { $0["title"]?.stringValue }.joined(separator: ", "))
                    }
                    if let tags = d["tags"]?.arrayValue, !tags.isEmpty {
                        detail("Tags", tags.compactMap { $0.stringValue }.map { "#" + $0 }.joined(separator: " "))
                    }
                    if let src = d["source"]?.stringValue, !src.isEmpty {
                        detail("Came from", src == "imessage" ? "A text" : "An email")
                    }
                    if let spent = d["totalTimeSpent"]?.numberValue, spent > 60000 {
                        detail("Time on it", "\(Int(spent / 60000))m")
                    }
                    if let ups = d["updates"]?.arrayValue, !ups.isEmpty {
                        ForEach(Array(ups.enumerated()), id: \.offset) { _, u in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(MacViews.agoLabel(isoDate(u["at"]?.stringValue)))
                                    .font(.caption).foregroundStyle(Theme.textTertiary)
                                Text(u["text"]?.stringValue ?? "").font(.system(size: 14)).foregroundStyle(Theme.text)
                            }
                        }
                    }
                    if let hist = d["history"]?.arrayValue, !hist.isEmpty {
                        detail("Recent days", hist.prefix(8).compactMap { h in
                            guard let date = h["date"]?.stringValue else { return nil }
                            return (h["state"]?.stringValue == "abandoned" ? "✕ " : "✓ ") + DateLogic.relDate(date)
                        }.joined(separator: "  "))
                    }
                }
            }
        }
        .onAppear(perform: ask)
    }

    private func hasSomething(_ d: [String: JSONValue]) -> Bool {
        !(d["projects"]?.arrayValue ?? []).isEmpty || !(d["tags"]?.arrayValue ?? []).isEmpty
            || !(d["updates"]?.arrayValue ?? []).isEmpty || !(d["history"]?.arrayValue ?? []).isEmpty
            || !(d["source"]?.stringValue ?? "").isEmpty
    }

    private func detail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(Theme.textTertiary)
            Text(value).font(.system(size: 14)).foregroundStyle(Theme.text)
        }
    }

    private func isoDate(_ s: String?) -> Date? {
        guard let s = s else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    private func ask() {
        guard !asked, !id.isEmpty else { return }
        asked = true
        views.request("task", params: ["id": .string(id)]) { result in
            if case .success(let v) = result { data = v.objectValue }
        }
    }
}
