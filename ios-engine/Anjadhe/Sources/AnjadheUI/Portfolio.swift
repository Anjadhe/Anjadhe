import SwiftUI
import AnjadheCore

// The Portfolio app on the phone (2026-09-21) — the desktop page, phone-sized.
//
// Until now this was one screen: a total and six movers. It is now the
// desktop's own shape: a left nav of SCOPES in a drawer (All accounts, each
// account, Tickers, Strategy), a masthead with the composition bar and the
// value chart, the holdings table, the daily brief, watchlist, real estate,
// liabilities, and detail pages for a ticker (chart, business profile and its
// verdict tiles, headlines, holdings by account, transactions), for a plan
// (target mix, guardrails, adherence) and for a property or a debt.
//
// Every number is computed ON THE MAC by the desktop's own accessors and
// arrives through `MacViews` — the phone does no portfolio arithmetic of its
// own, deliberately. The records DO sync (accounts, transactions, watchlist
// live in the `portfolio` blob), but holdings are average-cost maths over
// live quotes, and a second implementation of that is exactly the drift the
// Mac-served lane exists to prevent.
//
// Colour law: ink everywhere, semantic red/green on signed money only, the
// asset-class hues on the composition bar (data, not chrome).

let PORTFOLIO_TTL: TimeInterval = 5 * 60

// MARK: - Money

/// Whole dollars, grouped. The Mac sends numbers; the phone formats them —
/// `hideValues` is a per-Mac display preference and never travels.
func pfMoney(_ v: Double?, cents: Bool = false) -> String {
    guard let v = v, v.isFinite else { return "—" }
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "en_US")
    f.minimumFractionDigits = cents ? 2 : 0
    f.maximumFractionDigits = cents ? 2 : 0
    let n = cents ? v : v.rounded()
    return (v < 0 ? "−$" : "$") + (f.string(from: NSNumber(value: abs(n))) ?? String(abs(n)))
}

/// "+$1,234 (+1.2%)" / "−$56 (−0.3%)" — the sign travels on both numbers.
func pfChange(_ v: Double?, _ pct: Double?) -> String {
    guard let v = v, v.isFinite else { return "" }
    let sign = v > 0 ? "+" : (v < 0 ? "−" : "")
    var body = sign + pfMoney(abs(v))
    if let p = pct, p.isFinite { body += " (" + sign + String(format: "%.1f", abs(p)) + "%)" }
    return body
}

func pfPercent(_ v: Double?, digits: Int = 1) -> String {
    guard let v = v, v.isFinite else { return "—" }
    return String(format: "%.\(digits)f%%", v)
}

/// Semantic red/green by sign — the sanctioned exception to monochrome.
func pfTone(_ v: Double?) -> Color {
    guard let v = v, v.isFinite else { return Theme.text }
    return v > 0 ? Theme.success : (v < 0 ? Theme.danger : Theme.text)
}

/// The asset-class hues of the desktop's composition bar.
func pfClassHue(_ key: String) -> Color {
    switch key {
    case "stocks": return Color(rgb: 0x4F6BED)
    case "cash": return Color(rgb: 0x16A34A)
    case "realestate": return Color(rgb: 0xD97706)
    default: return Theme.textTertiary
    }
}

/// A quiet labelled statistic, the shape the ticker page's stat row uses.
struct PfStat: View {
    let label: String
    let value: String
    var tone: Color = Theme.text
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase).tracking(0.7)
                .foregroundStyle(Theme.textTertiary)
            Text(value).font(.system(size: 17, weight: .semibold).monospacedDigit())
                .foregroundStyle(tone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A property row: 96pt label gutter, the Mac's detail-pane shape.
struct PfProp: View {
    let label: String
    let value: String
    var tone: Color = Theme.text
    var last: Bool = false
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Text(label).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                    .frame(width: 104, alignment: .leading)
                Text(value).font(.system(size: 15)).foregroundStyle(tone)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            if !last { Divider().padding(.leading, 14) }
        }
    }
}

func pfPropCard<C: View>(@ViewBuilder _ content: () -> C) -> some View {
    VStack(spacing: 0) { content() }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
}

/// A chip. Copied rather than imported: the Email AI one is file-private.
struct PfChip: View {
    let text: String
    var filled = false
    var tone: Color? = nil
    var body: some View {
        Text(text).font(.system(size: 12, weight: .semibold))
            .foregroundStyle(filled ? Theme.bg : (tone ?? Theme.textSecondary))
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(Capsule().fill(filled ? Theme.text : Theme.surface))
            .overlay(Capsule().strokeBorder(filled ? Theme.text : (tone ?? Theme.border)))
    }
}

// MARK: - The app: a scope of the portfolio

/// `scope` is "all" or an account id — the desktop's `setScope` vocabulary.
struct PortfolioView: View {
    var scope: String = "all"
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var drawerOpen = false
    @State private var range = "1y"
    @State private var showAllHoldings = false

    /// One cache slot per scope, so switching accounts does not thrash the
    /// overview's cached digest (and each keeps its own "Updated …" stamp).
    private var viewName: String { scope == "all" ? "portfolio" : "portfolio:\(scope)" }

    private var params: [String: JSONValue]? {
        scope == "all" ? nil : ["accountId": .string(scope)]
    }

    var body: some View {
        let _ = views.revision
        let snap = views.view(viewName, ttl: PORTFOLIO_TTL, request: "portfolio", params: params)
        let d = snap.data?.objectValue

        ZStack(alignment: .leading) {
            ScreenColumn {
                ScreenHead(title(d), sub: sub(d, snap)) {
                    HeadAction(symbol: "line.3.horizontal", label: "Accounts") {
                        withAnimation(.easeOut(duration: 0.2)) { drawerOpen = true }
                    }
                    macViewRefreshAction(views, viewName)
                }

                if let d = d {
                    masthead(d)
                    pricesLine(d)
                    chart(d)
                    briefCard(d)
                    strategyLine(d)
                    holdings(d)
                    watchlist(d)
                    properties(d)
                    liabilities(d)
                    AskDoor(label: "Ask about your portfolio…") {
                        router.openCompose(prefill: "About my portfolio: ")
                    }
                    MacViewUpdatedLine(at: snap.at, error: snap.error)
                } else {
                    EmptyText(snap.loading ? "Computing on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
                }
            }

            if drawerOpen {
                Color.black.opacity(0.25).ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }
                    .transition(.opacity)
                PortfolioDrawer(data: d, selected: scope) { pick in
                    withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false }
                    pick()
                }
                .transition(.move(edge: .leading))
            }
        }
        .pushedScreen()
    }

    // MARK: head

    private func title(_ d: [String: JSONValue]?) -> String {
        if scope == "all" { return "Portfolio" }
        return d?["account"]?["name"]?.stringValue ?? "Account"
    }

    private func sub(_ d: [String: JSONValue]?, _ snap: MacViews.Snapshot) -> String {
        guard let d = d else { return snap.loading ? "Asking your Mac…" : "From your Mac" }
        if scope != "all" {
            let t = d["account"]?["typeLabel"]?.stringValue ?? ""
            let n = d["holdings"]?.arrayValue?.count ?? 0
            return [t, "\(n) position\(n == 1 ? "" : "s")"].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        let n = d["accounts"]?.arrayValue?.count ?? 0
        return "\(n) account\(n == 1 ? "" : "s")"
    }

    // MARK: masthead

    private func masthead(_ d: [String: JSONValue]) -> some View {
        let totalValue = d["totalValue"]?.numberValue
        let netWorth = d["netWorth"]?.numberValue
        let debt = d["liabilitiesTotal"]?.numberValue ?? 0
        let hasDebt = debt > 0 && (netWorth?.isFinite ?? false)
        let headline = hasDebt ? netWorth : totalValue
        let day = d["dayChange"]?.numberValue
        let pl = d["totalPL"]?.numberValue

        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(hasDebt ? "Net worth" : "Total value")
                    .font(.system(size: 11, weight: .semibold)).textCase(.uppercase).tracking(0.7)
                    .foregroundStyle(Theme.textTertiary)
                Text(pfMoney(headline)).displayStyle(34).monospacedDigit()
                if hasDebt {
                    Text("Assets \(pfMoney(totalValue)) · debt \(pfMoney(debt))")
                        .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                }
            }
            HStack(spacing: 8) {
                if let v = day, v.isFinite, (d["dayBase"]?.numberValue ?? 0) > 0 {
                    PfChip(text: pfChange(v, d["dayChangePercent"]?.numberValue) + " today", tone: pfTone(v))
                }
                if let v = pl, v.isFinite, (d["totalCost"]?.numberValue ?? 0) > 0 {
                    PfChip(text: pfChange(v, d["totalPLPercent"]?.numberValue) + " all time", tone: pfTone(v))
                }
            }
            if let a = d["after"]?.objectValue, let c = a["change"]?.numberValue, c.isFinite {
                Text("\(a["session"]?.stringValue == "pre" ? "Pre" : "After hours") \(pfChange(c, nil))")
                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
            }
            CompositionBar(parts: (d["composition"]?.arrayValue ?? []).map {
                ($0["label"]?.stringValue ?? "", $0["value"]?.numberValue ?? 0, pfClassHue($0["key"]?.stringValue ?? ""))
            })
        }
        .padding(.vertical, 2)
    }

    /// Honest about what "today" is measured from — shown only when the
    /// newest quote is not fresh, which is the home card's own rule.
    @ViewBuilder private func pricesLine(_ d: [String: JSONValue]) -> some View {
        if let ms = d["pricesAsOf"]?.numberValue, ms > 0 {
            let at = Date(timeIntervalSince1970: ms / 1000)
            if Date().timeIntervalSince(at) > 15 * 60 {
                Text("Prices as of \(MacViews.agoLabel(at))")
                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
            }
        }
    }

    @ViewBuilder private func chart(_ d: [String: JSONValue]) -> some View {
        let hist = d["history"]?.arrayValue ?? []
        if hist.count > 1 {
            let cut = rangeCutoff(range)
            let vals = hist
                .filter { cut == nil || ($0["date"]?.stringValue ?? "") >= cut! }
                .compactMap { $0["value"]?.numberValue }
            RangedChart(values: vals,
                        ranges: [("1m", "1M"), ("3m", "3M"), ("1y", "1Y"), ("all", "All")],
                        range: $range,
                        emptyText: "Not enough snapshots in this range yet.")
        }
    }

    /// Dates come as YYYY-MM-DD, so the cutoff is a string compare.
    private func rangeCutoff(_ r: String) -> String? {
        let days: Int
        switch r {
        case "1m": days = 30
        case "3m": days = 91
        case "1y": days = 365
        default: return nil
        }
        let d = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    // MARK: sections

    @ViewBuilder private func briefCard(_ d: [String: JSONValue]) -> some View {
        if let b = d["brief"]?.objectValue, (b["available"]?.boolValue ?? false) {
            PortfolioBriefCard(brief: b, onWrite: { force in
                views.request("portfolio-action", params: [
                    "action": .string("write-brief"), "force": .bool(force)
                ]) { r in
                    switch r {
                    case .success: router.showToast("Writing today's brief on your Mac…")
                    case .failure(let e): router.showToast(e.localizedDescription)
                    }
                }
            })
        }
    }

    @ViewBuilder private func strategyLine(_ d: [String: JSONValue]) -> some View {
        if let s = d["strategy"]?.objectValue {
            Button { router.push(.strategy(s["id"]?.stringValue ?? "")) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(s["name"]?.stringValue ?? "Plan")
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        if (s["inherited"]?.boolValue ?? false) { PfChip(text: "overall plan") }
                        if s["status"]?.stringValue == "draft" { PfChip(text: "Unfinished") }
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    if let r = s["report"]?.objectValue, !(r["empty"]?.boolValue ?? false) {
                        HStack(spacing: 8) {
                            PfChip(text: strategyWord(r["status"]?.stringValue ?? ""), tone: strategyTone(r["status"]?.stringValue ?? ""))
                            Text(r["headline"]?.stringValue ?? "")
                                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if let o = s["objective"]?.stringValue, !o.isEmpty {
                        Text(o).font(.system(size: 13)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func holdings(_ d: [String: JSONValue]) -> some View {
        let rows = d["holdings"]?.arrayValue ?? []
        if !rows.isEmpty {
            let shown = showAllHoldings ? rows : Array(rows.prefix(12))
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Holdings", count: rows.count)
                CardList {
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, h in
                        HoldingRow(h: h, last: i == shown.count - 1 && (d["cash"]?.numberValue ?? 0) == 0) {
                            router.push(.ticker(h["ticker"]?.stringValue ?? ""))
                        }
                    }
                    if let cash = d["cash"]?.numberValue, cash != 0 {
                        RowView("Cash", sub: "Uninvested", last: true) {
                            Text(pfMoney(cash)).font(.system(size: 14, weight: .medium).monospacedDigit())
                                .foregroundStyle(Theme.text)
                        }
                    }
                }
                if rows.count > 12 {
                    Button(showAllHoldings ? "Show fewer" : "Show all \(rows.count)") {
                        withAnimation { showAllHoldings.toggle() }
                    }
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private func watchlist(_ d: [String: JSONValue]) -> some View {
        let rows = d["watchlist"]?.arrayValue ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Watchlist", count: rows.count)
                CardList {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, w in
                        Button { router.push(.ticker(w["ticker"]?.stringValue ?? "")) } label: {
                            RowView(w["ticker"]?.stringValue ?? "",
                                    sub: w["name"]?.stringValue,
                                    last: i == rows.count - 1) {
                                VStack(alignment: .trailing, spacing: 1) {
                                    Text(pfMoney(w["price"]?.numberValue, cents: true))
                                        .font(.system(size: 14, weight: .medium).monospacedDigit())
                                        .foregroundStyle(Theme.text)
                                    if let c = w["changePercent"]?.numberValue, c.isFinite {
                                        Text((c > 0 ? "+" : "") + pfPercent(c))
                                            .font(.system(size: 12).monospacedDigit())
                                            .foregroundStyle(pfTone(c))
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder private func properties(_ d: [String: JSONValue]) -> some View {
        let rows = d["properties"]?.arrayValue ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Real estate", count: rows.count)
                CardList {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, p in
                        Button { router.push(.portfolioProperty(p["id"]?.stringValue ?? "")) } label: {
                            RowView(p["name"]?.stringValue ?? "Property",
                                    sub: p["address"]?.stringValue, last: i == rows.count - 1) {
                                Text(pfMoney(p["currentValue"]?.numberValue))
                                    .font(.system(size: 14, weight: .medium).monospacedDigit())
                                    .foregroundStyle(Theme.text)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder private func liabilities(_ d: [String: JSONValue]) -> some View {
        let rows = d["liabilities"]?.arrayValue ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Liabilities", count: rows.count)
                CardList {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, l in
                        Button { router.push(.portfolioLiability(l["id"]?.stringValue ?? "")) } label: {
                            RowView(l["name"]?.stringValue ?? "Debt",
                                    sub: [l["typeLabel"]?.stringValue, l["lender"]?.stringValue]
                                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                                    last: i == rows.count - 1) {
                                Text("−" + pfMoney(l["balance"]?.numberValue))
                                    .font(.system(size: 14, weight: .medium).monospacedDigit())
                                    .foregroundStyle(Theme.text)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let m = d["monthlyPayments"]?.numberValue, m > 0 {
                    Text("\(pfMoney(m)) a month across these")
                        .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }
        }
    }
}

func strategyWord(_ s: String) -> String {
    switch s {
    case "on-track": return "On plan"
    case "drift": return "Drifting"
    case "breach": return "Off plan"
    default: return "No data"
    }
}

func strategyTone(_ s: String) -> Color {
    switch s {
    case "on-track": return Theme.success
    case "drift": return Theme.warning
    case "breach": return Theme.danger
    default: return Theme.border
    }
}

// MARK: - Holding row

private struct HoldingRow: View {
    let h: JSONValue
    let last: Bool
    let action: () -> Void

    var body: some View {
        let value = h["value"]?.numberValue
        let day = h["dayChange"]?.numberValue
        let pl = h["pl"]?.numberValue
        return Button(action: action) {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(h["label"]?.stringValue ?? h["ticker"]?.stringValue ?? "")
                            .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Text(sub).font(.system(size: 12)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(pfMoney(value)).font(.system(size: 15, weight: .semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                        if let d = day, d.isFinite {
                            Text(pfChange(d, h["dayPercent"]?.numberValue))
                                .font(.system(size: 12).monospacedDigit()).foregroundStyle(pfTone(d))
                        } else if let p = pl, p.isFinite {
                            Text(pfChange(p, h["plPercent"]?.numberValue))
                                .font(.system(size: 12).monospacedDigit()).foregroundStyle(pfTone(p))
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .contentShape(Rectangle())
                if !last { Divider().padding(.leading, 14) }
            }
        }
        .buttonStyle(.plain)
    }

    /// Shares · avg cost · weight — the desktop's columns, folded into a line.
    private var sub: String {
        var bits: [String] = []
        if let s = h["shares"]?.numberValue {
            let whole = s == s.rounded()
            bits.append((whole ? String(Int(s)) : String(format: "%.4g", s)) + " @ " + pfMoney(h["avgCost"]?.numberValue, cents: true))
        }
        if let w = h["weight"]?.numberValue, w.isFinite { bits.append(pfPercent(w) + " of book") }
        if let n = h["name"]?.stringValue, !n.isEmpty, bits.isEmpty { bits.append(n) }
        return bits.joined(separator: " · ")
    }
}

// MARK: - The nav drawer

private struct PortfolioDrawer: View {
    let data: [String: JSONValue]?
    let selected: String
    let onPick: (@escaping () -> Void) -> Void
    @EnvironmentObject var router: Router

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Accounts").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                    row("All accounts", sub: allSub, active: selected == "all") {
                        onPick { if selected != "all" { router.push(.portfolioScope("all")) } }
                    }
                    ForEach(Array((data?["accounts"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, a in
                        let id = a["id"]?.stringValue ?? ""
                        row(a["name"]?.stringValue ?? "Account",
                            sub: [a["typeLabel"]?.stringValue ?? "", pfMoney(a["value"]?.numberValue)]
                                .filter { !$0.isEmpty }.joined(separator: " · "),
                            active: selected == id) {
                            onPick { if selected != id { router.push(.portfolioScope(id)) } }
                        }
                    }

                    Text("Tickers").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                    row("All tickers", sub: tickersSub, active: false) {
                        onPick { router.push(.portfolioTickers) }
                    }

                    Text("Plan").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                    row("Strategy", sub: nil, active: false) {
                        onPick { router.push(.strategy("")) }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .frame(width: 270)
        .frame(maxHeight: .infinity)
        .background(Theme.bg)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 0.5) }
        .ignoresSafeArea(edges: .bottom)
    }

    private var allSub: String {
        guard let d = data else { return "" }
        if let debt = d["liabilitiesTotal"]?.numberValue, debt > 0 {
            return "Net worth " + pfMoney(d["netWorth"]?.numberValue)
        }
        let n = d["accounts"]?.arrayValue?.count ?? 0
        return pfMoney(d["totalValue"]?.numberValue) + " · \(n) account\(n == 1 ? "" : "s")"
    }

    private var tickersSub: String {
        guard let t = data?["tickersNav"]?.objectValue else { return "" }
        let held = Int(t["held"]?.numberValue ?? 0)
        let watching = Int(t["watching"]?.numberValue ?? 0)
        return "\(held) held" + (watching > 0 ? " · \(watching) watching" : "")
    }

    private func row(_ label: String, sub: String?, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(Theme.text)
                if let s = sub, !s.isEmpty {
                    Text(s).font(.system(size: 12)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(active ? Theme.surface : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
    }
}

// MARK: - The daily brief

private struct PortfolioBriefCard: View {
    let brief: [String: JSONValue]
    let onWrite: (Bool) -> Void
    @State private var expanded = false

    var body: some View {
        let text = brief["text"]?.stringValue ?? ""
        let writing = brief["writing"]?.boolValue ?? false
        let stale = brief["stale"]?.boolValue ?? false
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                SectionLabel("Today's brief")
                Spacer()
                if !text.isEmpty {
                    PfChip(text: stale ? "Yesterday" : "AI", tone: stale ? nil : Theme.accent)
                }
            }
            if writing {
                Text("Writing today's brief on your Mac…")
                    .font(.system(size: 14)).italic().foregroundStyle(Theme.textTertiary)
            } else if !text.isEmpty {
                MarkdownView(text: expanded ? text : RecordText.preview(text, 420))
                    .font(.system(size: 15))
                HStack(spacing: 14) {
                    if text.count > 420 {
                        Button(expanded ? "Show less" : "Read it all") { withAnimation { expanded.toggle() } }
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                    }
                    Button(stale ? "Write today's" : "Rewrite now") { onWrite(!stale) }
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary)
                        .buttonStyle(.plain)
                }
            } else if let e = brief["error"]?.stringValue, !e.isEmpty {
                Text(e).font(.system(size: 13)).foregroundStyle(Theme.danger)
                SecondaryButton(label: "Try again") { onWrite(true) }
            } else {
                SecondaryButton(label: "Write today's brief with \(brief["destination"]?.stringValue ?? "your model")") { onWrite(false) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

// MARK: - Property and liability details

struct PortfolioPropertyDetail: View {
    let id: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = views.revision
        let d = views.view("portfolio", ttl: PORTFOLIO_TTL).data?.objectValue
        let p = (d?["properties"]?.arrayValue ?? []).first { $0["id"]?.stringValue == id }
        let debts = (d?["liabilities"]?.arrayValue ?? []).filter { $0["propertyId"]?.stringValue == id }
        let owed = debts.reduce(0.0) { $0 + ($1["balance"]?.numberValue ?? 0) }

        ScreenColumn(spacing: 18) {
            if let p = p {
                let value = p["currentValue"]?.numberValue
                let paid = p["purchasePrice"]?.numberValue
                let gain = (value ?? 0) - (paid ?? 0)
                ScreenHead(p["name"]?.stringValue ?? "Property", sub: p["address"]?.stringValue)
                pfPropCard {
                    PfProp(label: "Current value", value: pfMoney(value))
                    PfProp(label: "Purchase price", value: pfMoney(paid))
                    PfProp(label: "Gain", value: pfChange(gain, paid.map { $0 > 0 ? gain / $0 * 100 : nil } ?? nil), tone: pfTone(gain))
                    PfProp(label: "Purchased", value: p["purchaseDate"]?.stringValue ?? "—", last: debts.isEmpty)
                    if !debts.isEmpty {
                        PfProp(label: "Secured debt", value: pfMoney(owed))
                        PfProp(label: "Equity", value: pfMoney((value ?? 0) - owed), last: true)
                    }
                }
                if !debts.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel("Secured by")
                        CardList {
                            ForEach(Array(debts.enumerated()), id: \.offset) { i, l in
                                Button { router.push(.portfolioLiability(l["id"]?.stringValue ?? "")) } label: {
                                    RowView(l["name"]?.stringValue ?? "Debt", sub: l["lender"]?.stringValue, last: i == debts.count - 1) {
                                        Text("−" + pfMoney(l["balance"]?.numberValue))
                                            .font(.system(size: 14, weight: .medium).monospacedDigit())
                                            .foregroundStyle(Theme.text)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if let n = p["notes"]?.stringValue, !n.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel("Notes")
                        Text(n).font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                ScreenHead("Property")
                EmptyText("That property is no longer on your Mac.")
            }
        }
        .pushedScreen()
    }
}

struct PortfolioLiabilityDetail: View {
    let id: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = views.revision
        let d = views.view("portfolio", ttl: PORTFOLIO_TTL).data?.objectValue
        let l = (d?["liabilities"]?.arrayValue ?? []).first { $0["id"]?.stringValue == id }
        let property = (d?["properties"]?.arrayValue ?? []).first { $0["id"]?.stringValue == l?["propertyId"]?.stringValue }

        ScreenColumn(spacing: 18) {
            if let l = l {
                let balance = l["balance"]?.numberValue
                let original = l["originalAmount"]?.numberValue
                ScreenHead(l["name"]?.stringValue ?? "Debt",
                           sub: [l["typeLabel"]?.stringValue, l["lender"]?.stringValue]
                            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                pfPropCard {
                    PfProp(label: "Balance", value: pfMoney(balance))
                    if let o = original, o > 0 {
                        let paid = o - (balance ?? 0)
                        PfProp(label: "Original", value: pfMoney(o))
                        PfProp(label: "Paid down", value: pfMoney(paid) + " (" + pfPercent(paid / o * 100) + ")")
                    }
                    if let r = l["interestRate"]?.numberValue { PfProp(label: "Rate", value: pfPercent(r, digits: 2)) }
                    if let m = l["monthlyPayment"]?.numberValue { PfProp(label: "Monthly", value: pfMoney(m)) }
                    PfProp(label: "Started", value: l["startDate"]?.stringValue ?? "—", last: property == nil)
                    if let p = property {
                        PfProp(label: "Secured by", value: p["name"]?.stringValue ?? "")
                        PfProp(label: "Equity", value: pfMoney((p["currentValue"]?.numberValue ?? 0) - (balance ?? 0)), last: true)
                    }
                }
                if let n = l["notes"]?.stringValue, !n.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel("Notes")
                        Text(n).font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                ScreenHead("Debt")
                EmptyText("That debt is no longer on your Mac.")
            }
        }
        .pushedScreen()
    }
}
