import XCTest
@testable import AnjadheCore

/// The phone's Tasks view must equal the DESKTOP's, view for view, on a
/// fixture built to hit the edges (month-end and annual repeats, an
/// abandoned-today task, custom weekdays, a blank project group, link order).
/// The golden is the desktop's own output, written and checked by the Mac's
/// tests/task-list-parity-test.js — so drift on either side fails a test.
final class TaskListParityTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try JSONValue.parse(String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8))
    }

    /// JSON numbers decode as Double on both sides; compare as values.
    private func same(_ a: JSONValue, _ b: JSONValue, _ path: String, _ diffs: inout [String]) {
        switch (a, b) {
        case (.object(let x), .object(let y)):
            for k in Set(x.keys).union(y.keys) {
                guard let xv = x[k], let yv = y[k] else { diffs.append("\(path).\(k) missing on one side"); continue }
                same(xv, yv, "\(path).\(k)", &diffs)
            }
        case (.array(let x), .array(let y)):
            guard x.count == y.count else { diffs.append("\(path) has \(y.count) not \(x.count)"); return }
            for i in x.indices { same(x[i], y[i], "\(path)[\(i)]", &diffs) }
        default:
            if a != b { diffs.append("\(path): desktop \(a) phone \(b)") }
        }
    }

    func testEveryViewMatchesTheDesktop() throws {
        let fx = try fixture("task-list-parity.input.json")
        let golden = try fixture("task-list-parity.golden.json")
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let ctx = TaskList.Context(items: fx["items"]!.arrayValue!, goals: fx["goals"]!.arrayValue!,
                                   links: fx["links"]!.arrayValue!, today: fx["today"]!.stringValue!, cal: cal)
        var diffs: [String] = []
        let views = golden.objectValue ?? [:]
        XCTAssertEqual(views.count, 54)
        for (key, expected) in views {
            let parts = key.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            let got = TaskList.view(slice: parts[0], group: parts[1].isEmpty ? nil : parts[1], ctx)
            same(expected, got, key, &diffs)
        }
        XCTAssertTrue(diffs.isEmpty, diffs.prefix(10).joined(separator: "\n"))
    }
}
