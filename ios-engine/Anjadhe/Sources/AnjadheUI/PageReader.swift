import Foundation
import AnjadheCore

// PageReader lived in HeadlinesFetch.swift (once PhoneNews.swift) beside the
// headline fetch for Portfolio's holdings. That fetch left with news on
// holdings on 2026-10-09 (docs/COACH.md §7); the agent's `read_url` still
// reads pages, so this half moved here whole, with the one regex helper it
// borrowed from HeadlinesFetch.

/// Reading a web page on the phone (the agent's `read_url`, PhoneAgent):
/// Google News links resolved to the publisher (main.js
/// `_resolveGoogleNewsUrl`, the same handshake), then the page's paragraphs
/// — a small stand-in for the Mac's Readability.
enum PageReader {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    private static var resolved: [String: String] = [:]
    private static let lock = NSLock()

    static func match(_ pattern: String, _ s: String, group: Int = 1) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              m.numberOfRanges > group, let r = Range(m.range(at: group), in: s) else { return nil }
        return String(s[r])
    }

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
