import Foundation

// A routine is a STANDING CONVERSATION (2026-10-07): the Mac keeps its
// definition on `conv.standing = { body, config }` in the synced
// `agent-conversations` blob, and each run's result is an assistant
// message in that chat carrying `metadata.routineRun = { id, at, error,
// readAt }` (the Mac's NotePrompts facade, js/apps/notes/note-prompts.js).
// Nothing routine-shaped lives in the `notes` blob any more.
//
// The phone reads the same records. The two readers below hand them out in
// the shapes the screens already draw — a routine as a record carrying
// `prompt` (its config) and `content` (its prompt text), a run as a post
// carrying `feed` `{promptId, model, error, readAt}`, `title` and
// `content` — so Feed, Routines, Now and the simple home keep their code.
// Everything shown is the record's own; nothing here writes a sentence.
public enum StandingChats {
    public static func isStanding(_ conv: JSONValue) -> Bool {
        conv["standing"]?.objectValue != nil
    }

    /// Every routine (and saved prompt), as records: `{id, title, content,
    /// prompt, createdAt, modifiedAt}`.
    public static func routines(_ conversations: [JSONValue]) -> [JSONValue] {
        conversations.compactMap { c -> JSONValue? in
            guard let st = c["standing"]?.objectValue, let id = c["id"]?.stringValue else { return nil }
            let title: String = c["title"]?.stringValue ?? "Untitled routine"
            let body: String = st["body"]?.stringValue ?? ""
            let config: JSONValue = st["config"] ?? .object([:])
            let created: String = c["createdAt"]?.stringValue ?? ""
            let updated: String = c["updatedAt"]?.stringValue ?? created
            var rec: [String: JSONValue] = [:]
            rec["id"] = .string(id)
            rec["title"] = .string(title)
            rec["content"] = .string(body)
            rec["prompt"] = config
            rec["template"] = .string("prompt")
            rec["createdAt"] = .string(created)
            rec["modifiedAt"] = .string(updated)
            return .object(rec)
        }
    }

    public static func isRun(_ msg: JSONValue) -> Bool {
        msg["role"]?.stringValue == "assistant" && msg["metadata"]?["routineRun"]?.objectValue != nil
    }

    /// Every run of every routine as a post, newest first.
    public static func runs(_ conversations: [JSONValue]) -> [JSONValue] {
        var out: [JSONValue] = []
        for c in conversations {
            guard isStanding(c), let cid = c["id"]?.stringValue else { continue }
            let title = c["title"]?.stringValue ?? "Untitled routine"
            for m in c["messages"]?.arrayValue ?? [] {
                guard isRun(m), let r = m["metadata"]?["routineRun"]?.objectValue, let id = r["id"]?.stringValue else { continue }
                let at = r["at"]?.stringValue ?? m["timestamp"]?.stringValue ?? ""
                let error = r["error"]?.stringValue ?? ""
                var feed: [String: JSONValue] = ["promptId": .string(cid)]
                if let model = m["metadata"]?["model"]?.stringValue { feed["model"] = .string(model) }
                if !error.isEmpty { feed["error"] = .string(error) }
                if let read = r["readAt"]?.stringValue, !read.isEmpty { feed["readAt"] = .string(read) }
                let content: String = error.isEmpty ? (m["content"]?.stringValue ?? "") : ""
                var rec: [String: JSONValue] = [:]
                rec["id"] = .string(id)
                rec["title"] = .string(title)
                rec["content"] = .string(content)
                rec["feed"] = .object(feed)
                rec["createdAt"] = .string(at)
                rec["modifiedAt"] = .string(at)
                out.append(.object(rec))
            }
        }
        return out.sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
    }

    /// The conversations with one run marked read (`readAt` stamped on its
    /// message, the conversation's `updatedAt` moved so the record wins the
    /// merge on the Mac). Returns nil when nothing changed.
    public static func markingRead(_ conversations: [JSONValue], runId: String, now: String) -> [JSONValue]? {
        var list = conversations
        for (i, c) in list.enumerated() {
            guard isStanding(c), case .object(var conv) = c, var msgs = conv["messages"]?.arrayValue else { continue }
            for (j, m) in msgs.enumerated() {
                guard isRun(m), case .object(var msg) = m, case .object(var meta) = msg["metadata"] ?? .null,
                      case .object(var run) = meta["routineRun"] ?? .null,
                      run["id"]?.stringValue == runId else { continue }
                if let read = run["readAt"]?.stringValue, !read.isEmpty { return nil }
                run["readAt"] = .string(now)
                meta["routineRun"] = .object(run)
                msg["metadata"] = .object(meta)
                msgs[j] = .object(msg)
                conv["messages"] = .array(msgs)
                conv["updatedAt"] = .string(now)
                list[i] = .object(conv)
                return list
            }
        }
        return nil
    }
}
