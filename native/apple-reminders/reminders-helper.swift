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

    let daysBack = CommandLine.arguments.count > 2 ? (Int(CommandLine.arguments[2]) ?? 45) : 45
    let daysAhead = CommandLine.arguments.count > 3 ? (Int(CommandLine.arguments[3]) ?? 120) : 120
    let start = Date().addingTimeInterval(-Double(daysBack) * 86400)
    let end = Date().addingTimeInterval(Double(daysAhead) * 86400)

    func hex(_ cg: CGColor?) -> String {
        guard let comps = cg?.components, comps.count >= 3 else { return "" }
        let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
        return String(format: "#%02x%02x%02x", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }

    let cals = store.calendars(for: .event).filter { cal in
        let src = cal.source
        if src?.sourceType == .local { return true }
        if src?.sourceType == .calDAV && (src?.title ?? "").lowercased().contains("icloud") { return true }
        return false
    }
    guard !cals.isEmpty else {
        emit(["calendars": [], "events": [], "note": "no iCloud or local calendars on this Mac"])
    }

    let iso = ISO8601DateFormatter()
    let calRows = cals.map { [
        "id": $0.calendarIdentifier,
        "title": $0.title,
        "color": hex($0.cgColor),
    ] }

    // predicateForEvents expands recurring events into occurrences — the
    // same shape the app's Google sync stores (singleEvents=true).
    let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: cals))
    let rows: [[String: Any]] = events.compactMap { e in
        if e.status == .canceled { return nil }
        return [
            "externalId": e.calendarItemExternalIdentifier ?? "",
            "title": e.title ?? "",
            "notes": String((e.notes ?? "").prefix(4000)),
            "location": e.location ?? "",
            "start": e.startDate.map { iso.string(from: $0) } ?? "",
            "end": e.endDate.map { iso.string(from: $0) } ?? "",
            "allDay": e.isAllDay,
            "calendarId": e.calendar?.calendarIdentifier ?? "",
            "calendarTitle": e.calendar?.title ?? "",
        ]
    }
    emit(["calendars": calRows, "events": rows])
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
