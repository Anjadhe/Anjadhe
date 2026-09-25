import Foundation

/// The rules behind the phone's simple home — pure, so they can be tested
/// and so the screen stays a rendering of them rather than a second place
/// where they live. The desktop shell (`js/core/simple-experience.js`,
/// docs/SIMPLE_EXPERIENCE.md) is the reference; each rule below says where
/// it follows the Mac and where the phone deliberately differs.
public enum SimpleHome {

    // MARK: On your radar — the next timed things, from SYNCED data only

    public struct RadarRow: Equatable {
        /// `event` opens Calendar, `tasks` opens Tasks.
        public let kind: String
        public let title: String
        public let meta: String
    }

    /// The next two timed calendar events inside 24 hours, then overdue and
    /// today's task counts — the Mac's `dayAhead`, over the blobs the phone
    /// already syncs, so it renders instantly and works with the Mac asleep.
    ///
    /// Deliberately excludes all-day events (they are not a "next thing"),
    /// cancelled ones, and events the Mac derived FROM tasks (`source ==
    /// "schedule"`) — those would double-count against the task rows below.
    ///
    /// Unlike the Mac it does NOT also filter by connected account: the
    /// phone has no account list, and its own Calendar screen shows whatever
    /// is in the blob, so filtering here would make the two disagree.
    public static func radar(events: [JSONValue], tasks: [JSONValue],
                             now: Date = Date(), cal: Calendar = .current) -> [RadarRow] {
        var rows: [RadarRow] = []
        let horizon = now.addingTimeInterval(24 * 60 * 60)

        let upcoming = events.compactMap { ev -> (Date, JSONValue)? in
            guard ev["allDay"]?.boolValue != true,
                  ev["status"]?.stringValue != "cancelled",
                  ev["source"]?.stringValue != "schedule",
                  let startISO = ev["start"]?.stringValue,
                  let start = DateLogic.parseISO(startISO) else { return nil }
            // The horizon check first, so a calendar full of future events
            // pays ONE date parse each rather than two — parsing ISO-8601 is
            // the most expensive thing this function does.
            guard start < horizon else { return nil }
            // Still relevant if it is running now: end (or start) is ahead.
            let end = ev["end"]?.stringValue.flatMap { DateLogic.parseISO($0) } ?? start
            guard end > now else { return nil }
            return (start, ev)
        }.sorted { $0.0 < $1.0 }

        for (start, ev) in upcoming.prefix(2) {
            // Google and Apple events both land as `summary` (the Calendar
            // screen reads the same field); `title` is only a fallback for
            // anything hand-written.
            rows.append(RadarRow(kind: "event",
                                 title: ev["summary"]?.stringValue ?? ev["title"]?.stringValue ?? "Upcoming event",
                                 meta: whenLabel(start, now: now, cal: cal)))
        }

        var overdue: [JSONValue] = [], today: [JSONValue] = []
        let todayStr = DateLogic.todayStr(now, cal)
        for t in tasks {
            if ScheduleLogic.isOneTime(t) && ScheduleLogic.taskResolved(t) { continue }
            if ScheduleLogic.taskDueToday(t, today: now, cal: cal) {
                if !ScheduleLogic.taskDoneToday(t, today: now, cal: cal) { today.append(t) }
            } else if ScheduleLogic.isOneTime(t) {
                let due = t["scheduledDate"]?.stringValue ?? ""
                if !due.isEmpty && due < todayStr { overdue.append(t) }
            }
        }
        if !overdue.isEmpty {
            rows.append(RadarRow(kind: "tasks",
                                 title: "\(overdue.count) overdue task\(overdue.count == 1 ? "" : "s")",
                                 meta: titlePreview(overdue)))
        }
        if !today.isEmpty {
            rows.append(RadarRow(kind: "tasks",
                                 title: "\(today.count) task\(today.count == 1 ? "" : "s") for today",
                                 meta: titlePreview(today)))
        }
        return rows
    }

    /// "Happening now" / "In 25 min" / "Thu · 9:00 AM" — the Mac's wording.
    static func whenLabel(_ start: Date, now: Date, cal: Calendar) -> String {
        if start <= now { return "Happening now" }
        let minutes = max(1, Int(ceil(start.timeIntervalSince(now) / 60)))
        if minutes < 60 { return "In \(minutes) min" }
        let day = DateFormatter(); day.calendar = cal; day.setLocalizedDateFormatFromTemplate("EEE")
        let time = DateFormatter(); time.calendar = cal; time.setLocalizedDateFormatFromTemplate("jmm")
        return day.string(from: start) + " · " + time.string(from: start)
    }

    private static func titlePreview(_ tasks: [JSONValue]) -> String {
        tasks.prefix(2).map { $0["title"]?.stringValue ?? "Untitled" }.joined(separator: " · ")
    }

    // MARK: From your routines — what the app did on its own

    public struct RoutineUpdate: Equatable, Identifiable {
        public let id: String        // the post's note id
        public let title: String     // the routine's name
        public let stamp: String     // the post's createdAt, for the row's "when"
        public let failed: Bool
        /// The post's own body, for the screen to preview. Nothing here
        /// writes a sentence ABOUT a post — see the note on the Mac's
        /// `_summaryFor` in docs/SIMPLE_EXPERIENCE.md.
        public let content: String
    }

    /// One row per routine, newest UNREAD edition only, capped.
    ///
    /// The posts are notes carrying a `feed` object — `{promptId, readAt,
    /// error}` — exactly as the Mac writes them. (The phone's Feed screen
    /// read `promptFeed.items` instead, a field that is always empty; that
    /// is why it showed nothing.)
    ///
    /// Unread is the whole lifecycle, as on the Mac: a quiet run posts
    /// nothing so it can never appear here, opening a row marks it read and
    /// the section then stops rendering. A failed run stays, because it
    /// cannot be read — only cleared.
    public static func routineUpdates(notes: [JSONValue], limit: Int = 3) -> [RoutineUpdate] {
        var newestPerRoutine: [String: (stamp: String, update: RoutineUpdate)] = [:]
        for n in notes {
            guard let feed = n["feed"]?.objectValue else { continue }
            guard feed["readAt"]?.stringValue?.isEmpty ?? true else { continue } // already read
            guard let id = n["id"]?.stringValue else { continue }
            let routine = feed["promptId"]?.stringValue ?? id
            let stamp = n["createdAt"]?.stringValue ?? n["modifiedAt"]?.stringValue ?? ""
            let failed = !(feed["error"]?.stringValue?.isEmpty ?? true)
            if let held = newestPerRoutine[routine], held.stamp >= stamp { continue }
            newestPerRoutine[routine] = (stamp, RoutineUpdate(
                id: id,
                title: n["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "A routine",
                stamp: stamp,
                failed: failed,
                content: n["content"]?.stringValue ?? ""))
        }
        return newestPerRoutine.values
            .sorted { $0.stamp > $1.stamp }
            .prefix(limit)
            .map { $0.update }
    }

    // MARK: Log journal

    /// More than two days since the last entry — `AppManager.journalNudgeDue`.
    /// With no entries at all the phone says nothing: the Mac anchors on a
    /// stored first-seen stamp, and inventing one here would nag a phone
    /// whose journal simply has not synced yet.
    public static func journalNudgeDue(entries: [JSONValue], now: Date = Date()) -> Bool {
        var newest = ""
        for e in entries {
            let d = e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? ""
            if d > newest { newest = d }
        }
        guard !newest.isEmpty, let last = DateLogic.parseISO(newest) else { return false }
        return now.timeIntervalSince(last) / 86_400 > 2
    }
}
