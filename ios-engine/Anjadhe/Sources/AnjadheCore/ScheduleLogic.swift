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
