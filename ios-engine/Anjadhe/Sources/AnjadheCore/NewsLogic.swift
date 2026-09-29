import Foundation

/// News, built ON THE PHONE when the Mac is away (docs/MOBILE_NATIVE.md "M5",
/// phase 2) — the pure half. Each function names the desktop function it
/// ports: js/main/news-sources.js (the parsers, Connect's lib/news.js twin)
/// and js/apps/news/news-feed.js + news-app.js (the timeline). Rule #1 of
/// docs/DISCOVER.md holds here too: nothing in a headline is model-written.
public enum NewsLogic {
    public static let maxItems = 20                    // per source per topic
    public static let topicMax = 20                    // NewsFeed.TOPIC_MAX
    public static let maxTopics = 16                   // NewsFeed.MAX_TOPICS
    public static let storyMaxAgeMs: Double = 48 * 3600 * 1000
    public static let tasteMaxAgeMs: Double = 90 * 86400 * 1000
    public static let sourceIds = ["google", "bing", "hn"]
    public static let sourceLabels = ["google": "Google News", "bing": "Bing News", "hn": "Hacker News"]

    // MARK: settings (NewsFeed.settings / _normalizeSources)

    public struct Settings: Equatable {
        public let interests: [String]
        public let location: String
        public let sources: [String]
    }

    public static func normalizeSources(_ list: [JSONValue]?) -> [String] {
        let want = Set((list ?? []).compactMap { $0.stringValue?.trimmingCharacters(in: .whitespaces).lowercased() })
        let out = sourceIds.filter { want.contains($0) }
        return out.isEmpty ? ["google"] : out
    }

    public static func settings(_ blob: [String: JSONValue]) -> Settings {
        let interests = (blob["interests"]?.arrayValue ?? []).compactMap { $0.stringValue?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return Settings(interests: interests,
                        location: blob["location"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? "",
                        sources: normalizeSources(blob["sources"]?.arrayValue))
    }

    /// The topics a refresh fetches (NewsFeed._refresh).
    public static func fetchTopics(_ s: Settings) -> [String] {
        var t = Array(s.interests.prefix(maxTopics - (s.location.isEmpty ? 0 : 1)))
        if !s.location.isEmpty { t.append(s.location) }
        return t
    }

    /// NewsFeed.taste(): signals younger than ~3 months.
    public static func taste(_ blob: [String: JSONValue], nowMs: Double) -> (clicks: [String], fewer: [String]) {
        func fresh(_ k: String) -> [String] {
            (blob[k]?.arrayValue ?? []).compactMap { s in
                guard let t = s["title"]?.stringValue, !t.isEmpty,
                      nowMs - (s["at"]?.numberValue ?? 0) < tasteMaxAgeMs else { return nil }
                return t
            }
        }
        return (fresh("clicks"), fresh("fewer"))
    }

    // MARK: parsers (news-sources.js)

    static func decodeEntities(_ s: String) -> String {
        var out = s.replacingOccurrences(of: "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>", with: "$1", options: .regularExpression)
        for (a, b) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#039;", "'"), ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " "), ("&amp;", "&")] {
            out = out.replacingOccurrences(of: a, with: b)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func firstMatch(_ pattern: String, in s: String, group: Int = 1) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              m.numberOfRanges > group, let r = Range(m.range(at: group), in: s) else { return nil }
        return String(s[r])
    }

    static func unwrapBingLink(_ url: String) -> String? {
        guard let u = URLComponents(string: url), let host = u.host?.lowercased(),
              host == "bing.com" || host.hasSuffix(".bing.com"),
              let target = u.queryItems?.first(where: { $0.name == "url" })?.value,
              target.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
        return target
    }

    static func origin(_ url: String) -> String? {
        guard let u = URLComponents(string: url), let scheme = u.scheme, let host = u.host else { return nil }
        return "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
    }

    static let rfc822: [DateFormatter] = ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, dd MMM yyyy HH:mm:ss Z", "dd MMM yyyy HH:mm:ss zzz"].map {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = $0; return f
    }
    static func parseDate(_ s: String) -> Date? {
        let t = s.trimmingCharacters(in: .whitespaces)
        for f in rfc822 { if let d = f.date(from: t) { return d } }
        return DateLogic.parseISO(t)
    }
    static let isoOut: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()

    /// parseRss — Google and Bing news feeds.
    public static func parseRss(_ xml: String, via: String) -> [JSONValue] {
        var items: [JSONValue] = []
        let parts = xml.components(separatedBy: "<item")
        for raw in parts.dropFirst() {
            guard let gt = raw.firstIndex(of: ">") else { continue }
            let head = raw[raw.startIndex..<gt]
            if let c = head.first, !c.isWhitespace && c != "/" { continue }   // <items>, <itemFoo>
            var block = String(raw[raw.index(after: gt)...])
            if let end = block.range(of: "</item>") { block = String(block[..<end.lowerBound]) }
            func tag(_ name: String) -> String {
                firstMatch("<\(name)(?:\\s[^>]*)?>([\\s\\S]*?)</\(name)>", in: block).map(decodeEntities) ?? ""
            }
            var title = tag("title"), url = tag("link")
            let source = tag("source").isEmpty ? tag("News:Source") : tag("source")
            let pub = parseDate(tag("pubDate"))
            guard !title.isEmpty, !url.isEmpty else { continue }
            let unwrapped = unwrapBingLink(url)
            if let u = unwrapped { url = u }
            if !source.isEmpty, title.lowercased().hasSuffix(" - " + source.lowercased()) {
                title = String(title.dropLast(source.count + 3)).trimmingCharacters(in: .whitespaces)
            }
            var sourceUrl = decodeEntities(firstMatch("<source\\s[^>]*url=(?:\"([^\"]*)\"|'([^']*)')", in: block)
                ?? firstMatch("<source\\s[^>]*url=(?:\"([^\"]*)\"|'([^']*)')", in: block, group: 2) ?? "")
            if sourceUrl.isEmpty, let u = unwrapped { sourceUrl = origin(u) ?? "" }
            let okSource = sourceUrl.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
            items.append(.object([
                "title": .string(String(title.prefix(300))), "url": .string(String(url.prefix(2000))),
                "source": .string(String(source.prefix(100))),
                "sourceUrl": .string(okSource ? String(sourceUrl.prefix(300)) : ""),
                "publishedAt": pub.map { .string(isoOut.string(from: $0)) } ?? .null,
                "via": .string(via),
            ]))
            if items.count >= maxItems { break }
        }
        return items
    }

    /// hnItems — Hacker News via Algolia.
    public static func hnItems(_ json: String) -> [JSONValue] {
        guard let data = try? JSONValue.parse(json) else { return [] }
        var items: [JSONValue] = []
        for h in data["hits"]?.arrayValue ?? [] {
            let id: String = h["objectID"]?.stringValue ?? h["objectID"]?.numberValue.map { String(Int($0)) } ?? ""
            let title = (h["title"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
            guard !title.isEmpty, id.range(of: "^\\d{1,12}$", options: .regularExpression) != nil else { continue }
            let thread = "https://news.ycombinator.com/item?id=\(id)"
            let link = (h["url"]?.stringValue).flatMap { $0.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil ? $0.trimmingCharacters(in: .whitespaces) : nil } ?? ""
            var host = "", orig = ""
            if !link.isEmpty, let u = URLComponents(string: link), let h0 = u.host {
                host = h0.replacingOccurrences(of: "^www\\.", with: "", options: [.regularExpression, .caseInsensitive])
                orig = origin(link) ?? ""
            }
            let pub = (h["created_at"]?.stringValue).flatMap { DateLogic.parseISO($0) }
            var o: [String: JSONValue] = [
                "title": .string(String(title.prefix(300))),
                "url": .string(String((host.isEmpty ? thread : link).prefix(2000))),
                "source": .string(String((host.isEmpty ? "Hacker News" : host).prefix(100))),
                "sourceUrl": .string(String((host.isEmpty ? "https://news.ycombinator.com" : orig).prefix(300))),
                "publishedAt": pub.map { .string(isoOut.string(from: $0)) } ?? .null,
                "discussionUrl": .string(thread), "via": .string("hn"),
            ]
            if let p = h["points"]?.numberValue, p.isFinite { o["points"] = .number(max(0, p.rounded())) }
            items.append(.object(o))
            if items.count >= maxItems { break }
        }
        return items
    }

    public static func sourceURL(_ id: String, topic: String, nowMs: Double) -> URL? {
        var c: URLComponents
        switch id {
        case "google":
            c = URLComponents(string: "https://news.google.com/rss/search")!
            c.queryItems = [.init(name: "q", value: topic), .init(name: "hl", value: "en-US"), .init(name: "gl", value: "US"), .init(name: "ceid", value: "US:en")]
        case "bing":
            c = URLComponents(string: "https://www.bing.com/news/search")!
            c.queryItems = [.init(name: "q", value: topic), .init(name: "format", value: "rss"), .init(name: "mkt", value: "en-US")]
        case "hn":
            c = URLComponents(string: "https://hn.algolia.com/api/v1/search")!
            let since = Int(nowMs / 1000) - 48 * 3600
            c.queryItems = [.init(name: "query", value: topic), .init(name: "tags", value: "story"),
                            .init(name: "hitsPerPage", value: String(maxItems)),
                            .init(name: "numericFilters", value: "created_at_i>\(since),points>=10")]
        default: return nil
        }
        return c.url
    }

    // MARK: same story (NewsFeed._titleTokens / _sameStory)

    static let stop: Set<String> = ["the", "and", "for", "with", "from", "into", "over", "after", "amid",
        "says", "say", "its", "his", "her", "their", "this", "that", "are", "was", "will", "has", "have", "had",
        "been", "more", "most", "latest", "today", "news", "update", "updates", "live", "breaking",
        "how", "what", "when", "why", "who"]

    public static func tokens(_ t: String) -> Set<String> {
        let cleaned = t.lowercased().unicodeScalars.map { (CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789").contains($0) || CharacterSet.whitespacesAndNewlines.contains($0)) ? Character($0) : " " }
        var out = Set<String>()
        for w in String(cleaned).split(whereSeparator: { $0.isWhitespace }) where w.count > 2 && !stop.contains(String(w)) { out.insert(String(w)) }
        return out
    }

    static func tokensMatch(_ a: Set<String>, _ b: Set<String>) -> Bool {
        guard !a.isEmpty, !b.isEmpty else { return false }
        return Double(a.intersection(b).count) / Double(min(a.count, b.count)) >= 0.6
    }

    public static func sameStory(_ a: String, _ b: String) -> Bool { tokensMatch(tokens(a), tokens(b)) }

    // MARK: "update" mark (NewsFeed._isUpdate, without the page's own date)

    public static func isUpdate(_ it: JSONValue) -> Bool {
        let pub: Double? = it["publishedAt"]?.numberValue
            ?? (it["publishedAt"]?.stringValue).flatMap { DateLogic.parseISO($0) }.map { $0.timeIntervalSince1970 * 1000 }
        guard let p = pub else { return false }
        for u in [it["url"]?.stringValue, it["openUrl"]?.stringValue].compactMap({ $0 }) {
            guard let y = firstMatch("/(20\\d{2})[/-](\\d{2})[/-](\\d{2})(?=[/-]|$)", in: u, group: 1),
                  let m = firstMatch("/(20\\d{2})[/-](\\d{2})[/-](\\d{2})(?=[/-]|$)", in: u, group: 2),
                  let d = firstMatch("/(20\\d{2})[/-](\\d{2})[/-](\\d{2})(?=[/-]|$)", in: u, group: 3),
                  let yi = Int(y), let mi = Int(m), let di = Int(d) else { continue }
            var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
            guard let day = cal.date(from: DateComponents(year: yi, month: mi, day: di)) else { continue }
            if p - day.timeIntervalSince1970 * 1000 > 38 * 3600 * 1000 { return true }
        }
        return false
    }

    // MARK: topic colour (NewsApp.topicHue / _buildHueMap)

    public static let topicHues = ["#4F6BED", "#F97316", "#14B8A6", "#EC4899", "#65A30D", "#8B5CF6", "#F59E0B", "#0EA5E9", "#EF4444", "#0891B2", "#B45309", "#6366F1"]

    static func hueSlot(_ key: String) -> Int {
        var h: UInt32 = 0
        for c in key.utf16 { h = h &* 31 &+ UInt32(c) }
        return Int(h % UInt32(topicHues.count))
    }

    public static func hueMap(_ interests: [String]) -> [String: String] {
        var map: [String: String] = [:]
        var taken = Set<Int>()
        let n = topicHues.count
        for t in interests {
            let key = t.trimmingCharacters(in: .whitespaces).lowercased()
            guard !key.isEmpty, map[key] == nil else { continue }
            var slot = hueSlot(key)
            if taken.count < n { while taken.contains(slot) { slot = (slot + 1) % n } }
            taken.insert(slot)
            map[key] = topicHues[slot]
        }
        return map
    }

    public static func topicHue(_ topic: String, map: [String: String]) -> String {
        let key = topic.trimmingCharacters(in: .whitespaces).lowercased()
        guard !key.isEmpty else { return "" }
        return map[key] ?? topicHues[hueSlot(key)]
    }

    // MARK: the timeline (NewsFeed._refresh → NewsApp._buildGroups → MobileViews._news)

    /// Per-topic fetch results (`{topic, items, error?}` — Connect's shape and
    /// the direct fetch's) → the groups the view ships, newest first per
    /// topic, story-deduped, capped per source, dismissed stories dropped.
    public static func groups(_ fetched: [JSONValue], fewer: [String], clicks: [String], hues: [String: String], nowMs: Double) -> [JSONValue] {
        let clickSets = clicks.map(tokens)
        func isRead(_ t: String) -> Bool { let tk = tokens(t); return clickSets.contains { tokensMatch(tk, $0) } }
        func dismissed(_ t: String) -> Bool { fewer.contains { sameStory($0, t) } }
        var out: [JSONValue] = []
        for t in fetched where t["error"] == nil {
            let topic = t["topic"]?.stringValue ?? ""
            var rows: [(pub: Double, row: [String: JSONValue])] = []
            for it in t["items"]?.arrayValue ?? [] {
                guard let ps = it["publishedAt"]?.stringValue, let d = DateLogic.parseISO(ps) else { continue }
                let pub = d.timeIntervalSince1970 * 1000
                guard nowMs - pub <= storyMaxAgeMs else { continue }
                let title = String((it["title"]?.stringValue ?? "").prefix(200)), url = it["url"]?.stringValue ?? ""
                guard !title.isEmpty, !url.isEmpty, !dismissed(title) else { continue }
                let via = normalizeSources([it["via"] ?? .null]).first ?? "google"
                var r: [String: JSONValue] = [
                    "title": .string(title), "url": .string(url),
                    "source": .string(String((it["source"]?.stringValue ?? "").prefix(60))),
                    "sourceUrl": .string((it["sourceUrl"]?.stringValue).map { $0.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil ? String($0.prefix(300)) : "" } ?? ""),
                    "topic": .string(topic), "publishedAt": .number(pub), "via": .string(via),
                ]
                if let du = it["discussionUrl"]?.stringValue, du.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil { r["discussionUrl"] = .string(String(du.prefix(300))) }
                if let p = it["points"]?.numberValue, p >= 0, p == p.rounded() { r["points"] = .number(p) }
                rows.append((pub, r))
            }
            rows.sort { $0.pub > $1.pub }
            var kept: [[String: JSONValue]] = [], perVia: [String: Int] = [:]
            for (_, r) in rows {
                let via = r["via"]?.stringValue ?? "google"
                if perVia[via, default: 0] >= topicMax { continue }
                let title = r["title"]?.stringValue ?? ""
                if kept.contains(where: { sameStory($0["title"]?.stringValue ?? "", title) }) { continue }
                perVia[via, default: 0] += 1
                kept.append(r)
            }
            guard !kept.isEmpty else { continue }
            out.append(.object(["topic": .string(topic), "hue": .string(topicHue(topic, map: hues)),
                                "rows": .array(kept.prefix(60).map { r in
                var o = r
                let via = r["via"]?.stringValue ?? "google"
                o["updated"] = .bool(isUpdate(.object(r)))
                o["viaLabel"] = .string(via == "google" ? "" : (sourceLabels[via] ?? ""))
                o["points"] = r["points"] ?? .null
                o["discussionUrl"] = r["discussionUrl"] ?? .string("")
                o["why"] = .string("")
                o["read"] = .bool(isRead(r["title"]?.stringValue ?? ""))
                return .object(o)
            })]))
        }
        // gi / ri: each row's address, as the Mac numbers them.
        return out.prefix(24).enumerated().map { gi, g in
            guard case .object(var go) = g else { return g }
            let rows = (go["rows"]?.arrayValue ?? []).enumerated().map { ri, r -> JSONValue in
                guard case .object(var ro) = r else { return r }
                ro["gi"] = .number(Double(gi)); ro["ri"] = .number(Double(ri)); return .object(ro)
            }
            go["rows"] = .array(rows)
            return .object(go)
        }
    }
}
