import SwiftUI
import AnjadheCore

// The Mac-served view screens (data lane 2, docs/MOBILE_NATIVE.md): Email AI,
// News, Portfolio. The data behind them deliberately never syncs as a blob
// (the mailbox is SQLite on the Mac, the news cache is machine-local, quotes
// are machine-local), so each screen renders the read-only DIGEST the Mac
// builds on request — cached by `MacViews`, refreshed past its TTL in the
// background, and honest about its age when the Mac is unreachable.

let INSIGHTS_TTL: TimeInterval = 5 * 60

/// The refresh head action every Mac-served screen carries.
func macViewRefreshAction(_ views: MacViews, _ name: String) -> some View {
    HeadAction(symbol: "arrow.triangle.2.circlepath", label: "Refresh") { views.refresh(name) }
}

/// "Updated 5m ago from your Mac · <error>" — the honesty line.
struct MacViewUpdatedLine: View {
    let at: Date?
    let error: String?
    /// Built on this phone because the Mac was away (M5 phase 2).
    var onPhone: Bool = false
    var body: some View {
        let ago = MacViews.agoLabel(at)
        let whence = onPhone ? "on this phone — your Mac is away" : "from your Mac"
        Text("Updated \(ago.isEmpty ? "never" : ago) \(whence)" + (error.map { " · \($0)" } ?? ""))
            .font(.system(size: 12))
            .foregroundStyle(Theme.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A JSON field rendered as display text: strings as-is, numbers without a
/// trailing ".0" (amounts may arrive either way).
func macViewText(_ v: JSONValue?) -> String {
    guard let v = v else { return "" }
    if let s = v.stringValue { return s }
    if let n = v.numberValue {
        return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
    }
    if let b = v.boolValue { return b ? "true" : "false" }
    return ""
}

// MARK: - Email AI (app id `fyi`, the desktop's law)

private let FYI_TYPE_LABELS: [String: String] = [
    "task": "Tasks", "appointment": "Appointments", "reservation": "Reservations",
    "payment": "Payments", "receipt": "Receipts", "code": "Codes", "shipping": "Deliveries",
    "newsletter": "Newsletters", "promotion": "Promotions", "general": "General",
]

private func fyiTypeLabel(_ t: String) -> String {
    if let l = FYI_TYPE_LABELS[t] { return l }
    guard !t.isEmpty else { return "Other" }
    return t.prefix(1).uppercased() + t.dropFirst()
}

/// One folder in the Email AI nav: a type, its label, and its rows.
private struct FyiFolder: Identifiable {
    let type: String
    let label: String
    var rows: [JSONValue]
    var id: String { type }
    var unread: Int { rows.filter { !($0["read"]?.boolValue ?? false) }.count }
}

/// The Email AI page — a phone-sized port of the Mac's page: a collapsed
/// left nav (the drawer) of folders and bundles, an Unread/All toggle, and
/// the folder's rows. The digest comes from the Mac (`MacViews` "insights");
/// nothing here is model-written. `folder` is nil for the Overview,
/// "trips" for the Trips bundle, else a type key.
struct FyiView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var folder: String? = nil
    @State private var drawerOpen = false
    @AppStorage("fyi-unread-only") private var unreadOnly = true

    var body: some View {
        let _ = views.revision
        let snap = views.view("insights", ttl: INSIGHTS_TTL)
        let d = snap.data?.objectValue
        let folders = buildFolders(d)
        let trips = d?["trips"]?.arrayValue ?? []
        let totalUnread = folders.reduce(0) { $0 + $1.unread }

        ZStack(alignment: .leading) {
            ScreenColumn {
                ScreenHead(headTitle(folders), sub: headSub(d, snap, totalUnread)) {
                    HeadAction(symbol: "line.3.horizontal", label: "Folders") {
                        withAnimation(.easeOut(duration: 0.2)) { drawerOpen = true }
                    }
                    macViewRefreshAction(views, "insights")
                }
                if d == nil {
                    EmptyText(snap.loading ? "Building the digest on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
                } else {
                    FyiReadToggle(unreadOnly: $unreadOnly)
                    if folder == "trips" {
                        tripsSection(trips, always: true)
                    } else if let f = folder, let fo = folders.first(where: { $0.type == f }) {
                        let rows = visible(fo.rows)
                        if rows.isEmpty {
                            EmptyText(unreadOnly && !fo.rows.isEmpty ? "Nothing unread in \(fo.label)." : "Nothing in \(fo.label) yet.")
                        } else {
                            CardList {
                                ForEach(Array(rows.enumerated()), id: \.offset) { i, a in
                                    insightRow(a, last: i == rows.count - 1)
                                }
                            }
                        }
                    } else {
                        // Overview: trips first (the desktop's "what wants you"
                        // ordering), then every folder that has something to show.
                        tripsSection(trips, always: false)
                        let shown = folders.map { FyiFolder(type: $0.type, label: $0.label, rows: visible($0.rows)) }.filter { !$0.rows.isEmpty }
                        if shown.isEmpty {
                            EmptyText(unreadOnly && totalUnread == 0 && folders.contains { !$0.rows.isEmpty }
                                      ? "All caught up — nothing unread." : "No insights in the window.")
                        }
                        ForEach(shown) { g in
                            VStack(alignment: .leading, spacing: 8) {
                                Button { folder = g.type } label: {
                                    HStack(spacing: 6) {
                                        SectionLabel(g.label, count: g.rows.count)
                                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                                    }
                                }.buttonStyle(.plain)
                                CardList {
                                    ForEach(Array(g.rows.enumerated()), id: \.offset) { i, a in
                                        insightRow(a, last: i == g.rows.count - 1)
                                    }
                                }
                            }
                        }
                    }
                    MacViewUpdatedLine(at: snap.at, error: snap.error, onPhone: snap.builtOnPhone)
                }
            }

            if drawerOpen {
                Color.black.opacity(0.25).ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }
                    .transition(.opacity)
                FyiDrawer(folders: folders, tripsLive: liveTripCount(trips), totalUnread: totalUnread, selected: folder) { pick in
                    folder = pick
                    withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false }
                }
                .transition(.move(edge: .leading))
            }
        }
        .pushedScreen()
    }

    // MARK: data shaping

    /// Folders in the Mac's order (the digest's `folders`, else the types seen).
    private func buildFolders(_ d: [String: JSONValue]?) -> [FyiFolder] {
        guard let d = d else { return [] }
        var order: [(String, String)] = (d["folders"]?.arrayValue ?? []).compactMap {
            guard let t = $0["type"]?.stringValue else { return nil }
            return (t, $0["label"]?.stringValue ?? fyiTypeLabel(t))
        }
        var byType: [String: [JSONValue]] = [:]
        for a in d["insights"]?.arrayValue ?? [] {
            let t = a["type"]?.stringValue ?? "general"
            byType[t, default: []].append(a)
            if !order.contains(where: { $0.0 == t }) { order.append((t, fyiTypeLabel(t))) }
        }
        return order.map { FyiFolder(type: $0.0, label: $0.1, rows: byType[$0.0] ?? []) }
    }

    private func visible(_ rows: [JSONValue]) -> [JSONValue] {
        unreadOnly ? rows.filter { !($0["read"]?.boolValue ?? false) } : rows
    }

    private func liveTripCount(_ trips: [JSONValue]) -> Int {
        let today = DateLogic.todayStr()
        return trips.filter { ($0["end"]?.stringValue ?? "").prefix(10) >= today }.count
    }

    private func headTitle(_ folders: [FyiFolder]) -> String {
        if folder == "trips" { return "Trips" }
        if let f = folder, let fo = folders.first(where: { $0.type == f }) { return fo.label }
        return "Insights"
    }

    private func headSub(_ d: [String: JSONValue]?, _ snap: MacViews.Snapshot, _ unread: Int) -> String {
        guard d != nil else { return snap.loading ? "Asking your Mac…" : "From your Mac" }
        if folder == "trips" { return "Reservations grouped into trips" }
        if folder != nil { return "Insights" }
        return unread > 0 ? "\(unread) unread insight\(unread == 1 ? "" : "s")" : "All caught up"
    }

    // MARK: pieces

    @ViewBuilder private func tripsSection(_ trips: [JSONValue], always: Bool) -> some View {
        if !trips.isEmpty || always {
            VStack(alignment: .leading, spacing: 8) {
                if !always { SectionLabel("Trips") }
                if trips.isEmpty {
                    EmptyText("No trips on the horizon.")
                } else {
                    CardList {
                        ForEach(Array(trips.enumerated()), id: \.offset) { i, t in
                            let span = [t["start"]?.stringValue, t["end"]?.stringValue]
                                .compactMap { $0 }.filter { !$0.isEmpty }
                                .map { DateLogic.relDate($0) }.joined(separator: " – ")
                            RowView(t["label"]?.stringValue ?? "Trip", sub: span, last: i == trips.count - 1)
                        }
                    }
                }
            }
        }
    }

    private func insightRow(_ a: JSONValue, last: Bool) -> some View {
        let emailId = a["emailId"]?.stringValue ?? ""
        let read = a["read"]?.boolValue ?? false
        let subject = a["title"]?.stringValue ?? ""
        let summary = a["summary"]?.stringValue ?? ""
        // The Mac's row reads the summary and falls back to the subject.
        let text = summary.isEmpty ? (subject.isEmpty ? "(no subject)" : subject) : summary
        let sub = [
            a["from"]?.stringValue ?? "",
            (a["matterDate"]?.stringValue).map { DateLogic.relDate($0) } ?? "",
            macViewText(a["amount"]),
        ].filter { !$0.isEmpty }.joined(separator: " · ")

        return Button {
            if !emailId.isEmpty { router.push(.insight(emailId)) }
        } label: {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            if !read {
                                Circle().fill(Theme.text).frame(width: 7, height: 7)
                            }
                            Text(text)
                                .font(.system(size: 16, weight: read ? .regular : .medium))
                                .foregroundStyle(Theme.text)
                                .lineLimit(2)
                        }
                        if !sub.isEmpty {
                            Text(sub).font(.system(size: 13)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textTertiary).padding(.top, 4)
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .contentShape(Rectangle())
                if !last { Divider().padding(.leading, 14) }
            }
        }
        .buttonStyle(.plain)
    }
}

/// Unread / All — the feed's toggle, on the Email AI page.
private struct FyiReadToggle: View {
    @Binding var unreadOnly: Bool
    var body: some View {
        HStack(spacing: 0) {
            seg("Unread", on: unreadOnly) { unreadOnly = true }
            seg("All", on: !unreadOnly) { unreadOnly = false }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: Theme.radiusSm + 3).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm + 3).strokeBorder(Theme.border))
        .frame(maxWidth: 220)
    }
    private func seg(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 13, weight: on ? .semibold : .medium))
                .foregroundStyle(on ? Theme.bg : Theme.textSecondary)
                .frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(on ? Theme.text : .clear))
        }
        .buttonStyle(.plain)
    }
}

/// The collapsed left nav: Insights (Overview + every folder, unread counts
/// in the attention voice, empty folders quiet) and Bundles (Trips, live
/// count in the quiet voice) — the Mac's Email AI nav, as a drawer.
private struct FyiDrawer: View {
    let folders: [FyiFolder]
    let tripsLive: Int
    let totalUnread: Int
    let selected: String?
    let onPick: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Insights").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                    row("Overview", count: totalUnread, quiet: false, active: selected == nil) { onPick(nil) }
                    ForEach(folders) { f in
                        row(f.label, count: f.unread, quiet: f.rows.isEmpty, active: selected == f.type) { onPick(f.type) }
                    }
                    Text("Bundles").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                    row("Trips", count: tripsLive, quiet: tripsLive == 0, active: selected == "trips", countQuiet: true) { onPick("trips") }
                }
                .padding(.bottom, 24)
            }
        }
        .frame(width: 260)
        .frame(maxHeight: .infinity)
        .background(Theme.bg)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 0.5) }
        .ignoresSafeArea(edges: .bottom)
    }

    private func row(_ label: String, count: Int, quiet: Bool, active: Bool, countQuiet: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(quiet ? Theme.textTertiary : Theme.text)
                Spacer()
                if count > 0 {
                    Text("\(count)").font(.system(size: 12, weight: countQuiet ? .regular : .semibold))
                        .foregroundStyle(countQuiet ? Theme.textTertiary : Theme.bg)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(countQuiet ? Theme.surface : Theme.text))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(active ? Theme.surface : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
    }
}

// MARK: - Insight detail (the Mac's detail pane, phone-sized)

/// One insight in full. Opens on the digest's row at once, then asks the
/// Mac for the whole record (`insight` view) — which also marks it read on
/// the Mac, exactly as opening the Mac's detail does. Layout follows the
/// Mac's pane top to bottom: chips, subject, the model's summary, the
/// property rows, action items, the assistant door, read/unread, and the
/// email's plain text to check the insight against.
struct InsightDetail: View {
    let emailId: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var full: JSONValue? = nil
    @State private var loading = false
    @State private var error: String? = nil
    @State private var showBody = false
    @State private var readOverride: Bool? = nil

    private var digestRow: JSONValue? {
        (views.view("insights", ttl: INSIGHTS_TTL).data?["insights"]?.arrayValue ?? [])
            .first { $0["emailId"]?.stringValue == emailId }
    }

    var body: some View {
        let _ = views.revision
        let row = digestRow
        let f = full
        let subject = f?["subject"]?.stringValue ?? row?["title"]?.stringValue ?? "(no subject)"
        let summary = f?["summary"]?.stringValue ?? row?["summary"]?.stringValue ?? ""
        let typeLabel = f?["typeLabel"]?.stringValue ?? fyiTypeLabel(row?["type"]?.stringValue ?? "")
        let read = readOverride ?? (f?["read"]?.boolValue ?? row?["read"]?.boolValue ?? true)
        let props = buildProps(f, row)
        let actions = (f?["actionItems"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let attachments = (f?["attachments"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let bodyText = f?["body"]?.stringValue ?? ""

        ScreenColumn(spacing: 18) {
            // chips
            HStack(spacing: 8) {
                chip(typeLabel, filled: false)
                if let st = f?["status"]?.stringValue, st == "cancelled" || st == "changed" {
                    chip(st == "cancelled" ? "Cancelled" : "Changed", filled: false, danger: st == "cancelled")
                }
                if !read { chip("Unread", filled: true) }
            }
            .padding(.top, 6)

            Text(subject).displayStyle(24)
                .fixedSize(horizontal: false, vertical: true)

            if !summary.isEmpty {
                Text(summary).font(.system(size: 16)).foregroundStyle(Theme.textSecondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !props.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(props.enumerated()), id: \.offset) { i, p in
                        HStack(alignment: .top, spacing: 12) {
                            Text(p.0).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                                .frame(width: 96, alignment: .leading)
                            Text(p.1).font(.system(size: 15)).foregroundStyle(Theme.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        if i < props.count - 1 { Divider().padding(.leading, 14) }
                    }
                }
                .background(Theme.bg)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
            }

            if !actions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Action items")
                    CardList {
                        ForEach(Array(actions.enumerated()), id: \.offset) { i, a in
                            RowView(a, last: i == actions.count - 1)
                        }
                    }
                }
            }

            AskDoor(label: "Ask about this insight…") {
                router.openCompose(prefill: "About the email \"\(subject)\": ")
            }

            HStack(spacing: 10) {
                SecondaryButton(label: read ? "Mark unread" : "Mark read") { setRead(!read) }
            }

            if loading && f == nil {
                Text("Fetching the full insight from your Mac…").font(.system(size: 13)).italic().foregroundStyle(Theme.textTertiary)
            } else if let e = error, f == nil {
                Text(e).font(.system(size: 13)).foregroundStyle(Theme.danger)
            }

            if !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Attachments")
                    ForEach(attachments, id: \.self) { name in
                        HStack(spacing: 8) {
                            Image(systemName: "paperclip").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                            Text(name).font(.system(size: 14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                    }
                    Text("Open the attachment on your Mac.").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }

            if !bodyText.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Email")
                    Text(bodyText)
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary).lineSpacing(3)
                        .lineLimit(showBody ? nil : 8)
                        .fixedSize(horizontal: false, vertical: true)
                    if bodyText.count > 400 {
                        Button(showBody ? "Show less" : "Show the whole email") { withAnimation { showBody.toggle() } }
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .pushedScreen()
        .onAppear { load(markRead: true) }
    }

    // MARK: pieces

    private func chip(_ text: String, filled: Bool, danger: Bool = false) -> some View {
        Text(text).font(.system(size: 12, weight: .semibold))
            .foregroundStyle(filled ? Theme.bg : (danger ? Theme.danger : Theme.textSecondary))
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(Capsule().fill(filled ? Theme.text : Theme.surface))
            .overlay(Capsule().strokeBorder(filled ? Theme.text : (danger ? Theme.danger : Theme.border)))
    }

    /// The Mac's property order: when, return, route/where/booking, amount,
    /// from, received. Dates arrive as ISO and are formatted here.
    private func buildProps(_ f: JSONValue?, _ row: JSONValue?) -> [(String, String)] {
        var out: [(String, String)] = []
        func day(_ iso: String?) -> String {
            guard let s = iso, !s.isEmpty else { return "" }
            let df = DateFormatter(); df.setLocalizedDateFormatFromTemplate("EEEMMMd")
            if let d = DateLogic.parseISO(s) {
                // A bare date is a local day, not UTC midnight.
                if s.count == 10, let local = Calendar.current.date(from: Calendar.current.dateComponents(in: TimeZone(identifier: "UTC")!, from: d)) {
                    return df.string(from: local)
                }
                return df.string(from: d)
            }
            return s
        }
        func span(_ a: String?, _ b: String?) -> String {
            let s = day(a), e = day(b)
            if s.isEmpty { return "" }
            return e.isEmpty || e == s ? s : "\(s) – \(e)"
        }
        let when = span(f?["whenStart"]?.stringValue ?? row?["matterDate"]?.stringValue, f?["whenEnd"]?.stringValue)
        if !when.isEmpty { out.append(("When", when)) }
        let ret = span(f?["returnStart"]?.stringValue, f?["returnEnd"]?.stringValue)
        if !ret.isEmpty { out.append(("Return", ret)) }
        for p in f?["props"]?.arrayValue ?? [] {
            if let l = p["label"]?.stringValue, let v = p["value"]?.stringValue, !v.isEmpty { out.append((l, v)) }
        }
        if f == nil, let from = row?["from"]?.stringValue, !from.isEmpty { out.append(("From", from)) }
        if f == nil, let amt = row?["amount"], !macViewText(amt).isEmpty, !out.contains(where: { $0.0 == "Amount" }) {
            out.append(("Amount", macViewText(amt)))
        }
        if let cb = f?["cancelBy"]?.stringValue, !cb.isEmpty, cb >= DateLogic.todayStr() {
            out.append(("Cancel by", "Free cancellation until " + day(cb)))
        }
        if let r = f?["receivedAt"]?.stringValue, let d = DateLogic.parseISO(r) {
            let df = DateFormatter(); df.dateStyle = .medium; df.timeStyle = .short
            out.append(("Received", df.string(from: d)))
        }
        return out
    }

    // MARK: data

    private func load(markRead: Bool) {
        guard !loading else { return }
        loading = true
        error = nil
        var params: [String: JSONValue] = ["emailId": .string(emailId)]
        if markRead { params["markRead"] = .bool(true) }
        views.request("insight", params: params) { result in
            loading = false
            switch result {
            case .success(let data):
                full = data
                if markRead { views.markInsightRead(emailId, read: true) }
            case .failure(let err):
                error = err.localizedDescription
            }
        }
    }

    private func setRead(_ read: Bool) {
        readOverride = read
        views.markInsightRead(emailId, read: read)
        views.request("insight", params: ["emailId": .string(emailId), "read": .bool(read)]) { result in
            if case .failure(let err) = result {
                readOverride = !read
                views.markInsightRead(emailId, read: !read)
                router.showToast(err.localizedDescription)
            } else if case .success(let data) = result {
                full = data
            }
        }
    }
}
