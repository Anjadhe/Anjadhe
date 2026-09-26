import SwiftUI
import AnjadheCore

// The News app on the phone (2026-09-21) — the desktop page, phone-sized.
//
// Until now this was a list of headlines that opened the browser. It is now
// the app: the rail as a drawer (All news, each followed topic with its hue,
// the Sources scope, Saved), the timeline with its lead card, the Catch-me-up
// digest, search over the cached headlines, the Topics page, and a READER
// with the summary the Mac writes, its related coverage and its source block.
//
// The laws that travel with it:
//   • Rule #1 — the model never authors a headline. Titles, sources and dates
//     are quoted from the feed; the summary is labelled as model-written; the
//     related links are the deterministic shortlist the model may only SELECT
//     from by index, and the card says which it was.
//   • The SCOPE (`via`) is session state, here as on the Mac: a scope that
//     survived a relaunch would read as News having lost half its stories.
//   • Topic and All-news counts are scope-filtered; the Sources counts are
//     not. Saved is never scoped — it is a collection you built, not a feed.
//   • Topics write through at once; the refresh they earn runs once on leave.

let NEWS_TTL: TimeInterval = 30 * 60

/// One stable hue per topic, straight from the Mac, so a topic wears the same
/// colour on both machines.
func newsHue(_ hex: String?) -> Color {
    guard let h = hex, !h.isEmpty else { return Theme.accent }
    return Color(hexString: h)
}

/// `updated` is the Mac's `NewsFeed._isUpdate` verdict: the feed time is
/// the story's LATEST publish (a live blog re-published all day), so a story
/// that first ran earlier reads "updated 40m ago", never a bare "40m ago".
func newsAgo(_ ms: Double?, updated: Bool = false) -> String {
    guard let ms = ms, ms > 0 else { return "" }
    let ago = MacViews.agoLabel(Date(timeIntervalSince1970: ms / 1000))
    return updated ? "updated " + ago : ago
}

// MARK: - The feed

struct NewsView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var topic: String? = nil       // nil = All news
    @State private var via: String? = nil         // nil = All sources (session only)
    @State private var query = ""
    @State private var drawerOpen = false

    var body: some View {
        let _ = views.revision
        let snap = views.view("news", ttl: NEWS_TTL)
        let d = snap.data?.objectValue
        let groups = d?["groups"]?.arrayValue ?? []
        let rows = query.isEmpty ? timeline(groups) : searchRows(groups)

        ZStack(alignment: .leading) {
            ScreenColumn {
                ScreenHead(headTitle(), sub: headSub(d, snap, rows.count)) {
                    HeadAction(symbol: "line.3.horizontal", label: "Topics") {
                        withAnimation(.easeOut(duration: 0.2)) { drawerOpen = true }
                    }
                    macViewRefreshAction(views, "news")
                }

                if d == nil {
                    EmptyText(snap.loading ? "Fetching headlines on your Mac…" : (snap.error ?? "Could not reach your Mac yet."))
                } else if (d?["settings"]?["interests"]?.arrayValue ?? []).isEmpty {
                    welcome()
                } else {
                    SearchField(placeholder: "Search headlines or paste a link", text: $query)
                    if let link = linkOf(query) {
                        Button { router.push(.newsArticle(link)) } label: {
                            RowView("Read this link", sub: link, last: true)
                                .background(Theme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
                                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                        }
                        .buttonStyle(.plain)
                    }
                    if let e = d?["lastError"]?.stringValue, !e.isEmpty {
                        Text(e).font(.system(size: 13)).foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let v = via {
                        Text("Showing \(sourceLabel(d, v)) only")
                            .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                    if query.isEmpty { digestCard(d) }

                    if rows.isEmpty {
                        EmptyText(query.isEmpty ? "No recent headlines here." : "Nothing matches “\(query)”.")
                    } else {
                        ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                            NewsCard(row: r, lead: query.isEmpty && topic == nil && i == 0,
                                     showTopic: topic == nil,
                                     onOpen: { router.push(.newsArticle(r["url"]?.stringValue ?? "")) },
                                     onFewer: { fewer(r) })
                        }
                    }
                    if (d?["ranked"]?.boolValue ?? false) && via == nil && query.isEmpty {
                        Text("Ranked for you on this Mac")
                            .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                    MacViewUpdatedLine(at: (d?["generatedAt"]?.numberValue).map { Date(timeIntervalSince1970: $0 / 1000) } ?? snap.at,
                                       error: snap.error, onPhone: snap.builtOnPhone)
                }
            }

            if drawerOpen {
                Color.black.opacity(0.25).ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }
                    .transition(.opacity)
                NewsDrawer(data: d, groups: groups, topic: topic, via: via,
                           counts: scopedCounts(groups), total: scopedTotal(groups),
                           onTopic: { t in topic = t; query = ""; close() },
                           onSource: { v in via = v; close() },
                           onSaved: { close(); router.push(.newsSaved) },
                           onTopics: { close(); router.push(.newsTopics) })
                    .transition(.move(edge: .leading))
            }
        }
        .pushedScreen()
    }

    private func close() { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }

    // MARK: head

    private func headTitle() -> String { topic ?? "News" }

    private func headSub(_ d: [String: JSONValue]?, _ snap: MacViews.Snapshot, _ n: Int) -> String {
        guard d != nil else { return snap.loading ? "Asking your Mac…" : "From your Mac" }
        if !query.isEmpty {
            return "\(n) matching stories in the last 48 hours of your topics"
        }
        if topic != nil { return "\(n) stor\(n == 1 ? "y" : "ies")" }
        return "Your topics, from your Mac"
    }

    // MARK: rows

    /// In scope? The one predicate, the desktop's own.
    private func inScope(_ r: JSONValue) -> Bool {
        guard let v = via else { return true }
        return (r["via"]?.stringValue ?? "google") == v
    }

    /// One chronological column, every story once, deduped by URL keeping its
    /// first address — the desktop's timeline.
    private func timeline(_ groups: [JSONValue]) -> [JSONValue] {
        var seen = Set<String>()
        var out: [JSONValue] = []
        for g in groups {
            if let t = topic, (g["topic"]?.stringValue ?? "") != t { continue }
            for r in g["rows"]?.arrayValue ?? [] {
                guard inScope(r) else { continue }
                let url = r["url"]?.stringValue ?? ""
                if url.isEmpty || seen.contains(url) { continue }
                seen.insert(url)
                out.append(r)
            }
        }
        return out.sorted { ($0["publishedAt"]?.numberValue ?? 0) > ($1["publishedAt"]?.numberValue ?? 0) }
    }

    /// A filter over cached rows, never a web search — as on the Mac.
    private func searchRows(_ groups: [JSONValue]) -> [JSONValue] {
        let terms = query.lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard !terms.isEmpty else { return timeline(groups) }
        return timeline(groups).filter { r in
            let hay = [(r["title"]?.stringValue ?? ""), (r["source"]?.stringValue ?? ""), (r["topic"]?.stringValue ?? "")]
                .joined(separator: " ").lowercased()
            return terms.allSatisfy { hay.contains($0) }
        }
    }

    /// Topic counts ARE scope-filtered: a rail promising 20 under a scope
    /// that shows 2 is the rail lying.
    private func scopedCounts(_ groups: [JSONValue]) -> [String: Int] {
        var out: [String: Int] = [:]
        for g in groups {
            out[g["topic"]?.stringValue ?? ""] = (g["rows"]?.arrayValue ?? []).filter(inScope).count
        }
        return out
    }

    private func scopedTotal(_ groups: [JSONValue]) -> Int {
        groups.reduce(0) { $0 + (($1["rows"]?.arrayValue ?? []).filter(inScope).count) }
    }

    private func sourceLabel(_ d: [String: JSONValue]?, _ id: String) -> String {
        (d?["sources"]?.arrayValue ?? []).first { $0["id"]?.stringValue == id }?["label"]?.stringValue ?? id
    }

    /// The one test for "is this a link" — the desktop's `_linkOf`.
    private func linkOf(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard t.range(of: "^https?://\\S+$", options: [.regularExpression, .caseInsensitive]) != nil,
              let u = URL(string: t), (u.host ?? "").contains(".") else { return nil }
        return t
    }

    // MARK: pieces

    private func welcome() -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Headlines from the topics you follow, fetched by your Mac and ranked there. Nothing is written by a model except the summaries you ask for.")
                .font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(label: "Choose topics to follow") { router.push(.newsTopics) }
        }
    }

    @ViewBuilder private func digestCard(_ d: [String: JSONValue]?) -> some View {
        if let digest = d?["digest"]?.objectValue, let text = digest["text"]?.stringValue, !text.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    PfChip(text: "AI digest", tone: Theme.accent)
                    Spacer()
                    Button("Hide") { act(["action": .string("clear-digest")], toast: nil) }
                        .font(.system(size: 13)).foregroundStyle(Theme.textTertiary).buttonStyle(.plain)
                }
                Text(text).font(.system(size: 15)).foregroundStyle(Theme.textSecondary).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Written on your Mac from these headlines")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
        } else if d?["digestAvailable"]?.boolValue ?? false {
            SecondaryButton(label: "Catch me up") {
                act(["action": .string("catchup")], toast: "Writing your digest on your Mac…")
            }
        }
    }

    private func fewer(_ r: JSONValue) {
        act(["action": .string("fewer"),
             "title": .string(r["title"]?.stringValue ?? ""),
             "topic": .string(r["topic"]?.stringValue ?? "")],
            toast: "Showing fewer stories like that")
    }

    private func act(_ params: [String: JSONValue], toast: String?) {
        views.request("news-action", params: params) { r in
            switch r {
            case .success:
                if let t = toast { router.showToast(t) }
                views.refresh("news")
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }
}

// MARK: - A story card

/// One renderer, as on the desktop: `lead` is purely the newest post in All
/// news and changes only the styling — a topic-hue wash, a tinted border and
/// a larger headline. There is no dek: the feeds ship title, source and date,
/// and nothing here is ever model-written.
struct NewsCard: View {
    let row: JSONValue
    var lead = false
    var showTopic = true
    var onOpen: () -> Void
    var onFewer: (() -> Void)? = nil

    var body: some View {
        let hue = newsHue(row["hue"]?.stringValue)
        let read = row["read"]?.boolValue ?? false
        return Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(byline).font(.system(size: 12)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    Spacer(minLength: 4)
                    if showTopic, let t = row["topic"]?.stringValue, !t.isEmpty {
                        HStack(spacing: 4) {
                            Circle().fill(hue).frame(width: 6, height: 6)
                            Text(t).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
                Text(row["title"]?.stringValue ?? "")
                    .font(lead ? Theme.display(23) : .system(size: 16, weight: read ? .regular : .semibold))
                    .tracking(lead ? Theme.displayTracking(23) : 0)
                    .foregroundStyle(read ? Theme.textSecondary : Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                if let why = row["why"]?.stringValue, !why.isEmpty {
                    Text("For you · \(why)").font(.system(size: 12)).foregroundStyle(Theme.accent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(lead ? 16 : 14)
            .background(
                Group {
                    if lead {
                        LinearGradient(colors: [hue.opacity(0.10), Theme.surface], startPoint: .topLeading, endPoint: .bottomTrailing)
                    } else { Theme.surface }
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd)
                .strokeBorder(lead ? hue.opacity(0.35) : Theme.border))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let f = onFewer { Button("Show fewer like this", role: .destructive, action: f) }
        }
    }

    private var byline: String {
        var bits: [String] = []
        let src = row["source"]?.stringValue ?? ""
        if !src.isEmpty { bits.append(src) }
        let ago = newsAgo(row["publishedAt"]?.numberValue, updated: row["updated"]?.boolValue ?? false)
        if !ago.isEmpty { bits.append(ago) }
        if let v = row["viaLabel"]?.stringValue, !v.isEmpty { bits.append(v) }
        if let p = row["points"]?.numberValue { bits.append("\(Int(p)) pts") }
        return bits.joined(separator: " · ")
    }
}

// MARK: - The rail, as a drawer

private struct NewsDrawer: View {
    let data: [String: JSONValue]?
    let groups: [JSONValue]
    let topic: String?
    let via: String?
    let counts: [String: Int]
    let total: Int
    let onTopic: (String?) -> Void
    let onSource: (String?) -> Void
    let onSaved: () -> Void
    let onTopics: () -> Void

    var body: some View {
        let interests = (data?["settings"]?["interests"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let sources = (data?["sources"]?.arrayValue ?? []).filter { $0["on"]?.boolValue ?? false }
        let bySource = data?["bySource"]?.objectValue ?? [:]
        let hues = data?["topicHues"]?.objectValue ?? [:]

        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    row("All news", count: total, hue: nil, active: topic == nil) { onTopic(nil) }
                    row("Saved", count: Int(data?["savedCount"]?.numberValue ?? 0), hue: nil, active: false) { onSaved() }

                    if !interests.isEmpty {
                        Text("Topics").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                        // A followed topic with nothing new still belongs here.
                        ForEach(interests, id: \.self) { t in
                            row(t, count: counts[t] ?? 0, hue: newsHue(hues[t]?.stringValue), active: topic == t) { onTopic(t) }
                        }
                        Button("Edit topics ›", action: onTopics)
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textSecondary)
                            .buttonStyle(.plain)
                            .padding(.horizontal, 22).padding(.top, 6)
                    }

                    // Shown only with a real choice to make, as on the Mac.
                    if sources.count >= 2 {
                        Text("Sources").sectionHeaderStyle().padding(.horizontal, 14).padding(.top, 18).padding(.bottom, 6)
                        row("All sources", count: bySource.values.reduce(0) { $0 + Int($1.numberValue ?? 0) },
                            hue: nil, active: via == nil) { onSource(nil) }
                        ForEach(Array(sources.enumerated()), id: \.offset) { _, s in
                            let id = s["id"]?.stringValue ?? ""
                            row(s["label"]?.stringValue ?? id, count: Int(bySource[id]?.numberValue ?? 0),
                                hue: nil, active: via == id) { onSource(id) }
                        }
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

    private func row(_ label: String, count: Int, hue: Color?, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let h = hue { Circle().fill(h).frame(width: 7, height: 7) }
                Text(label).font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(count == 0 ? Theme.textTertiary : Theme.text)
                    .lineLimit(1)
                Spacer()
                if count > 0 {
                    Text("\(count)").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
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

// MARK: - Saved

struct NewsSavedView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = views.revision
        let snap = views.view("news-saved", ttl: 5 * 60)
        let items = snap.data?["items"]?.arrayValue ?? []

        ScreenColumn {
            ScreenHead("Saved", sub: items.isEmpty ? "Nothing kept yet" : "\(items.count) stor\(items.count == 1 ? "y" : "ies") kept") {
                macViewRefreshAction(views, "news-saved")
            }
            if items.isEmpty {
                EmptyText(snap.loading ? "Asking your Mac…" : "Save a story from its reader and it waits for you here.")
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    NewsCard(row: it, showTopic: true,
                             onOpen: { router.push(.newsArticle(it["url"]?.stringValue ?? "")) })
                        .contextMenu {
                            Button("Remove from Saved", role: .destructive) {
                                views.request("news-action", params: [
                                    "action": .string("unsave"), "url": .string(it["url"]?.stringValue ?? "")
                                ]) { _ in views.refresh("news-saved") }
                            }
                        }
                }
                MacViewUpdatedLine(at: snap.at, error: snap.error, onPhone: snap.builtOnPhone)
            }
        }
        .pushedScreen()
    }
}

// MARK: - Topics

/// A page, not a modal — and no Save button. Every pick writes through at
/// once; the headline refresh those picks earn runs ONCE on leave.
struct NewsTopicsView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var adding = ""
    @State private var dirty = false
    @State private var location = ""
    @State private var locationLoaded = false

    var body: some View {
        let _ = views.revision
        let snap = views.view("news", ttl: NEWS_TTL)
        let d = snap.data?.objectValue
        let interests = (d?["settings"]?["interests"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let limit = Int(d?["topicLimit"]?.numberValue ?? 15)
        let hues = d?["topicHues"]?.objectValue ?? [:]

        ScreenColumn(spacing: 18) {
            ScreenHead("Topics", sub: "Follow up to \(limit) topics. Your Mac fetches them.")

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel("Following", count: interests.count)
                if interests.isEmpty {
                    EmptyText("Nothing followed yet — add one below or pick from the ideas.")
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 8) {
                        ForEach(interests, id: \.self) { t in
                            Button { act(["action": .string("unfollow"), "topic": .string(t)]) } label: {
                                HStack(spacing: 5) {
                                    Circle().fill(newsHue(hues[t]?.stringValue)).frame(width: 7, height: 7)
                                    Text(t).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1)
                                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                                }
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(Capsule().fill(Theme.surface))
                                .overlay(Capsule().strokeBorder(newsHue(hues[t]?.stringValue).opacity(0.5)))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                HStack(spacing: 8) {
                    TextField("Add a topic, e.g. San Francisco city updates", text: $adding)
                        .font(.system(size: 15))
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Capsule().fill(Theme.surface))
                        .overlay(Capsule().strokeBorder(Theme.border))
                        .onSubmit(addTopic)
                    Button("Add", action: addTopic)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                        .buttonStyle(.plain)
                }
            }

            if let sources = d?["sources"]?.arrayValue, !sources.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Sources", count: sources.filter { $0["on"]?.boolValue ?? false }.count)
                    CardList {
                        ForEach(Array(sources.enumerated()), id: \.offset) { i, s in
                            let on = s["on"]?.boolValue ?? false
                            Button {
                                act(["action": .string("source"), "source": .string(s["id"]?.stringValue ?? ""), "on": .bool(!on)])
                            } label: {
                                RowView(s["label"]?.stringValue ?? "", sub: s["desc"]?.stringValue, last: i == sources.count - 1) {
                                    Image(systemName: on ? "checkmark.square.fill" : "square")
                                        .font(.system(size: 17)).foregroundStyle(on ? Theme.text : Theme.textTertiary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Ideas")
                ForEach(Array((d?["catalog"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, g in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(g["group"]?.stringValue ?? "").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), alignment: .leading)], alignment: .leading, spacing: 6) {
                            ForEach((g["topics"]?.arrayValue ?? []).compactMap { $0.stringValue }, id: \.self) { t in
                                let on = interests.contains { $0.lowercased() == t.lowercased() }
                                Button { act(["action": .string(on ? "unfollow" : "follow"), "topic": .string(t)]) } label: {
                                    Text(t).font(.system(size: 12.5))
                                        .foregroundStyle(on ? Theme.bg : Theme.textSecondary)
                                        .lineLimit(1)
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(Capsule().fill(on ? Theme.text : Theme.surface))
                                        .overlay(Capsule().strokeBorder(on ? Theme.text : Theme.border))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("More")
                TextField("City, region or country", text: $location)
                    .font(.system(size: 15)).textFieldStyle(.plain)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Capsule().fill(Theme.surface))
                    .overlay(Capsule().strokeBorder(Theme.border))
                    .onSubmit { act(["action": .string("location"), "location": .string(location)]) }
                if let muted = d?["mutedCount"]?.numberValue, muted > 0 {
                    HStack {
                        Text("\(Int(muted)) stories you asked to see fewer like")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Button("Show them again") { act(["action": .string("reset-fewer")]) }
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.text).buttonStyle(.plain)
                    }
                }
            }
        }
        .pushedScreen()
        .onAppear {
            guard !locationLoaded else { return }
            locationLoaded = true
            location = d?["settings"]?["location"]?.stringValue ?? ""
        }
        // Leaving is what settles the refresh — the one fetch the picks earned.
        .onDisappear {
            if !location.isEmpty { views.request("news-action", params: ["action": .string("location"), "location": .string(location)]) { _ in } }
            guard dirty else { return }
            views.request("news-action", params: ["action": .string("settle")]) { _ in
                views.refresh("news")
            }
        }
    }

    private func addTopic() {
        let t = adding.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        adding = ""
        act(["action": .string("follow"), "topic": .string(String(t.prefix(60)))])
    }

    private func act(_ params: [String: JSONValue]) {
        views.request("news-action", params: params) { r in
            switch r {
            case .success:
                dirty = true
                views.refresh("news")
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }
}
