import Foundation
import Security
import AnjadheCore

// The phone's own assistant for when the Mac is away (docs/MOBILE_NATIVE.md
// "M5"; the laws P1-P5 head AnjadheCore/PhoneAI.swift). Three pieces:
//   • CloudCredentials — the Mac's Connect key, in this phone's Keychain (P4).
//   • CloudClient — nenva Cloud's OpenAI-compatible API: streamed chat with
//     tools, web search, the model catalog.
//   • PhoneAgent — a small tool loop: the web plus READ-ONLY synced records
//     (P3). Nothing it runs writes to the store.

// MARK: - Keychain

enum CloudCredentials {
    private static let service = "com.anjadhe.phone-ai"
    private static let account = "nenva-cloud"

    struct Value: Codable, Equatable { let apiKey: String; let baseURL: String }

    static func load() -> Value? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    static func save(_ v: Value) {
        guard let data = try? JSONEncoder().encode(v) else { return }
        clear()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account,
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                kSecValueData as String: data]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func clear() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}

// MARK: - nenva Cloud

struct CloudError: LocalizedError {
    let message: String
    let authFailed: Bool
    init(_ m: String, authFailed: Bool = false) { message = m; self.authFailed = authFailed }
    var errorDescription: String? { message }
}

struct CloudClient {
    static let defaultBase = "https://api.anjadhe.com"
    let apiKey: String
    let baseURL: String

    private func request(_ path: String, body: JSONValue, timeout: TimeInterval) throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else { throw CloudError("Bad nenva Cloud address.") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(body)
        return req
    }

    private static func failure(_ status: Int, _ data: Data?) -> CloudError {
        let msg = data.flatMap { try? JSONValue.parse(String(decoding: $0, as: UTF8.self)) }?["error"]
        let text = msg?.stringValue ?? msg?["message"]?.stringValue
        if status == 401 { return CloudError("nenva Cloud did not accept this phone's key.", authFailed: true) }
        if status == 429 { return CloudError(text ?? "nenva Cloud's monthly allowance is used up, or too many requests at once.") }
        return CloudError(text ?? "nenva Cloud error (\(status)).")
    }

    /// The catalog — keyless, so Settings can list models before a key exists.
    static func models(baseURL: String = defaultBase) async -> [(id: String, label: String)] {
        guard let url = URL(string: baseURL + "/v1/llm/models") else { return [] }
        var req = URLRequest(url: url); req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONValue.parse(String(decoding: data, as: UTF8.self)) else { return [] }
        return (json["models"]?.arrayValue ?? []).compactMap { m in
            guard let id = m["id"]?.stringValue?.trimmingCharacters(in: .whitespaces), !id.isEmpty else { return nil }
            let label = m["label"]?.stringValue?.trimmingCharacters(in: .whitespaces)
            return (id, (label?.isEmpty == false ? label! : id))
        }
    }

    /// One streamed turn. `onText` gets each slice of text as it arrives.
    func chat(model: String, messages: [JSONValue], tools: [JSONValue]?,
              onText: @escaping (String) -> Void) async throws -> SSEAccumulator {
        var body: [String: JSONValue] = ["model": .string(model), "messages": .array(messages), "stream": .bool(true)]
        if let tools = tools, !tools.isEmpty { body["tools"] = .array(tools) }
        let req = try request("/v1/llm/chat/completions", body: .object(body), timeout: 120)
        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var data = Data()
            for try await b in bytes { data.append(b); if data.count > 8192 { break } }
            throw Self.failure(status, data)
        }
        var acc = SSEAccumulator()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            let added = acc.feed(line)
            if !added.isEmpty { onText(added) }
            if acc.done { break }
        }
        return acc
    }

    func search(_ query: String) async throws -> [JSONValue] {
        let req = try request("/v1/search", body: .object(["query": .string(query), "maxResults": .number(6)]), timeout: 30)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw Self.failure(status, data) }
        let json = try JSONValue.parse(String(decoding: data, as: UTF8.self))
        return json["results"]?.arrayValue ?? []
    }
}

// MARK: - The tools (read-only, P3)

struct PhoneTools {
    let store: AppStore
    let client: CloudClient

    private var privacy: [String: JSONValue] { store.blob("cloud-privacy") }
    private func allowed(_ cls: String) -> Bool { PhonePrivacy.allows(cls, settings: privacy) }

    static func fn(_ name: String, _ desc: String, _ props: [String: JSONValue], required: [String] = []) -> JSONValue {
        .object(["type": .string("function"), "function": .object([
            "name": .string(name), "description": .string(desc),
            "parameters": .object(["type": .string("object"), "properties": .object(props),
                                   "required": .array(required.map { .string($0) })])])])
    }
    static func str(_ d: String) -> JSONValue { .object(["type": .string("string"), "description": .string(d)]) }

    static let definitions: [JSONValue] = [
        fn("web_search", "Search the web. Returns titles, links and snippets.", ["query": str("What to search for")], required: ["query"]),
        fn("read_url", "Read the text of a web page (https only).", ["url": str("The page address")], required: ["url"]),
        fn("list_tasks", "The user's open tasks. range: today (due today or overdue), upcoming (next 14 days), or all.",
           ["range": str("today | upcoming | all")]),
        fn("list_events", "Calendar events between two dates (YYYY-MM-DD). Defaults to today through the next 7 days.",
           ["from": str("YYYY-MM-DD"), "to": str("YYYY-MM-DD")]),
        fn("list_projects", "The user's active projects with their target dates.", [:]),
        fn("search_records", "Search the user's tasks, notes, projects, calendar events and journal by words.",
           ["query": str("Words to look for")], required: ["query"]),
        fn("read_record", "Read one record in full. kind: task | note | project | event | journal.",
           ["kind": str("task | note | project | event | journal"), "id": str("The record id from a list or search")], required: ["kind", "id"]),
    ]

    func run(_ name: String, _ argText: String) async -> String {
        let args = (try? JSONValue.parse(argText.isEmpty ? "{}" : argText)) ?? .object([:])
        func s(_ k: String) -> String { args[k]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        do {
            let out: JSONValue
            switch name {
            case "web_search":
                guard !s("query").isEmpty else { return #"{"error":"query is required"}"# }
                out = .object(["results": .array(try await client.search(s("query")))])
            case "read_url": out = await readURL(s("url"))
            case "list_tasks": out = listTasks(s("range"))
            case "list_events": out = listEvents(from: s("from"), to: s("to"))
            case "list_projects": out = listProjects()
            case "search_records": out = searchRecords(s("query"))
            case "read_record": out = readRecord(kind: s("kind"), id: s("id"))
            default: out = .object(["error": .string("Unknown tool \(name). On the phone only read tools are available.")])
            }
            let text = (try? String(decoding: JSONEncoder().encode(out), as: UTF8.self)) ?? "{}"
            return PlainText.truncate(text, 7000)
        } catch {
            return "{\"error\":\(Self.q(error.localizedDescription))}"
        }
    }

    static func q(_ s: String) -> String {
        (try? String(decoding: JSONEncoder().encode(s), as: UTF8.self)) ?? "\"\""
    }

    // Web

    private func readURL(_ raw: String) async -> JSONValue {
        guard let url = URL(string: raw), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else {
            return .object(["error": .string("Only https addresses can be read.")])
        }
        // Google News links are a JS shell, not the article: resolve them to
        // the publisher first, then read the page's paragraphs.
        let target = await PageReader.resolveGoogleNews(raw)
        if let page = await PageReader.read(target), page.text.count >= 200 {
            return .object(["url": .string(target), "title": .string(page.title),
                            "text": .string(PlainText.truncate(page.text, 6000))])
        }
        var req = URLRequest(url: url); req.timeoutInterval = 20
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { return .object(["error": .string("The page answered \(status).")]) }
            let html = String(decoding: data.prefix(1_500_000), as: UTF8.self)
            let title = html.range(of: "<title[^>]*>([\\s\\S]*?)</title>", options: [.regularExpression, .caseInsensitive])
                .map { PlainText.strip(String(html[$0])) } ?? ""
            var body = html
            for tag in ["script", "style", "noscript", "svg", "nav", "footer", "header"] {
                body = body.replacingOccurrences(of: "<\(tag)[\\s\\S]*?</\(tag)>", with: " ", options: [.regularExpression, .caseInsensitive])
            }
            return .object(["url": .string(raw), "title": .string(title),
                            "text": .string(PlainText.truncate(PlainText.strip(body), 6000))])
        } catch {
            return .object(["error": .string(error.localizedDescription)])
        }
    }

    // Records

    private func tasks() -> [JSONValue] { store.items("schedule", "scheduleItems") }

    private func taskRow(_ t: JSONValue) -> JSONValue {
        var o: [String: JSONValue] = ["id": t["id"] ?? .null, "title": t["title"] ?? .null]
        if let d = t["scheduledDate"]?.stringValue { o["date"] = .string(d) }
        if let tm = t["scheduledTime"]?.stringValue, !tm.isEmpty { o["time"] = .string(tm) }
        return .object(o)
    }

    private func listTasks(_ range: String) -> JSONValue {
        let today = DateLogic.todayStr()
        let horizon = DateLogic.dateStr(Date().addingTimeInterval(14 * 86400))
        let open = tasks().filter { !ScheduleLogic.taskResolved($0) }
        let rows = open.filter { t in
            let d = t["scheduledDate"]?.stringValue ?? ""
            switch range {
            case "upcoming": return !d.isEmpty && d > today && d <= horizon
            case "all": return true
            default: return ScheduleLogic.taskDueToday(t) || (!d.isEmpty && d < today)
            }
        }
        return .object(["today": .string(today), "tasks": .array(rows.prefix(60).map(taskRow)),
                        "count": .number(Double(rows.count))])
    }

    private func eventDate(_ e: JSONValue) -> String {
        String((e["start"]?.stringValue ?? "").prefix(10))
    }

    private func listEvents(from: String, to: String) -> JSONValue {
        let a = from.isEmpty ? DateLogic.todayStr() : from
        let b = to.isEmpty ? DateLogic.dateStr(Date().addingTimeInterval(7 * 86400)) : to
        let rows = store.items("calendar", "events")
            .filter { let d = eventDate($0); return d >= a && d <= b }
            .sorted { ($0["start"]?.stringValue ?? "") < ($1["start"]?.stringValue ?? "") }
            .prefix(80)
            .map { e -> JSONValue in
                var o: [String: JSONValue] = ["id": e["id"] ?? .null, "title": e["summary"] ?? .null, "start": e["start"] ?? .null]
                if let end = e["end"]?.stringValue { o["end"] = .string(end) }
                if let loc = e["location"]?.stringValue, !loc.isEmpty { o["location"] = .string(loc) }
                return .object(o)
            }
        return .object(["from": .string(a), "to": .string(b), "events": .array(Array(rows))])
    }

    private func listProjects() -> JSONValue {
        let rows = store.items("goals", "goals")
            .filter { $0["status"]?.stringValue != "completed" && $0["status"]?.stringValue != "draft" }
            .prefix(60)
            .map { g -> JSONValue in
                var o: [String: JSONValue] = ["id": g["id"] ?? .null, "title": g["title"] ?? .null]
                if let d = g["targetDate"]?.stringValue, !d.isEmpty { o["targetDate"] = .string(d) }
                if let grp = g["group"]?.stringValue, !grp.isEmpty { o["group"] = .string(grp) }
                return .object(o)
            }
        return .object(["projects": .array(Array(rows))])
    }

    /// Every searchable record as (kind, id, title, text, date). Notes and
    /// journal only when their privacy class allows (P3). Routines and their
    /// result posts are notes under the hood; they are left out.
    private func corpus() -> [(kind: String, id: String, title: String, text: String, date: String)] {
        var out: [(String, String, String, String, String)] = []
        for t in tasks() {
            guard let id = t["id"]?.stringValue else { continue }
            out.append(("task", id, t["title"]?.stringValue ?? "", PlainText.strip(t["description"]?.stringValue ?? ""), t["scheduledDate"]?.stringValue ?? ""))
        }
        for g in store.items("goals", "goals") {
            guard let id = g["id"]?.stringValue else { continue }
            out.append(("project", id, g["title"]?.stringValue ?? "", PlainText.strip(g["description"]?.stringValue ?? ""), g["targetDate"]?.stringValue ?? ""))
        }
        for e in store.items("calendar", "events") {
            guard let id = e["id"]?.stringValue else { continue }
            out.append(("event", id, e["summary"]?.stringValue ?? "", PlainText.strip((e["location"]?.stringValue ?? "") + " " + (e["description"]?.stringValue ?? "")), eventDate(e)))
        }
        if allowed("notes") {
            for n in store.items("notes", "notes") {
                guard let id = n["id"]?.stringValue else { continue }
                let tpl = n["template"]?.stringValue ?? ""
                if tpl == "feed" || tpl == "prompt" || n["prompt"] != nil { continue }
                out.append(("note", id, n["title"]?.stringValue ?? "", PlainText.strip(n["content"]?.stringValue ?? ""), String((n["modifiedAt"]?.stringValue ?? "").prefix(10))))
            }
        }
        if allowed("journal") {
            for j in store.items("journal", "entries") {
                guard let id = j["id"]?.stringValue else { continue }
                out.append(("journal", id, j["title"]?.stringValue ?? (j["date"]?.stringValue ?? ""), PlainText.strip(j["content"]?.stringValue ?? ""), j["date"]?.stringValue ?? ""))
            }
        }
        return out
    }

    private func searchRecords(_ query: String) -> JSONValue {
        let terms = query.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count > 1 }
        guard !terms.isEmpty else { return .object(["error": .string("query is required")]) }
        var hits: [(score: Int, row: JSONValue)] = []
        for r in corpus() {
            let title = r.title.lowercased(), text = r.text.lowercased()
            var score = 0
            for t in terms {
                if title.contains(t) { score += 3 } else if text.contains(t) { score += 1 } else { score = -1; break }
            }
            guard score > 0 else { continue }
            var o: [String: JSONValue] = ["kind": .string(r.kind), "id": .string(r.id), "title": .string(r.title)]
            if !r.date.isEmpty { o["date"] = .string(r.date) }
            if !r.text.isEmpty { o["snippet"] = .string(PlainText.truncate(r.text, 160)) }
            hits.append((score, .object(o)))
        }
        hits.sort { $0.score > $1.score }
        var result: [String: JSONValue] = ["results": .array(hits.prefix(15).map { $0.row })]
        let held = ["notes": "Notes", "journal": "Journal"].filter { !allowed($0.key) }.map { $0.value }.sorted()
        if !held.isEmpty { result["notSearched"] = .string("\(held.joined(separator: " and ")) stay off nenva Cloud under Cloud Privacy (Settings on the Mac).") }
        return .object(result)
    }

    private func readRecord(kind: String, id: String) -> JSONValue {
        switch kind {
        case "note" where !allowed("notes"), "journal" where !allowed("journal"):
            return .object(["error": .string("That stays off nenva Cloud under Cloud Privacy. It can be read when your Mac answers.")])
        default: break
        }
        guard let r = corpus().first(where: { $0.kind == kind && $0.id == id }) else {
            return .object(["error": .string("No \(kind) with that id.")])
        }
        return .object(["kind": .string(r.kind), "id": .string(r.id), "title": .string(r.title),
                        "date": .string(r.date), "text": .string(PlainText.truncate(r.text, 6000))])
    }
}

// MARK: - The loop

struct PhoneAgent {
    static let maxRounds = 6
    let store: AppStore
    let client: CloudClient
    let choice: PhoneModelChoice

    private func systemPrompt() -> String {
        let f = DateFormatter(); f.dateFormat = "EEEE, MMMM d, yyyy 'at' h:mm a"
        return """
        You are nenva, the user's personal AI, answering in the nenva app on their iPhone. Their Mac, where you normally run with all of their tools, cannot be reached right now, so you are running on \(choice.displayName) from the phone. Now: \(f.string(from: Date())).

        What you can do here: search the web, read web pages, and READ the user's synced tasks, calendar, projects, notes and journal (notes and journal only when their Cloud Privacy settings allow). You cannot change anything from the phone: no creating, editing, completing or deleting, no email. If asked to, say plainly that it has to wait for their Mac, and offer to hand it over when the Mac is back (their next message will reach the Mac with this conversation).

        Use tools for facts about the user's records or the current world; never invent a task, event, date or link. When you mention a task, note, project, journal entry or event a tool returned, link its title: [Title](anjadhe://task/<id>), anjadhe://note/<id>, anjadhe://project/<id>, anjadhe://journal/<id>, anjadhe://event/<id>, with the id from the tool result.

        Style: concise and phone-readable, short paragraphs, simple markdown, no wide tables.
        """
    }

    /// Runs one answer. `onText` streams the answer being written; it resets
    /// (receives nil) when a tool round starts, like the Mac's buffer does.
    func answer(history: [PhoneThread.Message], onText: @escaping (String?) -> Void) async throws -> String {
        var messages: [JSONValue] = [.object(["role": .string("system"), "content": .string(systemPrompt())])]
        for m in history { messages.append(.object(["role": .string(m.role), "content": .string(m.content)])) }
        let tools = PhoneTools(store: store, client: client)
        for round in 0..<Self.maxRounds {
            let last = round == Self.maxRounds - 1
            if last {
                messages.append(.object(["role": .string("user"), "content": .string(
                    "(Automatic note, not from the user.) The tool budget is used up. Answer now from the results above, in plain prose, and say in one line what is still missing.")]))
            }
            onText(nil)
            let acc = try await client.chat(model: choice.model, messages: messages,
                                            tools: last ? nil : PhoneTools.definitions,
                                            onText: { onText($0) })
            let calls = Array(acc.toolCalls.prefix(4))
            if calls.isEmpty || last {
                let text = LeakedToolCalls.strip(acc.content)
                if text.isEmpty { throw CloudError("nenva Cloud returned an empty answer.") }
                return text
            }
            messages.append(.object([
                "role": .string("assistant"), "content": .string(acc.content),
                "tool_calls": .array(calls.map { c in .object([
                    "id": .string(c.id), "type": .string("function"),
                    "function": .object(["name": .string(c.name), "arguments": .string(c.arguments)])]) })]))
            for c in calls {
                let result = await tools.run(c.name, c.arguments)
                messages.append(.object(["role": .string("tool"), "tool_call_id": .string(c.id),
                                         "name": .string(c.name), "content": .string(result)]))
            }
        }
        throw CloudError("No answer was written.")
    }
}
