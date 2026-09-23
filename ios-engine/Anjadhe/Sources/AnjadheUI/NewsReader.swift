import SwiftUI
import AnjadheCore

// The News reader on the phone (2026-09-21).
//
// The Mac does the reading. Asking for an article STARTS the desktop's own
// pipeline — fetch the page, summarize it, fall back to search coverage,
// extract dates, search related coverage — and answers straight away with
// whatever it has; this screen re-asks on a timer until the piece is
// finished. That is the same shape the portfolio brief uses, and it is why a
// summary that takes a local model two minutes does not need the channel's
// thirty-second window widened.
//
// Provenance behaves as it does on the Mac: while the summary is still being
// written, neither Related nor Source is drawn — they belong under a finished
// piece, and showing them over a half-written one just makes the page jump.

struct NewsReaderView: View {
    let url: String
    var titleHint: String = ""

    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @State private var article: JSONValue? = nil
    @State private var error: String? = nil
    @State private var asked = false
    @State private var poll: Timer? = nil
    @State private var summaryOpen = false

    var body: some View {
        let a = article?.objectValue
        let pending = a?["pending"]?.boolValue ?? false
        let hue = newsHue(a?["hue"]?.stringValue)

        ScreenColumn(spacing: 18) {
            ScreenHead(a?["title"]?.stringValue ?? (titleHint.isEmpty ? "Reading…" : titleHint),
                       sub: byline(a)) {
                if let a = a {
                    let saved = a["saved"]?.boolValue ?? false
                    HeadAction(symbol: saved ? "star.fill" : "star", label: saved ? "Saved" : "Save") {
                        toggleSave(saved)
                    }
                }
                HeadAction(symbol: "safari", label: "Open article") {
                    openURL(a?["openUrl"]?.stringValue ?? url)
                }
            }

            if let t = a?["topic"]?.stringValue, !t.isEmpty {
                HStack(spacing: 5) {
                    Circle().fill(hue).frame(width: 7, height: 7)
                    Text(t).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textSecondary)
                }
            }

            if let e = error {
                Text(e).font(.system(size: 14)).foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            summarySection(a, pending: pending)

            if !pending {
                relatedSection(a)
                eventsSection(a)
                sourceSection(a)
            }

            AskDoor(label: "Ask about this…") {
                router.openCompose(prefill: "About the article \"\(a?["title"]?.stringValue ?? titleHint)\": ")
            }
            SecondaryButton(label: "Open article") { openURL(a?["openUrl"]?.stringValue ?? url) }
            if let d = a?["discussionUrl"]?.stringValue, !d.isEmpty {
                SecondaryButton(label: "Hacker News thread") { openURL(d) }
            }
        }
        .pushedScreen()
        .onAppear(perform: start)
        .onDisappear { poll?.invalidate(); poll = nil }
    }

    // MARK: sections

    @ViewBuilder private func summarySection(_ a: [String: JSONValue]?, pending: Bool) -> some View {
        let summary = a?["summary"]?.stringValue ?? ""
        let status = a?["status"]?.stringValue ?? ""
        let readErr = a?["error"]?.stringValue ?? ""

        VStack(alignment: .leading, spacing: 10) {
            if let tag = a?["modeTag"]?.stringValue, !summary.isEmpty {
                HStack(spacing: 8) {
                    // Accent for what a model wrote, monochrome for the
                    // deterministic extract — the desktop's own distinction.
                    PfChip(text: tag, tone: (a?["modePlain"]?.boolValue ?? false) ? nil : Theme.accent)
                    if a?["streaming"]?.boolValue ?? false {
                        Text("writing…").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                    Spacer()
                }
                if let note = a?["modeNote"]?.stringValue, !note.isEmpty {
                    Text(note).font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !summary.isEmpty {
                MarkdownView(text: summaryOpen ? summary : RecordText.preview(summary, 1200))
                    .font(.system(size: 15))
                if summary.count > 1200 {
                    Button(summaryOpen ? "Show less" : "Read it all") { withAnimation { summaryOpen.toggle() } }
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text).buttonStyle(.plain)
                }
            } else if !readErr.isEmpty {
                Text(readErr).font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(status.isEmpty ? "Reading the article on your Mac…" : status)
                    .font(.system(size: 15)).italic().foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.border))
    }

    @ViewBuilder private func relatedSection(_ a: [String: JSONValue]?) -> some View {
        if a?["relatedLoading"]?.boolValue ?? false {
            Text("Looking for other coverage…").font(.system(size: 13)).italic().foregroundStyle(Theme.textTertiary)
        } else if let rows = a?["related"]?.arrayValue, !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    SectionLabel("Related coverage")
                    // Picked by a model, or the plain shortlist — the card
                    // says which, and either way every link is a real one.
                    PfChip(text: (a?["relatedPicked"]?.boolValue ?? false) ? "AI" : "Web",
                           tone: (a?["relatedPicked"]?.boolValue ?? false) ? Theme.accent : nil)
                }
                CardList {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        Button { router.push(.newsArticle(r["url"]?.stringValue ?? "")) } label: {
                            RowView(r["title"]?.stringValue ?? "",
                                    sub: [r["site"]?.stringValue, r["kindLabel"]?.stringValue]
                                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                                    last: i == rows.count - 1) {
                                Button { openURL(r["url"]?.stringValue ?? "") } label: {
                                    Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Theme.textTertiary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                Text((a?["relatedPicked"]?.boolValue ?? false)
                     ? "Picked from a web search on this headline — every headline and link is the publisher's own"
                     : "From a web search on this headline")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private func eventsSection(_ a: [String: JSONValue]?) -> some View {
        if let events = a?["events"]?.arrayValue, !events.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    SectionLabel("Dates in this article")
                    PfChip(text: "AI", tone: Theme.accent)
                }
                CardList {
                    ForEach(Array(events.enumerated()), id: \.offset) { i, e in
                        RowView(e["title"]?.stringValue ?? "",
                                sub: [e["date"]?.stringValue, e["time"]?.stringValue]
                                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                                last: i == events.count - 1)
                    }
                }
                Text("Spotted in this article — check before you rely on it. Add one from your Mac.")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private func sourceSection(_ a: [String: JSONValue]?) -> some View {
        if let s = a?["sourceCard"]?.objectValue {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Source")
                pfPropCard {
                    if let v = s["subject"]?.stringValue, !v.isEmpty { PfProp(label: "Subject", value: v) }
                    if let v = s["site"]?.stringValue, !v.isEmpty { PfProp(label: "Source", value: v) }
                    if let v = s["publishedAt"]?.stringValue, !v.isEmpty { PfProp(label: "Published", value: stamp(v)) }
                    if let v = s["updatedAt"]?.stringValue, !v.isEmpty { PfProp(label: "Updated", value: stamp(v)) }
                    PfProp(label: "Article", value: s["url"]?.stringValue ?? url, last: true)
                }
            }
        }
    }

    private func byline(_ a: [String: JSONValue]?) -> String {
        var bits: [String] = []
        if let p = a?["publisher"]?.stringValue, !p.isEmpty { bits.append(p) }
        let ago = newsAgo(a?["publishedAt"]?.numberValue)
        if !ago.isEmpty { bits.append(ago) }
        return bits.isEmpty ? "From your Mac" : bits.joined(separator: " · ")
    }

    private func stamp(_ iso: String) -> String {
        guard let d = DateLogic.parseISO(iso) else { return iso }
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short
        return f.string(from: d)
    }

    // MARK: fetching

    private func start() {
        guard !asked else { return }
        asked = true
        fetch(record: true)
    }

    private func fetch(record: Bool) {
        var params: [String: JSONValue] = ["url": .string(url)]
        if !titleHint.isEmpty { params["title"] = .string(titleHint) }
        // The click is recorded once, on the first ask — a poll is not a read.
        if !record { params["record"] = .bool(false) }
        views.request("news-article", params: params) { r in
            switch r {
            case .success(let data):
                article = data
                error = nil
                if data["pending"]?.boolValue ?? false { schedulePoll() } else { poll?.invalidate(); poll = nil }
            case .failure(let e):
                // Keep whatever we already showed; say why it stopped moving.
                error = e.localizedDescription
                poll?.invalidate(); poll = nil
            }
        }
    }

    /// Re-ask while the Mac is still working. Two seconds is fast enough to
    /// feel live and slow enough that a local model's decode is not competing
    /// with a request per second.
    private func schedulePoll() {
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { _ in
            fetch(record: false)
        }
    }

    private func toggleSave(_ saved: Bool) {
        views.request("news-action", params: [
            "action": .string(saved ? "unsave" : "save"), "url": .string(url)
        ]) { r in
            switch r {
            case .success:
                router.showToast(saved ? "Removed from Saved" : "Saved")
                fetch(record: false)
                views.refresh("news-saved")
            case .failure(let e): router.showToast(e.localizedDescription)
            }
        }
    }
}
