import Foundation

/// The Tasks list, built ON THE PHONE when the Mac is away
/// (docs/MOBILE_NATIVE.md "M5", phase 2).
///
/// While the Mac answers, the list is the Mac's (`MobileViews._tasks` in
/// js/agent/mobile-views.js) — its comment explains why: a Swift copy of the
/// rules drifts. This is that copy anyway, for the one case where the choice
/// is between a copy and nothing, and it returns the Mac view's EXACT shape so
/// the screen cannot tell the difference except by the "built on this phone"
/// line. The Mac's answer replaces it the moment the Mac is back.
///
/// Each function names the desktop function it ports. Dates are local
/// `YYYY-MM-DD` strings throughout, exactly as the desktop keeps them, so no
/// time zone can move a task to another day.
public enum TaskList {
    public static let sliceLabels: [String: String] = [
        "today": "Today", "tomorrow": "Tomorrow", "week": "This week",
        "month": "This month", "later": "Later", "all": "All",
    ]
    public static let sliceOrder = ["today", "tomorrow", "week", "month", "later", "all"]
    /// ActionsApp.DAY_REPEATS
    static let dayRepeats: Set<String> = ["daily", "weekdays", "weekly", "custom"]

    // MARK: dates (ISO strings, local calendar)

    static func components(_ iso: String) -> (Int, Int, Int)? {
        let p = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        return p.count == 3 ? (p[0], p[1], p[2]) : nil
    }

    static func date(_ iso: String, _ cal: Calendar) -> Date? {
        guard let (y, m, d) = components(iso) else { return nil }
        return cal.date(from: DateComponents(year: y, month: m, day: d))
    }

    static func iso(_ d: Date, _ cal: Calendar) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func addDays(_ isoStr: String, _ n: Int, _ cal: Calendar) -> String {
        guard let d = date(isoStr, cal), let r = cal.date(byAdding: .day, value: n, to: d) else { return isoStr }
        return iso(r, cal)
    }

    /// 0 = Sunday … 6 = Saturday (JS getDay).
    static func weekday(_ isoStr: String, _ cal: Calendar) -> Int {
        guard let d = date(isoStr, cal) else { return -1 }
        return cal.component(.weekday, from: d) - 1
    }

    static func monthEnd(_ isoStr: String, _ cal: Calendar) -> String {
        guard let (y, m, _) = components(isoStr),
              let first = cal.date(from: DateComponents(year: y, month: m, day: 1)),
              let next = cal.date(byAdding: .month, value: 1, to: first),
              let last = cal.date(byAdding: .day, value: -1, to: next) else { return isoStr }
        return iso(last, cal)
    }

    static func daysInMonth(_ y: Int, _ m: Int, _ cal: Calendar) -> Int {
        guard let first = cal.date(from: DateComponents(year: y, month: m, day: 1)),
              let r = cal.range(of: .day, in: .month, for: first) else { return 28 }
        return r.count
    }

    // MARK: task facts (ScheduleApp)

    static func s(_ t: JSONValue, _ k: String) -> String { t[k]?.stringValue ?? "" }
    static func repeatOf(_ t: JSONValue) -> String {
        let r = s(t, "repeat"); return r.isEmpty ? "none" : r
    }
    static func isRepeating(_ t: JSONValue) -> Bool { repeatOf(t) != "none" }
    static func num(_ v: JSONValue?) -> Int? { v?.numberValue.map { Int($0) } }

    static func history(_ t: JSONValue) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in t["history"]?.objectValue ?? [:] {
            if let st = v.stringValue { out[k] = st } else if let st = v["state"]?.stringValue { out[k] = st }
        }
        return out
    }

    static func lastAbandoned(_ t: JSONValue) -> String? {
        history(t).filter { $0.value == "abandoned" }.keys.sorted().last
    }

    static func completedOn(_ t: JSONValue, _ today: String) -> Bool { s(t, "lastCompletedDate") == today }
    static func abandonedOn(_ t: JSONValue, _ day: String) -> Bool { history(t)[day] == "abandoned" }

    /// ScheduleApp.repeatsOnDay
    static func repeatsOnDay(_ t: JSONValue, _ dow: Int) -> Bool {
        switch repeatOf(t) {
        case "daily": return true
        case "weekdays": return dow >= 1 && dow <= 5
        case "weekly": return num(t["dayOfWeek"]) == dow
        case "custom": return (t["repeatDays"]?.arrayValue ?? []).contains { num($0) == dow }
        default: return false
        }
    }

    /// ScheduleApp.repeatsOnDate
    static func repeatsOnDate(_ t: JSONValue, _ day: String) -> Bool {
        let sd = s(t, "scheduledDate")
        guard let (_, rm, rd) = components(sd), let (_, dm, dd) = components(day) else { return false }
        switch repeatOf(t) {
        case "monthly": return rd == dd
        case "annually": return rm == dm && rd == dd
        default: return false
        }
    }

    /// ScheduleApp.occursOn — the anchor is a START date: a recurrence never
    /// fires before it.
    public static func occursOn(_ t: JSONValue, _ day: String, cal: Calendar = .current) -> Bool {
        guard isRepeating(t) else { return s(t, "scheduledDate") == day }
        let sd = s(t, "scheduledDate")
        if !sd.isEmpty && day < sd { return false }
        let r = repeatOf(t)
        if r == "monthly" || r == "annually" { return repeatsOnDate(t, day) }
        return repeatsOnDay(t, weekday(day, cal))
    }

    /// ScheduleApp.nextOccurrenceDate
    static func nextOccurrence(_ t: JSONValue, from: String, _ cal: Calendar) -> String {
        let sd = s(t, "scheduledDate")
        guard !sd.isEmpty, let (_, am, ad) = components(sd) else { return sd }
        let eff = from < sd ? sd : from
        guard var (y, m, _) = components(eff) else { return sd }
        switch repeatOf(t) {
        case "monthly":
            for _ in 0..<25 {
                let cand = String(format: "%04d-%02d-%02d", y, m, min(ad, daysInMonth(y, m, cal)))
                if cand >= eff { return cand }
                m += 1; if m > 12 { m = 1; y += 1 }
            }
        case "annually":
            for _ in 0..<4 {
                let cand = String(format: "%04d-%02d-%02d", y, am, min(ad, daysInMonth(y, am, cal)))
                if cand >= eff { return cand }
                y += 1
            }
        default: break
        }
        return sd
    }

    /// ScheduleApp._agendaDateFor
    static func agendaDate(_ t: JSONValue, _ today: String, _ cal: Calendar) -> String {
        let r = repeatOf(t)
        if r == "monthly" || r == "annually" { return nextOccurrence(t, from: today, cal) }
        let sd = s(t, "scheduledDate")
        return sd.isEmpty ? String(s(t, "createdAt").prefix(10)) : sd
    }

    /// TaskListUI.isCompleted / isAbandoned
    public static func isDoneForList(_ t: JSONValue, _ today: String) -> Bool {
        if isRepeating(t) { return completedOn(t, today) || abandonedOn(t, today) }
        return !s(t, "lastCompletedDate").isEmpty || history(t).values.contains("abandoned")
    }

    /// ScheduleApp.messageSourceKind
    static func sourceKind(_ t: JSONValue) -> String? {
        let src = s(t, "sourceEmailId")
        guard !src.isEmpty else { return nil }
        if s(t, "source") == "imessage" || src.hasPrefix("imsg:") { return "imessage" }
        return "email"
    }

    static func timeKey(_ t: JSONValue) -> String { let st = s(t, "startTime"); return st.isEmpty ? "99:99" : st }

    /// ActionsApp._startMins (untimed = -1, so first)
    static func startMins(_ t: JSONValue) -> Int {
        var st = s(t, "startTime"); if st.isEmpty { st = s(t, "endTime") }
        guard !st.isEmpty else { return -1 }
        let p = st.split(separator: ":").map { Int($0) ?? 0 }
        return (p.first ?? 0) * 60 + (p.count > 1 ? p[1] : 0)
    }

    // MARK: the index of task → goals (ScheduleApp.buildTaskLinkIndex)

    public struct Context {
        let items: [JSONValue]
        let goals: [JSONValue]
        /// task id → linked goal ids, in LINK order (a JS Set keeps insertion
        /// order, and the row lists projects in it).
        let taskGoals: [String: [String]]
        let goalById: [String: JSONValue]
        let today: String
        let cal: Calendar

        public init(items: [JSONValue], goals: [JSONValue], links: [JSONValue], today: String, cal: Calendar = .current) {
            self.items = items; self.goals = goals; self.today = today; self.cal = cal
            var idx: [String: [String]] = [:]
            func add(_ task: String, _ goal: String) {
                if !(idx[task]?.contains(goal) ?? false) { idx[task, default: []].append(goal) }
            }
            for l in links {
                let sa = s(l, "sourceApp"), ta = s(l, "targetApp")
                if sa == "schedule" && ta == "goals" { add(s(l, "sourceId"), s(l, "targetId")) }
                else if ta == "schedule" && sa == "goals" { add(s(l, "targetId"), s(l, "sourceId")) }
            }
            taskGoals = idx
            goalById = Dictionary(goals.map { (s($0, "id"), $0) }, uniquingKeysWith: { a, _ in a })
        }

        func goalGroup(_ g: JSONValue) -> String { s(g, "group").trimmingCharacters(in: .whitespaces) }
    }

    /// ActionsApp.groupPredicateFor
    static func predicate(_ f: String?, _ c: Context) -> ((JSONValue) -> Bool)? {
        guard let f = f, !f.isEmpty else { return nil }
        if f == "src:email" { return { sourceKind($0) == "email" } }
        if f == "src:imessage" { return { sourceKind($0) == "imessage" } }
        if f == "t:*" { return { !($0["tags"]?.arrayValue ?? []).isEmpty } }
        if f.hasPrefix("t:") {
            let name = String(f.dropFirst(2))
            return { ($0["tags"]?.arrayValue ?? []).contains { $0.stringValue == name } }
        }
        if f == "unassigned" { return { (c.taskGoals[s($0, "id")] ?? []).isEmpty } }
        let name = f.hasPrefix("g:") ? String(f.dropFirst(2)) : ""
        let ids = Set(c.goals.filter { c.goalGroup($0) == name }.map { s($0, "id") })
        return { t in (c.taskGoals[s(t, "id")] ?? []).contains { ids.contains($0) } }
    }

    // MARK: rows (MobileViews._taskRow)

    public static func row(_ t: JSONValue, _ c: Context) -> JSONValue {
        let projects: [JSONValue] = (c.taskGoals[s(t, "id")] ?? []).compactMap { gid in
            guard let g = c.goalById[gid] else { return nil }
            return .object(["id": .string(gid), "title": .string(String(s(g, "title").prefix(120)))])
        }
        let note = String(s(t, "description").prefix(160))
        func orNull(_ v: String) -> JSONValue { v.isEmpty ? .null : .string(v) }
        return .object([
            "id": t["id"] ?? .null,
            "title": .string(String(s(t, "title").prefix(300))),
            "date": orNull(s(t, "scheduledDate")),
            "time": orNull(s(t, "startTime")),
            "repeat": isRepeating(t) ? .string(repeatOf(t)) : .null,
            "done": .bool(isDoneForList(t, c.today)),
            "completedToday": .bool(completedOn(t, c.today)),
            "tags": .array((t["tags"]?.arrayValue ?? []).prefix(8).compactMap { $0.stringValue.map { .string(String($0.prefix(40))) } }),
            "projects": .array(Array(projects.prefix(3))),
            "source": sourceKind(t).map { .string($0) } ?? .null,
            "note": orNull(note),
        ])
    }

    // MARK: grouping (ScheduleApp.getGroupedItems)

    struct Grouped {
        var overdue: [JSONValue] = [], todayActive: [JSONValue] = [], todayCompleted: [JSONValue] = []
        var tomorrow: [JSONValue] = [], later: [JSONValue] = [], noDate: [JSONValue] = []
    }

    static func grouped(_ c: Context) -> Grouped {
        let today = c.today, tomorrowDate = addDays(today, 1, c.cal)
        var g = Grouped()
        for t in c.items {
            if !isRepeating(t) {
                let resolved = s(t, "lastCompletedDate").isEmpty ? (lastAbandoned(t) ?? "") : s(t, "lastCompletedDate")
                if !resolved.isEmpty && resolved != today { continue }
            }
            if isRepeating(t) {
                let dueToday = occursOn(t, today, cal: c.cal), dueTomorrow = occursOn(t, tomorrowDate, cal: c.cal)
                if dueToday {
                    if completedOn(t, today) || abandonedOn(t, today) { g.todayCompleted.append(t) } else { g.todayActive.append(t) }
                }
                if dueTomorrow { g.tomorrow.append(t) }
                let r = repeatOf(t)
                if (r == "monthly" || r == "annually") && !dueToday && !dueTomorrow { g.later.append(t) }
                continue
            }
            if completedOn(t, today) || abandonedOn(t, today) { g.todayCompleted.append(t); continue }
            let sd = s(t, "scheduledDate")
            if sd.isEmpty { g.noDate.append(t); continue }
            if sd < today { g.overdue.append(t) }
            else if sd == today { g.todayActive.append(t) }
            else if sd == tomorrowDate { g.tomorrow.append(t) }
            else { g.later.append(t) }
        }
        let byTime: (JSONValue, JSONValue) -> Bool = { timeKey($0) < timeKey($1) }
        let byDate: (JSONValue, JSONValue) -> Bool = {
            let da = agendaDate($0, today, c.cal), db = agendaDate($1, today, c.cal)
            return da != db ? da < db : timeKey($0) < timeKey($1)
        }
        g.todayActive.sort(by: byTime); g.todayCompleted.sort(by: byTime); g.tomorrow.sort(by: byTime)
        g.overdue.sort(by: byDate); g.later.sort(by: byDate)
        g.noDate.sort { timeKey($0) != timeKey($1) ? timeKey($0) < timeKey($1) : s($0, "title") < s($1, "title") }
        return g
    }

    // MARK: ranges (ActionsApp._rangeDates / _openItemsOn / _rangeItems / _laterItems)

    static func rangeDates(_ id: String, _ c: Context) -> [String] {
        if id == "tomorrow" { return [addDays(c.today, 1, c.cal)] }
        let end = id == "week" ? addDays(c.today, (7 - weekday(c.today, c.cal)) % 7, c.cal) : monthEnd(c.today, c.cal)
        var out: [String] = [], d = c.today
        while d <= end && out.count < 40 { out.append(d); d = addDays(d, 1, c.cal) }
        return out
    }

    static func openItemsOn(_ day: String, includeDayRepeats: Bool, _ c: Context) -> [JSONValue] {
        c.items.filter { t in
            guard !s(t, "title").isEmpty else { return false }
            if !isRepeating(t) {
                return s(t, "scheduledDate") == day && s(t, "lastCompletedDate").isEmpty && lastAbandoned(t) == nil
            }
            if !includeDayRepeats && dayRepeats.contains(repeatOf(t)) { return false }
            if !occursOn(t, day, cal: c.cal) { return false }
            if day == c.today && (completedOn(t, c.today) || abandonedOn(t, c.today)) { return false }
            return true
        }.sorted { startMins($0) < startMins($1) }
    }

    static func rangeItems(_ id: String, _ pred: ((JSONValue) -> Bool)?, _ c: Context) -> [(date: String, items: [JSONValue])] {
        let include = id != "month"
        return rangeDates(id, c).map { d in (d, openItemsOn(d, includeDayRepeats: include, c).filter { pred?($0) ?? true }) }
            .filter { !$0.items.isEmpty }
    }

    static func laterItems(_ pred: ((JSONValue) -> Bool)?, _ c: Context) -> (months: [(key: String, label: String, items: [JSONValue])], noDate: [JSONValue]) {
        let end = monthEnd(c.today, c.cal)
        var dated: [(item: JSONValue, date: String)] = [], noDate: [JSONValue] = []
        for t in c.items {
            guard !s(t, "title").isEmpty, pred?(t) ?? true else { continue }
            if isRepeating(t) {
                if dayRepeats.contains(repeatOf(t)) { continue }
                let next = nextOccurrence(t, from: c.today, c.cal)
                if !next.isEmpty && next > end { dated.append((t, next)) }
                continue
            }
            if !s(t, "lastCompletedDate").isEmpty || lastAbandoned(t) != nil { continue }
            let sd = s(t, "scheduledDate")
            if sd.isEmpty { noDate.append(t) } else if sd > end { dated.append((t, sd)) }
        }
        dated.sort { $0.date != $1.date ? $0.date < $1.date : startMins($0.item) < startMins($1.item) }
        noDate.sort { s($0, "title") < s($1, "title") }
        let fmt = DateFormatter(); fmt.calendar = c.cal; fmt.timeZone = c.cal.timeZone
        fmt.setLocalizedDateFormatFromTemplate("MMMM yyyy")
        var months: [(key: String, label: String, items: [JSONValue])] = []
        for e in dated {
            let key = String(e.date.prefix(7))
            if months.last?.key != key {
                let label = date(e.date, c.cal).map { fmt.string(from: $0) } ?? key
                months.append((key, label, []))
            }
            months[months.count - 1].items.append(e.item)
        }
        return (months, noDate)
    }

    // MARK: the view (MobileViews._tasks)

    public static func view(slice rawSlice: String?, group rawGroup: String?, _ c: Context) -> JSONValue {
        let slice = sliceOrder.contains(rawSlice ?? "") ? rawSlice! : "today"
        let group = (rawGroup?.isEmpty == false) ? String(rawGroup!.prefix(80)) : nil
        let pred = predicate(group, c)
        let keep: ([JSONValue]) -> [JSONValue] = { list in (pred.map { p in list.filter(p) } ?? list).map { row($0, c) } }
        var groups: [JSONValue] = []
        func add(_ id: String, _ label: String, _ items: [JSONValue], danger: Bool = false, date: String? = nil) {
            guard !items.isEmpty else { return }
            var o: [String: JSONValue] = ["id": .string(id), "label": .string(label), "danger": .bool(danger), "items": .array(items)]
            if let d = date { o["date"] = .string(d) }
            groups.append(.object(o))
        }
        if slice == "today" || slice == "all" {
            let g = grouped(c)
            add("overdue", "Overdue", keep(g.overdue), danger: true)
            add("today", "Today", keep(g.todayActive))
            if slice == "all" {
                add("tomorrow", "Tomorrow", keep(g.tomorrow))
                add("later", "Later", keep(g.later))
                add("nodate", "No date", keep(g.noDate))
            }
            add("done", "Done today", keep(g.todayCompleted))
        } else if slice == "later" {
            let l = laterItems(pred, c)
            for m in l.months { add(m.key, m.label, m.items.map { row($0, c) }) }
            add("nodate", "No date", l.noDate.map { row($0, c) })
        } else {
            for day in rangeItems(slice, pred, c) { add(day.date, day.date, day.items.map { row($0, c) }, date: day.date) }
        }
        return .object([
            "today": .string(c.today), "slice": .string(slice), "group": group.map { .string($0) } ?? .null,
            "label": .string(sliceLabels[slice] ?? slice),
            "nav": navCounts(c), "groups": .array(groups),
        ])
    }

    /// ActionsApp._navCounts, in the view's `nav` shape.
    static func navCounts(_ c: Context) -> JSONValue {
        let g = grouped(c)
        let l = laterItems(nil, c)
        var counts: [String: Int] = [
            "today": g.overdue.count + g.todayActive.count,
            "tomorrow": rangeItems("tomorrow", nil, c).reduce(0) { $0 + $1.items.count },
            "week": rangeItems("week", nil, c).reduce(0) { $0 + $1.items.count },
            "month": rangeItems("month", nil, c).reduce(0) { $0 + $1.items.count },
            "later": l.months.reduce(0) { $0 + $1.items.count } + l.noDate.count,
            "all": 0,
        ]
        var tags: [String: Int] = [:], groups: [String: Int] = [:]
        var unassigned = 0, fromEmail = 0, fromTexts = 0
        let groupOf = Dictionary(c.goals.map { (s($0, "id"), c.goalGroup($0)) }, uniquingKeysWith: { a, _ in a })
        for t in c.items {
            guard !s(t, "title").isEmpty, !isDoneForList(t, c.today) else { continue }
            counts["all", default: 0] += 1
            for tag in Set((t["tags"]?.arrayValue ?? []).compactMap { $0.stringValue }) { tags[tag, default: 0] += 1 }
            switch sourceKind(t) { case "email": fromEmail += 1; case "imessage": fromTexts += 1; default: break }
            let set = c.taskGoals[s(t, "id")] ?? []
            if set.isEmpty { unassigned += 1; continue }
            var seen = Set<String>()
            for gid in set { if let name = groupOf[gid], seen.insert(name).inserted { groups[name, default: 0] += 1 } }
        }
        let slices: [JSONValue] = sliceOrder.map { id in .object([
            "id": .string(id), "label": .string(sliceLabels[id] ?? id),
            "count": .number(Double(counts[id] ?? 0)), "attention": .bool(id == "today")]) }
        let tagRows: [JSONValue] = tags.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(40)
            .map { .object(["id": .string("t:" + $0.key), "name": .string($0.key), "count": .number(Double($0.value))]) }
        let projRows: [JSONValue] = groups.sorted {
            let a = $0.key.isEmpty ? "Ungrouped" : $0.key, b = $1.key.isEmpty ? "Ungrouped" : $1.key
            return $0.value != $1.value ? $0.value > $1.value : a < b
        }.prefix(40).map { .object(["id": .string("g:" + $0.key), "name": .string($0.key.isEmpty ? "Ungrouped" : $0.key), "count": .number(Double($0.value))]) }
        var sources: [JSONValue] = []
        if fromEmail > 0 { sources.append(.object(["id": .string("src:email"), "label": .string("From email"), "count": .number(Double(fromEmail))])) }
        if fromTexts > 0 { sources.append(.object(["id": .string("src:imessage"), "label": .string("From texts"), "count": .number(Double(fromTexts))])) }
        return .object(["slices": .array(slices), "tags": .array(tagRows), "projects": .array(projRows),
                        "sources": .array(sources), "unassigned": .number(Double(unassigned))])
    }

    // MARK: one task (MobileViews._task)

    public static func detail(id: String, updates: [JSONValue], _ c: Context) -> JSONValue? {
        guard let t = c.items.first(where: { s($0, "id") == id }), case .object(var o) = row(t, c) else { return nil }
        o["description"] = .string(String(s(t, "description").prefix(8000)))
        o["totalTimeSpent"] = .number(t["totalTimeSpent"]?.numberValue ?? 0)
        o["createdAt"] = t["createdAt"] ?? .null
        o["lastCompletedDate"] = t["lastCompletedDate"] ?? .null
        o["history"] = .array(history(t).sorted { $0.key > $1.key }.prefix(30)
            .map { .object(["date": .string($0.key), "state": .string($0.value)]) })
        o["updates"] = .array(Array(updates.prefix(20)))
        return .object(o)
    }

    // MARK: the checkbox (ScheduleApp.isDone + toggleComplete)

    /// ScheduleApp.isDone
    public static func isDone(_ t: JSONValue, today: String) -> Bool {
        isRepeating(t) ? completedOn(t, today) : !s(t, "lastCompletedDate").isEmpty
    }

    /// The task after the desktop's toggle, driven by a DIRECTION as the
    /// Mac's `tasks-action` is: a no-op when it is already that way. Stamps
    /// `updatedAt` / `modifiedAt` so the edit wins a merge.
    public static func setDone(_ t: JSONValue, done: Bool, today: String, now: String, nowMs: Double) -> JSONValue {
        guard case .object(var o) = t, isDone(t, today: today) != done else { return t }
        var h = t["history"]?.objectValue ?? [:]
        if !done {
            o["lastCompletedDate"] = .null
            if h[today]?.stringValue == "done" { h[today] = nil }
        } else {
            o["lastCompletedDate"] = .string(today)
            h[today] = .string("done")
            if !isRepeating(t) { h = h.filter { $0.value.stringValue != "abandoned" } }
            if let started = t["timerStartedAt"]?.stringValue, let at = DateLogic.parseISO(started) {
                let elapsed = max(0, nowMs - at.timeIntervalSince1970 * 1000)
                o["totalTimeSpent"] = .number((t["totalTimeSpent"]?.numberValue ?? 0) + elapsed)
                o["timerStartedAt"] = .null
            }
        }
        o["history"] = .object(h)
        o["updatedAt"] = .string(now)
        return .object(o)
    }
}
