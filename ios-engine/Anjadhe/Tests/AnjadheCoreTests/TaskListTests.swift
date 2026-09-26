import XCTest
@testable import AnjadheCore

/// The phone's copy of the Mac's Tasks view (TaskList.swift), pinned to the
/// desktop rules it ports. UTC calendar; "today" is Thu 2026-06-18.
final class TaskListTests: XCTestCase {
    private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
    private let today = "2026-06-18"   // Thursday

    private func t(_ json: String) -> JSONValue { try! JSONValue.parse(json) }

    private lazy var items: [JSONValue] = [
        t(#"{"id":"late","title":"Pay rent","scheduledDate":"2026-06-10"}"#),
        t(#"{"id":"now2","title":"Call bank","scheduledDate":"2026-06-18","startTime":"14:00"}"#),
        t(#"{"id":"now1","title":"Standup","scheduledDate":"2026-06-18","startTime":"09:00","tags":["work"]}"#),
        t(#"{"id":"tmr","title":"Dentist","scheduledDate":"2026-06-19"}"#),
        t(#"{"id":"sat","title":"Groceries","scheduledDate":"2026-06-20","tags":["home"]}"#),
        t(#"{"id":"jul","title":"Renew passport","scheduledDate":"2026-07-15","sourceEmailId":"e1"}"#),
        t(#"{"id":"some","title":"Learn piano"}"#),
        t(#"{"id":"done","title":"Old done","scheduledDate":"2026-06-01","lastCompletedDate":"2026-06-02"}"#),
        t(#"{"id":"donetoday","title":"Finished","scheduledDate":"2026-06-18","lastCompletedDate":"2026-06-18"}"#),
        t(#"{"id":"skip","title":"Skipped","scheduledDate":"2026-06-05","history":{"2026-06-05":"abandoned"}}"#),
        t(#"{"id":"daily","title":"Meditate","repeat":"daily","scheduledDate":"2026-06-01"}"#),
        t(#"{"id":"future","title":"New habit","repeat":"daily","scheduledDate":"2026-06-25"}"#),
        t(#"{"id":"monthly","title":"Invoice","repeat":"monthly","scheduledDate":"2026-01-28"}"#),
        t(#"{"id":"weekly","title":"Review","repeat":"weekly","dayOfWeek":5,"scheduledDate":"2026-06-01","lastCompletedDate":"2026-06-12"}"#),
    ]
    private let goals = [try! JSONValue.parse(#"{"id":"g1","title":"Move house","group":"Home"}"#)]
    private let links = [try! JSONValue.parse(#"{"sourceApp":"schedule","sourceId":"sat","targetApp":"goals","targetId":"g1"}"#)]
    private var ctx: TaskList.Context { TaskList.Context(items: items, goals: goals, links: links, today: today, cal: cal) }

    private func groups(_ v: JSONValue) -> [(String, [String])] {
        (v["groups"]?.arrayValue ?? []).map { g in
            (g["label"]?.stringValue ?? "", (g["items"]?.arrayValue ?? []).map { $0["id"]?.stringValue ?? "" })
        }
    }

    // The anchor is a START date: a recurrence never fires before it.
    func testOccursOnRespectsTheAnchor() {
        XCTAssertFalse(TaskList.occursOn(t(#"{"repeat":"daily","scheduledDate":"2026-06-25"}"#), today, cal: cal))
        XCTAssertTrue(TaskList.occursOn(t(#"{"repeat":"daily","scheduledDate":"2026-06-01"}"#), today, cal: cal))
        XCTAssertTrue(TaskList.occursOn(t(#"{"repeat":"weekly","dayOfWeek":4}"#), today, cal: cal))   // Thursday
        XCTAssertTrue(TaskList.occursOn(t(#"{"repeat":"weekdays"}"#), today, cal: cal))
        XCTAssertFalse(TaskList.occursOn(t(#"{"repeat":"weekdays"}"#), "2026-06-20", cal: cal))       // Saturday
    }

    func testTodaySlice() {
        let v = TaskList.view(slice: "today", group: nil, ctx)
        XCTAssertEqual(v["label"]?.stringValue, "Today")
        XCTAssertEqual(groups(v).map(\.0), ["Overdue", "Today", "Done today"])
        XCTAssertEqual(groups(v)[0].1, ["late"])
        // Timed first by time, untimed ('99:99') last.
        XCTAssertEqual(groups(v)[1].1, ["now1", "now2", "daily"])
        XCTAssertEqual(groups(v)[2].1, ["donetoday"])
        XCTAssertEqual(v["groups"]?.arrayValue?.first?["danger"]?.boolValue, true)
    }

    func testAllSlice() {
        let g = groups(TaskList.view(slice: "all", group: nil, ctx))
        XCTAssertEqual(g.map(\.0), ["Overdue", "Today", "Tomorrow", "Later", "No date", "Done today"])
        XCTAssertEqual(g[2].1, ["tmr", "daily", "weekly"])        // Friday: the weekly review
        // Later sorts by agenda date: the monthly invoice's NEXT occurrence (06-28).
        XCTAssertEqual(g[3].1, ["sat", "monthly", "jul"])
        XCTAssertEqual(g[4].1, ["some"])
    }

    // This week = today through Sunday, one group per day.
    func testWeekSlice() {
        let v = TaskList.view(slice: "week", group: nil, ctx)
        let g = groups(v)
        XCTAssertEqual(g.map(\.0), ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"])
        XCTAssertEqual(g[0].1, ["daily", "now1", "now2"])       // _startMins: untimed first here
        XCTAssertTrue(g[2].1.contains("sat"))
    }

    // This month leaves out day-based repeats; Later groups by month.
    func testMonthAndLater() {
        let month = groups(TaskList.view(slice: "month", group: nil, ctx))
        XCTAssertFalse(month.flatMap(\.1).contains("daily"))
        XCTAssertTrue(month.flatMap(\.1).contains("monthly"))   // 06-28
        let later = groups(TaskList.view(slice: "later", group: nil, ctx))
        XCTAssertEqual(later.first?.0, "July 2026")
        XCTAssertEqual(later.first?.1, ["jul"])
        XCTAssertEqual(later.last?.0, "No date")
    }

    func testScopes() {
        XCTAssertEqual(groups(TaskList.view(slice: "all", group: "t:home", ctx)).flatMap(\.1), ["sat"])
        XCTAssertEqual(groups(TaskList.view(slice: "all", group: "g:Home", ctx)).flatMap(\.1), ["sat"])
        XCTAssertEqual(groups(TaskList.view(slice: "all", group: "src:email", ctx)).flatMap(\.1), ["jul"])
        XCTAssertFalse(groups(TaskList.view(slice: "all", group: "unassigned", ctx)).flatMap(\.1).contains("sat"))
    }

    func testNavCounts() {
        let nav = TaskList.view(slice: "today", group: nil, ctx)["nav"]!
        let slices = Dictionary(uniqueKeysWithValues: (nav["slices"]?.arrayValue ?? []).map { ($0["id"]!.stringValue!, Int($0["count"]!.numberValue!)) })
        XCTAssertEqual(slices["today"], 4)                       // late + now1 + now2 + daily
        XCTAssertEqual(nav["tags"]?.arrayValue?.map { $0["name"]!.stringValue! }.sorted(), ["home", "work"])
        XCTAssertEqual(nav["projects"]?.arrayValue?.first?["name"]?.stringValue, "Home")
        XCTAssertEqual(nav["sources"]?.arrayValue?.first?["id"]?.stringValue, "src:email")
    }

    func testRowShape() {
        let r = TaskList.row(items[4], ctx)
        XCTAssertEqual(r["projects"]?.arrayValue?.first?["title"]?.stringValue, "Move house")
        XCTAssertEqual(r["date"]?.stringValue, "2026-06-20")
        XCTAssertTrue(r["time"]?.isNull ?? false)
        XCTAssertEqual(r["done"]?.boolValue, false)
    }

    // The desktop's toggle, driven by a direction.
    func testSetDone() {
        let now = "2026-06-18T12:00:00Z"
        let one = t(#"{"id":"x","title":"A","scheduledDate":"2026-06-10","history":{"2026-06-10":"abandoned"}}"#)
        let done = TaskList.setDone(one, done: true, today: today, now: now, nowMs: 0)
        XCTAssertEqual(done["lastCompletedDate"]?.stringValue, today)
        XCTAssertEqual(done["history"]?["2026-06-18"]?.stringValue, "done")
        XCTAssertNil(done["history"]?["2026-06-10"])            // no longer both done and abandoned
        XCTAssertEqual(TaskList.setDone(done, done: true, today: today, now: now, nowMs: 0), done)   // no-op
        let undone = TaskList.setDone(done, done: false, today: today, now: now, nowMs: 0)
        XCTAssertTrue(undone["lastCompletedDate"]?.isNull ?? false)
        XCTAssertNil(undone["history"]?["2026-06-18"])
    }
}
