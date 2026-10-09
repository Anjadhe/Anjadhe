import XCTest
@testable import AnjadheCore

/// The phone's Portfolio views equal the DESKTOP's, view for view, on a
/// fixture built to hit the edges: options live and expired, an unpriced
/// holding, a buy made today, a position sold to zero, a shared account,
/// crypto, strategies with every rule kind, and a stored watchlist nothing
/// reads any more (news, Tickers and the Watchlist left 2026-10-09,
/// docs/COACH.md §7). The golden is the desktop's own output
/// (tests/portfolio-parity-test.js).
final class PortfolioParityTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try JSONValue.parse(String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8))
    }

    private func diff(_ a: JSONValue, _ b: JSONValue, _ path: String, _ out: inout [String]) {
        switch (a, b) {
        case (.object(let x), .object(let y)):
            for k in Set(x.keys).union(y.keys).sorted() {
                guard let xv = x[k], let yv = y[k] else { out.append("\(path).\(k) only on \(x[k] == nil ? "phone" : "desktop")"); continue }
                diff(xv, yv, "\(path).\(k)", &out)
            }
        case (.array(let x), .array(let y)):
            guard x.count == y.count else { out.append("\(path): \(x.count) vs \(y.count)"); return }
            for i in x.indices { diff(x[i], y[i], "\(path)[\(i)]", &out) }
        case (.number(let x), .number(let y)):
            // Same order of operations → the same doubles; allow only
            // printing noise.
            if x != y && abs(x - y) > 1e-9 * max(1, abs(x)) { out.append("\(path): desktop \(x) phone \(y)") }
        default:
            if a != b { out.append("\(path): desktop \(a) phone \(b)") }
        }
    }

    func testEveryViewMatchesTheDesktop() throws {
        let fx = try fixture("portfolio-parity.input.json"), golden = try fixture("portfolio-parity.golden.json")
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let book = PortfolioBook(portfolio: fx["portfolio"]!.objectValue!, history: fx["history"]!.objectValue!,
                                 quotes: fx["quotes"]!.objectValue!, companyInfo: fx["companyInfo"]!.objectValue!,
                                 today: fx["today"]!.stringValue!, cal: cal)
        var d: [String] = []
        let noAccounts: JSONValue = .object(["error": .string("No portfolio accounts yet.")])
        for (key, expected) in golden["portfolio"]!.objectValue! {
            diff(expected, book.scopeView(accountId: key == "all" ? nil : key) ?? noAccounts, "portfolio[\(key)]", &d)
        }
        for (key, expected) in golden["ticker"]!.objectValue! {
            let parts = key.split(separator: "|").map(String.init)
            let (t, r) = PortfolioBook.tickerParams(parts[0], parts[1])
            let mh = (t == "AAPL" && r == "1y") ? fx["marketHistory"]!.arrayValue! : nil
            diff(expected, book.tickerView(ticker: parts[0], range: parts[1], marketHistory: mh) ?? .object(["error": .string("missing ticker")]), "ticker[\(key)]", &d)
        }
        for (key, expected) in golden["strategy"]!.objectValue! {
            diff(expected, book.strategyView(strategyId: key == "list" ? nil : key) ?? .object(["error": .string("That plan is no longer on your Mac.")]), "strategy[\(key)]", &d)
        }

        XCTAssertTrue(d.isEmpty, "\(d.count) diffs:\n" + d.prefix(25).joined(separator: "\n"))
    }
}
