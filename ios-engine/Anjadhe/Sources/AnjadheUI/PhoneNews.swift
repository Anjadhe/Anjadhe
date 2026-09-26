import Foundation
import AnjadheCore

/// News built on the phone when the Mac is away (docs/MOBILE_NATIVE.md "M5",
/// phase 2). The pure rules are NewsLogic.swift, pinned to the desktop by
/// NewsParityTests; this is the network and the view envelopes.
///
/// Routing is the MAC'S choice, never re-decided here (docs/DISCOVER.md):
/// the last answer the Mac served carries `route` — "connect" means the
/// user's topics go only through nenva Cloud (`/v1/news`, on the Mac's key),
/// "direct" means straight to the picked sources. The phone follows it and
/// carries it forward. With no Mac answer ever seen, or web access off on
/// the Mac, it builds nothing and says why.
struct PhoneNews {
    let store: AppStore
    let chat: ChatState

    typealias Done = (Result<JSONValue, Error>) -> Void
    struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
    static func fail(_ m: String) -> Result<JSONValue, Error> { .failure(Failure(message: m)) }

    var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    func build(_ view: String, _ p: [String: JSONValue], _ done: @escaping Done) -> Bool {
        switch view {
        case "news":
            Task { done(await news()) }
        case "news-article":
            done(article(p))
        case "news-action":
            done(action(p))
        default:
            return false
        }
        return true
    }

    static func isUpdate(_ it: JSONValue) -> Bool { NewsLogic.isUpdate(it) }

    // MARK: the feed

    private func news() async -> Result<JSONValue, Error> {
        guard let last = MacViews.storedAnswer("news"), let route = last["route"]?.stringValue, !route.isEmpty else {
            return Self.fail("Open News once while your Mac is reachable, so this phone knows where your headlines come from.")
        }
        if last["webOn"]?.boolValue == false {
            return Self.fail("Web access is off on your Mac, so News does not fetch headlines.")
        }
        let settings = NewsLogic.settings(store.blob("discover-settings"))
        let topics = NewsLogic.fetchTopics(settings)
        guard !topics.isEmpty else { return Self.fail("Follow a topic to see headlines.") }

        let fetched: [JSONValue]
        if route == "connect" {
            guard let cred = CloudCredentials.load() else {
                return Self.fail("Your headlines come through nenva Cloud. This phone gets the key from your Mac the next time they connect.")
            }
            do { fetched = try await Self.viaConnect(topics, settings.sources, cred) }
            catch { return Self.fail("nenva Connect could not fetch headlines right now.") }
        } else {
            fetched = await Self.direct(topics, settings.sources, nowMs: nowMs)
        }
        if !fetched.isEmpty && fetched.allSatisfy({ $0["error"] != nil }) {
            return Self.fail(route == "connect" ? "nenva Connect could not fetch headlines right now." : "The news sources could not be reached.")
        }

        let taste = NewsLogic.taste(store.blob("discover-taste"), nowMs: nowMs)
        let hues = NewsLogic.hueMap(settings.interests)
        let groups = NewsLogic.groups(fetched, fewer: taste.fewer, clicks: taste.clicks, hues: hues, nowMs: nowMs)
        var bySource: [String: Double] = [:], total = 0.0
        for g in groups { for r in g["rows"]?.arrayValue ?? [] { bySource[r["via"]?.stringValue ?? "google", default: 0] += 1; total += 1 } }
        let failed = fetched.filter { $0["error"] != nil }.compactMap { $0["topic"]?.stringValue }
        let saved = store.kv.get("app_news-saved")?.arrayValue ?? []
        let labels = NewsLogic.sourceLabels
        return .success(.object([
            "at": .number(nowMs), "generatedAt": .number(nowMs), "route": .string(route),
            "ranked": .bool(false), "webOn": .bool(true),
            "lastError": failed.isEmpty ? .null : .string("Could not fetch: \(failed.joined(separator: ", ")).") ,
            "settings": .object(["interests": .array(settings.interests.map { .string($0) }),
                                 "location": .string(settings.location),
                                 "sources": .array(settings.sources.map { .string($0) })]),
            // The Topics page's furniture is the Mac's; carry it forward.
            "sources": last["sources"].map { list in .array((list.arrayValue ?? []).map { s in
                guard case .object(var o) = s else { return s }
                o["on"] = .bool(settings.sources.contains(s["id"]?.stringValue ?? "")); return .object(o) }) }
                ?? .array(NewsLogic.sourceIds.map { .object(["id": .string($0), "label": .string(labels[$0] ?? $0), "desc": .string(""), "on": .bool(settings.sources.contains($0))]) }),
            "topicHues": .object(Dictionary(uniqueKeysWithValues: settings.interests.map { ($0, .string(NewsLogic.topicHue($0, map: hues))) })),
            "groups": .array(groups), "total": .number(total),
            "bySource": .object(bySource.mapValues { .number($0) }),
            // The digest is model-written from the whole feed on the Mac.
            "digest": .null, "digestAvailable": .bool(false),
            "savedCount": .number(Double(saved.count)),
            "catalog": last["catalog"] ?? .array([]),
            "topicLimit": last["topicLimit"] ?? .number(15),
            "mutedCount": .number(Double(taste.fewer.count)),
        ]))
    }

    /// `/v1/news`, chunked at 8 topics as the Mac does; all chunks or none.
    static func viaConnect(_ topics: [String], _ sources: [String], _ cred: CloudCredentials.Value) async throws -> [JSONValue] {
        var out: [JSONValue] = []
        var i = 0
        while i < topics.count {
            let chunk = Array(topics[i..<min(i + 8, topics.count)]); i += 8
            guard let url = URL(string: cred.baseURL + "/v1/news") else { throw Failure(message: "bad address") }
            var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 20
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(cred.apiKey)", forHTTPHeaderField: "Authorization")
            req.httpBody = try JSONEncoder().encode(JSONValue.object(["topics": .array(chunk.map { .string($0) }), "sources": .array(sources.map { .string($0) })]))
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

    /// Straight to each picked source, per topic, in parallel (`_newsDirect`).
    static func direct(_ topics: [String], _ sources: [String], nowMs: Double) async -> [JSONValue] {
        await withTaskGroup(of: (Int, JSONValue).self) { group in
            for (i, topic) in topics.enumerated() {
                group.addTask {
                    var lists: [[JSONValue]] = [], anyOK = false
                    for src in sources {
                        guard let url = NewsLogic.sourceURL(src, topic: topic, nowMs: nowMs) else { continue }
                        var req = URLRequest(url: url); req.timeoutInterval = 15
                        req.setValue("application/rss+xml, application/xml, text/xml, application/json", forHTTPHeaderField: "Accept")
                        req.setValue("Anjadhe/1.0", forHTTPHeaderField: "User-Agent")
                        guard let (data, resp) = try? await URLSession.shared.data(for: req),
                              (resp as? HTTPURLResponse)?.statusCode == 200 else { continue }
                        let text = String(decoding: data, as: UTF8.self)
                        lists.append(src == "hn" ? NewsLogic.hnItems(text) : NewsLogic.parseRss(text, via: src))
                        anyOK = true
                    }
                    guard anyOK else { return (i, .object(["topic": .string(topic), "items": .array([]), "error": .string("unavailable")])) }
                    // mergeSourceItems: newest first across sources.
                    let merged = lists.flatMap { $0 }.sorted {
                        ($0["publishedAt"]?.stringValue ?? "") > ($1["publishedAt"]?.stringValue ?? "")
                    }
                    return (i, .object(["topic": .string(topic), "items": .array(merged)]))
                }
            }
            var out: [(Int, JSONValue)] = []
            for await r in group { out.append(r) }
            return out.sorted { $0.0 < $1.0 }.map { $0.1 }
        }
    }

    // MARK: the writes (MobileViews._newsAction, the synced half)

    private func action(_ p: [String: JSONValue]) -> Result<JSONValue, Error> {
        let action = p["action"]?.stringValue ?? ""
        var blob = store.blob("discover-settings")
        let s = NewsLogic.settings(blob)
        func save(interests: [String]? = nil, location: String? = nil, sources: [String]? = nil) {
            blob["interests"] = .array((interests ?? s.interests).prefix(15).map { .string($0) })
            blob["location"] = .string(location ?? s.location)
            blob["sources"] = .array((sources ?? s.sources).map { .string($0) })
            store.saveBlob("discover-settings", blob)
        }
        switch action {
        case "follow", "unfollow":
            let topic = String((p["topic"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces).prefix(60))
            guard !topic.isEmpty else { return Self.fail("missing topic") }
            var list = s.interests
            let at = list.firstIndex { $0.lowercased() == topic.lowercased() }
            if action == "follow" {
                if at != nil { return .success(.object(["ok": .bool(true), "action": .string(action), "changed": .bool(false)])) }
                if list.count >= 15 { return Self.fail("You can follow up to 15 topics. Unfollow one first.") }
                list.append(topic)
            } else {
                guard let at = at else { return .success(.object(["ok": .bool(true), "action": .string(action), "changed": .bool(false)])) }
                list.remove(at: at)
            }
            save(interests: list)
            return .success(.object(["ok": .bool(true), "action": .string(action), "topic": .string(topic), "changed": .bool(true),
                                     "interests": .array(list.map { .string($0) })]))
        case "source":
            let id = p["source"]?.stringValue ?? ""
            guard NewsLogic.sourceIds.contains(id) else { return Self.fail("unknown source") }
            var list = s.sources.filter { $0 != id }
            if p["on"]?.boolValue == true { list.append(id) }
            guard !list.isEmpty else { return Self.fail("Keep at least one source on.") }
            let normalized = NewsLogic.normalizeSources(list.map { .string($0) })
            save(sources: normalized)
            return .success(.object(["ok": .bool(true), "action": .string(action), "sources": .array(normalized.map { .string($0) })]))
        case "location":
            let loc = String((p["location"]?.stringValue ?? "").prefix(80)).trimmingCharacters(in: .whitespaces)
            save(location: loc)
            return .success(.object(["ok": .bool(true), "action": .string(action), "location": .string(loc)]))
        case "refresh", "settle":
            // The next ask rebuilds from the sources; nothing runs in between.
            return .success(.object(["ok": .bool(true), "action": .string(action), "started": .bool(true)]))
        case "fewer":
            let title = String((p["title"]?.stringValue ?? "").prefix(200))
            guard !title.isEmpty else { return Self.fail("missing title") }
            addTaste("fewer", title: title, topic: p["topic"]?.stringValue ?? "", max: 80)
            return .success(.object(["ok": .bool(true), "action": .string(action), "title": .string(title)]))
        case "reset-fewer":
            var t = store.blob("discover-taste"); t["fewer"] = .array([]); store.saveBlob("discover-taste", t)
            return .success(.object(["ok": .bool(true), "action": .string(action)]))
        case "save", "unsave":
            return setSaved(p, on: action == "save")
        default:
            // catchup / clear-digest: the digest is written on the Mac.
            return Self.fail("That needs your Mac.")
        }
    }

    /// NewsFeed.recordClick / recordFewer: one signal per story, capped.
    private func addTaste(_ kind: String, title: String, topic: String, max: Int) {
        var t = store.blob("discover-taste")
        var list = t[kind]?.arrayValue ?? []
        let recent = kind == "clicks" ? Array(list.suffix(10)) : list
        guard !recent.contains(where: { NewsLogic.sameStory($0["title"]?.stringValue ?? "", title) }) else { return }
        list.append(.object(["title": .string(String(title.prefix(200))), "topic": .string(topic), "at": .number(nowMs)]))
        t[kind] = .array(Array(list.suffix(max)))
        store.saveBlob("discover-taste", t)
    }

    /// NewsApp.setSaved: identity is the feed URL, else the title.
    private func setSaved(_ p: [String: JSONValue], on: Bool) -> Result<JSONValue, Error> {
        let url = p["url"]?.stringValue ?? "", title = p["title"]?.stringValue ?? ""
        let item = itemFor(url: url, title: title)
        let key = item["url"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? item["title"]?.stringValue ?? ""
        guard !key.isEmpty else { return Self.fail("missing article") }
        func keyOf(_ x: JSONValue) -> String { x["url"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? x["title"]?.stringValue ?? "" }
        var list = (store.kv.get("app_news-saved")?.arrayValue ?? []).filter { keyOf($0) != key }
        if on {
            list.insert(.object([
                "url": .string(item["url"]?.stringValue ?? ""), "openUrl": .string(""),
                "title": .string(item["title"]?.stringValue ?? ""), "source": .string(item["source"]?.stringValue ?? ""),
                "sourceUrl": .string(item["sourceUrl"]?.stringValue ?? ""), "topic": .string(item["topic"]?.stringValue ?? ""),
                "publishedAt": item["publishedAt"] ?? .null, "savedAt": .number(nowMs)]), at: 0)
        }
        store.kv.set("app_news-saved", .array(Array(list.prefix(300))), now: KVStore.nowISO())
        store.bump()
        return .success(.object(["ok": .bool(true), "action": .string(on ? "save" : "unsave"), "url": .string(url), "saved": .bool(on)]))
    }

    /// MobileViews._newsItemFor: the row from the last feed or the saved
    /// list, else a bare link.
    private func itemFor(url: String, title: String) -> JSONValue {
        if let last = MacViews.storedAnswer("news") {
            for g in last["groups"]?.arrayValue ?? [] {
                if let hit = (g["rows"]?.arrayValue ?? []).first(where: { $0["url"]?.stringValue == url }) { return hit }
            }
        }
        if let hit = (store.kv.get("app_news-saved")?.arrayValue ?? []).first(where: { $0["url"]?.stringValue == url }) { return hit }
        let host = URLComponents(string: url)?.host?.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) ?? ""
        return .object(["title": .string(String(title.prefix(300))), "url": .string(url), "source": .string(host), "publishedAt": .null])
    }

    // MARK: one article

    /// A run outlives the view window: the first ask starts it and answers
    /// `pending`; the reader polls every 2 s (NewsReader) until it is done.
    final class ArticleRun {
        var status = "Reading the article on this phone…"
        var summary: String?
        var mode: String?
        var openUrl = ""
        var error: String?
        var streaming = false
        var done = false
        var at = Date()
    }
    private static var runs: [String: ArticleRun] = [:]
    private static let runsLock = NSLock()

    private func article(_ p: [String: JSONValue]) -> Result<JSONValue, Error> {
        let url = String((p["url"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces).prefix(2000))
        guard url.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else {
            return Self.fail("That is not a link this can read.")
        }
        let item = itemFor(url: url, title: p["title"]?.stringValue ?? "")
        if p["record"]?.boolValue != false, let t = item["title"]?.stringValue, !t.isEmpty {
            addTaste("clicks", title: t, topic: item["topic"]?.stringValue ?? "", max: 120)
        }
        Self.runsLock.lock()
        var run = Self.runs[url]
        if p["refresh"]?.boolValue == true, run?.done == true { run = nil }
        if run == nil {
            let r = ArticleRun()
            Self.runs[url] = r
            run = r
            let choice = chat.choice, cred = CloudCredentials.load()
            let store = self.store
            Task.detached { await PhoneNews.read(item: item, run: r, choice: choice, cred: cred, store: store) }
        }
        Self.runsLock.unlock()
        return .success(articleOut(item, run!))
    }

    private func articleOut(_ item: JSONValue, _ r: ArticleRun) -> JSONValue {
        let notes: [String: (String, String)] = [
            "article": ("AI summary", "Written on this phone by \(chat.choice?.displayName ?? "nenva Cloud") from the article itself, while your Mac was away"),
            "extract": ("Extract", "The article's own text. Choose a model for when your Mac is away to get a written summary."),
        ]
        let note = r.mode.flatMap { notes[$0] }
        let saved = (store.kv.get("app_news-saved")?.arrayValue ?? []).contains { $0["url"]?.stringValue == item["url"]?.stringValue }
        let topic = item["topic"]?.stringValue ?? ""
        return .object([
            "at": .number(nowMs), "url": item["url"] ?? .string(""),
            "title": .string(String((item["title"]?.stringValue ?? "").prefix(300))),
            "topic": .string(topic),
            "hue": .string(NewsLogic.topicHue(topic, map: NewsLogic.hueMap(NewsLogic.settings(store.blob("discover-settings")).interests))),
            "publisher": .string(String((item["source"]?.stringValue ?? "").prefix(60))),
            "publishedAt": item["publishedAt"] ?? .null,
            "updated": .bool(NewsLogic.isUpdate(item)),
            "discussionUrl": .string(item["discussionUrl"]?.stringValue ?? ""),
            "saved": .bool(saved), "pending": .bool(!r.done), "status": .string(r.done ? "" : r.status),
            "streaming": .bool(r.streaming), "summary": r.summary.map { .string(String($0.prefix(20000))) } ?? .null,
            "mode": r.mode.map { .string($0) } ?? .null,
            "modeTag": note.map { .string($0.0) } ?? .null, "modeNote": note.map { .string($0.1) } ?? .null,
            "modePlain": .bool(r.mode == "extract"),
            "openUrl": .string(r.openUrl.isEmpty ? (item["url"]?.stringValue ?? "") : r.openUrl),
            "error": r.error.map { .string($0) } ?? .null,
            "sourceCard": .null, "related": .null, "relatedLoading": .bool(false), "relatedPicked": .bool(false), "events": .null,
        ])
    }

    /// Resolve → read → summarise (with the phone's model) or extract.
    static func read(item: JSONValue, run: ArticleRun, choice: PhoneModelChoice?, cred: CloudCredentials.Value?, store: AppStore) async {
        let raw = item["url"]?.stringValue ?? ""
        let target = await PageReader.resolveGoogleNews(raw)
        run.openUrl = target
        guard let page = await PageReader.read(target), page.text.count >= 400 else {
            run.error = "This article could not be read on the phone. Open it in your browser instead."
            run.done = true
            return
        }
        guard let choice = choice, let cred = cred else {
            run.summary = PlainText.truncate(page.text, 3000)
            run.mode = "extract"
            run.done = true
            return
        }
        run.status = "Writing a summary with \(choice.displayName)…"
        let prompt = """
        Headline: \(item["title"]?.stringValue ?? page.title)

        \(PlainText.truncate(page.text, 12000))

        Give me a detailed summary of this news with full background, details and insights, in simple language, written like a human journalist, grounded on the information from the source material above. No exaggerations. No filler words. Just facts.

        How to write it:
        - Open with what happened and why it matters, in plain language.
        - Then the background a newcomer needs to follow the story.
        - Then the specifics: the numbers, names, dates and quotes that are actually in the material.
        - Close with what it means or what happens next, but ONLY where the material supports it. If it does not, leave it out rather than speculating.
        - Finish with a line containing just **Key points**, then up to five bullets carrying the hard facts.

        Rules: plain markdown, no preamble, do not repeat the headline as a title, do not pad. Use ONLY the material above; if something is not in it, do not write it. Do not write a source, link, or date line at the end - the app adds that itself.

        If the material is not actually article content (a cookie or consent notice, a redirect stub, a paywall or sign-in wall, an error page, unrelated boilerplate), reply with exactly: UNUSABLE
        """
        let messages: [JSONValue] = [
            .object(["role": .string("system"), "content": .string("You are a news journalist writing for a reader who has not followed this story. You write only from the source material you are given. You never invent facts, numbers, names, dates, or quotes that are not in that material.")]),
            .object(["role": .string("user"), "content": .string(prompt)]),
        ]
        do {
            run.streaming = true
            var partial = ""
            let acc = try await CloudClient(apiKey: cred.apiKey, baseURL: cred.baseURL)
                .chat(model: choice.model, messages: messages, tools: nil) { s in partial += s; run.summary = partial; run.mode = "article" }
            let text = acc.content.trimmingCharacters(in: .whitespacesAndNewlines)
            run.streaming = false
            if text.isEmpty || text.hasPrefix("UNUSABLE") {
                run.summary = PlainText.truncate(page.text, 3000); run.mode = "extract"
            } else {
                run.summary = text; run.mode = "article"
            }
        } catch {
            run.streaming = false
            if (error as? CloudError)?.authFailed == true { CloudCredentials.clear() }
            run.summary = PlainText.truncate(page.text, 3000); run.mode = "extract"
        }
        run.done = true
    }
}

/// Reading a web page on the phone: Google News links resolved to the
/// publisher (main.js `_resolveGoogleNewsUrl`, the same handshake), then the
/// page's paragraphs — a small stand-in for the Mac's Readability.
enum PageReader {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    private static var resolved: [String: String] = [:]
    private static let lock = NSLock()

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
            guard let sg = NewsLogicBridge.match("data-n-a-sg=\"([^\"]+)\"", html),
                  let ts = NewsLogicBridge.match("data-n-a-ts=\"([^\"]+)\"", html), let tsn = Double(ts) else { return url }
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
            guard let dest = NewsLogicBridge.match("(https?://(?!news\\.google\\.com)[^\\s\"\\\\]+)", body) else { return url }
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
        let title = NewsLogicBridge.match("<title[^>]*>([\\s\\S]*?)</title>", html).map { decodeNumeric(PlainText.strip($0)) } ?? ""
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

/// The one regex helper PhoneNews needs from AnjadheCore's internals.
enum NewsLogicBridge {
    static func match(_ pattern: String, _ s: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }
}
