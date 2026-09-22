import SwiftUI
import AnjadheCore

// The Tickers page, one ticker's detail, and the Strategy scope (2026-09-21).
// Companions to Portfolio.swift; see its header for the lane and colour laws.

// MARK: - Tickers: every held or watched symbol on one table

/// The desktop's Tickers page, in its two views. Positions is the money;
/// Indicators is the same symbols wearing the business profile's own
/// verdicts. Rows, the verdict SPEC and each column's first-click direction
/// all come from the Mac, so the columns, their tones and "best first" cannot
/// drift from what the desktop shows. Filtering and sorting are pure view
/// state and stay here — a round trip per column tap would be absurd.
struct PortfolioTickersView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @AppStorage("portfolio-tickers-view") private var mode = "positions"
    @AppStorage("portfolio-tickers-source") private var source = "all"
    @State private var query = ""
    @State private var sortCol = "value"
    @State private var sortDesc = true

    var body: some View {
        let _ = views.revision
        let snap = views.view("portfolio-tickers", ttl: PORTFOLIO_TTL)
        let d = snap.data?.objectValue
        let specs = d?["specs"]?.arrayValue ?? []
        let rows = sorted(filtered(d?["rows"]?.arrayValue ?? []))

        ScreenColumn {
            ScreenHead("Tickers", sub: headSub(d)) { macViewRefreshAction(views, "portfolio-tickers") }

            if d == nil {
                EmptyText(snap.loading ? "Consolidating on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
            } else {
                Segmented(options: [("positions", "Positions"), ("indicators", "Indicators")], value: $mode)
                Segmented(options: [("all", "All"), ("held", "Held"), ("watch", "Watching")], value: $source)
                SearchField(placeholder: "Filter by ticker or name", text: $query)
                sortBar(specs)

                if rows.isEmpty {
                    EmptyText(query.isEmpty ? "Nothing here yet." : "No ticker matches “\(query)”.")
                } else {
                    CardList {
                        ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                            Button { router.push(.ticker(r["ticker"]?.stringValue ?? "")) } label: {
                                if mode == "indicators" {
                                    indicatorRow(r, specs: specs, last: i == rows.count - 1)
                                } else {
                                    positionRow(r, last: i == rows.count - 1)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                MacViewUpdatedLine(at: snap.at, error: snap.error)
            }
        }
        .pushedScreen()
        .onChange(of: mode) { _ in
            // Each view has its own natural first sort, as on the Mac.
            sortCol = mode == "indicators" ? "ticker" : "value"
            sortDesc = mode != "indicators"
        }
    }

    private func headSub(_ d: [String: JSONValue]?) -> String {
        guard let d = d else { return "From your Mac" }
        if mode == "indicators", let s = d["indicatorSummary"]?.objectValue {
            let total = Int(s["total"]?.numberValue ?? 0)
            let profiled = Int(s["profiled"]?.numberValue ?? 0)
            let today = Int(s["today"]?.numberValue ?? 0)
            var bits = ["\(profiled) of \(total) profiled"]
            if today > 0 { bits.append("\(today) today") }
            if total > profiled { bits.append("\(total - profiled) waiting") }
            return bits.joined(separator: " · ")
        }
        guard let s = d["summary"]?.objectValue else { return "From your Mac" }
        let held = Int(s["held"]?.numberValue ?? 0)
        let watched = Int(s["watched"]?.numberValue ?? 0)
        var bits = ["\(held) held"]
        if watched > 0 { bits.append("\(watched) watching") }
        if let v = s["value"]?.numberValue { bits.append(pfMoney(v)) }
        return bits.joined(separator: " · ")
    }

    // MARK: filter / sort — the Mac's own predicates, in Swift

    private func filtered(_ rows: [JSONValue]) -> [JSONValue] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return rows.filter { r in
            let held = r["held"]?.boolValue ?? false
            let watched = r["watched"]?.boolValue ?? false
            if source == "held" && !held { return false }
            // "Watching" keeps a row that is both, as on the Mac.
            if source == "watch" && !watched { return false }
            if q.isEmpty { return true }
            let hay = [(r["ticker"]?.stringValue ?? ""), (r["label"]?.stringValue ?? ""), (r["name"]?.stringValue ?? "")]
                .joined(separator: " ").lowercased()
            return hay.contains(q)
        }
    }

    /// Missing values always sink, in BOTH directions — the desktop's rule,
    /// and the reason an unwritten profile never reads as the low end.
    private func sorted(_ rows: [JSONValue]) -> [JSONValue] {
        func text(_ r: JSONValue) -> String? {
            switch sortCol {
            case "ticker": return r["label"]?.stringValue ?? r["ticker"]?.stringValue
            case "name": return r["name"]?.stringValue
            default: return nil
            }
        }
        func number(_ r: JSONValue) -> Double? {
            if sortCol.hasPrefix("ind:") {
                let key = String(sortCol.dropFirst(4))
                guard let ind = r["ind"]?[key]?.objectValue,
                      let rank = ind["rank"]?.numberValue else { return nil }
                return rank
            }
            switch sortCol {
            case "value": return r["value"]?.numberValue
            case "day": return r["dayPct"]?.numberValue
            case "pl": return r["pl"]?.numberValue
            case "weight": return r["weight"]?.numberValue
            case "price": return r["price"]?.numberValue
            default: return nil
            }
        }
        let textual = sortCol == "ticker" || sortCol == "name"
        return rows.sorted { a, b in
            if textual {
                let ta = text(a) ?? "", tb = text(b) ?? ""
                // An empty name sinks, like any other missing value.
                if ta.isEmpty != tb.isEmpty { return tb.isEmpty }
                let r = ta.localizedCaseInsensitiveCompare(tb)
                if r == .orderedSame { return false }
                return sortDesc ? r == .orderedDescending : r == .orderedAscending
            }
            let na = number(a), nb = number(b)
            if na == nil && nb == nil { return false }
            if na == nil { return false }   // missing sinks
            if nb == nil { return true }
            if na! == nb! { return false }
            return sortDesc ? na! > nb! : na! < nb!
        }
    }

    @ViewBuilder private func sortBar(_ specs: [JSONValue]) -> some View {
        let cols: [(String, String)] = mode == "indicators"
            ? [("ticker", "Ticker")] + specs.map { ("ind:" + ($0["key"]?.stringValue ?? ""), $0["label"]?.stringValue ?? "") }
            : [("value", "Value"), ("day", "Day"), ("pl", "P&L"), ("weight", "Weight"), ("ticker", "Ticker")]
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(cols, id: \.0) { col in
                    Button { tapSort(col.0, specs) } label: {
                        HStack(spacing: 3) {
                            Text(col.1).font(.system(size: 12, weight: sortCol == col.0 ? .semibold : .regular))
                            if sortCol == col.0 {
                                Image(systemName: sortDesc ? "arrow.down" : "arrow.up").font(.system(size: 9, weight: .bold))
                            }
                        }
                        .foregroundStyle(sortCol == col.0 ? Theme.bg : Theme.textSecondary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(sortCol == col.0 ? Theme.text : Theme.surface))
                        .overlay(Capsule().strokeBorder(sortCol == col.0 ? Theme.text : Theme.border))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 1)
        }
    }

    /// First click on a column sorts BEST first, which for a verdict column
    /// is whichever end of its own scale the Mac says is good.
    private func tapSort(_ col: String, _ specs: [JSONValue]) {
        if sortCol == col { sortDesc.toggle(); return }
        sortCol = col
        if col.hasPrefix("ind:") {
            let key = String(col.dropFirst(4))
            let dir = specs.first { $0["key"]?.stringValue == key }?["defaultDir"]?.stringValue
            sortDesc = dir == "desc"
        } else {
            sortDesc = col != "ticker"
        }
    }

    // MARK: rows

    private func positionRow(_ r: JSONValue, last: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(r["label"]?.stringValue ?? "").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        if !(r["held"]?.boolValue ?? false) { PfChip(text: "Watching") }
                    }
                    if let n = r["name"]?.stringValue, !n.isEmpty {
                        Text(n).font(.system(size: 12)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(r["value"]?.numberValue != nil ? pfMoney(r["value"]?.numberValue) : pfMoney(r["price"]?.numberValue, cents: true))
                        .font(.system(size: 15, weight: .semibold).monospacedDigit()).foregroundStyle(Theme.text)
                    if let c = r["dayPct"]?.numberValue, c.isFinite {
                        Text((c > 0 ? "+" : "") + pfPercent(c))
                            .font(.system(size: 12).monospacedDigit()).foregroundStyle(pfTone(c))
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
            if !last { Divider().padding(.leading, 14) }
        }
    }

    /// One quiet word per verdict; only the ENDS of a scale carry colour, and
    /// the categorical AI column and "Unknown" stay ink. The desktop's law —
    /// the first cut with meters and pills "looked overwhelming".
    private func indicatorRow(_ r: JSONValue, specs: [JSONValue], last: Bool) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(r["label"]?.stringValue ?? "").font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Spacer()
                    if let day = r["profileDay"]?.stringValue, !day.isEmpty {
                        Text(profileAge(day)).font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                    } else {
                        Text("No profile").font(.system(size: 11)).foregroundStyle(Theme.textQuaternary)
                    }
                }
                if (r["profiled"]?.boolValue ?? false) {
                    FlowRow(spacing: 6) {
                        ForEach(Array(specs.enumerated()), id: \.offset) { _, spec in
                            let key = spec["key"]?.stringValue ?? ""
                            if let v = r["ind"]?[key]?.objectValue, let word = v["word"]?.stringValue, !word.isEmpty {
                                HStack(spacing: 4) {
                                    Text(spec["label"]?.stringValue ?? key)
                                        .font(.system(size: 10, weight: .semibold))
                                        .textCase(.uppercase).tracking(0.5)
                                        .foregroundStyle(Theme.textQuaternary)
                                    Text(word).font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(verdictTone(v))
                                }
                            }
                        }
                    }
                } else {
                    Text("Open it to write today's profile.")
                        .font(.system(size: 12)).italic().foregroundStyle(Theme.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
            if !last { Divider().padding(.leading, 14) }
        }
    }
}

/// Only the ends of a scale carry colour; middles, the categorical column and
/// "Unknown" stay ink.
func verdictTone(_ v: [String: JSONValue]) -> Color {
    if v["unknown"]?.boolValue ?? false { return Theme.textTertiary }
    if v["categorical"]?.boolValue ?? false { return Theme.text }
    switch v["tone"]?.stringValue {
    case "good": return Theme.success
    case "bad": return Theme.danger
    default: return Theme.text
    }
}

func profileAge(_ day: String) -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: day) else { return day }
    let days = Calendar.current.dateComponents([.day], from: d, to: Date()).day ?? 0
    if days <= 0 { return "Today" }
    if days == 1 { return "Yesterday" }
    return "\(days)d ago"
}

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

/// A wrapping row of small items — SwiftUI has no flow layout on iOS 16.
struct FlowRow<Content: View>: View {
    var spacing: CGFloat = 6
    @ViewBuilder var content: () -> Content
    var body: some View {
        // A simple two-per-line grid reads well at phone width and needs no
        // layout maths; the verdict labels are all of similar length.
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                            GridItem(.flexible(), alignment: .leading)],
                  alignment: .leading, spacing: spacing) {
            content()
        }
    }
}

// MARK: - Ticker detail

struct PortfolioTickerDetail: View {
    let ticker: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var range = "1y"
    @State private var tab = "holdings"
    @State private var profileOpen = false
    @State private var news: [JSONValue] = []

    private var slot: String { "portfolio-ticker:\(ticker):\(range)" }

    var body: some View {
        let _ = views.revision
        let snap = views.view(slot, ttl: PORTFOLIO_TTL, request: "portfolio-ticker",
                              params: ["ticker": .string(ticker), "range": .string(range)])
        let d = snap.data?.objectValue

        ScreenColumn(spacing: 18) {
            ScreenHead(d?["label"]?.stringValue ?? ticker, sub: headSub(d)) {
                if let d = d, d["option"] == nil || d["option"]?.isNull == true {
                    let watched = d["watched"]?.boolValue ?? false
                    HeadAction(symbol: watched ? "star.fill" : "star", label: watched ? "Watching" : "Watch") {
                        toggleWatch(watched)
                    }
                }
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
                profileSection(d)
                newsSection(d)
                positionsSection(d)
                AskDoor(label: "Ask about \(ticker)…") {
                    router.openCompose(prefill: "About \(ticker): ")
                }
                openInRow(d)
                MacViewUpdatedLine(at: snap.at, error: snap.error)
            } else {
                EmptyText(snap.loading ? "Looking it up on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
            }
        }
        .pushedScreen()
        .onAppear(perform: loadNews)
    }

    private func headSub(_ d: [String: JSONValue]?) -> String {
        guard let d = d else { return "From your Mac" }
        let name = d["company"]?["name"]?.stringValue ?? d["profile"]?["name"]?.stringValue ?? ""
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

    // MARK: profile

    @ViewBuilder private func profileSection(_ d: [String: JSONValue]) -> some View {
        let p = d["profile"]?.objectValue
        let available = d["profileAvailable"]?.boolValue ?? false
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel("Business profile")
                Spacer()
                if let p = p, p["text"]?.stringValue?.isEmpty == false {
                    PfChip(text: (p["current"]?.boolValue ?? false) ? "AI · today" : "AI · \(profileAge(p["day"]?.stringValue ?? ""))",
                           tone: Theme.accent)
                }
            }
            if let p = p, let verdicts = p["verdicts"]?.objectValue, !verdicts.isEmpty {
                verdictTiles(verdicts)
            }
            if let p = p, let text = p["text"]?.stringValue, !text.isEmpty {
                markdownText((profileOpen ? text : String(text.prefix(500)) + (text.count > 500 ? "…" : "")))
                    .font(.system(size: 15)).foregroundStyle(Theme.textSecondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 14) {
                    if text.count > 500 {
                        Button(profileOpen ? "Show less" : "Read it all") { withAnimation { profileOpen.toggle() } }
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text).buttonStyle(.plain)
                    }
                    if available {
                        Button("Write it again") { writeProfile(force: true) }
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary).buttonStyle(.plain)
                    }
                }
                if let n = p["corrections"]?.numberValue, n > 0 {
                    Text("Reflects \(Int(n)) of your note\(Int(n) == 1 ? "" : "s")")
                        .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            } else if let e = p?["error"]?.stringValue, !e.isEmpty {
                Text(e).font(.system(size: 13)).foregroundStyle(Theme.danger)
                if available { SecondaryButton(label: "Try again") { writeProfile(force: true) } }
            } else if available {
                SecondaryButton(label: "Write today's profile with \(d["profileDestination"]?.stringValue ?? "your model")") {
                    writeProfile(force: false)
                }
            } else {
                EmptyText("Set up a model on your Mac to get a profile.")
            }

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
    }

    private func verdictTiles(_ verdicts: [String: JSONValue]) -> some View {
        let specs = views.view("portfolio-tickers", ttl: PORTFOLIO_TTL).data?["specs"]?.arrayValue ?? []
        // Fall back to whatever keys the profile carries, in its own order,
        // when the tickers digest is not cached yet.
        let keys: [(String, String)] = specs.isEmpty
            ? verdicts.keys.sorted().map { ($0, $0) }
            : specs.map { ($0["key"]?.stringValue ?? "", $0["label"]?.stringValue ?? "") }
        return LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                   GridItem(.flexible(), alignment: .leading)],
                         alignment: .leading, spacing: 10) {
            ForEach(keys, id: \.0) { key, label in
                if let word = verdicts[key]?.stringValue, !word.isEmpty {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(label).font(.system(size: 10, weight: .semibold))
                            .textCase(.uppercase).tracking(0.5).foregroundStyle(Theme.textQuaternary)
                        Text(word == "Unknown" ? "Not said" : word)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(word == "Unknown" ? Theme.textTertiary : Theme.text)
                    }
                }
            }
        }
    }

    // MARK: news + positions

    @ViewBuilder private func newsSection(_ d: [String: JSONValue]) -> some View {
        if !news.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("In the news")
                CardList {
                    ForEach(Array(news.prefix(8).enumerated()), id: \.offset) { i, it in
                        Button { router.push(.newsArticle(it["url"]?.stringValue ?? "")) } label: {
                            RowView(it["title"]?.stringValue ?? "",
                                    sub: it["source"]?.stringValue,
                                    last: i == min(8, news.count) - 1)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

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

    // MARK: actions

    private func toggleWatch(_ watched: Bool) {
        views.request("portfolio-action", params: [
            "action": .string(watched ? "unwatch" : "watch"), "ticker": .string(ticker)
        ]) { r in
            switch r {
            case .success:
                router.showToast(watched ? "Removed from your watchlist" : "Watching \(ticker)")
                views.refresh(slot)
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }

    private func writeProfile(force: Bool) {
        views.request("portfolio-action", params: [
            "action": .string("write-profile"), "ticker": .string(ticker), "force": .bool(force)
        ]) { r in
            switch r {
            case .success: router.showToast("Writing the profile on your Mac…")
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }

    private func loadNews() {
        guard news.isEmpty else { return }
        views.request("portfolio-news", params: ["ticker": .string(ticker), "limit": .number(8)]) { r in
            if case .success(let data) = r { news = data["items"]?.arrayValue ?? [] }
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

        AskDoor(label: "Ask about this plan…") {
            router.openCompose(prefill: "About my \"\(s["name"]?.stringValue ?? "plan")\" strategy: ")
        }
        Text("Anjadhe is not an investment adviser. This measures your holdings against the plan you wrote.")
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
