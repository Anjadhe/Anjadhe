import Foundation

/// Portfolio, built ON THE PHONE when the Mac is away (docs/MOBILE_NATIVE.md
/// "M5", phase 3). The pure half: the holdings arithmetic and every Portfolio
/// view the Mac serves, in the Mac's EXACT shapes.
///
/// While the Mac answers, the numbers are the Mac's (`MobileViews._portfolio*`
/// in js/agent/mobile-views.js). This port runs only when the choice is
/// between a copy and nothing (Ram, 2026-09-25: "its ok to port the holdings
/// to phone"), and drift is a TEST FAILURE: tests/portfolio-parity-test.js
/// runs the desktop's real code on a fixture and pins its output as the golden
/// PortfolioParityTests hold this file to. Each function names the desktop
/// function it ports, and keeps its order of operations, so the floating-point
/// results are the same numbers, not merely close ones.
///
/// What the phone never has — the model-written ticker profiles, their
/// verdicts, the daily brief, after-hours quotes from the Mac's v7 batch — is
/// sent the way the Mac sends it when those modules are absent: null, empty,
/// or not at all. Never invented.
public struct PortfolioBook {
    let accounts: [JSONValue]          // PortfolioApp.accounts (shared ones included)
    let transactions: [JSONValue]
    let properties: [JSONValue]
    let liabilities: [JSONValue]
    let strategies: [JSONValue]
    let watchlist: [JSONValue]
    let snapshots: [JSONValue]
    let quotes: [String: JSONValue]    // PortfolioApp.priceCache
    let companyInfo: [String: JSONValue]
    let today: String                  // local YYYY-MM-DD
    let cal: Calendar

    public init(portfolio: [String: JSONValue], history: [String: JSONValue], quotes: [String: JSONValue],
                companyInfo: [String: JSONValue] = [:], today: String, cal: Calendar = .current) {
        func arr(_ k: String) -> [JSONValue] { portfolio[k]?.arrayValue ?? [] }
        accounts = arr("accounts"); transactions = arr("transactions"); properties = arr("properties")
        liabilities = arr("liabilities"); strategies = arr("strategies"); watchlist = arr("watchlist")
        snapshots = history["snapshots"]?.arrayValue ?? []
        self.quotes = quotes; self.companyInfo = companyInfo; self.today = today; self.cal = cal
    }

    // MARK: JS-exact helpers

    static func s(_ v: JSONValue?, _ k: String) -> String { v?[k]?.stringValue ?? "" }
    static func d(_ v: JSONValue?) -> Double? { v?.numberValue }
    /// `x || 0` for a number field.
    static func z(_ v: JSONValue?) -> Double { let n = v?.numberValue ?? 0; return n.isNaN ? 0 : n }
    /// MobileViews._num: finite number, else null.
    static func num(_ v: Double?) -> JSONValue { guard let v = v, v.isFinite else { return .null }; return .number(v) }
    static func num(_ v: JSONValue?) -> JSONValue { num(v?.numberValue) }
    /// String(x).slice(0, n) — UTF-16 units, as JS counts.
    static func cut(_ s: String, _ n: Int) -> String {
        let u = Array(s.utf16); return u.count <= n ? s : (String(utf16CodeUnits: Array(u.prefix(n)), count: n))
    }
    /// A JS number as `${n}` prints it.
    public static func jsNum(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x == x.rounded() && abs(x) < 1e21 { return String(Int64(x)) }
        return "\(x)"
    }
    /// Number.prototype.toFixed(0).
    static func fixed0(_ x: Double) -> String {
        let r = x.rounded(.toNearestOrAwayFromZero)
        if r == 0 && x < 0 { return "-0" }
        return String(Int64(r))
    }
    /// String.prototype.localeCompare, near enough for ticker symbols.
    static func localeLess(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [], range: nil, locale: Locale(identifier: "en")) == .orderedAscending
    }
    /// A stable sort (Array.prototype.sort is stable since ES2019).
    static func stable<T>(_ xs: [T], by less: (T, T) -> Bool) -> [T] {
        xs.enumerated().sorted { a, b in
            if less(a.element, b.element) { return true }
            if less(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }
    /// `new Date(str)` in ms: date-only strings are UTC midnight.
    static func dateMs(_ str: String) -> Double {
        if let (y, m, dd) = components(str), str.count == 10 {
            var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!
            return (c.date(from: DateComponents(year: y, month: m, day: dd))?.timeIntervalSince1970 ?? .nan) * 1000
        }
        return (DateLogic.parseISO(str)?.timeIntervalSince1970 ?? .nan) * 1000
    }
    static func components(_ iso: String) -> (Int, Int, Int)? {
        let p = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        return p.count == 3 ? (p[0], p[1], p[2]) : nil
    }

    // MARK: options (PortfolioApp.optionMeta / displayTicker / optionDaysToExpiry)

    public struct OptionMeta { let underlying: String; let expiration: String; let optionType: String; let strike: Double }

    static let occ = try! NSRegularExpression(pattern: "^([A-Z.]{1,6})(\\d{6})([CP])(\\d{8})$")
    public static func optionMeta(_ t: String) -> OptionMeta? {
        guard let m = occ.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) else { return nil }
        func g(_ i: Int) -> String { String(t[Range(m.range(at: i), in: t)!]) }
        let d = g(2)
        let exp = "20\(d.prefix(2))-\(d.dropFirst(2).prefix(2))-\(d.suffix(2))"
        return OptionMeta(underlying: g(1), expiration: exp, optionType: g(3) == "P" ? "put" : "call", strike: Double(Int(g(4)) ?? 0) / 1000)
    }
    static func multiplier(_ t: String) -> Double { optionMeta(t) != nil ? 100 : 1 }

    func displayTicker(_ t: String) -> String {
        guard let m = Self.optionMeta(t), let (y, mo, dd) = Self.components(m.expiration) else { return t }
        let strike = m.strike == m.strike.rounded() ? Self.jsNum(m.strike) : String(format: "%.2f", m.strike)
        return "\(m.underlying) $\(strike) \(m.optionType == "put" ? "Put" : "Call") \(mo)/\(dd)/\(String(format: "%02d", y % 100))"
    }

    public func daysToExpiry(_ m: OptionMeta) -> Double {
        guard let a = TaskListDates.date(today, cal), let b = TaskListDates.date(m.expiration, cal) else { return .nan }
        return Double(cal.dateComponents([.day], from: a, to: b).day ?? 0)
    }

    func optionJSON(_ m: OptionMeta) -> JSONValue {
        .object(["underlying": .string(m.underlying), "expiration": .string(m.expiration), "optionType": .string(m.optionType),
                 "strike": Self.num(m.strike), "daysToExpiry": Self.num(daysToExpiry(m))])
    }

    static func money(_ v: Double) -> String {
        if v == 0 { return "$0.00" }
        let f = NumberFormatter(); f.locale = Locale(identifier: "en_US"); f.numberStyle = .decimal
        f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
        let abs = "$" + (f.string(from: NSNumber(value: Swift.abs(v))) ?? "")
        return v < 0 ? "-" + abs : abs
    }
    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// PortfolioUI.tickerName
    func tickerName(_ t: String) -> String {
        if let m = Self.optionMeta(t), let (y, mo, dd) = Self.components(m.expiration) {
            return "\(m.optionType == "put" ? "Put" : "Call") · \(Self.money(m.strike)) · \(Self.months[mo - 1]) \(dd), \(y)"
        }
        guard let info = companyInfo[t], info["error"] == nil || info["error"]?.isNull == true,
              let name = info["name"]?.stringValue, !name.isEmpty, name != t else { return "" }
        return name
    }

    static let accountTypes = ["brokerage": "Brokerage", "401k": "401(k)", "ira": "IRA", "roth-ira": "Roth IRA",
                               "hsa": "HSA", "savings": "Savings", "checking": "Checking", "other": "Other"]
    static let liabilityTypes = ["mortgage": "Mortgage", "heloc": "Home equity line", "auto": "Auto loan",
                                 "student": "Student loan", "personal": "Personal loan", "credit": "Credit card", "other": "Other"]

    // MARK: records

    func ownAccounts() -> [JSONValue] { accounts.filter { $0["shared"] == nil || $0["shared"]?.isNull == true } }
    func ownTransactions() -> [JSONValue] {
        let ids = Set(ownAccounts().map { Self.s($0, "id") })
        return transactions.filter { ids.contains(Self.s($0, "accountId")) }
    }
    func quote(_ t: String) -> JSONValue? { quotes[t] }

    // MARK: holdings (PortfolioApp.computeHoldings)

    public struct Holding {
        public let ticker: String
        public let option: OptionMeta?
        let multiplier: Double
        let priceEstimated: Bool
        let after: JSONValue?
        public let totalShares, avgCostBasis, costBasis, currentPrice, currentValue: Double
        let profitLoss, profitLossPercent, dayChange, dayChangePercent, dayBase: Double
        let accounts: [String]
    }

    public func holdings(_ accountId: String? = nil) -> [Holding] {
        let txns = accountId.map { id in transactions.filter { Self.s($0, "accountId") == id } } ?? ownTransactions()
        struct Acc { var shares = 0.0, costBasis = 0.0, todayShares = 0.0, todayCost = 0.0; var accounts: [String] = [] }
        var order: [String] = [], by: [String: Acc] = [:]
        for txn in Self.stable(txns, by: { Self.dateMs(Self.s($0, "date")) < Self.dateMs(Self.s($1, "date")) }) {
            let t = Self.s(txn, "ticker")
            if by[t] == nil { by[t] = Acc(); order.append(t) }
            var h = by[t]!
            let acct = Self.s(txn, "accountId")
            if !h.accounts.contains(acct) { h.accounts.append(acct) }
            let type = Self.s(txn, "type"), q = Self.z(txn["quantity"])
            let amount = q * Self.z(txn["pricePerShare"]) * Self.multiplier(t)
            if type == "buy" || type == "holding" {
                h.costBasis += amount
                h.shares += q
                if type == "buy" && Self.s(txn, "date") == today { h.todayShares += q; h.todayCost += amount }
            } else if type == "sell" {
                if h.shares > 0 {
                    let avg = h.costBasis / h.shares
                    h.shares -= q
                    h.costBasis = h.shares * avg
                }
            }
            by[t] = h
        }
        let rows: [Holding] = order.compactMap { t in
            let h = by[t]!
            guard h.shares > 0.0001 else { return nil }
            let option = Self.optionMeta(t)
            let mult: Double = option != nil ? 100 : 1
            let cached = quote(t)
            let price = Self.z(cached?["price"])
            let value = h.shares * price * mult
            let avg = h.shares > 0 ? h.costBasis / (h.shares * mult) : 0
            let pl = value - h.costBasis
            let plPct = h.costBasis > 0 ? (pl / h.costBasis) * 100 : 0
            let chg = Self.z(cached?["change"])
            let todayShares = min(h.shares, h.todayShares)
            let carried = h.shares - todayShares
            let todayCost = h.todayShares > 0 ? h.todayCost * (todayShares / h.todayShares) : 0
            let dayChange = price != 0 ? carried * chg * mult + (todayShares * price * mult - todayCost) : 0
            let dayBase = carried * (price - chg) * mult + todayCost
            let dayPct = dayBase > 0 ? (dayChange / dayBase) * 100 : 0
            let after = cached?["after"].flatMap { $0.isNull ? nil : $0 }
            return Holding(ticker: t, option: option, multiplier: mult, priceEstimated: cached?["estimated"]?.boolValue ?? false,
                           after: after, totalShares: h.shares, avgCostBasis: avg, costBasis: h.costBasis, currentPrice: price,
                           currentValue: value, profitLoss: pl, profitLossPercent: plPct, dayChange: dayChange,
                           dayChangePercent: dayPct, dayBase: dayBase, accounts: h.accounts)
        }
        return Self.stable(rows) { $0.currentValue > $1.currentValue }
    }

    /// computeCash / computeTotalCash
    func cash(_ accountId: String) -> Double {
        guard let a = accounts.first(where: { Self.s($0, "id") == accountId }), let c = a["cashBalance"]?.numberValue else { return 0 }
        return c
    }
    func totalCash(_ accountId: String? = nil) -> Double {
        if let id = accountId { return cash(id) }
        return ownAccounts().reduce(0) { $0 + cash(Self.s($1, "id")) }
    }

    /// getSummary
    struct Summary {
        let totalValue, totalCost, totalPL, totalPLPercent, totalDayChange, totalDayChangePercent, totalDayBase: Double
        let cash, realEstateValue, liabilitiesTotal, netWorth, afterChange, afterBase: Double
        let afterSession: String?
    }
    func summary(_ hs: [Holding], _ accountId: String?) -> Summary {
        let stock = hs.reduce(0) { $0 + $1.currentValue }
        let cost = hs.reduce(0) { $0 + $1.costBasis }
        let c = totalCash(accountId)
        let re = accountId != nil ? 0 : properties.reduce(0) { $0 + Self.z($1["currentValue"]) }
        let total = stock + c + re
        let debt = accountId != nil ? 0 : liabilities.reduce(0) { $0 + Self.z($1["balance"]) }
        let pl = stock - cost
        let plPct = cost > 0 ? (pl / cost) * 100 : 0
        let day = hs.reduce(0) { $0 + $1.dayChange }
        let base = hs.reduce(0) { $0 + $1.dayBase }
        let dayPct = base > 0 ? (day / base) * 100 : 0
        let afterChange = hs.reduce(0.0) { $0 + ($1.after != nil ? $1.totalShares * (Self.d($1.after?["change"]) ?? .nan) * $1.multiplier : 0) }
        let afterBase = hs.reduce(0.0) { $0 + ($1.after != nil ? $1.currentValue : 0) }
        let session = hs.first { $0.after != nil }.flatMap { $0.after?["session"]?.stringValue }.flatMap { $0.isEmpty ? nil : $0 }
        return Summary(totalValue: total, totalCost: cost, totalPL: pl, totalPLPercent: plPct, totalDayChange: day,
                       totalDayChangePercent: dayPct, totalDayBase: base, cash: c, realEstateValue: re, liabilitiesTotal: debt,
                       netWorth: total - debt, afterChange: afterChange, afterBase: afterBase, afterSession: session)
    }

    // MARK: rows (MobileViews._pfHolding / _pricesAsOf)

    public func pricesAsOf(_ hs: [Holding]) -> JSONValue {
        var at = 0.0
        for h in hs { let t = Self.z(quote(h.ticker)?["updatedAt"]); if t > at { at = t } }
        return at != 0 ? .number(at) : .null
    }

    func afterJSON(_ a: JSONValue?) -> JSONValue {
        guard let a = a else { return .null }
        let session = a["session"]?.stringValue ?? ""
        return .object(["price": Self.num(a["price"]), "change": Self.num(a["change"]), "changePercent": Self.num(a["changePercent"]),
                        "session": session.isEmpty ? .null : .string(session)])
    }

    func holdingJSON(_ h: Holding, _ denom: Double) -> JSONValue {
        .object([
            "ticker": .string(Self.cut(h.ticker, 24)),
            "label": .string(Self.cut(displayTicker(h.ticker), 48)),
            "name": .string(Self.cut(tickerName(h.ticker), 80)),
            "option": h.option.map(optionJSON) ?? .null,
            "shares": Self.num(h.totalShares), "avgCost": Self.num(h.avgCostBasis), "costBasis": Self.num(h.costBasis),
            "price": Self.num(h.currentPrice), "priceEstimated": .bool(h.priceEstimated), "value": Self.num(h.currentValue),
            "weight": denom > 0 ? Self.num(h.currentValue / denom * 100) : .null,
            "pl": Self.num(h.profitLoss), "plPercent": Self.num(h.profitLossPercent),
            "dayChange": Self.num(h.dayChange), "dayPercent": Self.num(h.dayChangePercent),
            "after": afterJSON(h.after),
            "accounts": .array(h.accounts.prefix(12).map { .string($0) }),
        ])
    }

    // MARK: strategies (PortfolioStrategy)

    func strategy(id: String) -> JSONValue? { strategies.first { Self.s($0, "id") == id } }
    func defaultStrategy() -> JSONValue? {
        strategies.first { $0["isDefault"]?.boolValue == true } ?? (strategies.count == 1 ? strategies[0] : nil)
    }
    func forAccount(_ accountId: String) -> (strategy: JSONValue?, inherited: Bool) {
        if let a = ownAccounts().first(where: { Self.s($0, "id") == accountId }),
           let sid = a["strategyId"]?.stringValue, !sid.isEmpty, let own = strategy(id: sid) { return (own, false) }
        if let f = defaultStrategy() { return (f, true) }
        return (nil, false)
    }

    static let interview: [(id: String, field: String, required: Bool, question: String)] = [
        ("purpose", "objective", true, "What is this money for?"),
        ("horizon", "horizon", true, "When do you expect to need it?"),
        ("risk", "riskLevel", true, "How big a drop could you sit through without selling?"),
        ("approach", "thesis", true, "How do you want it invested, and what do you believe that makes you pick that?"),
        ("allocation", "targets", true, "What mix are you aiming for?"),
        ("guardrails", "rules", false, "What limits do you want to hold yourself to?"),
        ("review", "reviewCadence", false, "How often do you want to revisit this?"),
        ("coverage", "coverage", true, "Does this cover everything, or only some accounts? And what should it be called?"),
    ]

    func missingTopics(_ s: JSONValue) -> [String] {
        Self.interview.filter { t in
            guard t.required else { return false }
            let v = s[t.field]
            if let a = v?.arrayValue { return a.isEmpty }
            guard let v = v, !v.isNull else { return true }
            if let str = v.stringValue { return str.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            if let b = v.boolValue { return !b }
            if let n = v.numberValue { return n == 0 || n.isNaN }
            return false
        }.map(\.id)
    }

    struct Report {
        var json: [String: JSONValue]
        var status: String, headline: String, empty: Bool
        var counts: JSONValue
    }

    static func upperList(_ v: JSONValue?) -> [String] { (v?.arrayValue ?? []).map { ($0.stringValue ?? Self.jsString($0)).uppercased() } }
    static func jsString(_ v: JSONValue) -> String {
        switch v { case .string(let s): return s; case .number(let n): return jsNum(n); case .bool(let b): return b ? "true" : "false"; default: return "" }
    }

    /// PortfolioStrategy.evaluate
    func evaluate(_ strategy: JSONValue, accountId: String? = nil) -> Report {
        let hs = holdings(accountId)
        let c = totalCash(accountId)
        let invested = hs.reduce(0) { $0 + $1.currentValue }
        let total = invested + c
        let unpriced = hs.filter { !($0.currentPrice > 0) }.map { displayTicker($0.ticker) }
        guard total > 0 else {
            return Report(json: ["total": .number(0), "empty": .bool(true), "targets": .array([]), "rules": .array([]),
                                 "unclassified": .null, "unpriced": .array(unpriced.map { .string($0) })],
                          status: "no-data", headline: "Nothing to measure yet.", empty: true, counts: .null)
        }
        func pct(_ v: Double) -> Double { (v / total) * 100 }
        var claimed = Set<String>()
        struct T { let label: String; let json: JSONValue; let status: String; let actualPct: Double; let targetPct: Double; let driftPct: Double }
        var targets: [T] = []
        for target in strategy["targets"]?.arrayValue ?? [] {
            let list = Self.upperList(target["tickers"])
            let matched = hs.filter { h in
                guard !list.isEmpty else { return false }
                if list.contains(h.ticker.uppercased()) { return true }
                return h.option.map { list.contains($0.underlying.uppercased()) } ?? false
            }
            matched.forEach { claimed.insert($0.ticker) }
            var value = matched.reduce(0) { $0 + $1.currentValue }
            let includeCash = target["includeCash"]?.boolValue ?? false
            if includeCash { value += c }
            let actual = pct(value)
            let tp = Self.d(target["targetPct"]) ?? .nan
            let mn = Self.d(target["minPct"]) ?? (tp - 5)
            let mx = Self.d(target["maxPct"]) ?? (tp + 5)
            let status = actual < mn ? "under" : (actual > mx ? "over" : "ok")
            let delta = (tp / 100) * total - value
            let label = Self.s(target, "label")
            targets.append(T(label: label, json: .object([
                "label": .string(Self.cut(label, 60)),
                "tickers": .array((target["tickers"]?.arrayValue ?? []).map { .string(displayTicker(Self.jsString($0))) }.prefix(20).map { $0 }),
                "includeCash": .bool(includeCash), "targetPct": Self.num(tp), "minPct": Self.num(mn), "maxPct": Self.num(mx),
                "actualPct": Self.num(actual), "value": Self.num(value), "status": .string(status),
                "deltaValue": Self.num(delta), "driftPct": Self.num(actual - tp),
            ]), status: status, actualPct: actual, targetPct: tp, driftPct: actual - tp))
        }
        let strays = hs.filter { !claimed.contains($0.ticker) }
        let strayValue = strays.reduce(0) { $0 + $1.currentValue }
        let anyCash = (strategy["targets"]?.arrayValue ?? []).contains { $0["includeCash"]?.boolValue == true }
        let unclassifiedValue = strayValue + (anyCash ? 0 : c)
        let unclassified: JSONValue = (!targets.isEmpty && unclassifiedValue > 0.005 * total) ? .object([
            "pct": Self.num(pct(unclassifiedValue)), "value": Self.num(unclassifiedValue),
            "tickers": .array(strays.map { .string(displayTicker($0.ticker)) }.prefix(12).map { $0 }),
            "includesCash": .bool(!anyCash && c > 0),
        ]) : .null

        struct Rule { let json: JSONValue; let status: String; let detail: String }
        var rules: [Rule] = []
        for rule in strategy["rules"]?.arrayValue ?? [] {
            let kind = Self.s(rule, "kind"), text = Self.s(rule, "text")
            let v = Self.d(rule["value"]) ?? .nan, vs = Self.jsNum(v)
            func make(_ label: String, _ status: String, _ detail: String) {
                rules.append(Rule(json: .object(["kind": .string(Self.cut(kind, 1000)), "text": .string(Self.cut(text, 300)),
                                                 "label": .string(Self.cut(label, 120)), "status": .string(status),
                                                 "detail": .string(Self.cut(detail, 300))]), status: status, detail: detail))
            }
            switch kind {
            case "max_position":
                let exempt = Self.upperList(rule["exclude"])
                let over = Self.stable(hs.filter { !exempt.contains($0.ticker.uppercased()) && !exempt.contains(($0.option?.underlying ?? "").uppercased()) }
                    .map { (ticker: displayTicker($0.ticker), p: pct($0.currentValue)) }
                    .filter { $0.p > v }) { $0.p > $1.p }
                make("No position over \(vs)%" + (exempt.isEmpty ? "" : " (excluding \(exempt.joined(separator: ", ")))"),
                     over.isEmpty ? "ok" : "breach",
                     over.isEmpty ? "Largest position is within \(vs)%."
                        : over.map { "\($0.ticker) is \(Self.fixed0($0.p))%" }.joined(separator: ", ") + " against a \(vs)% cap.")
            case "min_cash", "max_cash":
                let cp = pct(c), isMin = kind == "min_cash"
                let bad = isMin ? cp < v : cp > v
                make("\(isMin ? "At least" : "At most") \(vs)% cash", bad ? "breach" : "ok",
                     "Cash is \(Self.fixed0(cp))% against a \(vs)% \(isMin ? "floor" : "ceiling").")
            case "avoid", "only":
                let list = Self.upperList(rule["tickers"])
                guard !list.isEmpty else { continue }
                let held = hs.map { (display: displayTicker($0.ticker), key: ($0.option?.underlying ?? $0.ticker).uppercased()) }
                let offenders = kind == "avoid" ? held.filter { list.contains($0.key) } : held.filter { !list.contains($0.key) }
                var seen = Set<String>(), uniq: [String] = []
                for o in offenders where seen.insert(o.display).inserted { uniq.append(o.display) }
                make(kind == "avoid" ? "Stay away from \(list.joined(separator: ", "))" : "Only hold \(list.joined(separator: ", "))",
                     offenders.isEmpty ? "ok" : "breach",
                     offenders.isEmpty ? "No holdings conflict with this." : "Holding \(uniq.joined(separator: ", ")).")
            default:
                make(text.isEmpty ? "Rule" : text, "judgment", "Stated in words. Check this against the holdings yourself.")
            }
        }
        let breaches = rules.filter { $0.status == "breach" }.count
        let drifted = targets.filter { $0.status != "ok" }.count
        let judgment = rules.filter { $0.status == "judgment" }.count
        let status = breaches > 0 ? "breach" : (drifted > 0 ? "drift" : "on-track")
        let headline: String
        if status == "breach" {
            headline = rules.first { $0.status == "breach" }?.detail ?? "\(breaches) rule\(breaches == 1 ? "" : "s") broken."
        } else if status == "drift" {
            let worst = Self.stable(targets.filter { $0.status != "ok" }) { abs($0.driftPct) > abs($1.driftPct) }.first
            headline = worst.map { "\($0.label) is \(Self.fixed0($0.actualPct))% against a \(Self.jsNum($0.targetPct))% target." }
                ?? "\(drifted) target\(drifted == 1 ? "" : "s") outside its band."
        } else {
            headline = "Holdings match the plan."
        }
        let counts: JSONValue = .object(["drifted": .number(Double(drifted)), "breaches": .number(Double(breaches)), "needsJudgment": .number(Double(judgment))])
        return Report(json: ["total": Self.num(total), "cash": Self.num(c), "empty": .bool(false), "counts": counts,
                             "targets": .array(targets.map(\.json)), "rules": .array(rules.map(\.json)),
                             "unclassified": unclassified, "unpriced": .array(unpriced.map { .string($0) })],
                      status: status, headline: headline, empty: false, counts: counts)
    }

    /// MobileViews._pfStrategyLine
    func strategyLine(_ accountId: String?) -> JSONValue {
        var st: JSONValue? = nil, inherited = false
        if let id = accountId { let r = forAccount(id); st = r.strategy; inherited = r.inherited } else { st = defaultStrategy() }
        guard let s = st else { return .null }
        let r = evaluate(s, accountId: accountId)
        let status = Self.s(s, "status")
        return .object([
            "id": .string(Self.s(s, "id")), "name": .string(Self.cut(Self.s(s, "name"), 80)),
            "objective": .string(Self.cut(Self.s(s, "objective"), 300)), "status": .string(status.isEmpty ? "active" : status),
            "inherited": .bool(inherited),
            "report": .object(["status": .string(r.status), "headline": .string(Self.cut(r.headline, 240)), "counts": r.counts, "empty": .bool(r.empty)]),
        ])
    }

    // MARK: the views

    func accountRow(_ a: JSONValue) -> JSONValue {
        let id = Self.s(a, "id"), hs = holdings(id), sm = summary(hs, id)
        let type = Self.s(a, "type")
        let label = Self.accountTypes[type] ?? type
        return .object([
            "id": .string(id), "name": .string(Self.cut(Self.s(a, "name"), 60)), "type": .string(type.isEmpty ? "other" : type),
            "typeLabel": .string(Self.cut(label, 30)), "value": Self.num(sm.totalValue), "cash": Self.num(sm.cash),
            "holdings": .number(Double(hs.count)), "linked": .bool(a["brokerage"] != nil && a["brokerage"]?.isNull == false),
        ])
    }

    /// MobileViews._portfolio. nil = "No portfolio accounts yet."
    public func scopeView(accountId wanted: String?) -> JSONValue? {
        let accts = ownAccounts()
        guard !accts.isEmpty else { return nil }
        let accountId = accts.contains { Self.s($0, "id") == (wanted ?? "") } ? wanted : nil
        let hs = holdings(accountId), sm = summary(hs, accountId)
        let holdingsValue = hs.reduce(0) { $0 + $1.currentValue }
        let denom = holdingsValue + sm.cash
        let comp: [(String, String, Double)] = [
            ("stocks", "Investments", sm.totalValue - sm.cash - sm.realEstateValue),
            ("cash", "Cash", sm.cash), ("realestate", "Real estate", sm.realEstateValue),
        ]
        let movers = Self.stable(hs.filter { $0.dayChange.isFinite && $0.dayChangePercent.isFinite && abs($0.dayChangePercent) >= 1 }) {
            abs($0.dayChange) > abs($1.dayChange)
        }.prefix(6).map { h -> JSONValue in
            .object(["ticker": .string(Self.cut(h.ticker, 24)), "label": .string(Self.cut(displayTicker(h.ticker), 48)),
                     "dayChange": Self.num(h.dayChange), "dayChangePercent": Self.num(h.dayChangePercent)])
        }
        let held = Set(holdings().map(\.ticker))
        let watching = watchlist.filter { !held.contains(Self.s($0, "ticker").uppercased()) }.count
        var out: [String: JSONValue] = [
            "scope": .string(accountId ?? "all"), "pricesAsOf": pricesAsOf(hs),
            "totalValue": Self.num(sm.totalValue), "totalCost": Self.num(sm.totalCost), "netWorth": Self.num(sm.netWorth),
            "liabilitiesTotal": Self.num(sm.liabilitiesTotal), "cash": Self.num(sm.cash), "realEstateValue": Self.num(sm.realEstateValue),
            "dayChange": Self.num(sm.totalDayChange), "dayChangePercent": Self.num(sm.totalDayChangePercent), "dayBase": Self.num(sm.totalDayBase),
            "totalPL": Self.num(sm.totalPL), "totalPLPercent": Self.num(sm.totalPLPercent),
            "after": sm.afterSession.map { .object(["session": .string($0), "change": Self.num(sm.afterChange), "base": Self.num(sm.afterBase)]) } ?? .null,
            "composition": .array(comp.filter { $0.2 > 0 }.map { .object(["key": .string($0.0), "label": .string($0.1), "value": Self.num($0.2)]) }),
            "holdings": .array(hs.map { holdingJSON($0, denom) }),
            "movers": .array(Array(movers)),
            "accounts": .array(accts.map(accountRow)),
            "tickersNav": .object(["held": .number(Double(held.count)), "watching": .number(Double(watching))]),
            "strategy": strategyLine(accountId),
        ]
        let hist: [JSONValue]
        if let id = accountId {
            hist = snapshots.filter { $0["accounts"]?[id] != nil && $0["accounts"]?[id]?.isNull == false }
                .map { .object(["date": $0["date"] ?? .null, "value": Self.num($0["accounts"]?[id]?["value"])]) }
        } else {
            hist = snapshots.map { .object(["date": $0["date"] ?? .null, "value": Self.num($0["totalValue"]), "netWorth": Self.num($0["netWorth"])]) }
        }
        out["history"] = .array(Array(hist.filter { !($0["date"]?.stringValue ?? "").isEmpty && $0["value"]?.isNull == false }.suffix(800)))
        if let id = accountId {
            out["account"] = accts.first { Self.s($0, "id") == id }.map(accountRow) ?? .null
            return .object(out)
        }
        out["properties"] = .array(properties.map { p in .object([
            "id": .string(Self.s(p, "id")), "name": .string(Self.cut(Self.s(p, "name"), 80)), "address": .string(Self.cut(Self.s(p, "address"), 160)),
            "currentValue": Self.num(p["currentValue"]), "purchasePrice": Self.num(p["purchasePrice"]),
            "purchaseDate": Self.s(p, "purchaseDate").isEmpty ? .null : .string(Self.s(p, "purchaseDate")),
            "notes": .string(Self.cut(Self.s(p, "notes"), 600))]) })
        let liab: [JSONValue] = liabilities.map { l in
            let type = Self.s(l, "type")
            return .object([
                "id": .string(Self.s(l, "id")), "name": .string(Self.cut(Self.s(l, "name"), 80)), "type": .string(type.isEmpty ? "other" : type),
                "typeLabel": .string(Self.cut(Self.liabilityTypes[type] ?? "Other", 40)),
                "lender": .string(Self.cut(Self.s(l, "lender"), 60)), "balance": Self.num(l["balance"]), "originalAmount": Self.num(l["originalAmount"]),
                "interestRate": Self.num(l["interestRate"]), "monthlyPayment": Self.num(l["monthlyPayment"]),
                "startDate": Self.s(l, "startDate").isEmpty ? .null : .string(Self.s(l, "startDate")),
                "propertyId": Self.s(l, "propertyId").isEmpty ? .null : .string(Self.s(l, "propertyId")),
                "notes": .string(Self.cut(Self.s(l, "notes"), 600))])
        }
        out["liabilities"] = .array(liab)
        let monthly = liab.reduce(0.0) { $0 + ($1["monthlyPayment"]?.numberValue ?? 0) }
        out["monthlyPayments"] = monthly != 0 && !monthly.isNaN ? .number(monthly) : .null
        out["watchlist"] = .array(Self.stable(watchlist.map { w -> (String, JSONValue) in
            let t = Self.s(w, "ticker").uppercased(), q = quote(t)
            return (t, .object(["ticker": .string(t), "name": .string(Self.cut(tickerName(t), 80)),
                                "price": Self.num(q?["price"]), "change": Self.num(q?["change"]), "changePercent": Self.num(q?["changePercent"])]))
        }) { Self.localeLess($0.0, $1.0) }.map(\.1))
        return .object(out)
    }

    /// MobileViews._portfolioTickers (PortfolioTickers.consolidate / summarize).
    /// The indicator columns are the model-written profiles' verdicts, which
    /// live only on the Mac: no specs, no `ind`, nothing profiled.
    public func tickersView(accountId wanted: String?) -> JSONValue {
        let accts = ownAccounts()
        let accountId = accts.contains { Self.s($0, "id") == (wanted ?? "") } ? (wanted ?? "") : ""
        let hs = holdings(accountId.isEmpty ? nil : accountId)
        let c = accountId.isEmpty ? totalCash() : cash(accountId)
        let totalValue = hs.reduce(0) { $0 + $1.currentValue } + c
        struct Row { var json: [String: JSONValue]; let held: Bool; let watched: Bool; let option: Bool; let value: Double?; let dayChange: Double?; let pl: Double?; let accounts: [String] }
        var rows: [Row] = []
        var watched: [String] = []
        for w in watchlist { let t = Self.s(w, "ticker").uppercased(); if !t.isEmpty && !watched.contains(t) { watched.append(t) } }
        var seen = Set<String>()
        func base(_ t: String) -> [String: JSONValue] {
            ["ticker": .string(Self.cut(t, 24)), "label": .string(Self.cut(displayTicker(t), 48)), "name": .string(Self.cut(tickerName(t), 80)),
             "profiled": .bool(false), "profileDay": .null, "ind": .object([:])]
        }
        for h in hs {
            seen.insert(h.ticker)
            let priced = h.currentPrice != 0
            let value = priced ? h.currentValue : 0
            var j = base(h.ticker)
            j["held"] = .bool(true); j["watched"] = .bool(watched.contains(h.ticker)); j["option"] = .bool(h.option != nil)
            j["shares"] = Self.num(h.totalShares); j["avgCost"] = Self.num(h.avgCostBasis); j["price"] = Self.num(h.currentPrice)
            j["priceEstimated"] = .bool(h.priceEstimated); j["value"] = Self.num(value)
            j["weight"] = Self.num(priced && totalValue > 0 ? (value / totalValue) * 100 : 0)
            j["pl"] = priced ? Self.num(h.profitLoss) : .null; j["plPct"] = priced ? Self.num(h.profitLossPercent) : .null
            j["dayChange"] = priced ? Self.num(h.dayChange) : .null; j["dayPct"] = priced ? Self.num(h.dayChangePercent) : .null
            j["accountCount"] = .number(Double(h.accounts.count))
            rows.append(Row(json: j, held: true, watched: watched.contains(h.ticker), option: h.option != nil, value: value,
                            dayChange: priced ? h.dayChange : nil, pl: priced ? h.profitLoss : nil, accounts: h.accounts))
        }
        for t in watched where !seen.contains(t) {
            seen.insert(t)
            let q = quote(t), price = Self.z(q?["price"])
            var j = base(t)
            j["held"] = .bool(false); j["watched"] = .bool(true); j["option"] = .bool(Self.optionMeta(t) != nil)
            j["shares"] = .number(0); j["avgCost"] = .null; j["price"] = Self.num(price)
            j["priceEstimated"] = .bool(q?["estimated"]?.boolValue ?? false); j["value"] = .null; j["weight"] = .null
            j["pl"] = .null; j["plPct"] = .null
            j["dayChange"] = price != 0 ? Self.num(Self.z(q?["change"])) : .null
            j["dayPct"] = price != 0 ? Self.num(Self.z(q?["changePercent"])) : .null
            j["accountCount"] = .number(0)
            rows.append(Row(json: j, held: false, watched: true, option: Self.optionMeta(t) != nil, value: nil, dayChange: nil, pl: nil, accounts: []))
        }
        var value = 0.0, day = 0.0, pl = 0.0, accountsSeen = Set<String>()
        var held = 0, watchedN = 0, both = 0, options = 0
        for r in rows {
            if r.held { held += 1 }; if r.watched { watchedN += 1 }; if r.held && r.watched { both += 1 }; if r.option { options += 1 }
            if r.held { value += r.value ?? 0; day += r.dayChange ?? 0; pl += r.pl ?? 0; r.accounts.forEach { accountsSeen.insert($0) } }
        }
        return .object([
            "pricesAsOf": pricesAsOf(hs), "accountId": accountId.isEmpty ? .null : .string(accountId),
            "summary": .object(["total": .number(Double(rows.count)), "held": .number(Double(held)), "watched": .number(Double(watchedN)),
                                "both": .number(Double(both)), "options": .number(Double(options)), "value": .number(value),
                                "dayChange": .number(day), "pl": .number(pl), "accountCount": .number(Double(accountsSeen.count))]),
            "indicatorSummary": .object(["total": .number(Double(rows.count)), "profiled": .number(0), "today": .number(0), "missing": .number(Double(rows.count))]),
            "specs": .array([]),
            "rows": .array(rows.map { .object($0.json) }),
        ])
    }

    static let historyRanges = ["1m", "3m", "1y", "5y", "max"]
    static let sites: [(String, String, (String) -> String)] = [
        ("perplexity", "Perplexity Finance", { "https://www.perplexity.ai/finance/\(enc($0))" }),
        ("robinhood", "Robinhood", { "https://robinhood.com/stocks/\(enc($0))" }),
        ("tradingview", "TradingView", { "https://www.tradingview.com/symbols/\(enc($0))/" }),
        ("yahoo", "Yahoo Finance", { "https://finance.yahoo.com/quote/\(enc($0.replacingOccurrences(of: ".", with: "-")))" }),
        ("finviz", "Finviz", { "https://finviz.com/quote.ashx?t=\(enc($0.replacingOccurrences(of: ".", with: "-")))" }),
    ]
    /// encodeURIComponent
    static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) ?? s
    }

    public static func tickerParams(_ raw: String?, _ range: String?) -> (ticker: String, range: String) {
        (cut((raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), 24),
         historyRanges.contains(range ?? "") ? range! : "1y")
    }

    /// MobileViews._portfolioTicker. `marketHistory` is Yahoo's series for
    /// (ticker, range), fetched by the caller; nil when it could not be.
    public func tickerView(ticker rawTicker: String?, range rawRange: String?, marketHistory: [JSONValue]?) -> JSONValue? {
        let (ticker, range) = Self.tickerParams(rawTicker, rawRange)
        guard !ticker.isEmpty else { return nil }
        let all = holdings()
        let denom = all.reduce(0) { $0 + $1.currentValue } + totalCash()
        let holding = all.first { $0.ticker == ticker }
        let meta = Self.optionMeta(ticker)
        let subject = meta.map { $0.underlying.uppercased() } ?? ticker
        let q = quote(ticker)
        let info = companyInfo[ticker]
        let company: JSONValue
        if let info = info, info["error"] == nil || info["error"]?.isNull == true {
            company = .object([
                "name": .string(Self.cut(Self.s(info, "name"), 120)), "type": .string(Self.s(info, "type")),
                "sector": .string(Self.cut(Self.s(info, "sector"), 60)), "industry": .string(Self.cut(Self.s(info, "industry"), 80)),
                "description": .string(Self.cut(Self.s(info, "description"), 2000)), "website": .string(Self.cut(Self.s(info, "website"), 200)),
                "country": .string(Self.cut(Self.s(info, "country"), 60)), "employees": Self.num(info["employees"])])
        } else { company = .null }
        let byAccount: [JSONValue] = accounts.compactMap { a in
            guard let h = holdings(Self.s(a, "id")).first(where: { $0.ticker == ticker }) else { return nil }
            let type = Self.s(a, "type")
            return .object(["accountId": .string(Self.s(a, "id")), "accountName": .string(Self.cut(Self.s(a, "name"), 60)),
                            "typeLabel": .string(Self.cut(Self.accountTypes[type] ?? type, 30)),
                            "shares": Self.num(h.totalShares), "avgCost": Self.num(h.avgCostBasis), "costBasis": Self.num(h.costBasis),
                            "value": Self.num(h.currentValue), "pl": Self.num(h.profitLoss), "plPercent": Self.num(h.profitLossPercent)])
        }
        let txns = Self.stable(ownTransactions().filter { Self.s($0, "ticker") == ticker }) {
            Self.dateMs(Self.s($0, "date")) > Self.dateMs(Self.s($1, "date"))
        }.prefix(200).map { t -> JSONValue in
            let amount = Self.z(t["quantity"]) * Self.z(t["pricePerShare"]) * Self.multiplier(Self.s(t, "ticker"))
            return .object(["id": .string(Self.s(t, "id")), "type": .string(Self.s(t, "type")),
                            "date": Self.s(t, "date").isEmpty ? .null : .string(Self.s(t, "date")),
                            "quantity": Self.num(t["quantity"]), "pricePerShare": Self.num(t["pricePerShare"]), "amount": Self.num(amount),
                            "accountId": .string(Self.s(t, "accountId")), "notes": .string(Self.cut(Self.s(t, "notes"), 300))])
        }
        let valueHistory = snapshots.filter { $0["tickers"]?[ticker] != nil && $0["tickers"]?[ticker]?.isNull == false }
            .map { s -> JSONValue in .object(["date": s["date"] ?? .null, "price": Self.num(s["tickers"]?[ticker]?["price"]),
                                              "value": Self.num(s["tickers"]?[ticker]?["value"])]) }
        let updatedAt = Self.z(q?["updatedAt"])
        let quoteJSON: JSONValue = .object([
            "price": Self.num(q?["price"]), "change": Self.num(q?["change"]), "changePercent": Self.num(q?["changePercent"]),
            "estimated": .bool(q?["estimated"]?.boolValue ?? false),
            "updatedAt": updatedAt != 0 ? .number(updatedAt) : .null,
            "after": afterJSON(q?["after"].flatMap { $0.isNull ? nil : $0 })])
        var market: JSONValue = .null
        if let mh = marketHistory {
            let pts: [JSONValue] = mh.map { p in .object(["date": p["date"] ?? .null, "price": Self.num(p["price"])]) }
            market = .array(Array(pts.suffix(1200)))
        }
        let siteSymbol = meta != nil ? subject : ticker
        let sitesJSON: [JSONValue] = Self.sites.map { site in
            .object(["action": .string(site.0), "label": .string(site.1), "url": .string(site.2(siteSymbol))])
        }
        var out: [String: JSONValue] = [:]
        out["ticker"] = .string(ticker)
        out["label"] = .string(Self.cut(displayTicker(ticker), 48))
        out["subject"] = .string(subject)
        out["watched"] = .bool(watchlist.contains { Self.s($0, "ticker") == ticker })
        out["option"] = meta.map(optionJSON) ?? .null
        out["company"] = company
        out["quote"] = quoteJSON
        out["holding"] = holding.map { holdingJSON($0, denom) } ?? .null
        out["byAccount"] = .array(byAccount)
        out["range"] = .string(range)
        out["marketHistory"] = market
        out["valueHistory"] = .array(Array(valueHistory.suffix(800)))
        out["transactions"] = .array(Array(txns))
        // The business profile is model-written on the Mac (PortfolioProfile).
        out["profile"] = .null
        out["profileAvailable"] = .bool(false)
        out["profileDestination"] = .string("")
        out["decisions"] = .array([])
        out["sites"] = .array(sitesJSON)
        return .object(out)
    }

    /// MobileViews._portfolioStrategy. nil for an id that is not there.
    public func strategyView(strategyId: String?) -> JSONValue? {
        func shape(_ s: JSONValue, full: Bool) -> JSONValue {
            let r = evaluate(s)
            var report = r.json
            report["status"] = .string(r.status)
            report["headline"] = .string(Self.cut(r.headline, 300))
            if report["cash"] == nil { report["cash"] = .null }
            report["unpriced"] = .array((report["unpriced"]?.arrayValue ?? []).prefix(20).map { $0 })
            if report["counts"] == nil { report["counts"] = .null }
            let status = Self.s(s, "status")
            var o: [String: JSONValue] = [
                "id": .string(Self.s(s, "id")), "name": .string(Self.cut(Self.s(s, "name"), 80)),
                "objective": .string(Self.cut(Self.s(s, "objective"), 600)), "horizon": .string(Self.cut(Self.s(s, "horizon"), 80)),
                "riskLevel": .string(Self.cut(Self.s(s, "riskLevel"), 40)), "status": .string(status.isEmpty ? "active" : status),
                "isDefault": .bool(s["isDefault"]?.boolValue ?? false),
                "thesis": .string(Self.cut(Self.s(s, "thesis"), 2000)), "coverage": .string(Self.cut(Self.s(s, "coverage"), 400)),
                "reviewCadence": .string(Self.cut(Self.s(s, "reviewCadence"), 80)),
                "report": .object(report),
            ]
            guard full else { return .object(o) }
            let sid = Self.s(s, "id")
            let isDefault = s["isDefault"]?.boolValue ?? false
            o["followers"] = .array(ownAccounts().filter { a in
                let own = Self.s(a, "strategyId")
                return own.isEmpty ? isDefault : own == sid
            }.map { .object(["id": .string(Self.s($0, "id")), "name": .string(Self.cut(Self.s($0, "name"), 60)), "own": .bool(Self.s($0, "strategyId") == sid)]) })
            o["accountsWithNoPlan"] = .number(Double(ownAccounts().filter { Self.s($0, "strategyId").isEmpty }.count))
            o["history"] = .array((s["history"]?.arrayValue ?? []).suffix(8).map { h in
                .object(["at": Self.s(h, "at").isEmpty ? .null : .string(Self.s(h, "at")), "summary": .string(Self.cut(Self.s(h, "summary"), 300))]) })
            o["missingTopics"] = .array(missingTopics(s).map { .string($0) })
            return .object(o)
        }
        if let id = strategyId, !id.isEmpty {
            guard let s = strategy(id: id) else { return nil }
            return .object(["strategy": shape(s, full: true)])
        }
        return .object([
            "strategies": .array(strategies.map { shape($0, full: false) }),
            "agenda": .array(Self.interview.map { .object(["id": .string($0.id), "question": .string(Self.cut($0.question, 200))]) }),
        ])
    }

    // MARK: headlines on holdings (PortfolioNews)

    static let fundTypes = ["ETF", "MUTUALFUND", "INDEX", "MONEYMARKET"]
    public static func isFund(_ identity: JSONValue?) -> Bool { fundTypes.contains((identity?["type"]?.stringValue ?? "").uppercased()) }

    /// PortfolioNews._subject
    static func subject(_ t: String) -> String? {
        guard !t.isEmpty, t != "__CASH__" else { return nil }
        return optionMeta(t)?.underlying ?? t
    }

    /// The subjects a headlines ask is about, BEFORE the fund filter of the
    /// collated feed (`headlines` → `_holdingSubjects`, or the ticker asked).
    public func newsCandidates(ticker: String?, accountId: String?) -> (subjects: [String], filterFunds: Bool) {
        if let t = ticker, !t.isEmpty {
            let s = Self.subject(Self.cut(t.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), 24))
            return (s.map { [$0] } ?? [], false)
        }
        var seen = Set<String>(), out: [String] = []
        let hs = Self.stable(holdings(accountId)) { $0.currentValue > $1.currentValue }
        for h in hs { if let s = Self.subject(h.ticker), seen.insert(s).inserted { out.append(s) } }
        if accountId == nil {
            for w in watchlist { if let s = Self.subject(Self.s(w, "ticker")), seen.insert(s).inserted { out.append(s) } }
        }
        return (Array(out.prefix(16)), true)
    }

    /// The identity PortfolioNews looks a ticker up by: the company cache
    /// first, then whatever the caller fetched.
    public func newsIdentity(_ t: String, fetched: JSONValue?) -> JSONValue {
        if let mem = companyInfo[t], mem["error"] == nil || mem["error"]?.isNull == true {
            return .object(["name": mem["name"] ?? .string(t), "type": mem["type"].flatMap { $0.isNull ? nil : $0 } ?? .null])
        }
        let name = fetched?["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? t
        return .object(["name": .string(name), "type": fetched?["type"].flatMap { $0.isNull ? nil : $0 } ?? .null])
    }

    static let cleanRe = try! NSRegularExpression(pattern: "[,.]?\\s+(Inc|Corp|Corporation|Co|Company|Ltd|Limited|PLC|plc|Holdings|Group|N\\.V\\.|S\\.A\\.|AG|SE)\\.?$", options: [.caseInsensitive])
    /// PortfolioNews._cleanName / _topic
    public static func newsTopic(_ t: String, _ identity: JSONValue) -> String {
        var name = identity["name"]?.stringValue ?? ""
        name = cleanRe.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
        name = name.replacingOccurrences(of: "[,.]\\s*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name.uppercased() == t.uppercased() { return "\(t) stock" }
        let fund = isFund(identity)
        let topic = fund ? name : "\(name) \(t)"
        if topic.utf16.count <= 80 { return topic }
        return fund ? cut(name, 80) : "\(cut(name, 79 - t.utf16.count)) \(t)"
    }

    /// One ticker's cached rows from a topic's fetched items (`_ensure`):
    /// dated within 7 days, titled, newest first, eight kept.
    public static func newsRows(_ items: [JSONValue], nowMs: Double) -> [JSONValue] {
        var rows: [(Double, JSONValue)] = []
        for it in items {
            guard let ps = it["publishedAt"]?.stringValue, let d = DateLogic.parseISO(ps) else { continue }
            let pub = d.timeIntervalSince1970 * 1000
            guard nowMs - pub <= 7 * 24 * 3600 * 1000 else { continue }
            let title = it["title"]?.stringValue ?? "", url = it["url"]?.stringValue ?? ""
            guard !title.isEmpty, !url.isEmpty else { continue }
            rows.append((pub, .object(["title": .string(cut(title, 200)), "url": .string(url),
                                       "source": .string(cut(it["source"]?.stringValue ?? "", 60)), "publishedAt": .number(pub)])))
        }
        return stable(rows) { $0.0 > $1.0 }.prefix(8).map(\.1)
    }

    /// `_collate` + the view's row shape: round-robin across tickers, one row per URL.
    public static func newsView(tickers: [String], rows: [String: [JSONValue]], limit: Int, fetchError: String?) -> JSONValue {
        let lists = tickers.map { t in (rows[t] ?? []).map { (t, $0) } }.filter { !$0.isEmpty }
        var out: [JSONValue] = [], seen = Set<String>()
        var i = 0
        while out.count < limit && lists.contains(where: { i < $0.count }) {
            for l in lists {
                guard i < l.count else { continue }
                let (t, it) = l[i]
                let url = it["url"]?.stringValue ?? ""
                if seen.contains(url) { continue }
                seen.insert(url)
                out.append(.object(["ticker": .string(t), "title": .string(cut(it["title"]?.stringValue ?? "", 200)), "url": .string(url),
                                    "source": .string(cut(it["source"]?.stringValue ?? "", 60)), "publishedAt": it["publishedAt"] ?? .null]))
                if out.count >= limit { break }
            }
            i += 1
        }
        return .object(["tickers": .array(tickers.map { .string($0) }),
                        "fetchError": fetchError.map { .string(cut($0, 200)) } ?? .null,
                        "items": .array(out.filter { !($0["title"]?.stringValue ?? "").isEmpty && !($0["url"]?.stringValue ?? "").isEmpty })])
    }

    // MARK: the watchlist write (addToWatchlist / removeFromWatchlist)

    /// The synced blob after watching or unwatching, with the Mac's stamps:
    /// a new record carries createdAt/updatedAt; a removal writes the
    /// tombstone the record merge needs (PortfolioApp._tombstone). nil when
    /// nothing changes.
    public static func setWatched(_ blob: [String: JSONValue], ticker raw: String, on: Bool, id: String, now: String) -> [String: JSONValue]? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !t.isEmpty else { return nil }
        var list = blob["watchlist"]?.arrayValue ?? []
        var out = blob
        if on {
            guard !list.contains(where: { s($0, "ticker") == t }) else { return nil }
            list.append(.object(["id": .string(id), "ticker": .string(t), "createdAt": .string(now), "updatedAt": .string(now)]))
        } else {
            guard let entry = list.first(where: { s($0, "ticker") == t }) else { return nil }
            let eid = s(entry, "id")
            var tomb = blob["tombstones"]?.objectValue ?? [:]
            if !eid.isEmpty { tomb[eid] = .string(now) }
            out["tombstones"] = .object(tomb)
            list.removeAll { s($0, "id") == eid }
        }
        out["watchlist"] = .array(list)
        return out
    }
}

/// Local-calendar dates for YYYY-MM-DD strings (shared with TaskList's rules).
enum TaskListDates {
    static func date(_ iso: String, _ cal: Calendar) -> Date? {
        let p = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }
}
