import Foundation
import AnjadheCore

/// Headlines fetched on the phone for Portfolio's holdings (PhoneFolio,
/// `portfolio-news`), the network half of the Mac's `PortfolioNews`. This
/// file was PhoneNews.swift until 2026-10-05, when the News app left the Mac
/// and the phone; what stayed is only what Portfolio still asks for: topics
/// → Google News rows, through nenva Connect (`/v1/news`, on the Mac's key)
/// or straight to the Google News RSS. Nothing in a headline is model-written.
///
/// Which way the topics go is decided by `PhoneFolio.headlinesRoute()`; this
/// file only knows how to fetch each way.
enum HeadlinesFetch {
    struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }

    static let maxItems = 20                      // per topic (NEWS_MAX_ITEMS_PER_TOPIC)
    static let userAgent = "Anjadhe/1.0"

    /// `/v1/news`, chunked at 8 topics as the Mac does; all chunks or none.
    /// Each element is `{topic, items, error?}` — Connect's shape.
    static func viaConnect(_ topics: [String], _ cred: CloudCredentials.Value) async throws -> [JSONValue] {
        var out: [JSONValue] = []
        var i = 0
        while i < topics.count {
            let chunk = Array(topics[i..<min(i + 8, topics.count)]); i += 8
            guard let url = URL(string: cred.baseURL + "/v1/news") else { throw Failure(message: "bad address") }
            var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 20
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(cred.apiKey)", forHTTPHeaderField: "Authorization")
            req.httpBody = try JSONEncoder().encode(JSONValue.object(["topics": .array(chunk.map { .string($0) }), "sources": .array([.string("google")])]))
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 { CloudCredentials.clear(); throw Failure(message: "auth") }
            guard status == 200, data.count <= 2 * 1024 * 1024,
                  let json = try? JSONValue.parse(String(decoding: data, as: UTF8.self)),
                  let list = json["topics"]?.arrayValue else { throw Failure(message: "HTTP \(status)") }
            out += list
        }
        return out
    }

    /// Straight to Google News, per topic, in parallel (main.js `_newsDirect`,
    /// Google only). Same element shape as `viaConnect`.
    static func direct(_ topics: [String]) async -> [JSONValue] {
        await withTaskGroup(of: (Int, JSONValue).self) { group in
            for (i, topic) in topics.enumerated() {
                group.addTask {
                    guard let url = googleURL(topic) else {
                        return (i, .object(["topic": .string(topic), "items": .array([]), "error": .string("unavailable")]))
                    }
                    var req = URLRequest(url: url); req.timeoutInterval = 15
                    req.setValue("application/rss+xml, application/xml, text/xml", forHTTPHeaderField: "Accept")
                    req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
                    guard let (data, resp) = try? await URLSession.shared.data(for: req),
                          (resp as? HTTPURLResponse)?.statusCode == 200 else {
                        return (i, .object(["topic": .string(topic), "items": .array([]), "error": .string("unavailable")]))
                    }
                    let items = parseRss(String(decoding: data, as: UTF8.self))
                    return (i, .object(["topic": .string(topic), "items": .array(items)]))
                }
            }
            var out: [(Int, JSONValue)] = []
            for await r in group { out.append(r) }
            return out.sorted { $0.0 < $1.0 }.map { $0.1 }
        }
    }

    static func googleURL(_ topic: String) -> URL? {
        var c = URLComponents(string: "https://news.google.com/rss/search")!
        c.queryItems = [.init(name: "q", value: topic), .init(name: "hl", value: "en-US"), .init(name: "gl", value: "US"), .init(name: "ceid", value: "US:en")]
        return c.url
    }

    // MARK: the Google News RSS parser (js/main/news-sources.js `parseRss`)

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

    static let rfc822: [DateFormatter] = ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, dd MMM yyyy HH:mm:ss Z", "dd MMM yyyy HH:mm:ss zzz"].map {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = $0; return f
    }
    static func parseDate(_ s: String) -> Date? {
        let t = s.trimmingCharacters(in: .whitespaces)
        for f in rfc822 { if let d = f.date(from: t) { return d } }
        return DateLogic.parseISO(t)
    }
    static let isoOut: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()

    /// A Google News RSS feed → `{title, url, source, sourceUrl, publishedAt, via}` rows.
    static func parseRss(_ xml: String) -> [JSONValue] {
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
            var title = tag("title")
            let url = tag("link")
            let source = tag("source").isEmpty ? tag("News:Source") : tag("source")
            let pub = parseDate(tag("pubDate"))
            guard !title.isEmpty, !url.isEmpty else { continue }
            if !source.isEmpty, title.lowercased().hasSuffix(" - " + source.lowercased()) {
                title = String(title.dropLast(source.count + 3)).trimmingCharacters(in: .whitespaces)
            }
            let sourceUrl = decodeEntities(firstMatch("<source\\s[^>]*url=(?:\"([^\"]*)\"|'([^']*)')", in: block)
                ?? firstMatch("<source\\s[^>]*url=(?:\"([^\"]*)\"|'([^']*)')", in: block, group: 2) ?? "")
            let okSource = sourceUrl.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
            items.append(.object([
                "title": .string(String(title.prefix(300))), "url": .string(String(url.prefix(2000))),
                "source": .string(String(source.prefix(100))),
                "sourceUrl": .string(okSource ? String(sourceUrl.prefix(300)) : ""),
                "publishedAt": pub.map { .string(isoOut.string(from: $0)) } ?? .null,
                "via": .string("google"),
            ]))
            if items.count >= maxItems { break }
        }
        return items
    }
}

/// Reading a web page on the phone (the agent's `read_url`, PhoneAgent):
/// Google News links resolved to the publisher (main.js
/// `_resolveGoogleNewsUrl`, the same handshake), then the page's paragraphs
/// — a small stand-in for the Mac's Readability.
enum PageReader {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    private static var resolved: [String: String] = [:]
    private static let lock = NSLock()

    static func match(_ pattern: String, _ s: String) -> String? { HeadlinesFetch.firstMatch(pattern, in: s) }

    static func resolveGoogleNews(_ url: String) async -> String {
        guard let u = URLComponents(string: url), u.host == "news.google.com", u.path.contains("/articles/"),
              let id = u.path.components(separatedBy: "/articles/").last?.split(separator: "/").first.map(String.init),
              !id.isEmpty else { return url }
        let hit = lock.withLock { resolved[id] }
        if let hit = hit { return hit }
        do {
            var shellReq = URLRequest(url: URL(string: url)!); shellReq.timeoutInterval = 12
            shellReq.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            let (shellData, _) = try await URLSession.shared.data(for: shellReq)
            let html = String(decoding: shellData, as: UTF8.self)
            guard let sg = match("data-n-a-sg=\"([^\"]+)\"", html),
                  let ts = match("data-n-a-ts=\"([^\"]+)\"", html), let tsn = Double(ts) else { return url }
            let inner: JSONValue = .array([.string("garturlreq"),
                .array([.array([.string("X"), .string("X"), .array([.string("X"), .string("X")]), .null, .null, .number(1), .number(1), .string("US:en"), .null, .number(1), .null, .null, .null, .null, .null, .number(0), .number(1)]),
                        .string("X"), .string("X"), .number(1), .array([.number(1), .number(1), .number(1)]), .number(1), .number(1), .null, .number(0), .number(0), .null, .number(0)]),
                .string(id), .number(tsn), .string(sg)])
            // JSON.stringify's output: no escaped slashes, integers bare.
            let enc = JSONEncoder(); enc.outputFormatting = [.withoutEscapingSlashes]
            let innerStr = String(decoding: try enc.encode(inner), as: UTF8.self)
            let freq = String(decoding: try enc.encode(JSONValue.array([.array([.array([.string("Fbv4je"), .string(innerStr), .null, .string("generic")])])])), as: UTF8.self)
            var req = URLRequest(url: URL(string: "https://news.google.com/_/DotsSplashUi/data/batchexecute")!)
            req.httpMethod = "POST"; req.timeoutInterval = 12
            req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            req.setValue("application/x-www-form-urlencoded;charset=UTF-8", forHTTPHeaderField: "Content-Type")
            // application/x-www-form-urlencoded, strictly (URLSearchParams).
            let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
            req.httpBody = ("f.req=" + (freq.addingPercentEncoding(withAllowedCharacters: safe) ?? "")).data(using: .utf8)
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return url }
            let body = String(decoding: data.prefix(64 * 1024), as: UTF8.self)
            guard let dest = match("(https?://(?!news\\.google\\.com)[^\\s\"\\\\]+)", body) else { return url }
            lock.withLock { resolved[id] = dest }
            return dest
        } catch { return url }
    }

    struct Page { let title: String; let text: String; let finalURL: String }

    static func read(_ url: String) async -> Page? {
        guard let u = URL(string: url), u.scheme?.lowercased() == "https" || u.scheme?.lowercased() == "http" else { return nil }
        var req = URLRequest(url: u); req.timeoutInterval = 20
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        let html = String(decoding: data.prefix(1_500_000), as: UTF8.self)
        let title = match("<title[^>]*>([\\s\\S]*?)</title>", html).map { decodeNumeric(PlainText.strip($0)) } ?? ""
        return Page(title: title, text: paragraphs(html), finalURL: http.url?.absoluteString ?? url)
    }

    /// The page's reading text: its <p> paragraphs of some length, in order;
    /// the whole stripped page when it has none.
    static func paragraphs(_ html: String) -> String {
        var body = html
        for tag in ["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form"] {
            body = body.replacingOccurrences(of: "<\(tag)[\\s\\S]*?</\(tag)>", with: " ", options: [.regularExpression, .caseInsensitive])
        }
        guard let re = try? NSRegularExpression(pattern: "<p[\\s>][\\s\\S]*?</p>", options: [.caseInsensitive]) else { return PlainText.strip(body) }
        let ps = re.matches(in: body, range: NSRange(body.startIndex..., in: body)).compactMap { m -> String? in
            guard let r = Range(m.range, in: body) else { return nil }
            let t = PlainText.strip(String(body[r]))
            return t.count >= 60 ? t : nil
        }
        return decodeNumeric(ps.isEmpty ? PlainText.strip(body) : ps.joined(separator: "\n\n"))
    }

    /// `&#8211;` / `&#x2013;` → the character (PlainText.strip handles only
    /// named entities, and publishers use numeric ones for dashes and quotes).
    static func decodeNumeric(_ s: String) -> String {
        guard s.contains("&#"), let re = try? NSRegularExpression(pattern: "&#(x[0-9a-fA-F]{1,6}|[0-9]{1,7});") else { return s }
        var out = "", last = s.startIndex
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            guard let whole = Range(m.range, in: s), let g = Range(m.range(at: 1), in: s) else { continue }
            out += s[last..<whole.lowerBound]
            let code = s[g].hasPrefix("x") ? UInt32(s[g].dropFirst(), radix: 16) : UInt32(s[g])
            if let c = code.flatMap(Unicode.Scalar.init) { out.unicodeScalars.append(c) } else { out += s[whole] }
            last = whole.upperBound
        }
        return out + s[last...]
    }
}
