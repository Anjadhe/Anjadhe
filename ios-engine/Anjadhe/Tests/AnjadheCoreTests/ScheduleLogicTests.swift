import XCTest
@testable import AnjadheCore

/// Parity with the task/date logic in mobile/app.js. Uses a UTC calendar
/// and a fixed "today" (Thu 2026-06-18) so day-of-week math is deterministic.
final class ScheduleLogicTests: XCTestCase {

    private let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private func date(_ y: Int, _ m: Int, _ d: Int) -> Date {
        utc.date(from: DateComponents(timeZone: TimeZone(identifier: "UTC"), year: y, month: m, day: d))!
    }
    private let thu = { () -> Date in
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!
        return c.date(from: DateComponents(timeZone: TimeZone(identifier: "UTC"), year: 2026, month: 6, day: 18))!
    }()

    func testDateHelpers() {
        XCTAssertEqual(DateLogic.dateStr(date(2026, 6, 18), utc), "2026-06-18")
        XCTAssertEqual(DateLogic.weekday(date(2026, 6, 18), utc), 4) // Thursday
        XCTAssertEqual(DateLogic.weekday(date(2026, 6, 20), utc), 6) // Saturday
        XCTAssertEqual(DateLogic.fmtTime("14:30"), "2:30 PM")
        XCTAssertEqual(DateLogic.fmtTime("09:05"), "9:05 AM")
        XCTAssertEqual(DateLogic.fmtTime("00:00"), "12:00 AM")
        XCTAssertEqual(DateLogic.fmtTime("12:00"), "12:00 PM")
        XCTAssertEqual(DateLogic.fmtTime("nope"), "nope")
    }

    func testRelDate() {
        XCTAssertEqual(DateLogic.relDate("2026-06-18T10:00:00.000Z", today: thu, cal: utc), "Today")
        XCTAssertEqual(DateLogic.relDate("2026-06-17", today: thu, cal: utc), "Yesterday")
        XCTAssertEqual(DateLogic.relDate("2026-06-15", today: thu, cal: utc), "3 days ago")
        XCTAssertEqual(DateLogic.relDate("", today: thu, cal: utc), "")
    }

    private func task(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }

    func testTaskRepeatModes() {
        let thu = self.thu
        let sat = date(2026, 6, 20)
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("daily")]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("weekdays")]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("weekdays")]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("weekly"), "dayOfWeek": .number(4)]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("weekly"), "dayOfWeek": .number(4)]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("custom"), "repeatDays": .array([.number(1), .number(4)])]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("monthly"), "scheduledDate": .string("2026-03-18")]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("monthly"), "scheduledDate": .string("2026-03-18")]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("annually"), "scheduledDate": .string("2020-06-18")]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["scheduledDate": .string("2026-06-18")]), on: thu, cal: utc)) // 'none'
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["scheduledDate": .string("2026-06-18")]), on: sat, cal: utc))
    }

    func testTaskDoneToday() {
        XCTAssertTrue(ScheduleLogic.taskDoneToday(task(["lastCompletedDate": .string("2026-06-18")]), today: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDoneToday(task(["lastCompletedDate": .string("2026-06-17")]), today: thu, cal: utc))
    }

    // (Habit cadence/streak tests went with the Habits feature, removed from
    // the product 2026-07-15 — recurring tasks cover habit-building.)
}
