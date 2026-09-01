import SwiftUI
import AnjadheCore

// Batch 2 of the native built-in apps: Notes, Journal, Calendar.
// Rich-text editing (notes/journal) is plain-text for now (content round-trips
// with the Mac's simple HTML); a formatting toolbar is a follow-up.
// (Habits was removed from the product 2026-07-15 — recurring tasks cover it.)

// MARK: Notes

struct NotesView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    private var notes: [JSONValue] {
        store.items("notes", "notes").sorted {
            let ap = $0["pinned"]?.boolValue ?? false, bp = $1["pinned"]?.boolValue ?? false
            if ap != bp { return ap }
            return ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "")
        }
    }
    var body: some View {
        List {
            if notes.isEmpty {
                Text("No notes yet. Tap + to write one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(notes, id: \.self) { n in
                    Button { editId = n["id"]?.stringValue } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 4) {
                                    if n["pinned"]?.boolValue == true { Image(systemName: "star.fill").font(.caption2).foregroundStyle(Theme.textSecondary) }
                                    Text(n["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                }
                                Text(plainPreview(n["content"]?.stringValue ?? "", 72)).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
                            }
                            Spacer()
                            Text(DateLogic.relDate(n["modifiedAt"]?.stringValue ?? "")).font(.caption2).foregroundStyle(Theme.textTertiary)
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Notes")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("notes", "notes", ["title": .string(""), "content": .string(""), "pinned": .bool(false), "tags": .array([])]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { NoteEditor(id: id) }
        }
    }
}

struct NoteEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var html = ""; @State private var pinned = false; @State private var loaded = false
    var body: some View {
        VStack(spacing: 0) {
            TextField("Title", text: $title, axis: .vertical).lineLimit(1...4).font(.title3.bold()).padding(.horizontal).padding(.top, 8)
                .onChange(of: title) { store.patchItem("notes", "notes", id: id, ["title": .string($0)]) }
            Divider().padding(.top, 8)
            RichEditorView(html: $html, placeholder: "Write…")
                .onChange(of: html) { store.patchItem("notes", "notes", id: id, ["content": .string($0)]) }
        }
        .background(Theme.bg)
        .navigationTitle("Note").inlineNavTitle()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { pinned.toggle(); store.patchItem("notes", "notes", id: id, ["pinned": .bool(pinned)]) } label: { Image(systemName: pinned ? "star.fill" : "star") }
                Button(role: .destructive) { store.deleteItem("notes", "notes", id: id); dismiss() } label: { Image(systemName: "trash") }
            }
        }
        .onAppear {
            guard !loaded, let n = store.findItem("notes", "notes", id: id) else { return }
            loaded = true
            title = n["title"]?.stringValue ?? ""; html = n["content"]?.stringValue ?? ""; pinned = n["pinned"]?.boolValue ?? false
        }
    }
}

// MARK: Journal

private let MOODS = ["great", "good", "okay", "low", "rough"]

struct JournalView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    private var entries: [JSONValue] {
        store.items("journal", "entries").sorted { ($0["date"]?.stringValue ?? $0["createdAt"]?.stringValue ?? "") > ($1["date"]?.stringValue ?? $1["createdAt"]?.stringValue ?? "") }
    }
    var body: some View {
        List {
            if entries.isEmpty {
                Text("No entries yet. Tap + to begin.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(entries, id: \.self) { e in
                    Button { editId = e["id"]?.stringValue } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(DateLogic.relDate(e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? "")).foregroundStyle(Theme.text)
                                Text(plainPreview(e["content"]?.stringValue ?? "", 76)).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
                            }
                            Spacer()
                            if let m = e["mood"]?.stringValue, !m.isEmpty {
                                Text(m).font(.caption2).foregroundStyle(Theme.textSecondary).padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.surface)).overlay(Capsule().strokeBorder(Theme.border))
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Journal")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("journal", "entries", ["content": .string(""), "mood": .string(""), "tags": .array([]), "date": .string(KVStore.nowISO())]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { JournalEditor(id: id) }
        }
    }
}

struct JournalEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var html = ""; @State private var mood = ""; @State private var loaded = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                ForEach(MOODS, id: \.self) { m in
                    Button(m) {
                        mood = (mood == m) ? "" : m
                        store.patchItem("journal", "entries", id: id, ["mood": .string(mood)])
                    }
                    .font(.caption).frame(maxWidth: .infinity).padding(.vertical, 6)
                    .background(mood == m ? Theme.text : Theme.surface)
                    .foregroundStyle(mood == m ? Theme.bg : Theme.textSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }.buttonStyle(.plain).padding()
            Divider()
            RichEditorView(html: $html, placeholder: "How was today?")
                .onChange(of: html) { store.patchItem("journal", "entries", id: id, ["content": .string($0)]) }
        }
        .background(Theme.bg)
        .navigationTitle("Journal").inlineNavTitle()
        .toolbar { ToolbarItem(placement: .primaryAction) { Button(role: .destructive) { store.deleteItem("journal", "entries", id: id); dismiss() } label: { Image(systemName: "trash") } } }
        .onAppear {
            guard !loaded, let e = store.findItem("journal", "entries", id: id) else { return }
            loaded = true
            html = e["content"]?.stringValue ?? ""; mood = e["mood"]?.stringValue ?? ""
        }
    }
}

// MARK: Calendar (read-only month + agenda)

struct CalendarView: View {
    @EnvironmentObject var store: AppStore
    @State private var monthAnchor = Date()
    @State private var selected = DateLogic.todayStr()
    private let cal = Calendar.current
    private let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    private func eventDate(_ ev: JSONValue) -> String {
        guard let start = ev["start"]?.stringValue else { return "" }
        if ev["allDay"]?.boolValue == true { return String(start.prefix(10)) }
        return DateLogic.parseISO(start).map { DateLogic.dateStr($0, cal) } ?? ""
    }
    private var eventsByDate: [String: [JSONValue]] {
        var m: [String: [JSONValue]] = [:]
        for ev in store.items("calendar", "events") { let k = eventDate(ev); if !k.isEmpty { m[k, default: []].append(ev) } }
        return m
    }
    private var tasks: [JSONValue] { store.items("schedule", "scheduleItems") }

    var body: some View {
        let comps = cal.dateComponents([.year, .month], from: monthAnchor)
        let year = comps.year ?? 2026, month = comps.month ?? 1
        return ScrollView {
            VStack(spacing: 14) {
                HStack {
                    Button { monthAnchor = cal.date(byAdding: .month, value: -1, to: monthAnchor)! } label: { Image(systemName: "chevron.left") }
                    Spacer(); Text("\(monthNames[month - 1]) \(String(year))").font(.headline); Spacer()
                    Button { monthAnchor = cal.date(byAdding: .month, value: 1, to: monthAnchor)! } label: { Image(systemName: "chevron.right") }
                }
                monthGrid(year: year, month: month)
                agenda
            }.padding()
        }
        .background(Theme.bg)
        .navigationTitle("Calendar").inlineNavTitle()
    }

    private func monthGrid(year: Int, month: Int) -> some View {
        let byDate = eventsByDate
        let first = cal.date(from: DateComponents(year: year, month: month, day: 1))!
        let startDow = cal.component(.weekday, from: first) - 1
        let daysInMonth = cal.range(of: .day, in: .month, for: first)!.count
        let total = Int((Double(startDow + daysInMonth) / 7).rounded(.up)) * 7
        let gridStart = cal.date(byAdding: .day, value: -startDow, to: first)!
        let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
        return VStack(spacing: 6) {
            HStack { ForEach(["S", "M", "T", "W", "T", "F", "S"], id: \.self) { Text($0).font(.caption2).foregroundStyle(Theme.textTertiary).frame(maxWidth: .infinity) } }
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(0..<total, id: \.self) { i in
                    let date = cal.date(byAdding: .day, value: i, to: gridStart)!
                    let ds = DateLogic.dateStr(date, cal)
                    let inMonth = cal.component(.month, from: date) == month
                    let hasItems = (byDate[ds]?.isEmpty == false) || tasks.contains { ScheduleLogic.taskDueOn($0, on: date, cal: cal) }
                    Button { selected = ds } label: {
                        VStack(spacing: 2) {
                            Text("\(cal.component(.day, from: date))").font(.callout)
                                .foregroundStyle(inMonth ? Theme.text : Theme.textTertiary)
                            Circle().fill(hasItems ? Theme.text : .clear).frame(width: 5, height: 5)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 8).fill(ds == selected ? Theme.surface : .clear))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ds == DateLogic.todayStr() ? Theme.text : .clear, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private var agenda: some View {
        let byDate = eventsByDate
        // `selected` is a bare yyyy-MM-dd produced from the LOCAL grid, so rebuild
        // it as a local-midnight date. Going through parseISO (UTC midnight) would
        // shift both the label and weekday-based taskDueOn back a day in a
        // behind-UTC zone.
        let date = Self.localMidnight(selected, cal) ?? Date()
        let events = (byDate[selected] ?? []).sorted {
            let aa = $0["allDay"]?.boolValue ?? false, ba = $1["allDay"]?.boolValue ?? false
            if aa != ba { return aa }
            return ($0["start"]?.stringValue ?? "") < ($1["start"]?.stringValue ?? "")
        }
        let dayTasks = tasks.filter { ScheduleLogic.taskDueOn($0, on: date, cal: cal) }
            .sorted { ($0["startTime"]?.stringValue ?? "99:99") < ($1["startTime"]?.stringValue ?? "99:99") }
        let isToday = selected == DateLogic.todayStr()
        return VStack(alignment: .leading, spacing: 8) {
            Text(agendaLabel(date)).sectionHeaderStyle()
            if events.isEmpty && dayTasks.isEmpty {
                Text("Nothing on this day.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(events, id: \.self) { ev in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ev["summary"]?.stringValue ?? "(No title)").foregroundStyle(Theme.text)
                            if let loc = ev["location"]?.stringValue, !loc.isEmpty { Text(loc).font(.caption).foregroundStyle(Theme.textSecondary) }
                        }
                        Spacer()
                        Text(eventTime(ev)).font(.caption).foregroundStyle(Theme.textTertiary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if let link = ev["htmlLink"]?.stringValue { openURL(link) } }
                    Divider()
                }
                ForEach(dayTasks, id: \.self) { t in
                    HStack(spacing: 12) {
                        Image(systemName: (isToday && ScheduleLogic.taskDoneToday(t)) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(isToday ? Theme.text : Theme.textTertiary)
                            .onTapGesture { if isToday, let id = t["id"]?.stringValue { let d = ScheduleLogic.taskDoneToday(t); store.patchItem("schedule", "scheduleItems", id: id, ["lastCompletedDate": d ? .null : .string(DateLogic.todayStr())]) } }
                        VStack(alignment: .leading, spacing: 1) { Text(t["title"]?.stringValue ?? "Untitled").foregroundStyle(Theme.text); Text("Task").font(.caption).foregroundStyle(Theme.textTertiary) }
                        Spacer()
                        if let st = t["startTime"]?.stringValue, !st.isEmpty { Text(DateLogic.fmtTime(st)).font(.caption).foregroundStyle(Theme.textTertiary) }
                    }
                    Divider()
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Parse a bare `yyyy-MM-dd` into midnight in the given (local) calendar.
    private static func localMidnight(_ ymd: String, _ cal: Calendar) -> Date? {
        let p = ymd.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }
    private func agendaLabel(_ d: Date) -> String { let f = DateFormatter(); f.dateFormat = "EEEE, MMMM d"; return f.string(from: d) }
    private func eventTime(_ ev: JSONValue) -> String {
        if ev["allDay"]?.boolValue == true { return "All day" }
        guard let d = DateLogic.parseISO(ev["start"]?.stringValue ?? "") else { return "" }
        let f = DateFormatter(); f.timeStyle = .short; return f.string(from: d)
    }
}
