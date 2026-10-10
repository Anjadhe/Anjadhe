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
/// When the Mac is AWAY, `PhoneViews` builds the same answer on the phone
/// (AnjadheCore/TaskList.swift, pinned to the desktop by a shared golden —
/// docs/MOBILE_NATIVE.md "M5"), and the last line says so.
///
/// Editing a task does NOT go through the Mac — see `TaskEditor` below. The
/// division is deliberate: reading wants the desktop's whole truth, writing
/// wants to work on a train.
///
/// Which is why the list says what it is BUILT FROM (`TASKS_KEYS`, 2026-09-22).
/// A served list has a cached answer and no way of its own to tell that the
/// question changed: edit a task's date in the editor below, or change it on
/// the Mac, and the rows kept their old shape until the TTL ran out or someone
/// tapped refresh. `MacViews` re-asks when one of these keys settles on both
/// sides — which for a write made here means when the MAC has taken it, not
/// when the phone wrote it, or the Mac would answer with the rows it still had.
let TASKS_TTL: TimeInterval = 90
/// The blobs the Mac computes this list from: the tasks themselves, the
/// projects a row names, and the links that tie the two together.
let TASKS_KEYS = ["app_schedule", "app_goals", "app_links"]

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
        let snap = views.view(viewName, ttl: TASKS_TTL, request: "tasks", params: params,
                              dependsOn: TASKS_KEYS)
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
                    MacViewUpdatedLine(at: snap.at, error: snap.error, onPhone: snap.builtOnPhone)
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

/// One task, as a reading sheet (2026-10-02, by request: "make it minimal
/// and match the ui theme … optimize for mobile"). What you read first is the
/// task: a check, the title in the heading serif, its details in full, and
/// one line saying when. Then one way to get help, what only the Mac knows
/// (project, where it came from, updates), and — folded under More — the
/// controls a task needs least often: repeat, time, reminders, delete.
///
/// Every field still writes the phone's synced copy on its own (offline is
/// the point of editing here); the Mac merges it record by record. While
/// the phone's copy is behind the Mac's, the Mac's own description shows
/// until there is something local to show.
struct TaskEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var chat: ChatState
    @EnvironmentObject var views: MacViews
    @State private var title = ""; @State private var notes = ""
    @State private var repeatMode = "none"
    @State private var date = Date(); @State private var time = ""
    @State private var dayOfWeek = 0; @State private var customDays: Set<Int> = []
    @State private var notify = 0; @State private var reminders: Set<Int> = []
    @State private var loaded = false
    @State private var typed = false
    @State private var showMore = false
    @State private var confirmDelete = false
    @StateObject private var draft = LocalEditDraft()
    @FocusState private var focus: Field?
    private enum Field { case title, notes }

    private let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private func patch(_ f: [String: JSONValue]) {
        for (key, value) in f { draft.stage(key, value) }
        saveDraft()
    }
    @discardableResult private func saveDraft() -> Bool {
        draft.save { store.patchItem("schedule", "scheduleItems", id: id, $0) }
    }
    /// Typed fields write on a debounce (see PendingWrites); a picker or a
    /// toggle is one deliberate act and writes at once.
    private func patchTyped(_ field: String, _ value: JSONValue) {
        typed = true
        draft.stage(field, value)
        PendingWrites.shared.schedule("task:\(id)") { saveDraft() }
    }

    private var record: JSONValue? { store.findItem("schedule", "scheduleItems", id: id) }
    private var macTask: [String: JSONValue]? {
        views.view("task:" + id, ttl: 60, request: "task", params: ["id": .string(id)]).data?.objectValue
    }

    var body: some View {
        let _ = store.revision
        let _ = views.revision
        let rec = record
        let mac = macTask
        Group {
            if rec == nil && !loaded && mac == nil {
                ScreenColumn { EmptyText("This task isn’t on your phone yet. It will appear when your phone next syncs with your Mac.") }
            } else {
                sheet(rec, mac)
            }
        }
        .pushedScreen()
        .navigationBarBackButtonHidden(!draft.fields.isEmpty)
        .toolbar {
            if !draft.fields.isEmpty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") { if saveDraft() { router.pop() } }
                }
            }
        }
        .onAppear(perform: load)
        .onChange(of: store.revision) { _ in load() }
        .onChange(of: mac?["description"]?.stringValue) { d in
            // The phone's copy is behind: show the Mac's words until it catches up.
            if !typed, notes.isEmpty, let d = d, !d.isEmpty { notes = d }
        }
        .onChange(of: mac?["title"]?.stringValue) { t in
            if !typed, title.isEmpty, let t = t, !t.isEmpty { title = t }
        }
        .onDisappear { PendingWrites.shared.flushAll() }
        .alert("Delete this task?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                PendingWrites.shared.flush("task:\(id)")
                if store.deleteItem("schedule", "scheduleItems", id: id) { router.pop() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: the sheet

    private func sheet(_ rec: JSONValue?, _ mac: [String: JSONValue]?) -> some View {
        let done = rec.map { ScheduleLogic.taskResolved($0) } ?? false
        return ScreenColumn(spacing: 18) {
            LocalSaveStatus(draft: draft) { saveDraft() }
            HStack(alignment: .top, spacing: 12) {
                CheckButton(on: done) { if let r = rec { toggleTaskDone(r, store) } }
                    .padding(.top, 6)
                    .disabled(rec == nil)
                TextField("What needs doing?", text: $title, axis: .vertical)
                    .font(Theme.display(24)).tracking(Theme.displayTracking(24))
                    .foregroundStyle(done ? Theme.textTertiary : Theme.text)
                    .strikethrough(done && repeatMode == "none")
                    .focused($focus, equals: .title)
                    .disabled(rec == nil)
                    .onChange(of: title) { v in if loaded && focus == .title { patchTyped("title", .string(v)) } }
            }
            .padding(.top, 4)

            Button { withAnimation(.easeOut(duration: 0.2)) { showMore = true } } label: {
                Text(whenLine).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            // The details, in full — the thing the desktop shows and the
            // phone used to crop to four lines of a form row.
            TextField("Add details", text: $notes, axis: .vertical)
                .font(.system(size: 16)).lineSpacing(4)
                .foregroundStyle(Theme.text)
                .focused($focus, equals: .notes)
                .disabled(rec == nil)
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: Theme.radiusLg).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.border))
                .contentShape(Rectangle())
                .onTapGesture { focus = .notes }
                .onChange(of: notes) { v in if loaded && focus == .notes { patchTyped("description", .string(v)) } }

            // A coached goal's progress (2026-10-09): the desktop sheet's
            // own block, from the Mac's `task` answer; absent without one.
            if let p = mac?["progress"]?.objectValue { CommitmentProgress(data: p) }

            // The task's own chat (2026-10-08): Today's row no longer carries
            // an "Open chat" pill; the door is here, on the task's page. A
            // chat already tied to this task (`todayKey` task:<id>, the
            // desktop's one conversation per thing) is continued; otherwise
            // a new one asks for help with it.
            let existing = taskChat()
            Button {
                if let cid = existing {
                    chat.open(cid)
                    router.openCompose()
                    return
                }
                let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let d = notes.trimmingCharacters(in: .whitespacesAndNewlines)
                router.startChat("Help me with my task \"\(t)\"" + (d.isEmpty ? "." : ": \(d)") + " What is the next step, and can you do any of it for me? Ask before changing anything.")
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: existing == nil ? "sparkles" : "bubble.left").font(.system(size: 13))
                    Text(existing == nil ? "Help me with this" : "Continue the chat").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Capsule().fill(Theme.surface))
                .overlay(Capsule().strokeBorder(Theme.border))
            }
            .buttonStyle(.plain)

            CommitmentAttachments(id: id) {
                // Attaching is said in the task's own chat (the Mac's
                // attach_to_commitment asks before it writes).
                let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
                if let cid = taskChat() { chat.open(cid); router.openCompose(prefill: "Attach this to “\(t)”: ") }
                else { router.openCompose(prefill: "Attach this to my task “\(t)”: ") }
            }

            if let mac = mac { TaskContext(data: mac) }

            if rec == nil {
                Text("Shown from your Mac. You can edit it once your phone has synced.")
                    .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
            } else {
                more
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// "Due Fri, Oct 3 · 9:30 AM · Every week" — the facts in one line; a
    /// tap opens More, where they are set.
    private var whenLine: String {
        var parts: [String] = []
        switch repeatMode {
        case "none": parts.append("Due " + DateLogic.relDate(DateStr.toStr(date)))
        case "daily": parts.append("Every day")
        case "weekdays": parts.append("Weekdays")
        case "weekly": parts.append("Every " + ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][max(0, min(6, dayOfWeek))])
        case "monthly": parts.append("Monthly")
        case "annually": parts.append("Every year")
        case "custom": parts.append(customDays.sorted().map { weekdays[$0] }.joined(separator: ", "))
        default: break
        }
        if !time.isEmpty {
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
            parts.append(f.string(from: TimeStr.toDate(time)))
        }
        return parts.joined(separator: " · ")
    }

    // MARK: More — the controls a task needs least often

    private var more: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { withAnimation(.easeOut(duration: 0.2)) { showMore.toggle() } } label: {
                HStack(spacing: 6) {
                    Text("More").font(.system(size: 14, weight: .semibold))
                    Image(systemName: showMore ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(Theme.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showMore {
                VStack(spacing: 0) {
                    row("Repeat") {
                        Picker("Repeat", selection: $repeatMode) {
                            ForEach([("none", "Once"), ("daily", "Every day"), ("weekdays", "Weekdays"), ("weekly", "Weekly"), ("monthly", "Monthly"), ("annually", "Annually"), ("custom", "Custom days")], id: \.0) { Text($0.1).tag($0.0) }
                        }
                        .labelsHidden()
                        .onChange(of: repeatMode) { v in
                            var f: [String: JSONValue] = ["repeat": .string(v)]
                            // Seed a weekday so a weekly task actually fires (desktop defaults to Sunday).
                            if v == "weekly" { f["dayOfWeek"] = .number(Double(dayOfWeek)) }
                            if loaded { patch(f) }
                        }
                    }
                    if repeatMode == "none" || repeatMode == "monthly" || repeatMode == "annually" {
                        row(repeatMode == "monthly" ? "Day of month" : repeatMode == "annually" ? "Date each year" : "Date") {
                            DatePicker("", selection: $date, displayedComponents: .date).labelsHidden()
                                .onChange(of: date) { if loaded { patch(["scheduledDate": .string(DateStr.toStr($0))]) } }
                        }
                    }
                    if repeatMode == "weekly" {
                        row("Day") {
                            Picker("Day of week", selection: $dayOfWeek) { ForEach(0..<7, id: \.self) { Text(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][$0]).tag($0) } }
                                .labelsHidden()
                                .onChange(of: dayOfWeek) { if loaded { patch(["dayOfWeek": .number(Double($0))]) } }
                        }
                    }
                    if repeatMode == "custom" {
                        chips(Array(0..<7).map { ($0, weekdays[$0]) }, on: customDays) { d in
                            if customDays.contains(d) { customDays.remove(d) } else { customDays.insert(d) }
                            patch(["repeatDays": .array(customDays.sorted().map { .number(Double($0)) })])
                        }
                    }
                    row("Time") {
                        HStack(spacing: 8) {
                            if time.isEmpty {
                                Button("Add") { time = "09:00"; patch(["startTime": .string(time)]) }
                                    .font(.system(size: 15)).foregroundStyle(Theme.text).buttonStyle(.plain)
                            } else {
                                DatePicker("", selection: Binding(get: { TimeStr.toDate(time) }, set: { time = TimeStr.toStr($0); patch(["startTime": .string(time)]) }), displayedComponents: .hourAndMinute).labelsHidden()
                                Button { time = ""; patch(["startTime": .string("")]) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textTertiary) }.buttonStyle(.plain)
                            }
                        }
                    }
                    if !time.isEmpty {
                        row("Notify") {
                            Picker("Notify", selection: $notify) {
                                ForEach([(0, "At start time"), (5, "5 min before"), (10, "10 min before"), (15, "15 min before"), (30, "30 min before")], id: \.0) { Text($0.1).tag($0.0) }
                            }
                            .labelsHidden()
                            .onChange(of: notify) { if loaded { patch(["notifyBefore": .number(Double($0))]) } }
                        }
                    }
                    if repeatMode == "none" {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Remind me before").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                            chips([(1, "1 day"), (2, "2 days"), (3, "3 days"), (5, "5 days"), (7, "1 week")], on: reminders) { v in
                                if reminders.contains(v) { reminders.remove(v) } else { reminders.insert(v) }
                                patch(["reminderDaysBefore": .array(reminders.sorted(by: >).map { .number(Double($0)) })])
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                    }
                }
                .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))

                Button("Delete task") { confirmDelete = true }
                    .font(.system(size: 14)).foregroundStyle(Theme.danger).buttonStyle(.plain)
                    .padding(.top, 4)
            }
        }
    }

    private func row<C: View>(_ label: String, @ViewBuilder _ control: () -> C) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(label).font(.system(size: 15)).foregroundStyle(Theme.text)
                Spacer(minLength: 8)
                control()
            }
            .padding(.horizontal, 14).frame(minHeight: 46)
            Divider().padding(.leading, 14)
        }
    }

    private func chips(_ items: [(Int, String)], on: Set<Int>, toggle: @escaping (Int) -> Void) -> some View {
        HStack(spacing: 6) {
            ForEach(items, id: \.0) { (v, lbl) in
                Button(lbl) { toggle(v) }
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity).padding(.vertical, 7)
                    .foregroundStyle(on.contains(v) ? Theme.bg : Theme.textSecondary)
                    .background(Capsule().fill(on.contains(v) ? Theme.text : Theme.bg))
                    .overlay(Capsule().strokeBorder(on.contains(v) ? Color.clear : Theme.border))
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func load() {
        guard !loaded, let t = record else { return }
        title = t["title"]?.stringValue ?? ""; notes = t["description"]?.stringValue ?? ""
        repeatMode = t["repeat"]?.stringValue ?? "none"
        date = DateStr.toDate(t["scheduledDate"]?.stringValue ?? DateLogic.todayStr())
        time = t["startTime"]?.stringValue ?? ""
        dayOfWeek = Int(t["dayOfWeek"]?.numberValue ?? 0)
        customDays = Set((t["repeatDays"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
        notify = Int(t["notifyBefore"]?.numberValue ?? 0)
        reminders = Set((t["reminderDaysBefore"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
        // Pickers fire onChange as their state is filled in; writes start
        // only once the fields hold the record.
        DispatchQueue.main.async { loaded = true }
    }
}

/// What only the Mac knows about this task — which projects it is linked
/// to, where it came from, what has been written about it, how its recurring
/// days went. From the Mac's `task` answer; simply absent when the Mac is
/// not reachable. Quiet rows, no form chrome.
private struct TaskContext: View {
    let data: [String: JSONValue]

    var body: some View {
        let projects = (data["projects"]?.arrayValue ?? []).compactMap { $0["title"]?.stringValue }
        let tags = (data["tags"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let source = data["source"]?.stringValue ?? ""
        let ups = data["updates"]?.arrayValue ?? []
        let hist = data["history"]?.arrayValue ?? []
        let spent = data["totalTimeSpent"]?.numberValue ?? 0
        if !projects.isEmpty || !tags.isEmpty || !source.isEmpty || !ups.isEmpty || !hist.isEmpty || spent > 60000 {
            VStack(alignment: .leading, spacing: 12) {
                if !projects.isEmpty { fact("Project", projects.joined(separator: ", ")) }
                if !source.isEmpty { fact("Came from", source == "imessage" ? "A text" : "An email") }
                if !tags.isEmpty { fact("Tags", tags.map { "#" + $0 }.joined(separator: " ")) }
                if spent > 60000 { fact("Time on it", "\(Int(spent / 60000)) min") }
                if !hist.isEmpty {
                    fact("Recent days", hist.prefix(7).compactMap { h in
                        guard let date = h["date"]?.stringValue else { return nil }
                        return (h["state"]?.stringValue == "abandoned" ? "✕ " : "✓ ") + DateLogic.relDate(date)
                    }.joined(separator: "   "))
                }
                if !ups.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel("Updates")
                        ForEach(Array(ups.prefix(5).enumerated()), id: \.offset) { _, u in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(u["text"]?.stringValue ?? "").font(.system(size: 15)).foregroundStyle(Theme.text)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(MacViews.agoLabel(isoDate(u["at"]?.stringValue)))
                                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.textTertiary).frame(width: 88, alignment: .leading)
            Text(value).font(.system(size: 15)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func isoDate(_ s: String?) -> Date? {
        guard let s = s else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }
}

/// A coached goal's progress, as the desktop sheet shows it
/// (CommitmentsPage.progressHtml): the eyebrow, naming the goal when this is
/// one of its steps; the figure over time; the Mac's own progress sentence;
/// the stage, quieter. Every word and number is the Mac's
/// (MobileViews._progress) — the phone only draws them. No inputs.
struct CommitmentProgress: View {
    let data: [String: JSONValue]

    var body: some View {
        let isGoal = data["isGoal"]?.boolValue ?? true
        let goal = data["goalTitle"]?.stringValue ?? ""
        let sentence = data["sentence"]?.stringValue ?? ""
        let stage = data["stage"]?.stringValue ?? ""
        let m = data["measure"]?.objectValue
        let points = (m?["points"]?.arrayValue ?? []).compactMap { p -> (date: String, value: Double)? in
            guard let v = p["value"]?.numberValue, v.isFinite else { return nil }
            return (p["date"]?.stringValue ?? "", v)
        }
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(isGoal || goal.isEmpty ? "Progress" : "Progress · \(goal)")
            if let m = m, points.count >= 2 { chart(m, points) }
            if !sentence.isEmpty {
                Text(sentence).font(.system(size: 15)).foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !stage.isEmpty {
                Text(stage).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The desktop's line block (AnswerBlocks.renderLine): the measure and
    /// its latest figure over the line, the dates and the range under it.
    /// Unsigned, so ink: a figure going up is not good or bad by itself.
    private func chart(_ m: [String: JSONValue], _ pts: [(date: String, value: Double)]) -> some View {
        let clock = m["clock"]?.boolValue ?? false
        let unit = m["unit"]?.stringValue ?? ""
        let name = m["name"]?.stringValue ?? ""
        let label = clock || unit.isEmpty ? name : "\(name) (\(unit))"
        let values = pts.map { $0.value }
        let fmt: (Double) -> String = { clock ? Self.clockText($0) : Self.numberText($0) }
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.system(size: 13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer(minLength: 8)
                Text(fmt(values.last ?? 0)).font(.system(size: 15, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(Theme.text)
            }
            MiniChart(values: values, height: 96, signed: false)
            HStack {
                Text(Self.dateText(pts.first?.date ?? ""))
                Spacer(minLength: 8)
                Text("\(fmt(values.min() ?? 0)) – \(fmt(values.max() ?? 0))")
                Spacer(minLength: 8)
                Text(Self.dateText(pts.last?.date ?? ""))
            }
            .font(.system(size: 11.5)).foregroundStyle(Theme.textTertiary).monospacedDigit()
        }
    }

    /// Minutes after midnight as a time of day: 1420 -> "11:40 PM" (the
    /// desktop's `clock` format).
    static func clockText(_ v: Double) -> String {
        let m = ((Int(v.rounded()) % 1440) + 1440) % 1440
        let h = m / 60
        return "\(h % 12 == 0 ? 12 : h % 12):\(String(format: "%02d", m % 60)) \(h < 12 ? "AM" : "PM")"
    }

    static func numberText(_ v: Double) -> String {
        if v == v.rounded(), abs(v) < 1e12 { return String(Int(v)) }
        return String(format: "%.2f", v).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
    }

    private static let dayIn: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()
    private static let dayOut: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("MMMd"); return f }()
    static func dateText(_ s: String) -> String {
        guard let d = dayIn.date(from: String(s.prefix(10))) else { return s }
        return dayOut.string(from: d)
    }
}

extension TaskEditor {
    /// The newest chat tied to this task, if the phone holds one.
    func taskChat() -> String? {
        let keys: Set<String> = ["task:\(id)"]
        return (store.blob("agent-conversations")["conversations"]?.arrayValue ?? [])
            .filter { keys.contains($0["todayKey"]?.stringValue ?? "") || keys.contains($0["recordKey"]?.stringValue ?? "") }
            .filter { $0["private"]?.boolValue != true }
            .max { ($0["updatedAt"]?.stringValue ?? "") < ($1["updatedAt"]?.stringValue ?? "") }?["id"]?.stringValue
    }
}
