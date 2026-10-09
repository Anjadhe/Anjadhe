import SwiftUI
import AnjadheCore

// One ticker's detail and the Strategy scope (2026-09-21). Companions to
// Portfolio.swift; see its header for the lane and colour laws.
//
// 2026-10-09 (docs/COACH.md §7): the Tickers page (every held or watched
// symbol, its Indicators view of the AI profile's verdicts) is gone, and the
// ticker detail is the person's own data only — no Watch star, no business
// profile or verdict tiles, no headlines. What stays: the quote, the chart,
// the company's own description, positions by account, transactions, the
// owner's notes and the "Open in" sites.

/// A segmented control. Copied rather than imported: the Email AI one is
/// file-private and takes a Bool.
struct Segmented: View {
    let options: [(String, String)]
    @Binding var value: String
    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { o in
                Button { value = o.0 } label: {
                    Text(o.1).font(.system(size: 13, weight: value == o.0 ? .semibold : .medium))
                        .foregroundStyle(value == o.0 ? Theme.bg : Theme.textSecondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(value == o.0 ? Theme.text : .clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: Theme.radiusSm + 3).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm + 3).strokeBorder(Theme.border))
    }
}

// MARK: - Ticker detail

struct PortfolioTickerDetail: View {
    let ticker: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var range = "1y"
    @State private var tab = "holdings"

    private var slot: String { "portfolio-ticker:\(ticker):\(range)" }

    var body: some View {
        let _ = views.revision
        let snap = views.view(slot, ttl: PORTFOLIO_TTL, request: "portfolio-ticker",
                              params: ["ticker": .string(ticker), "range": .string(range)])
        let d = snap.data?.objectValue

        ScreenColumn(spacing: 18) {
            ScreenHead(d?["label"]?.stringValue ?? ticker, sub: headSub(d)) {
                macViewRefreshAction(views, slot)
            }

            if let d = d {
                quoteRow(d)
                RangedChart(values: (d["marketHistory"]?.arrayValue ?? []).compactMap { $0["price"]?.numberValue },
                            ranges: [("1m", "1M"), ("3m", "3M"), ("1y", "1Y"), ("5y", "5Y"), ("max", "Max")],
                            range: $range,
                            emptyText: "No price history came back for this range.")
                if let o = d["option"]?.objectValue { optionCard(o) }
                if let c = d["company"]?.objectValue { companyCard(c) }
                positionsSection(d)
                notesSection(d)
                tickerChat(d)
                openInRow(d)
                MacViewUpdatedLine(at: snap.at, error: snap.error)
            } else {
                EmptyText(snap.loading ? "Looking it up on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
            }
        }
        .pushedScreen()
    }

    /// The position's own conversation (`portfolio:ticker:<SYMBOL>`, an
    /// option's underlying), the one the desktop's ticker page opens.
    private func tickerChat(_ d: [String: JSONValue]) -> some View {
        let sym = d["subject"]?.stringValue ?? d["option"]?["underlying"]?.stringValue ?? ticker
        let label = d["label"]?.stringValue ?? ticker
        return TiedChatDoor(tie: .record("portfolio:ticker:\(sym)", title: label,
                                         body: "It is your \(label) position",
                                         placeholder: "Ask about your \(label) position…",
                                         resume: "Continue our conversation about \(label)…"))
    }

    private func headSub(_ d: [String: JSONValue]?) -> String {
        guard let d = d else { return "From your Mac" }
        let name = d["company"]?["name"]?.stringValue ?? ""
        let sector = d["company"]?["sector"]?.stringValue ?? ""
        return [name, sector].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func quoteRow(_ d: [String: JSONValue]) -> some View {
        let q = d["quote"]?.objectValue ?? [:]
        let h = d["holding"]?.objectValue
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                PfStat(label: "Price", value: pfMoney(q["price"]?.numberValue, cents: true))
                PfStat(label: "Day", value: pfChange(q["change"]?.numberValue, q["changePercent"]?.numberValue),
                       tone: pfTone(q["change"]?.numberValue))
            }
            if let h = h {
                HStack(alignment: .top, spacing: 12) {
                    PfStat(label: "Value", value: pfMoney(h["value"]?.numberValue))
                    PfStat(label: "P&L", value: pfChange(h["pl"]?.numberValue, h["plPercent"]?.numberValue),
                           tone: pfTone(h["pl"]?.numberValue))
                }
                HStack(alignment: .top, spacing: 12) {
                    PfStat(label: "Shares", value: h["shares"]?.numberValue.map { $0 == $0.rounded() ? String(Int($0)) : String(format: "%.4g", $0) } ?? "—")
                    PfStat(label: "Avg cost", value: pfMoney(h["avgCost"]?.numberValue, cents: true))
                }
                if let w = h["weight"]?.numberValue, w.isFinite {
                    Text("\(pfPercent(w)) of your book")
                        .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }
        }
    }

    private func optionCard(_ o: [String: JSONValue]) -> some View {
        pfPropCard {
            PfProp(label: "Underlying", value: o["underlying"]?.stringValue ?? "")
            PfProp(label: "Type", value: (o["optionType"]?.stringValue ?? "").capitalized)
            PfProp(label: "Strike", value: pfMoney(o["strike"]?.numberValue, cents: true))
            PfProp(label: "Expires", value: o["expiration"]?.stringValue ?? "—")
            PfProp(label: "Days left", value: o["daysToExpiry"]?.numberValue.map { String(Int($0)) } ?? "—", last: true)
        }
    }

    private func companyCard(_ c: [String: JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let desc = c["description"]?.stringValue, !desc.isEmpty {
                Text(desc).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .lineLimit(6).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if let s = c["sector"]?.stringValue, !s.isEmpty { PfChip(text: s) }
                if let t = c["type"]?.stringValue, !t.isEmpty { PfChip(text: t.capitalized) }
            }
        }
    }

    // MARK: notes

    /// The owner's notes on the symbol (the Mac's decisions on
    /// `portfolio:ticker:<symbol>`); once the footer of the AI profile.
    @ViewBuilder private func notesSection(_ d: [String: JSONValue]) -> some View {
        if let notes = d["decisions"]?.arrayValue, !notes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Your notes")
                ForEach(Array(notes.enumerated()), id: \.offset) { _, n in
                    Text("• " + (n.stringValue ?? ""))
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: positions

    @ViewBuilder private func positionsSection(_ d: [String: JSONValue]) -> some View {
        let byAccount = d["byAccount"]?.arrayValue ?? []
        let txns = d["transactions"]?.arrayValue ?? []
        if !byAccount.isEmpty || !txns.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Segmented(options: [("holdings", "By account"), ("transactions", "Transactions")], value: $tab)
                if tab == "holdings" {
                    if byAccount.isEmpty { EmptyText("You hold none of this today.") }
                    CardList {
                        ForEach(Array(byAccount.enumerated()), id: \.offset) { i, a in
                            RowView(a["accountName"]?.stringValue ?? "",
                                    sub: [a["typeLabel"]?.stringValue ?? "",
                                          a["shares"]?.numberValue.map { ($0 == $0.rounded() ? String(Int($0)) : String(format: "%.4g", $0)) + " sh" } ?? ""]
                                        .filter { !$0.isEmpty }.joined(separator: " · "),
                                    last: i == byAccount.count - 1) {
                                VStack(alignment: .trailing, spacing: 1) {
                                    Text(pfMoney(a["value"]?.numberValue))
                                        .font(.system(size: 14, weight: .medium).monospacedDigit()).foregroundStyle(Theme.text)
                                    if let p = a["pl"]?.numberValue, p.isFinite {
                                        Text(pfChange(p, a["plPercent"]?.numberValue))
                                            .font(.system(size: 12).monospacedDigit()).foregroundStyle(pfTone(p))
                                    }
                                }
                            }
                        }
                    }
                } else {
                    if txns.isEmpty { EmptyText("No transactions recorded.") }
                    CardList {
                        ForEach(Array(txns.prefix(40).enumerated()), id: \.offset) { i, t in
                            RowView(txnTitle(t), sub: t["date"]?.stringValue, last: i == min(40, txns.count) - 1) {
                                Text(pfMoney(t["amount"]?.numberValue))
                                    .font(.system(size: 14, weight: .medium).monospacedDigit()).foregroundStyle(Theme.text)
                            }
                        }
                    }
                }
            }
        }
    }

    private func txnTitle(_ t: JSONValue) -> String {
        let type = (t["type"]?.stringValue ?? "").uppercased()
        let qty = t["quantity"]?.numberValue.map { $0 == $0.rounded() ? String(Int($0)) : String(format: "%.4g", $0) } ?? ""
        let price = pfMoney(t["pricePerShare"]?.numberValue, cents: true)
        return "\(type) \(qty) @ \(price)"
    }

    @ViewBuilder private func openInRow(_ d: [String: JSONValue]) -> some View {
        let sites = d["sites"]?.arrayValue ?? []
        if !sites.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Open in")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(sites.enumerated()), id: \.offset) { _, s in
                            Button { openURL(s["url"]?.stringValue ?? "") } label: {
                                PfChip(text: s["label"]?.stringValue ?? "")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 1)
                }
            }
        }
    }
}

// MARK: - Strategy

/// The Plan scope: the list of plans, or one in full. Reading is UI; every
/// WRITE is a conversation — the desktop's law, and the reason this screen
/// has no form.
struct PortfolioStrategyView: View {
    let strategyId: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router

    private var slot: String { strategyId.isEmpty ? "portfolio-strategy" : "portfolio-strategy:\(strategyId)" }

    var body: some View {
        let _ = views.revision
        let snap = views.view(slot, ttl: PORTFOLIO_TTL, request: "portfolio-strategy",
                              params: strategyId.isEmpty ? nil : ["strategyId": .string(strategyId)])
        let d = snap.data?.objectValue

        ScreenColumn(spacing: 18) {
            if let one = d?["strategy"]?.objectValue {
                ScreenHead(one["name"]?.stringValue ?? "Plan", sub: metaLine(one)) { macViewRefreshAction(views, slot) }
                detail(one)
                MacViewUpdatedLine(at: snap.at, error: snap.error)
            } else if let list = d?["strategies"]?.arrayValue {
                ScreenHead("Strategy", sub: list.isEmpty ? "No plan yet" : "\(list.count) plan\(list.count == 1 ? "" : "s")") {
                    macViewRefreshAction(views, slot)
                }
                if list.isEmpty {
                    EmptyText("No plan yet. Your assistant can write one with you — it asks about purpose, horizon, risk, allocation and guardrails.")
                    if let agenda = d?["agenda"]?.arrayValue, !agenda.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel("What it will ask")
                            CardList {
                                ForEach(Array(agenda.enumerated()), id: \.offset) { i, t in
                                    RowView(t["question"]?.stringValue ?? "", last: i == agenda.count - 1)
                                }
                            }
                        }
                    }
                } else {
                    ForEach(Array(list.enumerated()), id: \.offset) { _, s in
                        if let obj = s.objectValue {
                            Button { router.push(.strategy(obj["id"]?.stringValue ?? "")) } label: { card(obj) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                AskDoor(label: "Write a plan with your assistant…") {
                    router.openCompose(prefill: "I want to set an investment strategy: ")
                }
                MacViewUpdatedLine(at: snap.at, error: snap.error)
            } else {
                ScreenHead("Strategy", sub: snap.loading ? "Asking your Mac…" : "From your Mac")
                EmptyText(snap.loading ? "Working it out on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
            }
        }
        .pushedScreen()
    }

    private func metaLine(_ s: [String: JSONValue]) -> String {
        [s["horizon"]?.stringValue ?? "",
         (s["riskLevel"]?.stringValue).map { $0.isEmpty ? "" : "\($0) risk" } ?? ""]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func card(_ s: [String: JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(s["name"]?.stringValue ?? "Plan").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                if s["isDefault"]?.boolValue ?? false { PfChip(text: "overall plan") }
                if s["status"]?.stringValue == "draft" { PfChip(text: "Unfinished") }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textTertiary)
            }
            if let o = s["objective"]?.stringValue, !o.isEmpty {
                Text(o).font(.system(size: 14)).foregroundStyle(Theme.textSecondary).lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            verdict(s)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }

    @ViewBuilder private func verdict(_ s: [String: JSONValue]) -> some View {
        if let r = s["report"]?.objectValue, !(r["empty"]?.boolValue ?? false) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    PfChip(text: strategyWord(r["status"]?.stringValue ?? ""), tone: strategyTone(r["status"]?.stringValue ?? ""))
                    Text(r["headline"]?.stringValue ?? "").font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let c = r["counts"]?.objectValue {
                    let drifted = Int(c["drifted"]?.numberValue ?? 0)
                    let breaches = Int(c["breaches"]?.numberValue ?? 0)
                    let targets = (r["targets"]?.arrayValue ?? []).count
                    let rules = (r["rules"]?.arrayValue ?? []).count
                    if targets > 0 || rules > 0 {
                        Text("\(targets - drifted) of \(targets) sleeves in band · \(rules - breaches) of \(rules) guardrails held")
                            .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                }
            }
        }
    }

    @ViewBuilder private func detail(_ s: [String: JSONValue]) -> some View {
        if s["status"]?.stringValue == "draft" { PfChip(text: "Unfinished") }
        if let o = s["objective"]?.stringValue, !o.isEmpty {
            Text(o).font(.system(size: 16)).foregroundStyle(Theme.textSecondary).lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        verdict(s)

        pfPropCard {
            PfProp(label: "Approach", value: s["thesis"]?.stringValue ?? "—")
            PfProp(label: "Covers", value: s["coverage"]?.stringValue ?? "—")
            PfProp(label: "Revisit", value: s["reviewCadence"]?.stringValue ?? "—", last: true)
        }

        if let r = s["report"]?.objectValue {
            let targets = r["targets"]?.arrayValue ?? []
            if !targets.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Target mix")
                    CardList {
                        ForEach(Array(targets.enumerated()), id: \.offset) { i, t in
                            targetRow(t, last: i == targets.count - 1)
                        }
                    }
                }
            }
            let rules = r["rules"]?.arrayValue ?? []
            if !rules.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Guardrails")
                    CardList {
                        ForEach(Array(rules.enumerated()), id: \.offset) { i, rl in
                            RowView(rl["label"]?.stringValue ?? rl["text"]?.stringValue ?? "",
                                    sub: rl["detail"]?.stringValue, last: i == rules.count - 1) {
                                Image(systemName: ruleSymbol(rl["status"]?.stringValue ?? ""))
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(ruleTone(rl["status"]?.stringValue ?? ""))
                            }
                        }
                    }
                }
            }
            if let u = r["unclassified"]?.objectValue, let pct = u["pct"]?.numberValue, pct > 0 {
                Text("\(pfPercent(pct)) of the book (\(pfMoney(u["value"]?.numberValue))) is not in the plan.")
                    .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        let followers = s["followers"]?.arrayValue ?? []
        if !followers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Accounts following it", count: followers.count)
                CardList {
                    ForEach(Array(followers.enumerated()), id: \.offset) { i, a in
                        Button { router.push(.portfolioScope(a["id"]?.stringValue ?? "")) } label: {
                            RowView(a["name"]?.stringValue ?? "",
                                    sub: (a["own"]?.boolValue ?? false) ? "Its own plan" : "Follows the overall plan",
                                    last: i == followers.count - 1)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }

        let history = s["history"]?.arrayValue ?? []
        if !history.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Changes")
                CardList {
                    ForEach(Array(history.enumerated()), id: \.offset) { i, h in
                        RowView(h["summary"]?.stringValue ?? "",
                                sub: (h["at"]?.stringValue).map { String($0.prefix(10)) },
                                last: i == history.count - 1)
                    }
                }
            }
        }

        // The plan's own conversation (`portfolio:strategy:<id>`), the one
        // the desktop's Strategy page opens.
        let name = s["name"]?.stringValue ?? ""
        let objective = s["objective"]?.stringValue ?? ""
        TiedChatDoor(tie: .record("portfolio:strategy:\(s["id"]?.stringValue ?? strategyId)",
                                  title: name.isEmpty ? "Strategy" : name,
                                  body: objective.isEmpty ? "" : "Its objective: \(objective)",
                                  placeholder: "Ask about this plan…",
                                  resume: "Continue our conversation about this plan…"))
        Text("nenva is not an investment adviser. This measures your holdings against the plan you wrote.")
            .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func targetRow(_ t: JSONValue, last: Bool) -> some View {
        let actual = t["actualPct"]?.numberValue ?? 0
        let target = t["targetPct"]?.numberValue ?? 0
        let delta = t["deltaValue"]?.numberValue
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(t["label"]?.stringValue ?? "").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Text("\(pfPercent(actual)) of \(pfPercent(target))")
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(t["status"]?.stringValue == "ok" ? Theme.textSecondary : Theme.warning)
                }
                // The bar carries the band; the tick is the target.
                GeometryReader { geo in
                    let scale = max(target * 1.6, actual * 1.2, 1)
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.surfaceHover).frame(height: 5)
                        if let lo = t["minPct"]?.numberValue, let hi = t["maxPct"]?.numberValue {
                            Capsule().fill(Theme.border)
                                .frame(width: max(2, geo.size.width * CGFloat((hi - lo) / scale)), height: 5)
                                .offset(x: geo.size.width * CGFloat(lo / scale))
                        }
                        Capsule().fill(Theme.text)
                            .frame(width: max(2, geo.size.width * CGFloat(actual / scale)), height: 5)
                        Rectangle().fill(Theme.accent)
                            .frame(width: 2, height: 11)
                            .offset(x: geo.size.width * CGFloat(target / scale))
                    }
                }
                .frame(height: 11)
                if let d = delta, abs(d) >= 1 {
                    Text((d > 0 ? "Add " : "Trim ") + pfMoney(abs(d)) + " to reach target")
                        .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            if !last { Divider().padding(.leading, 14) }
        }
    }

    private func ruleSymbol(_ s: String) -> String {
        switch s {
        case "ok": return "checkmark"
        case "breach": return "xmark"
        default: return "ellipsis"
        }
    }

    private func ruleTone(_ s: String) -> Color {
        switch s {
        case "ok": return Theme.success
        case "breach": return Theme.danger
        default: return Theme.textTertiary
        }
    }
}
