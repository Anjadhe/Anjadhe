import SwiftUI
import AnjadheCore

// Calendar — a read-only month view of synced calendar events and scheduled
// tasks, with a per-day agenda (port of mobile/screens/calendar.js). Events
// are created on the Mac; this screen never writes events.

struct CalendarView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var monthAnchor = Date()
    @State private var selected = DateLogic.todayStr()
    private let cal = Calendar.current
    private let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    /// Local Y-M-D of an event. All-day events keep their stored date as-is —
    /// parsing them through Date would shift across the timezone boundary.
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
        return ScreenColumn(spacing: 18) {
            ScreenHead("Calendar")
            HStack {
                Button { monthAnchor = cal.date(byAdding: .month, value: -1, to: monthAnchor)! } label: { Image(systemName: "chevron.left").frame(width: 32, height: 32) }
                    .accessibilityLabel("Previous month")
                Spacer(); Text("\(monthNames[month - 1]) \(String(year))").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text); Spacer()
                Button { monthAnchor = cal.date(byAdding: .month, value: 1, to: monthAnchor)! } label: { Image(systemName: "chevron.right").frame(width: 32, height: 32) }
                    .accessibilityLabel("Next month")
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text)
            monthGrid(year: year, month: month)
            agenda
        }
        .pushedScreen()
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
            HStack { ForEach(Array(["S", "M", "T", "W", "T", "F", "S"].enumerated()), id: \.offset) { _, d in Text(d).font(.caption2).foregroundStyle(Theme.textTertiary).frame(maxWidth: .infinity) } }
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(0..<total, id: \.self) { i in
                    let date = cal.date(byAdding: .day, value: i, to: gridStart)!
                    let ds = DateLogic.dateStr(date, cal)
                    let inMonth = cal.component(.month, from: date) == month
                    let hasItems = (byDate[ds]?.isEmpty == false) || tasks.contains { ScheduleLogic.taskDueOn($0, on: date, cal: cal) }
                    Button {
                        selected = ds
                        monthAnchor = date
                    } label: {
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
        let rowCount = events.count + dayTasks.count
        return VStack(alignment: .leading, spacing: 8) {
            SectionLabel(agendaLabel(date))
            if rowCount == 0 {
                EmptyText("Nothing on this day.")
            } else {
                CardList {
                    ForEach(Array(events.enumerated()), id: \.offset) { i, ev in
                        let link = ev["htmlLink"]?.stringValue ?? ""
                        RowView(ev["summary"]?.stringValue ?? "(No title)", sub: ev["location"]?.stringValue, last: i == rowCount - 1,
                                trailing: { Text(eventTime(ev)).font(.caption).foregroundStyle(Theme.textTertiary) })
                            .onTapGesture { if !link.isEmpty { openURL(link) } }
                    }
                    ForEach(Array(dayTasks.enumerated()), id: \.offset) { i, t in
                        let done = ScheduleLogic.isOneTime(t) ? ScheduleLogic.taskResolved(t) : (isToday && ScheduleLogic.taskDoneToday(t))
                        let id = t["id"]?.stringValue ?? ""
                        RowView(t["title"]?.stringValue ?? "", sub: "Task", done: done, last: events.count + i == rowCount - 1,
                                leading: { CheckButton(on: done, muted: !isToday) { toggleTaskDone(t, store) } },
                                trailing: {
                                    if let st = t["startTime"]?.stringValue, !st.isEmpty {
                                        Text(DateLogic.fmtTime(st)).font(.caption).foregroundStyle(Theme.textTertiary)
                                    }
                                })
                            .onTapGesture { if !id.isEmpty { router.push(.task(id)) } }
                    }
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
