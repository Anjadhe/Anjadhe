import Foundation

/// Task-repeat logic ported from `mobile/app.js`
/// (`taskDueOn`, `taskDoneToday`, …). Operates on `JSONValue`
/// records — the same shape the synced blobs carry — so it matches the JS
/// exactly. `today`/`cal` are injectable for deterministic tests.
public enum ScheduleLogic {

    // MARK: Tasks

    public static func taskDueOn(_ task: JSONValue, on date: Date, cal: Calendar = .current) -> Bool {
        let dow = DateLogic.weekday(date, cal)
        let ds = DateLogic.dateStr(date, cal)
        switch task["repeat"]?.stringValue ?? "none" {
        case "daily":
            return true
        case "weekdays":
            return dow >= 1 && dow <= 5
        case "weekly":
            return intOf(task["dayOfWeek"]) == dow
        case "custom":
            return (task["repeatDays"]?.arrayValue ?? []).contains { intOf($0) == dow }
        case "monthly":
            guard let sd = task["scheduledDate"]?.stringValue, sd.count >= 10 else { return false }
            return slice(sd, 8, 10) == slice(ds, 8, 10)
        case "annually":
            guard let sd = task["scheduledDate"]?.stringValue, sd.count >= 5 else { return false }
            return sliceFrom(sd, 5) == sliceFrom(ds, 5)
        default: // 'none'
            return task["scheduledDate"]?.stringValue == ds
        }
    }

    public static func taskDueToday(_ task: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        taskDueOn(task, on: today, cal: cal)
    }

    public static func taskDoneToday(_ task: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        task["lastCompletedDate"]?.stringValue == DateLogic.todayStr(today, cal)
    }

    /// A task with no repeat (missing or "none").
    public static func isOneTime(_ task: JSONValue) -> Bool {
        let r = task["repeat"]?.stringValue ?? "none"
        return r.isEmpty || r == "none"
    }

    /// The newest date the task was deliberately skipped (desktop
    /// `ScheduleApp.lastAbandonedDate`: history[date] == "abandoned").
    public static func lastAbandonedDate(_ task: JSONValue) -> String? {
        guard let h = task["history"]?.objectValue else { return nil }
        return h.filter { $0.value.stringValue == "abandoned" }.keys.sorted().last
    }

    /// The desktop's completion rule (`ScheduleApp.isResolved` / the list
    /// grouping in schedule-app.js): a ONE-TIME task is done once it carries
    /// any completion or abandonment date, whatever the day; a repeating
    /// task is an ongoing commitment and only counts as done for today.
    /// Using `taskDoneToday` for one-time tasks made every task completed on
    /// an earlier day show as overdue on the phone (2026-09-01).
    public static func taskResolved(_ task: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        if isOneTime(task) {
            let done = (task["lastCompletedDate"]?.stringValue).map { !$0.isEmpty } ?? false
            return done || lastAbandonedDate(task) != nil
        }
        return taskDoneToday(task, today: today, cal: cal)
    }

    // MARK: internals

    private static func intOf(_ v: JSONValue?) -> Int {
        if let n = v?.numberValue { return Int(n) }
        return -999
    }

    /// JS `String.slice(start, end)` on characters.
    static func slice(_ s: String, _ start: Int, _ end: Int) -> String {
        let chars = Array(s)
        guard start < chars.count else { return "" }
        return String(chars[start..<min(end, chars.count)])
    }
    static func sliceFrom(_ s: String, _ start: Int) -> String {
        let chars = Array(s)
        guard start < chars.count else { return "" }
        return String(chars[start...])
    }
}
