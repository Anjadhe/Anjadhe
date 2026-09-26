import XCTest
@testable import AnjadheCore

/// The phone's News port equals the DESKTOP's pipeline: the parsers on the
/// same raw replies, then the timeline built from the same fetched topics.
/// The golden is the desktop's own output (tests/news-parity-test.js).
final class NewsParityTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try JSONValue.parse(String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8))
    }

    private func diff(_ a: JSONValue, _ b: JSONValue, _ path: String, _ out: inout [String]) {
        switch (a, b) {
        case (.object(let x), .object(let y)):
            for k in Set(x.keys).union(y.keys) {
                guard let xv = x[k], let yv = y[k] else { out.append("\(path).\(k) only on \(x[k] == nil ? "phone" : "desktop")"); continue }
                diff(xv, yv, "\(path).\(k)", &out)
            }
        case (.array(let x), .array(let y)):
            guard x.count == y.count else { out.append("\(path): \(x.count) vs \(y.count)"); return }
            for i in x.indices { diff(x[i], y[i], "\(path)[\(i)]", &out) }
        default:
            if a != b { out.append("\(path): desktop \(a) phone \(b)") }
        }
    }

    func testParsersMatchTheDesktop() throws {
        let fx = try fixture("news-parity.input.json"), golden = try fixture("news-parity.golden.json")
        var d: [String] = []
        diff(golden["parsed"]!["google"]!, .array(NewsLogic.parseRss(fx["google"]!.stringValue!, via: "google")), "google", &d)
        diff(golden["parsed"]!["bing"]!, .array(NewsLogic.parseRss(fx["bing"]!.stringValue!, via: "bing")), "bing", &d)
        diff(golden["parsed"]!["hn"]!, .array(NewsLogic.hnItems(fx["hn"]!.stringValue!)), "hn", &d)
        XCTAssertTrue(d.isEmpty, d.prefix(10).joined(separator: "\n"))
    }

    func testTimelineMatchesTheDesktop() throws {
        let fx = try fixture("news-parity.input.json"), golden = try fixture("news-parity.golden.json")
        let now = fx["nowMs"]!.numberValue!
        let settings = NewsLogic.settings(fx["settings"]!.objectValue!)
        let taste = NewsLogic.taste(fx["taste"]!.objectValue!, nowMs: now)
        let hues = NewsLogic.hueMap(settings.interests)
        let groups = NewsLogic.groups(golden["fetched"]!.arrayValue!, fewer: taste.fewer, clicks: taste.clicks, hues: hues, nowMs: now)
        var d: [String] = []
        diff(golden["groups"]!, .array(groups), "groups", &d)
        let topicHues = JSONValue.object(Dictionary(uniqueKeysWithValues: settings.interests.map { ($0, JSONValue.string(NewsLogic.topicHue($0, map: hues))) }))
        diff(golden["topicHues"]!, topicHues, "topicHues", &d)
        XCTAssertTrue(d.isEmpty, d.prefix(12).joined(separator: "\n"))
    }
}
