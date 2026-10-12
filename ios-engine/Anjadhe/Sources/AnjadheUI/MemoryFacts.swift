import Foundation
import AnjadheCore

struct MemoryFacts {
    struct Group { let id: String; let label: String; let facts: [JSONValue] }
    let groups: [Group]

    /// MemoryManager.HEADINGS, in the Mac's order; a custom heading takes
    /// its page title and follows them.
    static let headings: [(String, String)] = [
        ("about", "About you"), ("people", "People"), ("work", "Work"),
        ("preferences", "Preferences"), ("plans", "Plans"), ("email", "Email"),
    ]
    static func symbol(_ id: String) -> String {
        switch id {
        case "about": return "person"
        case "people": return "person.2"
        case "work": return "briefcase"
        case "preferences": return "slider.horizontal.3"
        case "plans": return "calendar"
        case "email": return "envelope"
        default: return "bookmark"
        }
    }
    /// Six months unconfirmed reads "as of …" (MemoryManager.STALE_MS).
    static func isStale(_ f: JSONValue) -> Bool {
        guard let at = f["updatedAt"]?.stringValue, let d = DateLogic.parseISO(at) else { return false }
        return Date().timeIntervalSince(d) > 180 * 86400
    }

    init(store: AppStore) {
        let blob = store.blob("memory")
        let facts = (blob["facts"]?.arrayValue ?? []).filter {
            !($0["text"]?.stringValue ?? "").isEmpty && $0["deleted"]?.boolValue != true && $0["forgotten"]?.boolValue != true
        }
        let pages = blob["pages"]?.objectValue ?? [:]
        var order = Self.headings
        for (id, v) in pages where !order.contains(where: { $0.0 == id }) {
            order.append((id, v.stringValue ?? id))
        }
        var out: [Group] = []
        for (id, label) in order {
            let list = facts.filter { ($0["heading"]?.stringValue ?? "about") == id }
                .sorted { a, b in
                    let sa = a["starred"]?.boolValue == true, sb = b["starred"]?.boolValue == true
                    if sa != sb { return sa }
                    return (a["updatedAt"]?.stringValue ?? "") > (b["updatedAt"]?.stringValue ?? "")
                }
            // Every fixed heading shows (an empty one is where a fact is
            // added); a page the assistant started shows while it holds any.
            if !list.isEmpty || Self.headings.contains(where: { $0.0 == id }) { out.append(Group(id: id, label: label, facts: list)) }
        }
        groups = out
    }
}

