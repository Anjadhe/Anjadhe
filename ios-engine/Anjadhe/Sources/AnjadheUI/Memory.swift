import SwiftUI
import AnjadheCore

// Memory on the phone (2026-10-08) — the desktop's Memory page
// (SIMPLE_EXPERIENCE.md "Memory in the nav" and "Memory is everything nenva
// keeps for you"): one quiet panel of doors — Commitments · From your email
// and texts · Finance · Documents — each with its count, then what nenva
// remembers under its headings.
//
// Everything here is READ from synced blobs (`commitments`, `matters`,
// `memory`, `notes`). The facts nenva remembers are the person's to edit
// (MemoryManager M4): each heading is a row that opens its own page
// (MemoryPage.swift) where a fact is added, changed or removed, written to
// the synced `memory` blob the Mac reloads. The folders stay the Mac's.

struct MemoryView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = store.revision
        let commitments = CommitmentList(store: store)
        let folders = FolderList(store: store)
        let notesCount = store.items("notes", "notes").filter { $0["deletedAt"] == nil || $0["deletedAt"] == .null }.count
        let facts = MemoryFacts(store: store)
        return ScreenColumn(spacing: 22) {
            ScreenHead("Memory", sub: "Everything nenva keeps for you.") {
                HeadAction(symbol: "magnifyingglass", label: "Search") { router.root(.search) }
            }

            CardList {
                door("Commitments", symbol: "checklist", detail: commitments.doorLine) { router.open(app: "commitments") }
                door("From your email and texts", symbol: "envelope", detail: folders.doorLine) { router.open(app: "folders") }
                door("Finance", symbol: "chart.bar", detail: nil) { router.open(app: "portfolio") }
                door("Documents", symbol: "doc.text", detail: notesCount > 0 ? "\(notesCount) written" : nil, last: true) { router.open(app: "documents") }
            }

            // What nenva remembers: one row per heading, each opening its
            // own page where facts are added, changed and removed (2026-10-08,
            // by request: the headings were all expanded on this page).
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("What nenva remembers")
                CardList {
                    ForEach(Array(facts.groups.enumerated()), id: \.element.id) { i, g in
                        door(g.label, symbol: MemoryFacts.symbol(g.id),
                             detail: g.facts.isEmpty ? "Empty" : "\(g.facts.count)",
                             last: i == facts.groups.count - 1) { router.push(.memoryPage(g.id)) }
                    }
                }
            }
        }
        .rootScreen("Memory")
    }

    private func door(_ label: String, symbol: String, detail: String?, last: Bool = false,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: symbol).font(.system(size: 16)).foregroundStyle(Theme.text)
                        .frame(width: 22)
                    Text(label).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text)
                    Spacer(minLength: 8)
                    if let d = detail, !d.isEmpty {
                        Text(d).font(.system(size: 13)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textQuaternary)
                }
                .padding(.horizontal, 14).padding(.vertical, 13)
                .contentShape(Rectangle())
                if !last { Divider().padding(.leading, 48) }
            }
        }
        .buttonStyle(.plain)
    }

}

// MARK: - Memory facts (the `memory` blob, MemoryManager's one list)

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

// MARK: - Commitments (the desktop's page, CommitmentsPage.sections)

/// The sections of the desktop's Commitments page from the synced
/// `commitments` blob: Today (due or overdue, not the big ones), Moving
/// (the big ones), Waiting on others, Later, Done. Whether a REPEAT is due
/// today is the projected task's (ScheduleLogic), which is the same rule the
/// bridge projects from.
struct CommitmentList {
    let today: [JSONValue], moving: [JSONValue], waiting: [JSONValue], later: [JSONValue], done: [JSONValue]
    let tasks: [String: JSONValue]
    let todayStr: String

    init(store: AppStore) {
        let all = store.items("commitments", "items")
        todayStr = DateLogic.todayStr()
        var tasks: [String: JSONValue] = [:]
        for t in store.items("schedule", "scheduleItems") { if let id = t["id"]?.stringValue { tasks[id] = t } }
        self.tasks = tasks
        let open = all.filter { ($0["state"]?.stringValue ?? "open") == "open" }
        let isBig: (JSONValue) -> Bool = { c in c["outcome"]?.stringValue.map { !$0.isEmpty } == true || c["shape"]?.stringValue == "goal" }
        let ts = todayStr
        let due: (JSONValue) -> Bool = { c in
            if Self.repeats(c) {
                guard let id = c["id"]?.stringValue, let t = tasks[id] else { return false }
                return ScheduleLogic.taskDueToday(t) && !ScheduleLogic.taskDoneToday(t)
            }
            guard let d = c["when"]?["date"]?.stringValue, !d.isEmpty else { return false }
            return d <= ts
        }
        let todayList = open.filter { due($0) && !isBig($0) }
        let inToday = Set(todayList.compactMap { $0["id"]?.stringValue })
        let moving = open.filter { isBig($0) && ($0["parent"]?.stringValue ?? "").isEmpty }
        let bigOpen = Set(moving.compactMap { $0["id"]?.stringValue })
        let waiting = open.filter { $0["waitingOn"]?.objectValue != nil && !inToday.contains($0["id"]?.stringValue ?? "") }
        let inWaiting = Set(waiting.compactMap { $0["id"]?.stringValue })
        let later = open.filter { c in
            let id = c["id"]?.stringValue ?? ""
            let parent = c["parent"]?.stringValue ?? ""
            return !inToday.contains(id) && !bigOpen.contains(id) && !inWaiting.contains(id)
                && !(!parent.isEmpty && bigOpen.contains(parent)) && !isBig(c)
        }
        let doneList = all.filter { ["done", "dropped"].contains($0["state"]?.stringValue ?? "") }
            .sorted { ($0["doneAt"]?.stringValue ?? $0["updatedAt"]?.stringValue ?? "") > ($1["doneAt"]?.stringValue ?? $1["updatedAt"]?.stringValue ?? "") }
        let timeOf: (JSONValue) -> String = { $0["when"]?["time"]?.stringValue ?? "99:99" }
        let dateOf: (JSONValue) -> String = { $0["when"]?["date"]?.stringValue ?? $0["by"]?.stringValue ?? "9999" }
        let title: (JSONValue) -> String = { $0["title"]?.stringValue ?? "" }
        self.today = todayList.sorted { a, b in
            let ao = !Self.repeats(a) && dateOf(a) < ts, bo = !Self.repeats(b) && dateOf(b) < ts
            if ao != bo { return ao }
            if ao && bo && dateOf(a) != dateOf(b) { return dateOf(a) < dateOf(b) }
            if timeOf(a) != timeOf(b) { return timeOf(a) < timeOf(b) }
            return title(a) < title(b)
        }
        self.moving = moving.sorted { ($0["by"]?.stringValue ?? "9999", title($0)) < ($1["by"]?.stringValue ?? "9999", title($1)) }
        self.waiting = waiting.sorted { ($0["waitingOn"]?["since"]?.stringValue ?? "") < ($1["waitingOn"]?["since"]?.stringValue ?? "") }
        self.later = later.sorted { (dateOf($0), title($0)) < (dateOf($1), title($1)) }
        self.done = Array(doneList.prefix(20))
    }

    static func repeats(_ c: JSONValue) -> Bool {
        guard let r = c["repeat"] else { return false }
        if let s = r.stringValue { return !s.isEmpty && s != "none" }
        return r.objectValue != nil
    }

    /// The desktop's one line, joined from counts.
    var line: String {
        let overdue = today.filter { !Self.repeats($0) && ($0["when"]?["date"]?.stringValue ?? "") < todayStr }.count
        var parts = [today.isEmpty ? "Nothing due today" : "\(today.count) for today"]
        if overdue > 0 { parts.append("\(overdue) overdue") }
        if !moving.isEmpty { parts.append("\(moving.count) bigger \(moving.count == 1 ? "one" : "ones") moving") }
        if !waiting.isEmpty { parts.append("\(waiting.count) waiting on others") }
        return parts.joined(separator: ", ") + "."
    }
    var doorLine: String? {
        let open = today.count + moving.count + waiting.count + later.count
        if open == 0 { return nil }
        return today.isEmpty ? "\(open) open" : "\(today.count) today"
    }

    /// One quiet line of facts for a row.
    func facts(_ c: JSONValue) -> String {
        var parts: [String] = []
        if let w = c["waitingOn"]?["who"]?.stringValue, !w.isEmpty { parts.append("Waiting on \(w)") }
        if Self.repeats(c) {
            parts.append("Repeats")
        } else if let d = c["when"]?["date"]?.stringValue, !d.isEmpty {
            parts.append(d < todayStr ? "Overdue · " + DateLogic.relDate(d) : DateLogic.relDate(d))
        } else if let by = c["by"]?.stringValue, !by.isEmpty {
            parts.append("By " + DateLogic.relDate(by))
        }
        if let t = c["when"]?["time"]?.stringValue, !t.isEmpty { parts.append(DateLogic.fmtTime(t)) }
        return parts.joined(separator: " · ")
    }
}

struct CommitmentsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    /// For the app session, like the desktop's switch; never stored.
    static var showCompleted = false
    @State private var showDone = CommitmentsView.showCompleted

    var body: some View {
        let _ = store.revision
        let list = CommitmentList(store: store)
        return ScreenColumn(spacing: 20) {
            ScreenHead("Commitments", sub: list.line) {
                // Done is hidden by default; one switch in the heading shows
                // it, for the rest of the session (the desktop, 2026-10-08).
                if !list.done.isEmpty {
                    Button {
                        withAnimation { CommitmentsView.showCompleted.toggle(); showDone = CommitmentsView.showCompleted }
                    } label: {
                        Text(showDone ? "Hide completed" : "Show completed")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Capsule().fill(showDone ? Theme.accentSoft : Theme.surface))
                            .overlay(Capsule().strokeBorder(Theme.border))
                    }
                    .buttonStyle(.plain)
                }
            }
            AskDoor(label: "Add a commitment, or tell nenva what to change") {
                router.openCompose(prefill: "Add a commitment: ")
            }
            section("Today", list.today, list, check: true)
            section("Moving", list.moving, list)
            section("Waiting on others", list.waiting, list)
            section("Later", list.later, list)
            if showDone && !list.done.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Done", count: list.done.count)
                    CardList {
                        ForEach(Array(list.done.enumerated()), id: \.offset) { i, c in
                            RowView(c["title"]?.stringValue ?? "", sub: c["state"]?.stringValue == "dropped" ? "Ignored" : "Done",
                                    done: true, last: i == list.done.count - 1)
                                .onTapGesture { open(c, list) }
                        }
                    }
                }
            }
            if list.today.isEmpty && list.moving.isEmpty && list.waiting.isEmpty && list.later.isEmpty && list.done.isEmpty {
                EmptyText("Nothing yet. Tell nenva what you will do, the way you would say it.")
            }
        }
        .pushedScreen()
    }

    @ViewBuilder private func section(_ title: String, _ items: [JSONValue], _ list: CommitmentList, check: Bool = false) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(title, count: items.count)
                CardList {
                    ForEach(Array(items.enumerated()), id: \.offset) { i, c in
                        let id = c["id"]?.stringValue ?? ""
                        let canCheck = check && list.tasks[id] != nil
                        RowView(c["title"]?.stringValue ?? "", sub: list.facts(c), last: i == items.count - 1) {
                            if canCheck { CheckButton(on: false) { complete(id) } }
                        } trailing: {
                            if let n = subCount(c, store: store), n > 0 {
                                Text("\(n) steps").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                            }
                        }
                        .onTapGesture { open(c, list) }
                    }
                }
            }
        }
    }

    private func subCount(_ c: JSONValue, store: AppStore) -> Int? {
        guard c["shape"]?.stringValue == "goal" || c["outcome"]?.stringValue != nil, let id = c["id"]?.stringValue else { return nil }
        return store.items("commitments", "items").filter { $0["parent"]?.stringValue == id && ($0["state"]?.stringValue ?? "open") == "open" }.count
    }

    /// A task opens its sheet; a big one opens its project page. Both are
    /// the projected records (the bridge keeps them in step).
    private func open(_ c: JSONValue, _ list: CommitmentList) {
        guard let id = c["id"]?.stringValue else { return }
        if list.tasks[id] != nil { router.push(.task(id)) }
        else if store.findItem("goals", "goals", id: id) != nil { router.push(.goal(id)) }
        else { router.showToast("Open this one on your Mac") }
    }

    /// Done, through the projected task: the Mac's bridge takes the write in
    /// (`importBlobs`) and the commitment's own door records it.
    private func complete(_ id: String) {
        store.patchItem("schedule", "scheduleItems", id: id, ["lastCompletedDate": .string(DateLogic.todayStr())])
        router.showToast("Done")
    }
}

// MARK: - Folders from email and texts (the `matters` blob)

/// The desktop's Insights list as it stands since MATTERS.md §17: the
/// FOLDERS, sectioned by the folder's own state — open with a step is Needs
/// you, open with nothing to do is For your information, settled is Done.
struct FolderList {
    let needs: [JSONValue], filed: [JSONValue], done: [JSONValue]

    init(store: AppStore) {
        let map = store.blob("matters")["matters"]?.objectValue ?? [:]
        let all = map.values.filter { m in
            // A folder only the person's own words or calendar made is not
            // "from your email and texts".
            Self.messages(m).count > 0
        }
        let open = all.filter { ($0["state"]?.stringValue ?? "open") == "open" }
        needs = open.filter { Self.openStep($0) != nil }
            .sorted { ($0["when"]?["date"]?.stringValue ?? "9999") < ($1["when"]?["date"]?.stringValue ?? "9999") }
        filed = open.filter { Self.openStep($0) == nil }
            .sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }
        done = all.filter { ($0["state"]?.stringValue ?? "open") != "open" }
            .sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }
    }

    static func messages(_ m: JSONValue) -> [JSONValue] {
        (m["sources"]?.arrayValue ?? []).filter { s in
            let k = s["kind"]?.stringValue ?? ""
            return k.isEmpty || k == "email" || k == "imessage" || k == "slack"
        }
    }
    static func openStep(_ m: JSONValue) -> JSONValue? {
        guard let n = m["next"], n["state"]?.stringValue == "open", n["evidenceInvalidated"]?.boolValue != true else { return nil }
        return n
    }
    static func title(_ m: JSONValue) -> String {
        let t = m["title"]?.stringValue ?? ""
        return t.isEmpty ? "Something to look at" : t
    }
    static let kindWord: [String: String] = ["appointment": "Appointment", "bill": "Bill", "reservation": "Reservation",
                                             "subscription": "Renewal", "order": "Delivery"]
    /// One quiet line: when, the amount once, where it stands.
    static func line(_ m: JSONValue) -> String {
        var parts: [String] = []
        if let d = m["when"]?["date"]?.stringValue, !d.isEmpty {
            var w = DateLogic.relDate(d)
            if let t = m["when"]?["time"]?.stringValue, !t.isEmpty { w += " · " + DateLogic.fmtTime(t) }
            parts.append(w)
        }
        if let a = m["amount"]?.stringValue, !a.isEmpty { parts.append(a) }
        else if let n = m["amount"]?.numberValue { parts.append(String(format: "$%.2f", n)) }
        let step = (m["status"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? openStep(m)?["what"]?.stringValue ?? ""
        if !step.isEmpty { parts.append(step) }
        return parts.joined(separator: " · ")
    }

    var lede: String {
        var parts = [needs.isEmpty ? "Nothing needs you" : "\(needs.count) need\(needs.count == 1 ? "s" : "") you"]
        if !filed.isEmpty { parts.append("\(filed.count) for your information") }
        if !done.isEmpty { parts.append("\(done.count) done") }
        return parts.joined(separator: " · ")
    }
    var doorLine: String? { needs.isEmpty ? (filed.isEmpty ? nil : "\(filed.count)") : "\(needs.count) need you" }
}

struct FoldersView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var query = ""
    @State private var showDone = false

    var body: some View {
        let _ = store.revision
        let f = FolderList(store: store)
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let match: (JSONValue) -> Bool = { m in
            q.isEmpty || FolderList.title(m).lowercased().contains(q)
                || FolderList.messages(m).contains { ($0["summary"]?.stringValue ?? "").lowercased().contains(q) || ($0["from"]?.stringValue ?? "").lowercased().contains(q) }
        }
        return ScreenColumn(spacing: 20) {
            ScreenHead("From your email and texts", sub: f.needs.isEmpty && f.filed.isEmpty && f.done.isEmpty ? nil : f.lede)
            SearchField(placeholder: "Search…", text: $query)
            block("Needs you", f.needs.filter(match))
            block("For your information", f.filed.filter(match))
            let done = f.done.filter(match)
            if !done.isEmpty {
                Button { withAnimation { showDone.toggle() } } label: {
                    HStack(spacing: 6) {
                        SectionLabel("Done", count: done.count)
                        Image(systemName: showDone ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                    }
                }
                .buttonStyle(.plain)
                if showDone || !q.isEmpty { rows(Array(done.prefix(60))) }
            }
            if f.needs.isEmpty && f.filed.isEmpty && f.done.isEmpty {
                EmptyText("Nothing here yet. Bills, renewals, bookings and deliveries show up here as nenva reads your email on your Mac.")
            }
        }
        .pushedScreen()
    }

    @ViewBuilder private func block(_ title: String, _ list: [JSONValue]) -> some View {
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(title, count: list.count)
                rows(list)
            }
        }
    }

    private func rows(_ list: [JSONValue]) -> some View {
        CardList {
            ForEach(Array(list.enumerated()), id: \.offset) { i, m in
                RowView(FolderList.title(m), sub: FolderList.line(m), last: i == list.count - 1) {
                    if let k = FolderList.kindWord[m["kind"]?.stringValue ?? ""] {
                        Text(k).font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                }
                .onTapGesture { if let id = m["id"]?.stringValue { router.push(.matter(id)) } }
            }
        }
    }
}

/// A folder's page (the desktop's MatterPage): the facts, read-only; the
/// one next step; what changed; every message with its own door; a box that
/// opens a chat about it.
struct MatterDetail: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var mailAsk: [String: JSONValue]?

    private func folder() -> JSONValue? {
        let blob = store.blob("matters")
        let map = blob["matters"]?.objectValue ?? [:]
        if let m = map[id] { return m }
        // A folder joined into another is found through its alias.
        if let to = blob["aliases"]?[id]?.stringValue { return map[to] }
        return nil
    }

    var body: some View {
        let _ = store.revision
        return Group {
            if let m = folder() { page(m) } else { ScreenColumn { EmptyText("That folder is gone. It may have been joined into another on your Mac.") }.pushedScreen() }
        }
        .mailDoor($mailAsk)
    }

    private func page(_ m: JSONValue) -> some View {
        let title = FolderList.title(m)
        let step = FolderList.openStep(m)
        let msgs = FolderList.messages(m).reversed().map { $0 }
        let log = (m["log"]?.arrayValue ?? []).reversed().map { $0 }
        let settled = (m["state"]?.stringValue ?? "open") != "open"
        return ScreenColumn(spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(([FolderList.kindWord[m["kind"]?.stringValue ?? ""] ?? "Folder"] + (settled ? [m["state"]?.stringValue == "cancelled" ? "Cancelled" : "Done"] : [])).joined(separator: " · ").uppercased())
                    .font(.system(size: 11.5, weight: .semibold)).tracking(0.7).foregroundStyle(Theme.textTertiary)
                Text(title).displayStyle(26).fixedSize(horizontal: false, vertical: true)
                let line = FolderList.line(m)
                if !line.isEmpty { Text(line).font(.system(size: 15)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true) }
            }

            if let s = step, let what = s["what"]?.stringValue, !what.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("NEXT STEP").font(.system(size: 11.5, weight: .semibold)).tracking(0.7).foregroundStyle(Theme.accent)
                    Text(what).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let url = s["url"]?.stringValue ?? s["link"]?.stringValue, url.hasPrefix("http") {
                        PrimaryButton(label: "Open the page") { openURL(url) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.blueWash))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
            }

            let facts = factRows(m)
            if !facts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Details")
                    CardList {
                        ForEach(Array(facts.enumerated()), id: \.offset) { i, f in
                            HStack(alignment: .top) {
                                Text(f.0).font(.system(size: 14)).foregroundStyle(Theme.textTertiary).frame(width: 110, alignment: .leading)
                                Text(f.1).font(.system(size: 14)).foregroundStyle(Theme.text).textSelection(.enabled)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            if i < facts.count - 1 { Divider().padding(.leading, 14) }
                        }
                    }
                }
            }

            if !msgs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Messages", count: msgs.count)
                    CardList {
                        ForEach(Array(msgs.enumerated()), id: \.offset) { i, s in
                            let text = s["kind"]?.stringValue == "imessage"
                            RowView(s["summary"]?.stringValue ?? "A message",
                                    sub: [s["from"]?.stringValue ?? "", DateLogic.relDate(s["at"]?.stringValue ?? "")].filter { !$0.isEmpty }.joined(separator: " · "),
                                    last: i == msgs.count - 1) {
                                Text(text ? "Messages" : "Open").font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(text ? Theme.textTertiary : Theme.accent)
                            }
                            .onTapGesture { openMessage(s) }
                        }
                    }
                }
            }

            if !log.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("What changed")
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(log.prefix(12).enumerated()), id: \.offset) { _, l in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(DateLogic.relDate(l["at"]?.stringValue ?? "")).font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                                    .frame(width: 70, alignment: .leading)
                                Text(l["text"]?.stringValue ?? "").font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }

            AskDoor(label: "Tell nenva what to do with this…") {
                router.openCompose(prefill: "About “\(title)”: ")
            }
        }
        .pushedScreen()
    }

    private func factRows(_ m: JSONValue) -> [(String, String)] {
        var out: [(String, String)] = []
        if let w = m["when"]?["date"]?.stringValue, !w.isEmpty {
            var s = DateLogic.relDate(w)
            if let t = m["when"]?["time"]?.stringValue, !t.isEmpty { s += ", " + DateLogic.fmtTime(t) }
            out.append(("When", s))
        }
        if let a = m["amount"]?.stringValue, !a.isEmpty { out.append(("Amount", a)) }
        if let v = m["vendor"]?.stringValue, !v.isEmpty { out.append(("With", v)) }
        if let p = m["place"]?.stringValue, !p.isEmpty { out.append(("Where", p)) }
        if let c = m["code"]?.stringValue, !c.isEmpty { out.append(("Confirmation", c)) }
        if let cal = m["calendar"]?["title"]?.stringValue, !cal.isEmpty { out.append(("On your calendar", cal)) }
        return out
    }

    /// An email opens in the person's mail app (MailDoor); a text lives in
    /// Messages, which has no link to one message.
    private func openMessage(_ s: JSONValue) {
        guard s["kind"]?.stringValue != "imessage", let id = s["id"]?.stringValue, !id.isEmpty else {
            router.showToast("This one is in Messages")
            return
        }
        var e: [String: JSONValue] = ["web": .string("https://mail.google.com/mail/u/0/#all/\(id)")]
        e["thread"] = .string(s["thread"]?.stringValue ?? id)
        if let app = MailDoor.choice { MailDoor.open(e, app: app) { router.showToast("Couldn’t open that email") } }
        else { mailAsk = e }
    }
}

// MARK: - Attached to a commitment (the desktop, 2026-10-08)

/// What a commitment carries in `attached` — a file from Documents, a text
/// document, or a link — each opened where it lives. Attaching is a
/// sentence to nenva in the commitment's own chat (`attach_to_commitment`
/// asks, like every commitment write); the phone never writes the
/// commitments store itself.
struct CommitmentAttachments: View {
    let id: String
    var onAttach: (() -> Void)? = nil
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        let c = store.items("commitments", "items").first { $0["id"]?.stringValue == id }
        let list = (c?["attached"]?.arrayValue ?? []).filter { $0["id"]?.stringValue != nil }
        VStack(alignment: .leading, spacing: 8) {
            if !list.isEmpty {
                SectionLabel("Attached", count: list.count)
                CardList {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, a in
                        let kind = a["kind"]?.stringValue ?? ""
                        RowView(title(a), sub: kind == "link" ? host(a) : kind == "note" ? "Text document" : "File in Documents",
                                last: i == list.count - 1) {
                            Image(systemName: kind == "link" ? "link" : kind == "note" ? "doc.text" : "doc")
                                .font(.system(size: 14)).foregroundStyle(Theme.textSecondary).frame(width: 20)
                        } trailing: {
                            Image(systemName: kind == "link" ? "arrow.up.right" : "chevron.right")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textQuaternary)
                        }
                        .onTapGesture { open(a) }
                    }
                }
            }
            if let attach = onAttach {
                Button(action: attach) {
                    HStack(spacing: 6) {
                        Image(systemName: "paperclip").font(.system(size: 13))
                        Text(list.isEmpty ? "Attach a document or link" : "Attach another").font(.system(size: 14, weight: .medium))
                    }
                    .foregroundStyle(Theme.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func title(_ a: JSONValue) -> String {
        let t = a["title"]?.stringValue ?? ""
        return t.isEmpty ? (a["id"]?.stringValue ?? "Attachment") : t
    }
    private func host(_ a: JSONValue) -> String {
        URL(string: a["id"]?.stringValue ?? "")?.host ?? "Link"
    }
    private func open(_ a: JSONValue) {
        let id = a["id"]?.stringValue ?? ""
        switch a["kind"]?.stringValue ?? "" {
        case "link": openURL(id)
        case "note":
            if store.findItem("notes", "notes", id: id) != nil { router.push(.note(id)) }
            else { router.showToast("That document isn’t on this phone") }
        default: router.push(.file(id))
        }
    }
}
