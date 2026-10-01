import Foundation

// The phone's own AI when the Mac is away (2026-09-25, docs/MOBILE_NATIVE.md
// "M5"). The pure half, testable with `swift test`: reading an OpenAI-style
// SSE stream, the chosen model, the privacy classes, and how a conversation
// the phone answered joins the Mac's. The network and the screens live in
// AnjadheUI (PhoneAgent.swift).
//
// Laws, each a decision (2026-09-25, with Ram):
//   P1  The Mac answers first. The phone answers by itself only when the Mac
//       cannot be reached AND the user chose a model for the phone (the
//       synced `phone-ai` key). Absent means off: the phone waits for the Mac.
//   P2  Every answer the phone wrote says so, with the model's name.
//   P3  On its own the phone only READS: the web, and synced records. It
//       changes nothing. Journal and wellness are read only when the synced
//       `cloud-privacy` classes allow them (off by default).
//   P4  nenva cloud rides the Mac's Connect key, handed over the encrypted
//       pairing and kept in the Keychain: one allowance per person.
//   P5  There is ONE conversation list (record-merged, 2026-09-25): the
//       phone writes its turns into the shared conversation and they reach
//       the Mac by sync, where two copies of one conversation union their
//       messages — no hand-back step, nothing kept only on the phone.

/// Curated models are named by TIER, never by model (2026-09-30) — the
/// Swift twin of js/agent/model-names.js. A hosted model is "nenva cloud
/// lite" / "nenva cloud pro" (an unknown id is "nenva cloud"); retired ids
/// map to their tier ids, and an older Connect is retried on the retired id.
public enum ModelTiers {
    public static let defaultCloudModel = "nenva-cloud-lite"
    public static let cloudLabel = "nenva cloud"
    public static let localLabel = "nenva local"
    static let tiers: [String: String] = [
        "nenva-cloud-lite": "nenva cloud lite",
        "nenva-cloud-pro": "nenva cloud pro",
    ]
    static let legacy: [String: String] = [
        "anjadhe-cloud": "nenva-cloud-lite",
        "anjadhe-cloud-qwen3.8": "nenva-cloud-pro",
    ]

    /// The tier id for any cloud id, old or new.
    public static func publicId(_ id: String) -> String {
        let s = id.trimmingCharacters(in: .whitespaces)
        return legacy[s] ?? s
    }

    /// The retired id an older Connect still knows, or nil.
    public static func legacyId(_ id: String) -> String? {
        legacy.first(where: { $0.value == id })?.key
    }

    /// A hosted model's name: its tier when known, else an operator label
    /// that already speaks as nenva, else "nenva cloud" — never a model's own name.
    public static func cloudName(model: String, label: String?) -> String {
        if let tier = tiers[publicId(model)] { return tier }
        let l = (label ?? "").trimmingCharacters(in: .whitespaces)
        if l.lowercased().hasPrefix("nenva") {
            if l.lowercased().hasPrefix("nenva cloud") { return "nenva cloud" + l.dropFirst("nenva cloud".count) }
            return l
        }
        return cloudLabel
    }

    /// A model name stored with no entry (an answer's signature), relabelled.
    public static func displayForStored(_ name: String) -> String {
        let s = name.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return s }
        let low = s.lowercased()
        if low.hasPrefix("anjadhe-cloud") || low.hasPrefix("nenva-cloud") { return cloudName(model: s, label: s) }
        if low.hasPrefix("nenva cloud") { return cloudName(model: "", label: s) }
        if low == localLabel || low.hasSuffix(".gguf") || s.contains("/") || low.hasPrefix("anjadhe-") { return localLabel }
        return s
    }
}

/// The model the user chose for the phone, from the synced `phone-ai` key.
public struct PhoneModelChoice: Equatable {
    public let engine: String
    public let model: String
    public let label: String

    public init(engine: String, model: String, label: String) {
        self.engine = engine; self.model = model; self.label = label
    }

    /// `{fallback: {engine, model, label}}` → a choice; anything else → nil (off).
    public static func from(_ blob: [String: JSONValue]) -> PhoneModelChoice? {
        guard let fb = blob["fallback"], let engine = fb["engine"]?.stringValue,
              let model = fb["model"]?.stringValue, !model.isEmpty,
              engine == "anjadhe" else { return nil }
        // A choice written before the tiers carries a retired id and maybe a
        // model's own name; it is read as its tier (ModelTiers).
        let id = ModelTiers.publicId(model)
        return PhoneModelChoice(engine: engine, model: id, label: ModelTiers.cloudName(model: id, label: fb["label"]?.stringValue))
    }

    /// The name an answer is signed with (P2): the tier name, nothing added.
    public var displayName: String { ModelTiers.cloudName(model: model, label: label) }

    public func blob(now: String) -> [String: JSONValue] {
        ["fallback": .object(["engine": .string(engine), "model": .string(model), "label": .string(label)]),
         "updatedAt": .string(now)]
    }
}

/// The synced `cloud-privacy` classes, read the way the Mac's CloudPrivacy
/// does: an explicit boolean wins, else the class default. The phone's
/// model always runs off the device, so the class alone decides (P3).
public enum PhonePrivacy {
    /// Classes that are OFF unless the user turned them on (cloud-privacy.js).
    static let offByDefault: Set<String> = ["journal", "wellness", "messages", "spending"]

    public static func allows(_ cls: String, settings: [String: JSONValue]) -> Bool {
        if let on = settings["classes"]?[cls]?.boolValue { return on }
        return !offByDefault.contains(cls)
    }
}

/// One tool call, assembled from streamed fragments.
public struct StreamedToolCall: Equatable {
    public var id: String
    public var name: String
    public var arguments: String
}

/// Reads an OpenAI-compatible `chat/completions` SSE stream line by line.
/// Text arrives in `delta.content`; tool calls arrive as fragments keyed by
/// `index`, whose `function.arguments` strings concatenate.
public struct SSEAccumulator {
    public private(set) var content = ""
    public private(set) var done = false
    private var calls: [Int: StreamedToolCall] = [:]

    public init() {}

    public var toolCalls: [StreamedToolCall] {
        calls.keys.sorted().compactMap { calls[$0] }.filter { !$0.name.isEmpty }
    }

    /// Feed one line. Returns the text it added (for streaming to the screen).
    @discardableResult
    public mutating func feed(_ line: String) -> String {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("data:") else { return "" }
        let payload = t.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { done = true; return "" }
        guard let json = try? JSONValue.parse(String(payload)),
              let choice = json["choices"]?.arrayValue?.first else { return "" }
        let delta = choice["delta"] ?? choice["message"] ?? .object([:])
        var added = ""
        if let text = delta["content"]?.stringValue, !text.isEmpty {
            content += text
            added = text
        }
        for (pos, tc) in (delta["tool_calls"]?.arrayValue ?? []).enumerated() {
            let idx = tc["index"]?.numberValue.map { Int($0) } ?? pos
            var cur = calls[idx] ?? StreamedToolCall(id: "", name: "", arguments: "")
            if let id = tc["id"]?.stringValue, !id.isEmpty { cur.id = id }
            if let name = tc["function"]?["name"]?.stringValue, !name.isEmpty { cur.name += name }
            if let args = tc["function"]?["arguments"]?.stringValue { cur.arguments += args }
            if cur.id.isEmpty { cur.id = "call_\(idx)" }
            calls[idx] = cur
        }
        return added
    }
}

/// A tool call the model wrote as TEXT (the Mac's ModelQuirks
/// .stripLeakedToolCalls): nothing ran, and the markup is never shown.
public enum LeakedToolCalls {
    public static func strip(_ text: String) -> String {
        guard text.range(of: "<tool_call>|<function=", options: [.regularExpression, .caseInsensitive]) != nil else { return text }
        var out = text
        for pattern in ["<tool_call>[\\s\\S]*?(</tool_call>|$)", "<function=[\\s\\S]*?(</function>|$)", "</?tool_call>"] {
            out = out.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        return out.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A conversation's turns as the phone shows and replays them. Since the
/// conversation list is ONE record-merged list (2026-09-25), the phone writes
/// its turns straight into the shared conversation; an answer it wrote
/// carries `metadata: {answeredOn: "phone", model}` and is signed with it (P2).
public enum PhoneThread {
    public struct Message: Equatable {
        public let role: String
        public let content: String
        /// Set on an answer the phone wrote: the model's name (P2).
        public let answeredBy: String?
        public init(role: String, content: String, answeredBy: String? = nil) {
            self.role = role; self.content = content; self.answeredBy = answeredBy
        }
    }

    public static func messages(_ conv: JSONValue?) -> [Message] {
        (conv?["messages"]?.arrayValue ?? []).compactMap { m in
            guard let role = m["role"]?.stringValue, role == "user" || role == "assistant",
                  let content = m["content"]?.stringValue,
                  !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let by = (role == "assistant" && m["metadata"]?["answeredOn"]?.stringValue == "phone")
                ? ModelTiers.displayForStored(m["metadata"]?["model"]?.stringValue ?? "nenva cloud") : nil
            return Message(role: role, content: content, answeredBy: by)
        }
    }

    /// The model's history for a phone turn: the conversation's tail.
    public static func history(_ conv: JSONValue?, limit: Int = 24) -> [Message] {
        Array(messages(conv).suffix(limit))
    }

    /// A phone turn appended to a conversation, stamped so it wins the merge
    /// for this conversation (and the Mac unions any turn it added meanwhile).
    public static func appending(_ conv: [String: JSONValue], _ message: [String: JSONValue], now: String) -> [String: JSONValue] {
        var c = conv
        c["messages"] = .array((conv["messages"]?.arrayValue ?? []) + [.object(message)])
        c["updatedAt"] = .string(now)
        return c
    }
}
