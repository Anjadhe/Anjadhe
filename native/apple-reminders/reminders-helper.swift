// Apple Reminders helper — the EventKit side of the iCloud Reminders import.
//
// Compiled on demand by main.js (apple-reminders IPC handlers) with swiftc and
// cached under userData; a packaged build may ship a prebuilt binary in
// resources instead. Spoken protocol: one JSON object on stdout, exit 0; any
// failure is a JSON {"error": ...} so the renderer never parses free text.
//
// Why a helper at all: Electron cannot call EventKit from JS, and the
// AppleScript route was measured at 3+ minutes for a 1,500-reminder store
// (its `whose` filter re-resolves per property). EventKit does the same
// fetch in under half a second.
//
// Commands:
//   status  — report the Reminders TCC authorization state without prompting
//   fetch   — request Reminders access (prompts once), then print reminder
//             lists, every incomplete reminder, and reminders completed in
//             the last 30 days (the completion-mirror window)
//   events  — request Calendars access (its own TCC class), then print
//             expanded event occurrences from iCloud + local calendar
//             sources only. Google-source calendars on this Mac are
//             deliberately excluded: the app syncs Google Calendar itself,
//             and importing the Mac's copy would double every event.
//             Optional args: daysBack daysAhead (defaults 45 / 120,
//             bracketing the app's own Google sync window).
//   event-create / event-update / event-delete (2026-09-09) — write-through
//             to the same iCloud + local calendars. ONE JSON object on
//             stdin: {calendarId, title, notes, location, allDay, start,
//             end, rrule} to create; plus {externalId, occurrenceStart,
//             span: "this" | "future" | "all"} to update or delete an
//             existing occurrence (EKSpan does this/following natively;
//             "all" edits the series master). For span "all" the app sends
//             startClock/endClock ("HH:MM") instead of dates — the clock
//             travels to the whole series, a date never does (the same rule
//             as the app's Google path). Dates: "YYYY-MM-DD" is a local
//             day, a naive "YYYY-MM-DDTHH:MM[:SS]" is local wall-clock, a
//             full ISO-8601 string with Z/offset is absolute. Reply:
//             {ok: true, externalId, eventId, occurrenceStart} or {error}.
//
// Identity: calendarItemExternalIdentifier is stable across devices for
// iCloud reminders (verified against the AppleScript x-apple-reminder://
// UUID), which is what makes cross-Mac dedup by sourceReminderId safe.
// The same identifier anchors event occurrence keys (externalId + start).

import EventKit
import Foundation

func emit(_ obj: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"json encode failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fetch"

if command == "status" {
    let s = EKEventStore.authorizationStatus(for: .reminder)
    let name: String
    switch s {
    case .notDetermined: name = "notDetermined"
    case .restricted: name = "restricted"
    case .denied: name = "denied"
    case .fullAccess: name = "authorized"
    case .writeOnly: name = "writeOnly"
    @unknown default: name = "unknown"
    }
    emit(["status": name, "authorized": name == "authorized"])
}

if command == "events" {
    let store = EKEventStore()
    authorizeEvents(store)

    let daysBack = CommandLine.arguments.count > 2 ? (Int(CommandLine.arguments[2]) ?? 45) : 45
    let daysAhead = CommandLine.arguments.count > 3 ? (Int(CommandLine.arguments[3]) ?? 120) : 120
    let start = Date().addingTimeInterval(-Double(daysBack) * 86400)
    let end = Date().addingTimeInterval(Double(daysAhead) * 86400)

    func hex(_ cg: CGColor?) -> String {
        guard let comps = cg?.components, comps.count >= 3 else { return "" }
        let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
        return String(format: "#%02x%02x%02x", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }

    let cals = mirroredCalendars(store)
    guard !cals.isEmpty else {
        emit(["calendars": [], "events": [], "note": "no iCloud or local calendars on this Mac"])
    }

    let iso = ISO8601DateFormatter()
    let calRows = cals.map { [
        "id": $0.calendarIdentifier,
        "title": $0.title,
        "color": hex($0.cgColor),
        // Subscribed / holiday / shared-read-only calendars refuse writes;
        // the app hides Edit/Delete and the calendar picker entry for them.
        "writable": $0.allowsContentModifications,
    ] }

    // predicateForEvents expands recurring events into occurrences — the
    // same shape the app's Google sync stores (singleEvents=true).
    let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: cals))
    let rows: [[String: Any]] = events.compactMap { e in
        if e.status == .canceled { return nil }
        return [
            "externalId": e.calendarItemExternalIdentifier ?? "",
            "eventId": e.eventIdentifier ?? "",
            "title": e.title ?? "",
            "notes": String((e.notes ?? "").prefix(4000)),
            "location": e.location ?? "",
            "start": e.startDate.map { iso.string(from: $0) } ?? "",
            "end": e.endDate.map { iso.string(from: $0) } ?? "",
            "allDay": e.isAllDay,
            "calendarId": e.calendar?.calendarIdentifier ?? "",
            "calendarTitle": e.calendar?.title ?? "",
            // The series shape, so the app can offer this/following/all and
            // show a "Repeats" row without a second round trip.
            "hasRecurrence": e.hasRecurrenceRules,
            "rrule": rruleString(e.recurrenceRules?.first),
            "isDetached": e.isDetached,
        ]
    }
    emit(["calendars": calRows, "events": rows])
}

// ── Calendar write-through (2026-09-09) ─────────────────────────────────

/// iCloud + local calendar sources only — the same set `events` mirrors, so
/// a write can never land in a Google-source calendar the app syncs itself.
func mirroredCalendars(_ store: EKEventStore) -> [EKCalendar] {
    return store.calendars(for: .event).filter { cal in
        let src = cal.source
        if src?.sourceType == .local { return true }
        if src?.sourceType == .calDAV && (src?.title ?? "").lowercased().contains("icloud") { return true }
        return false
    }
}

/// Best-effort RFC 5545 text for a rule, in the vocabulary the app's
/// Repeat presets and its `_humanRecurrence` already speak.
func rruleString(_ rule: EKRecurrenceRule?) -> String {
    guard let rule = rule else { return "" }
    var parts: [String] = []
    switch rule.frequency {
    case .daily: parts.append("FREQ=DAILY")
    case .weekly: parts.append("FREQ=WEEKLY")
    case .monthly: parts.append("FREQ=MONTHLY")
    case .yearly: parts.append("FREQ=YEARLY")
    @unknown default: return ""
    }
    if rule.interval > 1 { parts.append("INTERVAL=\(rule.interval)") }
    if rule.frequency == .weekly, let days = rule.daysOfTheWeek, !days.isEmpty {
        let names = ["", "SU", "MO", "TU", "WE", "TH", "FR", "SA"]
        let byday = days.map { names[$0.dayOfTheWeek.rawValue] }.filter { !$0.isEmpty }
        if !byday.isEmpty { parts.append("BYDAY=" + byday.joined(separator: ",")) }
    }
    if let end = rule.recurrenceEnd {
        if let until = end.endDate {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyyMMdd"
            parts.append("UNTIL=" + f.string(from: until))
        } else if end.occurrenceCount > 0 {
            parts.append("COUNT=\(end.occurrenceCount)")
        }
    }
    return "RRULE:" + parts.joined(separator: ";")
}

/// The inverse: the app's presets (FREQ / INTERVAL / BYDAY / COUNT / UNTIL).
/// Anything else is rejected rather than approximated — never write a rule
/// the user did not ask for.
func parseRrule(_ text: String) -> (EKRecurrenceRule?, String?) {
    var body = text
    if body.hasPrefix("RRULE:") { body = String(body.dropFirst(6)) }
    var freq: EKRecurrenceFrequency? = nil
    var interval = 1
    var days: [EKRecurrenceDayOfWeek] = []
    var end: EKRecurrenceEnd? = nil
    for part in body.split(separator: ";") {
        let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
        guard kv.count == 2 else { continue }
        switch kv[0] {
        case "FREQ":
            switch kv[1] {
            case "DAILY": freq = .daily
            case "WEEKLY": freq = .weekly
            case "MONTHLY": freq = .monthly
            case "YEARLY": freq = .yearly
            default: return (nil, "unsupported FREQ \(kv[1])")
            }
        case "INTERVAL": interval = max(1, Int(kv[1]) ?? 1)
        case "BYDAY":
            let map: [String: EKWeekday] = ["SU": .sunday, "MO": .monday, "TU": .tuesday, "WE": .wednesday, "TH": .thursday, "FR": .friday, "SA": .saturday]
            for d in kv[1].split(separator: ",") {
                guard let wd = map[String(d)] else { return (nil, "unsupported BYDAY \(d)") }
                days.append(EKRecurrenceDayOfWeek(wd))
            }
        case "COUNT": if let n = Int(kv[1]), n > 0 { end = EKRecurrenceEnd(occurrenceCount: n) }
        case "UNTIL":
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyyMMdd"
            if let d = f.date(from: String(kv[1].prefix(8))) { end = EKRecurrenceEnd(end: d) }
        default: return (nil, "unsupported rule part \(kv[0])")
        }
    }
    guard let f = freq else { return (nil, "rule has no FREQ") }
    return (EKRecurrenceRule(recurrenceWith: f, interval: interval, daysOfTheWeek: days.isEmpty ? nil : days, daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end), nil)
}

/// "YYYY-MM-DD" → local midnight; naive "YYYY-MM-DDTHH:MM[:SS]" → local
/// wall-clock; anything with Z or an offset → absolute.
func parseDate(_ raw: String) -> Date? {
    let s = raw.trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return nil }
    let posix = Locale(identifier: "en_US_POSIX")
    if s.count == 10 {
        let f = DateFormatter(); f.locale = posix; f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone.current
        return f.date(from: s)
    }
    let hasZone = s.hasSuffix("Z") || s.range(of: "[+-]\\d{2}:?\\d{2}$", options: .regularExpression) != nil
    if hasZone {
        let iso = ISO8601DateFormatter()
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: s)
    }
    for fmt in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
        let f = DateFormatter(); f.locale = posix; f.dateFormat = fmt; f.timeZone = TimeZone.current
        if let d = f.date(from: s) { return d }
    }
    return nil
}

func readInput() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
}

func authorizeEvents(_ store: EKEventStore) {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var authError: String? = nil
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { g, err in
            granted = g
            if let err = err { authError = String(describing: err) }
            sem.signal()
        }
    } else {
        store.requestAccess(to: .event) { g, err in
            granted = g
            if let err = err { authError = String(describing: err) }
            sem.signal()
        }
    }
    sem.wait()
    guard granted else {
        emit(["error": "access-denied", "detail": authError ?? ""])
    }
}

/// The occurrence the app is looking at: same external id, same start.
/// A recurring event's occurrences all share the identifier, so the start
/// is what tells them apart; the ±1s window absorbs formatter rounding.
func findOccurrence(_ store: EKEventStore, externalId: String, occurrenceStart: String) -> EKEvent? {
    guard !externalId.isEmpty, let start = parseDate(occurrenceStart) else { return nil }
    let pred = store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: start.addingTimeInterval(1), calendars: nil)
    return store.events(matching: pred).first {
        $0.calendarItemExternalIdentifier == externalId && abs($0.startDate.timeIntervalSince(start)) < 1
    }
}

func spanFrom(_ input: [String: Any]) -> EKSpan {
    return ((input["span"] as? String) ?? "this") == "this" ? .thisEvent : .futureEvents
}

/// Apply the payload's fields to an event. Only keys present change.
func applyFields(_ e: EKEvent, _ input: [String: Any], _ store: EKEventStore) -> String? {
    if let calId = input["calendarId"] as? String, !calId.isEmpty, e.calendar?.calendarIdentifier != calId {
        guard let cal = mirroredCalendars(store).first(where: { $0.calendarIdentifier == calId }) else {
            return "calendar not found (only this Mac's iCloud and local calendars can be written)"
        }
        e.calendar = cal
    }
    if let t = input["title"] as? String { e.title = t }
    if let n = input["notes"] as? String { e.notes = n.isEmpty ? nil : n }
    if let l = input["location"] as? String { e.location = l.isEmpty ? nil : l }
    if let allDay = input["allDay"] as? Bool { e.isAllDay = allDay }
    if let s = input["start"] as? String, !s.isEmpty {
        guard let d = parseDate(s) else { return "bad start \(s)" }
        e.startDate = d
    }
    if let en = input["end"] as? String, !en.isEmpty {
        guard var d = parseDate(en) else { return "bad end \(en)" }
        // The app speaks Google's all-day shape (exclusive next-day end);
        // EventKit wants the end inside the last day.
        if e.isAllDay && en.count == 10 { d = d.addingTimeInterval(-1) }
        e.endDate = d
    }
    // Series-wide clock edit: the time travels, the date stays.
    let cal = Calendar.current
    if let sc = input["startClock"] as? String, let (h, m) = clock(sc), !e.isAllDay {
        e.startDate = cal.date(bySettingHour: h, minute: m, second: 0, of: e.startDate) ?? e.startDate
    }
    if let ec = input["endClock"] as? String, let (h, m) = clock(ec), !e.isAllDay {
        var end = cal.date(bySettingHour: h, minute: m, second: 0, of: e.startDate) ?? e.endDate!
        if end <= e.startDate { end = cal.date(byAdding: .day, value: 1, to: end) ?? end }
        e.endDate = end
    }
    if e.isAllDay {
        e.startDate = cal.startOfDay(for: e.startDate)
        if e.endDate <= e.startDate { e.endDate = cal.date(byAdding: .day, value: 1, to: e.startDate)!.addingTimeInterval(-1) }
    } else if e.endDate <= e.startDate {
        return "end must be after start"
    }
    if input.keys.contains("rrule") {
        let text = (input["rrule"] as? String) ?? ""
        if text.isEmpty {
            e.recurrenceRules = nil
        } else {
            let (rule, err) = parseRrule(text)
            if let err = err { return err }
            e.recurrenceRules = rule.map { [$0] }
        }
    }
    return nil
}

func clock(_ s: String) -> (Int, Int)? {
    let p = s.split(separator: ":").compactMap { Int($0) }
    guard p.count >= 2, (0...23).contains(p[0]), (0...59).contains(p[1]) else { return nil }
    return (p[0], p[1])
}

func writeReply(_ e: EKEvent) -> Never {
    let iso = ISO8601DateFormatter()
    emit([
        "ok": true,
        "externalId": e.calendarItemExternalIdentifier ?? "",
        "eventId": e.eventIdentifier ?? "",
        "occurrenceStart": iso.string(from: e.startDate),
    ])
}

if command == "event-create" {
    let store = EKEventStore()
    authorizeEvents(store)
    let input = readInput()
    guard let calId = input["calendarId"] as? String, !calId.isEmpty else { emit(["error": "calendarId is required"]) }
    guard let cal = mirroredCalendars(store).first(where: { $0.calendarIdentifier == calId }) else {
        emit(["error": "calendar not found (only this Mac's iCloud and local calendars can be written)"])
    }
    guard cal.allowsContentModifications else { emit(["error": "\(cal.title) is a read-only calendar"]) }
    let e = EKEvent(eventStore: store)
    e.calendar = cal
    e.timeZone = TimeZone.current
    guard let s = input["start"] as? String, let start = parseDate(s) else { emit(["error": "start is required"]) }
    e.startDate = start
    e.endDate = start.addingTimeInterval(3600)
    var fields = input
    fields.removeValue(forKey: "calendarId")
    if let err = applyFields(e, fields, store) { emit(["error": err]) }
    if (e.title ?? "").isEmpty { emit(["error": "title is required"]) }
    do { try store.save(e, span: .thisEvent, commit: true) } catch { emit(["error": "save failed: \(error.localizedDescription)"]) }
    writeReply(e)
}

if command == "event-update" || command == "event-delete" {
    let store = EKEventStore()
    authorizeEvents(store)
    let input = readInput()
    let externalId = (input["externalId"] as? String) ?? ""
    let occ = (input["occurrenceStart"] as? String) ?? ""
    guard var e = findOccurrence(store, externalId: externalId, occurrenceStart: occ) else {
        emit(["error": "event not found — it may have moved or been deleted in Apple Calendar; the mirror refreshes within a minute"])
    }
    guard e.calendar?.allowsContentModifications ?? false else {
        emit(["error": "\(e.calendar?.title ?? "This calendar") is a read-only calendar"])
    }
    let spanName = (input["span"] as? String) ?? "this"
    var span = spanFrom(input)
    if spanName == "all" && e.hasRecurrenceRules {
        // The series master is the first occurrence; futureEvents from
        // there is the whole series.
        if let id = e.eventIdentifier, let master = store.event(withIdentifier: id) { e = master }
        span = .futureEvents
    }
    if command == "event-delete" {
        do { try store.remove(e, span: span, commit: true) } catch { emit(["error": "delete failed: \(error.localizedDescription)"]) }
        emit(["ok": true, "externalId": externalId])
    }
    if let err = applyFields(e, input, store) { emit(["error": err]) }
    do { try store.save(e, span: span, commit: true) } catch { emit(["error": "save failed: \(error.localizedDescription)"]) }
    writeReply(e)
}

guard command == "fetch" else {
    emit(["error": "unknown command: \(command)"])
}

let store = EKEventStore()
let authSem = DispatchSemaphore(value: 0)
var granted = false
var authError: String? = nil
if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { g, err in
        granted = g
        if let err = err { authError = String(describing: err) }
        authSem.signal()
    }
} else {
    store.requestAccess(to: .reminder) { g, err in
        granted = g
        if let err = err { authError = String(describing: err) }
        authSem.signal()
    }
}
authSem.wait()
guard granted else {
    emit(["error": "access-denied", "detail": authError ?? ""])
}

let iso = ISO8601DateFormatter()

func row(_ r: EKReminder) -> [String: Any] {
    var due = ""
    var hasTime = false
    if let comps = r.dueDateComponents {
        hasTime = comps.hour != nil
        if let d = Calendar.current.date(from: comps) { due = iso.string(from: d) }
    }
    var out: [String: Any] = [
        "externalId": r.calendarItemExternalIdentifier ?? "",
        "title": r.title ?? "",
        "notes": r.notes ?? "",
        "list": r.calendar?.title ?? "",
        "due": due,
        "hasTime": hasTime,
        "completed": r.isCompleted,
        "completionDate": r.completionDate.map { iso.string(from: $0) } ?? "",
        "lastModified": r.lastModifiedDate.map { iso.string(from: $0) } ?? "",
        "priority": r.priority,
    ]
    // Recurrence, flattened for the renderer's mapper: freq/interval/days
    // plus honesty flags for the shapes the app's repeat model can't say
    // (an end date, by-month-day sets, positional rules). The mapper falls
    // back to a one-time task for those rather than inventing occurrences.
    if let rule = r.recurrenceRules?.first {
        var rec: [String: Any] = ["interval": rule.interval]
        switch rule.frequency {
        case .daily: rec["freq"] = "daily"
        case .weekly: rec["freq"] = "weekly"
        case .monthly: rec["freq"] = "monthly"
        case .yearly: rec["freq"] = "yearly"
        @unknown default: rec["freq"] = "other"
        }
        // EKWeekday raw 1=Sunday … 7=Saturday → JS getDay() 0…6.
        rec["days"] = (rule.daysOfTheWeek ?? []).map { $0.dayOfTheWeek.rawValue - 1 }
        rec["hasEnd"] = rule.recurrenceEnd != nil
        rec["complex"] = (rule.daysOfTheMonth?.count ?? 0) > 1
            || (rule.monthsOfTheYear?.count ?? 0) > 1
            || (rule.setPositions?.count ?? 0) > 0
            || (rule.daysOfTheYear?.count ?? 0) > 0
            || (r.recurrenceRules?.count ?? 0) > 1
        out["recurrence"] = rec
    }
    return out
}

func fetch(_ predicate: NSPredicate) -> [EKReminder] {
    var out: [EKReminder] = []
    let sem = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: predicate) { rems in
        out = rems ?? []
        sem.signal()
    }
    sem.wait()
    return out
}

let lists = store.calendars(for: .reminder).map { ["title": $0.title, "id": $0.calendarIdentifier] }

let incomplete = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil))

// Recently completed: the renderer mirrors completion onto tasks it already
// imported. 30 days is plenty — anything older either mirrored long ago or
// predates the import entirely.
let since = Date().addingTimeInterval(-30 * 24 * 3600)
let done = fetch(store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: nil, calendars: nil))

emit([
    "lists": lists,
    "reminders": (incomplete + done).map(row),
    "incompleteCount": incomplete.count,
    "completedCount": done.count,
])
