import XCTest
@testable import AnjadheCore

/// The phone's Portfolio views equal the DESKTOP's, view for view, on a
/// fixture built to hit the edges: options live and expired, an unpriced
/// holding, a buy made today, a position sold to zero, a shared account,
/// crypto, strategies with every rule kind, headlines with failed topics.
/// The golden is the desktop's own output (tests/portfolio-parity-test.js).
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
        for (key, expected) in golden["tickers"]!.objectValue! {
            diff(expected, book.tickersView(accountId: key == "all" ? nil : key), "tickers[\(key)]", &d)
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

        // Headlines: identities, topics, the fetch, the collation.
        let now = fx["nowMs"]!.numberValue!
        var topicsAsked: [JSONValue] = []
        func news(_ ticker: String?, _ accountId: String?, _ limitParam: Double?) -> JSONValue {
            let limit = Int(min(30, max(1, (limitParam ?? 12) == 0 ? 12 : (limitParam ?? 12))))
            let plan = book.newsCandidates(ticker: ticker, accountId: accountId)
            var subjects = plan.subjects
            if plan.filterFunds {
                subjects = Array(subjects.filter { !PortfolioBook.isFund(book.newsIdentity($0, fetched: fx["newsIdentity"]![$0])) }.prefix(12))
            }
            if subjects.isEmpty { return .object(["tickers": .array([]), "items": .array([]), "fetchError": .null]) }
            let topics = subjects.map { PortfolioBook.newsTopic($0, book.newsIdentity($0, fetched: fx["newsIdentity"]![$0])) }
            var i = 0
            while i < topics.count { topicsAsked.append(.array(topics[i..<min(i + 8, topics.count)].map { .string($0) })); i += 8 }
            var rows: [String: [JSONValue]] = [:], failed = false
            for (s, topic) in zip(subjects, topics) {
                if let items = fx["newsFetched"]![topic]?.arrayValue { rows[s] = PortfolioBook.newsRows(items, nowMs: now) } else { failed = true }
            }
            return PortfolioBook.newsView(tickers: subjects, rows: rows, limit: limit,
                                          fetchError: failed ? "nenva Connect could not fetch headlines right now." : nil)
        }
        diff(golden["news"]!["all"]!, news(nil, nil, nil), "news[all]", &d)
        diff(golden["news"]!["acc-a"]!, news(nil, "acc-a", 3), "news[acc-a]", &d)
        diff(golden["news"]!["AAPL"]!, news("AAPL", nil, nil), "news[AAPL]", &d)
        diff(golden["news"]!["NVDA-option"]!, news("NVDA270115C00150000", nil, 50), "news[NVDA-option]", &d)
        diff(golden["newsTopics"]!, .array(topicsAsked), "newsTopics", &d)

        XCTAssertTrue(d.isEmpty, "\(d.count) diffs:\n" + d.prefix(25).joined(separator: "\n"))
    }

    func testWatchWritesStampsAndTombstones() {
        let blob = try! JSONValue.parse(#"{"watchlist":[{"id":"w1","ticker":"GOOG"}],"tombstones":{}}"#).objectValue!
        let on = PortfolioBook.setWatched(blob, ticker: " msft ", on: true, id: "w2", now: "2026-09-18T00:00:00Z")!
        XCTAssertEqual(on["watchlist"]?.arrayValue?.last?["ticker"]?.stringValue, "MSFT")
        XCTAssertEqual(on["watchlist"]?.arrayValue?.last?["updatedAt"]?.stringValue, "2026-09-18T00:00:00Z")
        XCTAssertNil(PortfolioBook.setWatched(on, ticker: "MSFT", on: true, id: "w3", now: "x"))
        let off = PortfolioBook.setWatched(on, ticker: "GOOG", on: false, id: "", now: "2026-09-18T01:00:00Z")!
        XCTAssertEqual(off["watchlist"]?.arrayValue?.count, 1)
        XCTAssertEqual(off["tombstones"]?["w1"]?.stringValue, "2026-09-18T01:00:00Z")
    }
}
