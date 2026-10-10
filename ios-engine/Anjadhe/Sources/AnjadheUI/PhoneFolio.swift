import Foundation
import AnjadheCore

/// Portfolio built on the phone when the Mac is away (docs/MOBILE_NATIVE.md
/// "M5", phase 3). The arithmetic and every view shape are
/// AnjadheCore/PortfolioLogic.swift, pinned to the desktop by
/// PortfolioParityTests; this is the network and the writes.
///
///   • Quotes: Yahoo's v8 chart endpoint per symbol (the Mac's own
///     `PriceFetcher.fetchSingle` fallback), cached MACHINE-LOCAL in
///     UserDefaults for five minutes (the Mac's CACHE_TTL) — never a synced
///     key, so a phone refreshing prices can never outrank a Mac's edits.
///     The same reply carries the company's name and instrument type, which
///     name the rows. After-hours quotes come only from the Mac's v7 batch:
///     not here.
///   • Market history: the same endpoint and ranges (`fetchPriceHistory`).
///   • The one action: refresh prices. Nothing here writes the synced blob.
///
/// News on holdings, the Tickers page, the Watchlist (and its watch /
/// unwatch write), ticker profiles and the brief left Finance 2026-10-09
/// (docs/COACH.md §7); the Mac no longer serves those views or actions and
/// neither does the phone.
struct PhoneFolio {
    let store: AppStore

    typealias Done = (Result<JSONValue, Error>) -> Void
    struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
    static func fail(_ m: String) -> Result<JSONValue, Error> { .failure(Failure(message: m)) }

    static let quoteTTL: TimeInterval = 5 * 60
    static let quotesKey = "anjadhe:phone-quotes"
    static let historyTTL: TimeInterval = 10 * 60
    private static var history: [String: (at: Date, data: [JSONValue]?)] = [:]
    private static let lock = NSLock()

    var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    func build(_ view: String, _ p: [String: JSONValue], _ done: @escaping Done) -> Bool {
        switch view {
        case "portfolio", "portfolio-ticker", "portfolio-strategy":
            Task { done(await read(view, p)) }
        case "portfolio-action":
            Task { done(await action(p)) }
        default:
            return false
        }
        return true
    }

    private func blob() -> [String: JSONValue] { store.blob("portfolio") }

    private func book(_ quotes: [String: JSONValue]) -> PortfolioBook {
        // Names and instrument types from the quote replies stand in for the
        // Mac's company cache (it holds more — sector, summary — from a
        // Yahoo endpoint the phone cannot reach).
        var info: [String: JSONValue] = [:]
        for (t, q) in quotes where !(q["name"]?.stringValue ?? "").isEmpty {
            info[t] = .object(["name": q["name"]!, "type": q["type"] ?? .null])
        }
        return PortfolioBook(portfolio: blob(), history: store.blob("portfolio-history"), quotes: quotes,
                             companyInfo: info, today: DateLogic.todayStr())
    }

    private func read(_ view: String, _ p: [String: JSONValue]) async -> Result<JSONValue, Error> {
        let accountId = p["accountId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        switch view {
        case "portfolio":
            let b = book(await quotes(for: symbols()))
            guard let v = b.scopeView(accountId: accountId) else { return Self.fail("No portfolio accounts yet.") }
            return .success(v)
        case "portfolio-ticker":
            let (t, range) = PortfolioBook.tickerParams(p["ticker"]?.stringValue, p["range"]?.stringValue)
            guard !t.isEmpty else { return Self.fail("missing ticker") }
            async let q = quotes(for: symbols() + [t])
            async let h = marketHistory(t, range)
            let (qs, hist) = await (q, h)
            return book(qs).tickerView(ticker: t, range: range, marketHistory: hist).map { .success($0) } ?? Self.fail("missing ticker")
        default: // portfolio-strategy
            let id = p["strategyId"]?.stringValue
            let b = book(await quotes(for: symbols()))
            return b.strategyView(strategyId: id).map { .success($0) } ?? Self.fail("That plan is gone.")
        }
    }

    // MARK: quotes

    /// PortfolioApp.getUniqueTickers: open positions (unexpired options) and
    /// positions in accounts shared in. (The watchlist stopped being quoted
    /// 2026-10-09 when it left Finance.)
    private func symbols() -> [String] {
        let b = PortfolioBook(portfolio: blob(), history: [:], quotes: [:], today: DateLogic.todayStr())
        var out: [String] = []
        func add(_ t: String) { if !t.isEmpty && !out.contains(t) { out.append(t) } }
        let accounts = blob()["accounts"]?.arrayValue ?? []
        for (i, id) in ([nil] + accounts.map { $0["id"]?.stringValue }).enumerated() {
            if i > 0 && (accounts[i - 1]["shared"] == nil || accounts[i - 1]["shared"]?.isNull == true) { continue }
            for h in b.holdings(id) where h.totalShares > 0 {
                if let o = h.option, b.daysToExpiry(o) < 0 { continue }
                add(h.ticker)
            }
        }
        return out
    }

    static func loadQuotes() -> [String: JSONValue] {
        guard let d = UserDefaults.standard.data(forKey: quotesKey), let v = try? JSONDecoder().decode(JSONValue.self, from: d) else { return [:] }
        return v.objectValue ?? [:]
    }
    static func saveQuotes(_ q: [String: JSONValue]) {
        if let d = try? JSONEncoder().encode(JSONValue.object(q)) { UserDefaults.standard.set(d, forKey: quotesKey) }
    }

    /// PriceFetcher.fetchPrices over the chart endpoint: stale symbols
    /// refetched in parallel; a failure is recorded as `missing`, as the Mac does.
    func quotes(for tickers: [String], force: Bool = false) async -> [String: JSONValue] {
        var cache = Self.loadQuotes()
        let now = nowMs
        let stale = tickers.filter { t in
            guard !force, let at = cache[t]?["updatedAt"]?.numberValue else { return true }
            return now - at > Self.quoteTTL * 1000
        }
        guard !stale.isEmpty else { return cache }
        let got = await withTaskGroup(of: (String, JSONValue?).self) { group -> [(String, JSONValue?)] in
            for t in stale { group.addTask { (t, await Self.fetchQuote(t)) } }
            var out: [(String, JSONValue?)] = []
            for await r in group { out.append(r) }
            return out
        }
        for (t, q) in got {
            if var o = q?.objectValue { o["updatedAt"] = .number(now); cache[t.uppercased()] = .object(o) }
            else { cache[t.uppercased()] = .object(["price": .null, "change": .number(0), "changePercent": .number(0), "updatedAt": .number(now), "missing": .bool(true)]) }
        }
        Self.saveQuotes(cache)
        return cache
    }

    static func chartURL(_ t: String, interval: String, range: String) -> URL? {
        let sym = t.replacingOccurrences(of: ".", with: "-")
        guard let enc = sym.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))) else { return nil }
        return URL(string: "https://query1.finance.yahoo.com/v8/finance/chart/\(enc)?interval=\(interval)&range=\(range)")
    }

    static func chart(_ url: URL) async -> JSONValue? {
        var req = URLRequest(url: url); req.timeoutInterval = 15
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONValue.parse(String(decoding: data, as: UTF8.self)) else { return nil }
        return json["chart"]?["result"]?.arrayValue?.first
    }

    /// fetchSingle: regularMarketPrice against chartPreviousClose || previousClose.
    static func fetchQuote(_ t: String) async -> JSONValue? {
        guard let url = chartURL(t, interval: "1d", range: "1d"), let result = await chart(url),
              let meta = result["meta"], let price = meta["regularMarketPrice"]?.numberValue else { return nil }
        let prevRaw = meta["chartPreviousClose"]?.numberValue ?? 0
        let prev = prevRaw != 0 ? prevRaw : (meta["previousClose"]?.numberValue ?? 0)
        let change = prev != 0 ? price - prev : 0
        let pct = prev != 0 ? (change / prev) * 100 : 0
        let name = meta["longName"]?.stringValue ?? meta["shortName"]?.stringValue ?? ""
        return .object(["price": .number(price), "change": .number(change), "changePercent": .number(pct),
                        "name": .string(name), "type": (meta["instrumentType"]).flatMap { $0.isNull ? nil : $0 } ?? .null])
    }

    static let ranges: [String: (range: String, interval: String)] = [
        "1m": ("1mo", "1d"), "3m": ("3mo", "1d"), "1y": ("1y", "1d"), "5y": ("5y", "1wk"), "max": ("max", "1mo"),
    ]

    /// fetchPriceHistory: closes keyed by LOCAL date, the last bar of a day
    /// kept, and at least two points or nothing.
    func marketHistory(_ t: String, _ rangeKey: String) async -> [JSONValue]? {
        let key = "\(t)|\(rangeKey)"
        if let hit = Self.lock.withLock({ Self.history[key] }), Date().timeIntervalSince(hit.at) < Self.historyTTL { return hit.data }
        let cfg = Self.ranges[rangeKey] ?? Self.ranges["1y"]!
        guard let url = Self.chartURL(t, interval: cfg.interval, range: cfg.range), let result = await Self.chart(url) else { return nil }
        let stamps = result["timestamp"]?.arrayValue ?? []
        let closes = result["indicators"]?["quote"]?.arrayValue?.first?["close"]?.arrayValue ?? []
        var out: [JSONValue] = []
        for (i, s) in stamps.enumerated() {
            guard i < closes.count, let c = closes[i].numberValue, c.isFinite, let ts = s.numberValue else { continue }
            let date = DateLogic.dateStr(Date(timeIntervalSince1970: ts))
            if out.last?["date"]?.stringValue == date { out.removeLast() }
            out.append(.object(["date": .string(date), "price": .number(c)]))
        }
        let data = out.count >= 2 ? out : nil
        if data != nil { Self.lock.withLock { Self.history[key] = (Date(), data) } }
        return data
    }

    // MARK: the action (MobileViews._portfolioAction)

    private func action(_ p: [String: JSONValue]) async -> Result<JSONValue, Error> {
        let action = p["action"]?.stringValue ?? ""
        switch action {
        case "refresh-prices":
            let q = await quotes(for: symbols(), force: true)
            let b = book(q)
            return .success(.object(["ok": .bool(true), "action": .string(action), "pricesAsOf": b.pricesAsOf(b.holdings())]))
        default:
            // The Mac's own answer to anything else (2026-10-09).
            return Self.fail("unknown action")
        }
    }
}
