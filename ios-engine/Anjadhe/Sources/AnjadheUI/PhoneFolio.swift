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
///     name the rows and let the headlines feed skip funds as the Mac does.
///     After-hours quotes come only from the Mac's v7 batch: not here.
///   • Market history: the same endpoint and ranges (`fetchPriceHistory`).
///   • Headlines on holdings: the Mac's News route (PhoneNews), Google only,
///     as `PortfolioNews` asks.
///   • The one write: watch / unwatch, into the synced (record-merged) blob
///     with the Mac's stamps and tombstone. Writing a profile or the brief is
///     a model run on the Mac and is refused here.
struct PhoneFolio {
    let store: AppStore

    typealias Done = (Result<JSONValue, Error>) -> Void
    struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
    static func fail(_ m: String) -> Result<JSONValue, Error> { .failure(Failure(message: m)) }

    static let quoteTTL: TimeInterval = 5 * 60
    static let quotesKey = "anjadhe:phone-quotes"
    static let historyTTL: TimeInterval = 10 * 60
    private static var history: [String: (at: Date, data: [JSONValue]?)] = [:]
    private static var news: [String: (at: Date, items: [JSONValue]?)] = [:]
    private static let lock = NSLock()

    var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    func build(_ view: String, _ p: [String: JSONValue], _ done: @escaping Done) -> Bool {
        switch view {
        case "portfolio", "portfolio-tickers", "portfolio-ticker", "portfolio-strategy", "portfolio-news":
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
        case "portfolio-tickers":
            return .success(book(await quotes(for: symbols())).tickersView(accountId: accountId))
        case "portfolio-ticker":
            let (t, range) = PortfolioBook.tickerParams(p["ticker"]?.stringValue, p["range"]?.stringValue)
            guard !t.isEmpty else { return Self.fail("missing ticker") }
            async let q = quotes(for: symbols() + [t])
            async let h = marketHistory(t, range)
            let (qs, hist) = await (q, h)
            return book(qs).tickerView(ticker: t, range: range, marketHistory: hist).map { .success($0) } ?? Self.fail("missing ticker")
        case "portfolio-strategy":
            let id = p["strategyId"]?.stringValue
            let b = book(await quotes(for: symbols()))
            return b.strategyView(strategyId: id).map { .success($0) } ?? Self.fail("That plan is gone.")
        default:
            return await headlines(p)
        }
    }

    // MARK: quotes

    /// PortfolioApp.getUniqueTickers: open positions (unexpired options),
    /// the watchlist, and positions in accounts shared in.
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
        for w in blob()["watchlist"]?.arrayValue ?? [] { add(w["ticker"]?.stringValue ?? "") }
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

    // MARK: headlines (PortfolioNews.headlines)

    private func headlines(_ p: [String: JSONValue]) async -> Result<JSONValue, Error> {
        let limitRaw = p["limit"]?.numberValue ?? 0
        let limit = Int(min(30, max(1, limitRaw == 0 || limitRaw.isNaN ? 12 : limitRaw)))
        let ticker = p["ticker"]?.stringValue.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        let accountId = ticker == nil ? p["accountId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } : nil
        let quotes = await self.quotes(for: symbols())
        let b = book(quotes)
        let plan = b.newsCandidates(ticker: ticker, accountId: accountId)
        // A symbol the quote cache has not seen gets its identity from one
        // chart call, as `_identity` asks the Mac's company lookup.
        var ids: [String: JSONValue] = [:]
        let unknown = plan.subjects.filter { quotes[$0]?["name"] == nil }
        let extra = unknown.isEmpty ? [:] : await self.quotes(for: unknown)
        for s in plan.subjects { ids[s] = b.newsIdentity(s, fetched: extra[s] ?? quotes[s]) }
        var subjects = plan.subjects
        if plan.filterFunds { subjects = Array(subjects.filter { !PortfolioBook.isFund(ids[$0]) }.prefix(12)) }
        let empty: JSONValue = .object(["tickers": .array([]), "items": .array([]), "fetchError": .null])
        guard !subjects.isEmpty else { return .success(empty) }

        guard let last = MacViews.storedAnswer("news"), let route = last["route"]?.stringValue, !route.isEmpty else {
            return .success(PortfolioBook.newsView(tickers: subjects, rows: [:], limit: limit,
                fetchError: "Open News once while your Mac is reachable, so this phone knows where your headlines come from."))
        }
        if last["webOn"]?.boolValue == false {
            return .success(PortfolioBook.newsView(tickers: subjects, rows: [:], limit: limit, fetchError: nil))
        }
        let topics = subjects.map { PortfolioBook.newsTopic($0, ids[$0] ?? .null) }
        let now = Date()
        let cold = zip(subjects, topics).filter { pair in
            guard let hit = Self.lock.withLock({ Self.news[pair.1.lowercased()] }) else { return true }
            let ttl: TimeInterval = (hit.items?.isEmpty ?? true) ? 5 * 60 : 30 * 60
            return now.timeIntervalSince(hit.at) >= ttl
        }.map(\.1)
        var failed = false
        if !cold.isEmpty {
            var fetched: [JSONValue] = []
            if route == "connect" {
                if let cred = CloudCredentials.load(), let r = try? await PhoneNews.viaConnect(cold, ["google"], cred) { fetched = r }
                else { failed = true }
            } else {
                fetched = await PhoneNews.direct(cold, ["google"], nowMs: nowMs)
            }
            for t in fetched {
                let topic = (t["topic"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces).lowercased()
                if t["error"] != nil { failed = true; continue }
                let rows = PortfolioBook.newsRows(t["items"]?.arrayValue ?? [], nowMs: nowMs)
                Self.lock.withLock { Self.news[topic] = (now, rows) }
            }
        }
        var rows: [String: [JSONValue]] = [:]
        for (s, topic) in zip(subjects, topics) {
            if let hit = Self.lock.withLock({ Self.news[topic.lowercased()] }), let items = hit.items { rows[s] = items }
        }
        let message = route == "connect" ? "nenva Connect could not fetch headlines right now." : "The news feed could not be reached right now."
        return .success(PortfolioBook.newsView(tickers: subjects, rows: rows, limit: limit, fetchError: failed ? message : nil))
    }

    // MARK: the writes (MobileViews._portfolioAction)

    private func action(_ p: [String: JSONValue]) async -> Result<JSONValue, Error> {
        let action = p["action"]?.stringValue ?? ""
        let ticker = PortfolioBook.tickerParams(p["ticker"]?.stringValue, nil).ticker
        switch action {
        case "watch", "unwatch":
            guard !ticker.isEmpty else { return Self.fail("missing ticker") }
            if PortfolioBook.optionMeta(ticker) != nil { return Self.fail("Options cannot be watched.") }
            let now = KVStore.nowISO()
            let next = PortfolioBook.setWatched(blob(), ticker: ticker, on: action == "watch", id: UUID().uuidString.lowercased(), now: now)
            if let next = next { store.saveBlob("portfolio", next) }
            if action == "watch" { _ = await quotes(for: [ticker]) }
            let watched = (blob()["watchlist"]?.arrayValue ?? []).contains { $0["ticker"]?.stringValue == ticker }
            return .success(.object(["ok": .bool(true), "action": .string(action), "ticker": .string(ticker),
                                     "changed": .bool(next != nil), "watched": .bool(watched)]))
        case "refresh-prices":
            let q = await quotes(for: symbols(), force: true)
            let b = book(q)
            return .success(.object(["ok": .bool(true), "action": .string(action), "pricesAsOf": b.pricesAsOf(b.holdings())]))
        default:
            // write-brief / write-profile: model runs on the Mac.
            return Self.fail("That is written on your Mac.")
        }
    }
}
