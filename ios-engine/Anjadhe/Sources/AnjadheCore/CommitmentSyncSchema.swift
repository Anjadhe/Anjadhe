import Foundation

/// Wire validation only. Shared fixtures enforce parity with commitment-sync.js;
/// capture, recurrence, planning and conflict presentation remain in shared JS.
enum CommitmentSyncSchema {
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    }
    private static func text(_ v: JSONValue?, _ max: Int, required: Bool = false) -> Bool {
        v?.stringValue.map { $0.utf16.count <= max && (!required || !$0.isEmpty) } == true
    }
    private static func id(_ v: JSONValue?) -> Bool { v?.stringValue.map { matches($0, "^[A-Za-z0-9._:-]{1,160}$") } == true }
    private static func exact(_ v: JSONValue?, _ keys: Set<String>) -> Bool { v?.objectValue.map { Set($0.keys) == keys } == true }
    private static func oneOf(_ v: JSONValue?, _ values: [String]) -> Bool { v?.stringValue.map { values.contains($0) } == true }
    private static func date(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue, matches(s, "^[0-9]{4}-[0-9]{2}-[0-9]{2}$") else { return false }
        let parts = s.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return false }
        let y = parts[0], m = parts[1], d = parts[2], leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
        return y > 0 && (1...12).contains(m) && d > 0 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    }
    private static func clock(_ v: JSONValue?) -> Bool { v?.stringValue.map { matches($0, "^([01][0-9]|2[0-3]):[0-5][0-9]$") } == true }
    private static func timePair(_ v: JSONValue) -> Bool {
        guard exact(v, ["time", "end"]), v["time"] == .null || clock(v["time"]), v["end"] == .null || clock(v["end"]) else { return false }
        if v["end"] == .null { return true }
        guard let start = v["time"]?.stringValue, let end = v["end"]?.stringValue else { return false }
        return end >= start
    }
    private static func list(_ v: JSONValue?, _ max: Int) -> Bool {
        guard let values = v?.arrayValue, values.count <= max + 1 else { return false }
        var previous = -1.0
        for v in values {
            guard let n = v.numberValue, n.isFinite, n.rounded() == n, n >= 0, n <= Double(max), n > previous else { return false }
            previous = n
        }
        return true
    }
    private static func measure(_ v: JSONValue) -> Bool {
        guard exact(v, ["name", "value", "unit"]), let name = v["name"]?.stringValue, name.utf16.count <= 40,
              matches(name, "^[a-z0-9][a-z0-9 _-]*$"), name.range(of: "[a-z]", options: .regularExpression) != nil,
              let number = v["value"]?.numberValue, number.isFinite, let unit = v["unit"]?.stringValue, unit.utf16.count <= 16,
              Array(unit.utf16) == Array(unit.lowercased().trimmingCharacters(in: .whitespacesAndNewlines).utf16),
              unit.range(of: "[\\r\\n\\t]", options: .regularExpression) == nil else { return false }
        return unit != "time" || number.rounded() == number && number >= 0 && number < 1440
    }
    static func validField(_ type: String, _ key: String, _ v: JSONValue) -> Bool {
        if type == "commitment-day" {
            guard key == "day", exact(v, ["commitmentId", "date", "mark", "log", "moved"]), id(v["commitmentId"]), date(v["date"]),
                  v["mark"] == .null || oneOf(v["mark"], ["done", "dropped"]), let moved = v["moved"],
                  moved == .null || timePair(moved) && moved["time"] != .null,
                  let log = v["log"]?.arrayValue, log.count <= 128 else { return false }
            for e in log {
                guard let object = e.objectValue, Set(object.keys).isSubset(of: ["at", "quote", "plan", "measures"]),
                      text(e["at"], 64, required: true), text(e["quote"], 200, required: true),
                      object["plan"] == nil || e["plan"]?.boolValue != nil else { return false }
                if let figures = object["measures"] {
                    guard e["plan"] != .bool(true), let values = figures.arrayValue, values.count <= 8, values.allSatisfy(measure),
                          Set(values.compactMap { $0["name"]?.stringValue }).count == values.count else { return false }
                }
            }
            return true
        }
        guard type == "commitment" else { return false }
        switch key {
        case "title": return text(v, 200, required: true)
        case "note": return text(v, 20000)
        case "outcome": return v == .null || text(v, 2000)
        case "parent": return v == .null || id(v)
        case "waitingOn": return v == .null || exact(v, ["who", "since"]) && text(v["who"], 80, required: true) && date(v["since"])
        case "created":
            guard exact(v, ["at", "origin", "shape"]), text(v["at"], 64, required: true), v["shape"] == .null || oneOf(v["shape"], ["task", "goal"]),
                  let origin = v["origin"]?.objectValue, Set(origin.keys).isSubset(of: ["kind", "ref"]),
                  oneOf(origin["kind"], ["you", "chat", "email", "text", "matter", "apple", "news"]) else { return false }
            return origin["ref"] == nil || origin["ref"] == .null || text(origin["ref"], 2000)
        case "lifecycle":
            guard exact(v, ["state", "doneAt"]), oneOf(v["state"], ["open", "done", "dropped"]) else { return false }
            return v["state"] == .string("open") ? v["doneAt"] == .null : text(v["doneAt"], 64, required: true)
        case "goal":
            guard exact(v, ["domain", "aim"]), v["domain"] == .null || oneOf(v["domain"], ["fitness", "health", "money", "parenting", "learning"]) else { return false }
            if v["aim"] == .null { return true }
            guard let a = v["aim"], let object = a.objectValue, Set(object.keys).isSubset(of: ["measure", "target", "unit", "dir", "from"]),
                  let name = a["measure"], let target = a["target"], let unit = a["unit"], oneOf(a["dir"], ["up", "down"]),
                  measure(.object(["name": name, "value": target, "unit": unit])) else { return false }
            guard let from = object["from"] else { return true }
            guard exact(from, ["value", "day"]), date(from["day"]), let value = from["value"] else { return false }
            return measure(.object(["name": name, "value": value, "unit": unit]))
        case "schedule":
            guard exact(v, ["when", "by", "repeat", "until", "remind"]), let when = v["when"], let rule = v["repeat"]?["rule"]?.stringValue,
                  exact(v["repeat"], ["rule", "days"]), ["none", "daily", "weekdays", "weekly", "monthly", "yearly", "custom"].contains(rule),
                  list(v["repeat"]?["days"], 6), v["by"] == .null || date(v["by"]), v["until"] == .null || date(v["until"]) else { return false }
            if when != .null {
                guard exact(when, ["date", "time", "end"]), when["date"] == .null || date(when["date"]),
                      let time = when["time"], let end = when["end"], timePair(.object(["time": time, "end": end])) else { return false }
            }
            let days = v["repeat"]!["days"]!.arrayValue!
            guard ["weekly", "custom"].contains(rule) ? !days.isEmpty : days.isEmpty else { return false }
            if let until = v["until"]?.stringValue {
                if rule == "none" { return false }
                if let start = when["date"]?.stringValue, until < start { return false }
            }
            if v["remind"] == .null { return true }
            guard exact(v["remind"], ["minutesBefore", "daysBefore"]), list(v["remind"]?["daysBefore"], 60) else { return false }
            if v["remind"]?["minutesBefore"] == .null { return true }
            guard let minutes = v["remind"]?["minutesBefore"]?.numberValue else { return false }
            return minutes.isFinite && minutes >= 0 && minutes <= 10080
        default: return false
        }
    }
}
