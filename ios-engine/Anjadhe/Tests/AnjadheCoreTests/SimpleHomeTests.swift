import XCTest
@testable import AnjadheCore

/// The simple home's rules. They decide what the phone's front page says,
/// so a mistake is either a missing thing that wanted the user, or a nag
/// that shouldn't be there.
final class SimpleHomeTests: XCTestCase {
    private let cal = Calendar(identifier: .gregorian)
    private let now = ISO8601DateFormatter().date(from: "2026-09-20T09:00:00Z")!

    private func iso(_ offsetMinutes: Int) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: now.addingTimeInterval(TimeInterval(offsetMinutes * 60)))
    }
    private func event(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }
    private func task(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }
    private func today() -> String { DateLogic.todayStr(now, cal) }
    private func daysAgo(_ n: Int) -> String {
        DateLogic.dateStr(now.addingTimeInterval(TimeInterval(-n * 86400)), cal)
    }

    // MARK: On your radar

    func testShowsTheNextTwoTimedEvents() {
        let events = [
            event(["title": .string("Standup"), "start": .string(iso(30)), "end": .string(iso(45))]),
            event(["title": .string("Review"), "start": .string(iso(120)), "end": .string(iso(180))]),
            event(["title": .string("Third"), "start": .string(iso(200)), "end": .string(iso(260))]),
        ]
        let rows = SimpleHome.radar(events: events, tasks: [], now: now, cal: cal)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].title, "Standup")
        XCTAssertEqual(rows[0].meta, "In 30 min")
        XCTAssertEqual(rows[1].title, "Review")
    }

    func testAnEventUnderWayIsStillShown() {
        let events = [event(["title": .string("Long meeting"), "start": .string(iso(-30)), "end": .string(iso(30))])]
        let rows = SimpleHome.radar(events: events, tasks: [], now: now, cal: cal)
        XCTAssertEqual(rows.first?.meta, "Happening now")
    }

    func testEventsThatAreNotTheNextThingAreExcluded() {
        let events = [
            event(["title": .string("All day"), "start": .string(iso(60)), "allDay": .bool(true)]),
            event(["title": .string("Cancelled"), "start": .string(iso(60)), "status": .string("cancelled")]),
            // Derived from a task — it would double-count against the task rows.
            event(["title": .string("From a task"), "start": .string(iso(60)), "source": .string("schedule")]),
            event(["title": .string("Tomorrow night"), "start": .string(iso(60 * 30))]),
            event(["title": .string("Already over"), "start": .string(iso(-120)), "end": .string(iso(-60))]),
        ]
        XCTAssertTrue(SimpleHome.radar(events: events, tasks: [], now: now, cal: cal).isEmpty)
    }

    func testCountsOverdueAndTodaysTasks() {
        let tasks = [
            task(["id": .string("a"), "title": .string("Pay invoice"), "repeat": .string("none"), "scheduledDate": .string(daysAgo(3))]),
            task(["id": .string("b"), "title": .string("Call bank"), "repeat": .string("none"), "scheduledDate": .string(daysAgo(1))]),
            task(["id": .string("c"), "title": .string("Write notes"), "repeat": .string("none"), "scheduledDate": .string(today())]),
            // Done today, and a finished one-off: neither wants you now.
            task(["id": .string("d"), "title": .string("Done"), "repeat": .string("none"),
                  "scheduledDate": .string(today()), "lastCompletedDate": .string(today())]),
            task(["id": .string("e"), "title": .string("Old done"), "repeat": .string("none"),
                  "scheduledDate": .string(daysAgo(5)), "lastCompletedDate": .string(daysAgo(5))]),
        ]
        let rows = SimpleHome.radar(events: [], tasks: tasks, now: now, cal: cal)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].title, "2 overdue tasks")
        XCTAssertEqual(rows[0].meta, "Pay invoice · Call bank")
        XCTAssertEqual(rows[1].title, "1 task for today")
        XCTAssertEqual(rows[1].kind, "tasks")
    }

    func testNothingToSayRendersNothing() {
        XCTAssertTrue(SimpleHome.radar(events: [], tasks: [], now: now, cal: cal).isEmpty)
    }

    // MARK: From your routines

    private func post(_ id: String, routine: String, at: String, read: String? = nil,
                      error: String? = nil, title: String = "A routine") -> JSONValue {
        var feed: [String: JSONValue] = ["promptId": .string(routine)]
        if let read = read { feed["readAt"] = .string(read) }
        if let error = error { feed["error"] = .string(error) }
        return .object(["id": .string(id), "title": .string(title), "createdAt": .string(at),
                        "content": .string("<p>the post</p>"), "feed": .object(feed)])
    }

    func testOneRowPerRoutineNewestFirst() {
        let notes = [
            post("p1", routine: "r1", at: "2026-09-20T07:00:00Z", title: "Morning news"),
            post("p2", routine: "r1", at: "2026-09-19T07:00:00Z", title: "Morning news"),
            post("p3", routine: "r2", at: "2026-09-20T08:00:00Z", title: "Market review"),
            .object(["id": .string("plain"), "title": .string("An ordinary note")]), // not a post
        ]
        let rows = SimpleHome.routineUpdates(notes: notes)
        XCTAssertEqual(rows.map(\.id), ["p3", "p1"], "newest first, one per routine")
        XCTAssertEqual(rows[0].title, "Market review")
    }

    func testReadPostsDoNotAppear() {
        let notes = [
            post("p1", routine: "r1", at: "2026-09-20T07:00:00Z", read: "2026-09-20T08:00:00Z"),
            post("p2", routine: "r2", at: "2026-09-20T07:30:00Z"),
        ]
        XCTAssertEqual(SimpleHome.routineUpdates(notes: notes).map(\.id), ["p2"])
    }

    /// A run that failed can't be read, only cleared — so it stays.
    func testAFailedRunIsKeptAndMarked() {
        let rows = SimpleHome.routineUpdates(notes: [post("p1", routine: "r1", at: "2026-09-20T07:00:00Z", error: "model unreachable")])
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].failed)
    }

    func testTheListIsCapped() {
        let notes = (0..<10).map { post("p\($0)", routine: "r\($0)", at: "2026-09-2\($0 % 10)T07:00:00Z") }
        XCTAssertEqual(SimpleHome.routineUpdates(notes: notes).count, 3)
        XCTAssertEqual(SimpleHome.routineUpdates(notes: notes, limit: 5).count, 5)
    }

    // MARK: Log journal

    func testJournalNudgeAfterTwoDays() {
        let entry = { (d: String) in JSONValue.object(["date": .string(d)]) }
        XCTAssertFalse(SimpleHome.journalNudgeDue(entries: [entry(iso(-60))], now: now))
        XCTAssertFalse(SimpleHome.journalNudgeDue(entries: [entry(iso(-60 * 24 * 2))], now: now))
        XCTAssertTrue(SimpleHome.journalNudgeDue(entries: [entry(iso(-60 * 24 * 3))], now: now))
        // The newest entry is what counts, not the first one found.
        XCTAssertFalse(SimpleHome.journalNudgeDue(
            entries: [entry(iso(-60 * 24 * 9)), entry(iso(-60))], now: now))
    }

    /// No entries at all says nothing — the Mac anchors on a stored
    /// first-seen stamp, and a phone whose journal has not synced yet must
    /// not be nagged about a journal it cannot see.
    func testNoEntriesMeansNoNudge() {
        XCTAssertFalse(SimpleHome.journalNudgeDue(entries: [], now: now))
    }
}
