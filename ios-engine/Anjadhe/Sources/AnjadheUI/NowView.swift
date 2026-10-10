import SwiftUI
import AnjadheCore

// Now on the phone (2026-10-02) — the desktop's Now page, drawn here.
//
// The Mac computes ALL of it (js/agent/mobile-views.js `_now`, over
// SimpleExperience: the sentence, the ranked cards, TODAY with one line of
// help and one action a row, the presence line). This file decides nothing
// about WHAT is shown or in what order — it draws, and it runs each action
// where it can run:
//   answer — the Mac's request queue (`home-answer` with an id; scope once)
//   mac    — a quiet act the Mac performs without a window (`home-answer`
//            with a card key: Later, Got it, Don't ask, Mark done)
//   url    — opened here (Join, Gmail, Directions)
//   chat   — sent as a NEW chat from this phone, so the answer comes here
//   post / task — a record this phone has a screen for
// Later and Got it are the Mac's state, so a card set aside here is set
// aside there too.
//
// One card at a time, like the Mac: the rest wait behind "N more". A swipe
// to the left sets the front card aside (its Later / Got it / Not now);
// nothing is ever APPROVED by a gesture.

struct NowView: View {
    let now: [String: JSONValue]
    let snap: MacViews.Snapshot
    let staleNote: String?
    @Binding var answered: [String: String]
    let answer: (_ id: String, _ approved: Bool, _ isPlan: Bool) -> Void
    let answering: Set<String>
    let answerError: [String: String]

    @EnvironmentObject var router: Router
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var chat: ChatState
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var sync: SyncCoordinator
    /// The card whose chat is being found or started on the Mac.
    @State private var opening: String?

    /// The card brought to the front from "N more" (per screen, like the Mac's).
    @State private var front: String?
    /// Cards acted on here, hidden at once while the Mac catches up.
    @State private var hidden: Set<String> = []
    @State private var busy: Set<String> = []
    @State private var allToday = false
    /// COMING UP: folded to its heading until tapped, and a day opens its
    /// rows beneath — folded again on every visit (the desktop, 2026-10-08).
    @State private var comingOpen = false
    @State private var comingDay: String?
    @State private var drag: CGFloat = 0
    /// An email waiting for the one-time "Gmail or Mail?" answer.
    @State private var mailAsk: [String: JSONValue]?

    private var cards: [JSONValue] {
        (now["cards"]?.arrayValue ?? []).filter { !hidden.contains($0["key"]?.stringValue ?? "") }
    }

    var body: some View {
        let cards = self.cards
        let frontCard = cards.first { $0["key"]?.stringValue == front } ?? cards.first
        let rest = cards.filter { $0["key"]?.stringValue != frontCard?["key"]?.stringValue }
        VStack(alignment: .leading, spacing: 22) {
            Text(now["note"]?.stringValue ?? "")
                .displayStyle(24)
                .fixedSize(horizontal: false, vertical: true)

            if let c = frontCard {
                VStack(alignment: .leading, spacing: 10) {
                    cardView(c, count: cards.count)
                    if !rest.isEmpty { moreLine(rest) }
                }
            }

            todaySection

            comingSection

            presenceLine
        }
        .mailDoor($mailAsk)
    }

    private func openEmail(_ e: [String: JSONValue]?) {
        guard let e = e else { return }
        if let app = MailDoor.choice { MailDoor.open(e, app: app) { router.showToast("Couldn’t open that email") } }
        else { mailAsk = e }
    }

    // MARK: the card

    private func cardView(_ c: JSONValue, count: Int) -> some View {
        let key = c["key"]?.stringValue ?? ""
        let kind = c["kind"]?.stringValue ?? ""
        let id = c["id"]?.stringValue ?? ""
        let approval = kind == "approval"
        let plan = c["plan"]?.arrayValue ?? []
        let quiet = c["quiet"]?.arrayValue ?? []
        let aside = quiet.first { ["later", "gotit"].contains($0["act"]?.stringValue ?? "") }
        let open = detailAction(c)
        return VStack(alignment: .leading, spacing: 9) {
            Button { open?() } label: {
            VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text((c["label"]?.stringValue ?? "").uppercased())
                    .font(.system(size: 11.5, weight: .semibold)).tracking(0.7)
                    .foregroundStyle(approval ? Theme.accent : Theme.textTertiary)
                Spacer(minLength: 0)
                if count > 1 {
                    Text("1 of \(count)").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }
            Text(c["title"]?.stringValue ?? "")
                .font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if let body = c["body"]?.stringValue, !body.isEmpty {
                Text(body).font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(open == nil)
            if !plan.isEmpty { planList(plan) }

            if let outcome = answered[id], !id.isEmpty {
                Text(outcome).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary)
            } else {
                if let err = answerError[id], !id.isEmpty {
                    Text(err).font(.system(size: 13)).foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                actions(c, key: key, id: id, kind: kind, plan: !plan.isEmpty, quiet: quiet)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            // The card's kind as a faint wash and top edge (DESIGN_SYSTEM.md
            // "Simple shell and Now colour"); the label still names it.
            ZStack(alignment: .top) {
                Self.wash(kind)
                Self.edge(kind).frame(height: 3)
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        )
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
        .overlay {
            // An approval blocks work, so it wears the one accent (the Mac's
            // blue approval card).
            if approval {
                RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.accent, lineWidth: 1.5)
            }
        }
        .offset(x: drag)
        .opacity(1 - Double(min(abs(drag), 160)) / 320)
        .gesture(aside == nil ? nil : DragGesture(minimumDistance: 24)
            .onChanged { v in if v.translation.width < 0 && abs(v.translation.width) > abs(v.translation.height) { drag = v.translation.width } }
            .onEnded { v in
                if v.translation.width < -110, let a = aside?["act"]?.stringValue {
                    withAnimation(.easeOut(duration: 0.18)) { drag = -420 }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { drag = 0; macAct(key, a) }
                } else {
                    withAnimation(.spring(response: 0.25)) { drag = 0 }
                }
            })
        .animation(.easeOut(duration: 0.2), value: key)
    }

    /// Tapping a card's head opens the thing it is about (the desktop: "a
    /// card's title opens its page; only the main button acts"): its task,
    /// its folder, the post or job it names, else the thing's chat.
    private func detailAction(_ c: JSONValue) -> (() -> Void)? {
        if let t = c["taskId"]?.stringValue, !t.isEmpty { return { router.push(.task(t)) } }
        if let m = c["matterId"]?.stringValue, !m.isEmpty { return { router.push(.matter(m)) } }
        let thing = c["thing"]?.stringValue ?? ""
        if let i = thing.firstIndex(of: ":") {
            let kind = String(thing[..<i]), id = String(thing[thing.index(after: i)...])
            if kind == "task", !id.isEmpty { return { router.push(.task(id)) } }
            if kind == "matter", !id.isEmpty { return { router.push(.matter(id)) } }
        }
        let p = c["primary"]?.objectValue ?? [:]
        if let pid = p["id"]?.stringValue, !pid.isEmpty {
            switch p["does"]?.stringValue ?? "" {
            case "post": return { router.push(.feedItem(pid)) }
            case "job": return { router.push(.job(pid)) }
            default: break
            }
        }
        if c["chat"]?["id"]?.stringValue != nil || !thing.isEmpty { return { openCardChat(c) } }
        return nil
    }

    @ViewBuilder
    private func actions(_ c: JSONValue, key: String, id: String, kind: String, plan: Bool, quiet: [JSONValue]) -> some View {
        let primary = c["primary"]?.objectValue
        let does = primary?["does"]?.stringValue ?? ""
        let isBusy = busy.contains(key) || answering.contains(id)
        let talk = c["talk"]?.stringValue ?? ""
        let thing = c["thing"]?.stringValue ?? ""
        let cardChat = c["chat"]?.objectValue
        VStack(alignment: .leading, spacing: 10) {
            if let ch = cardChat { standingBlock(c, ch) }
            HStack(spacing: 8) {
                if let p = primary {
                    pill(p["label"]?.stringValue ?? "Open", filled: true, accent: kind == "approval", busy: isBusy) {
                        runPrimary(key: key, id: id, p: p, plan: plan)
                    }
                }
                if does == "answer" {
                    pill(c["decline"]?.stringValue ?? "Not now", filled: false, busy: isBusy) {
                        answer(id, false, plan)
                    }
                }
                Spacer(minLength: 0)
            }
            if !id.isEmpty && primary == nil && (kind == "approval" || kind == "decide") {
                Text("Answer this one on your Mac")
                    .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
            }
            let links = quiet.compactMap { q -> (String, String)? in
                guard let l = q["label"]?.stringValue, let a = q["act"]?.stringValue else { return nil }
                return (l, a)
            }
            // A card about a THING has one chat, and its box is the door
            // to it (the desktop's card box, 2026-10-02); "Talk it through"
            // stays only for a card with no thing.
            if !thing.isEmpty {
                cardBox(c, key: key)
            }
            if !links.isEmpty || (!talk.isEmpty && thing.isEmpty) {
                FlowLinks(items: links.map { l in (l.0, { macAct(key, l.1) }) }
                          + (talk.isEmpty || !thing.isEmpty ? [] : [("Talk it through", { router.startChat(talk) })]))
                    .disabled(isBusy)
            }
        }
    }

    // MARK: the thing's chat (2026-10-08, the desktop's card box)

    /// Where the thing stands after its chat (SimpleExperience's own line),
    /// the latest change, and the way back into the chat.
    private func standingBlock(_ c: JSONValue, _ ch: [String: JSONValue]) -> some View {
        let standing = ch["standing"]?.stringValue ?? ""
        let changed = ch["changed"]?.stringValue ?? ""
        return VStack(alignment: .leading, spacing: 5) {
            if !standing.isEmpty {
                Text(standing).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !changed.isEmpty {
                Text(changed).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Continue in chat") { openCardChat(c) }
                .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.accent)
                .buttonStyle(.plain)
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
    }

    private func cardBox(_ c: JSONValue, key: String) -> some View {
        Button { openCardChat(c) } label: {
            HStack(spacing: 8) {
                Text(opening == key ? "Opening the chat…" : "Tell me what to do with this…")
                    .font(.system(size: 14)).foregroundStyle(Theme.textTertiary)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up").font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(Theme.accent.opacity(0.55)))
            }
            .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
            .background(Capsule().fill(Theme.surface))
            .overlay(Capsule().strokeBorder(Theme.border))
        }
        .buttonStyle(.plain)
        .disabled(opening != nil)
    }

    /// Open the thing's own chat, cursor in its composer. A chat the phone
    /// already holds opens at once; otherwise the Mac finds or starts it
    /// (`home-answer` act `chat`) and the phone opens it once it has synced.
    /// With the Mac away there is no thing chat to continue, so the phone
    /// starts its own about the card, as before.
    private func openCardChat(_ c: JSONValue) {
        let key = c["key"]?.stringValue ?? ""
        if let id = c["chat"]?["id"]?.stringValue, hasConv(id) { openConv(id); return }
        guard opening == nil else { return }
        opening = key
        views.request("home-answer", params: ["card": .string(key), "act": .string("chat")]) { result in
            switch result {
            case .success(let data):
                guard let id = data["conv"]?.stringValue else { opening = nil; fallbackChat(c); return }
                sync.triggerSync()
                waitForConv(id, tries: 30)
            case .failure:
                opening = nil
                fallbackChat(c)
            }
        }
    }

    private func hasConv(_ id: String) -> Bool {
        (store.blob("agent-conversations")["conversations"]?.arrayValue ?? []).contains { $0["id"]?.stringValue == id }
    }
    private func waitForConv(_ id: String, tries: Int) {
        if hasConv(id) || tries <= 0 { opening = nil; openConv(id); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { waitForConv(id, tries: tries - 1) }
    }
    private func openConv(_ id: String) {
        chat.open(id)
        router.openCompose()
    }
    private func fallbackChat(_ c: JSONValue) {
        let talk = c["talk"]?.stringValue ?? ""
        if !talk.isEmpty { router.startChat(talk) }
        else { router.openCompose(prefill: "About “\(c["title"]?.stringValue ?? "this")”: ") }
    }

    private func runPrimary(key: String, id: String, p: [String: JSONValue], plan: Bool) {
        switch p["does"]?.stringValue ?? "" {
        case "answer": answer(id, true, plan)
        case "url": if let u = p["url"]?.stringValue { openURL(u) }
        case "post": if let pid = p["id"]?.stringValue { router.push(.feedItem(pid)) }
        case "task": if let tid = p["id"]?.stringValue { router.push(.task(tid)) }
        case "job": if let jid = p["id"]?.stringValue { router.push(.job(jid)) }
        case "email": openEmail(p["email"]?.objectValue)
        case "chat":
            if let prompt = p["prompt"]?.stringValue {
                // A check-in's offer: the Mac remembers it was taken (C4),
                // the conversation is this phone's own.
                if let a = p["act"]?.stringValue { macAct(key, a, hide: true, quietly: true) }
                router.startChat(prompt)
            }
        case "mac": macAct(key, p["act"]?.stringValue ?? "primary")
        default: break
        }
    }

    /// A quiet act the Mac performs. The card goes at once; if the Mac
    /// refuses, it comes back with the Mac's reason.
    private func macAct(_ key: String, _ act: String, hide: Bool = true, quietly: Bool = false) {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        if hide { withAnimation(.easeOut(duration: 0.2)) { _ = hidden.insert(key) } }
        if front == key { front = nil }
        views.request("home-answer", params: ["card": .string(key), "act": .string(act)]) { result in
            busy.remove(key)
            switch result {
            case .success:
                views.refresh("home")
            case .failure(let err):
                hidden.remove(key)
                if !quietly { router.showToast(err.localizedDescription) }
            }
        }
    }

    private func planList(_ plan: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(plan.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(i + 1)")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.textTertiary)
                        .frame(width: 16, alignment: .trailing)
                    Text(step.stringValue ?? "")
                        .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.bg))
    }

    private func moreLine(_ rest: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(rest.count) more").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textTertiary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(rest.prefix(8).enumerated()), id: \.offset) { _, c in
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) { front = c["key"]?.stringValue }
                        } label: {
                            Text(c["title"]?.stringValue ?? "")
                                .font(.system(size: 13)).lineLimit(1)
                                .foregroundStyle(Theme.textSecondary)
                                .padding(.horizontal, 11).padding(.vertical, 6)
                                .background(Capsule().fill(Theme.surface))
                                .overlay(Capsule().strokeBorder(Theme.border))
                                .frame(maxWidth: 220)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: TODAY

    @ViewBuilder private var todaySection: some View {
        let today = now["today"]?.objectValue ?? [:]
        let rows = today["rows"]?.arrayValue ?? []
        let line = today["line"]?.stringValue ?? ""
        let plan = today["plan"]?.stringValue ?? ""
        let shown = allToday ? rows : Array(rows.prefix(5))
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Today")
            if !line.isEmpty || !plan.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if !line.isEmpty {
                        Text(line).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if !plan.isEmpty {
                        Button("Plan my day") { router.startChat(plan) }
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                    }
                }
            }
            if rows.isEmpty {
                Text("A clear day.").font(.system(size: 14)).italic().foregroundStyle(Theme.textTertiary)
            } else {
                CardList {
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, r in
                        todayRow(r, last: i == shown.count - 1)
                    }
                }
                if rows.count > 5 {
                    Button(allToday ? "Show less" : "\(rows.count - 5) more today") { allToday.toggle() }
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary).buttonStyle(.plain)
                }
            }
        }
    }

    private func todayRow(_ r: JSONValue, last: Bool) -> some View {
        let line = r["line"]?.stringValue ?? ""
        let attn = r["attn"]?.boolValue ?? false
        let live = r["live"]?.boolValue ?? false
        let action = r["action"]?.objectValue
        return HStack(alignment: .top, spacing: 12) {
            Text((r["time"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? "Anytime")
                .font(.system(size: 13).monospacedDigit()).foregroundStyle(Theme.textTertiary)
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(r["title"]?.stringValue ?? "")
                    .font(.system(size: 15)).foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if !line.isEmpty {
                    Text(line).font(.system(size: 13))
                        .foregroundStyle(attn ? Theme.warning : live ? Theme.accent : Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            // "Open chat" is not a row button (2026-10-08, by request): the
            // line already says it is in a chat, and the chat's door is on the
            // task's page. A row with no page of its own opens the chat.
            if let a = action, let label = a["label"]?.stringValue, a["does"]?.stringValue != "conv" {
                pill(label, filled: false, small: true) { runToday(a) }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .contentShape(Rectangle())
        .onTapGesture {
            if let t = r["taskId"]?.stringValue { router.push(.task(t)) }
            else if let a = action, a["does"]?.stringValue == "conv" { runToday(a) }
            else if let u = r["openUrl"]?.stringValue { openURL(u) }
        }
        .overlay(alignment: .bottom) { if !last { Rectangle().fill(Theme.borderLight).frame(height: 1).padding(.leading, 14) } }
    }

    private func runToday(_ a: [String: JSONValue]) {
        switch a["does"]?.stringValue ?? "" {
        case "url": if let u = a["url"]?.stringValue { openURL(u) }
        case "chat": if let p = a["prompt"]?.stringValue { router.startChat(p) }
        case "task": if let t = a["id"]?.stringValue { router.push(.task(t)) }
        case "job": if let j = a["id"]?.stringValue { router.push(.job(j)) }
        case "email": openEmail(a["email"]?.objectValue)
        case "conv": if let c = a["id"]?.stringValue { chat.open(c); router.showConversation() }
        default: break
        }
    }

    /// Blue for offers, decisions, approvals and questions; amber for a
    /// heads-up; violet for a check-in (the desktop's 2026-10-08 colour).
    static func wash(_ kind: String) -> Color {
        switch kind {
        case "headsup": return Theme.amberWash
        case "checkin": return Theme.violetWash
        default: return Theme.blueWash
        }
    }
    static func edge(_ kind: String) -> Color {
        switch kind {
        case "headsup": return Theme.warning.opacity(0.55)
        case "checkin": return Theme.violet.opacity(0.55)
        default: return Theme.accent.opacity(0.5)
        }
    }

    // MARK: coming up (2026-10-08)

    @ViewBuilder private var comingSection: some View {
        if let c = now["coming"]?.objectValue, let days = c["days"]?.arrayValue,
           let total = c["total"]?.numberValue, total > 0 {
            let rows = c["rows"]?.arrayValue ?? []
            VStack(alignment: .leading, spacing: 10) {
                Button { withAnimation(.easeOut(duration: 0.18)) { comingOpen.toggle(); if !comingOpen { comingDay = nil } } } label: {
                    HStack(spacing: 6) {
                        Text("COMING UP").sectionHeaderStyle().foregroundStyle(Theme.textSecondary)
                        Text("\(Int(total))").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.accent)
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                            .rotationEffect(.degrees(comingOpen ? 90 : 0))
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.accent.opacity(0.35)).frame(height: 1).offset(y: 5) }
                if comingOpen {
                    if let next = c["next"]?.objectValue {
                        let idx = Int(next["index"]?.numberValue ?? -1)
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(next["when"]?.stringValue ?? "").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                            Text(next["title"]?.stringValue ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { if idx >= 0 && idx < rows.count { openComing(rows[idx]) } }
                    }
                    HStack(spacing: 6) {
                        ForEach(Array(days.enumerated()), id: \.offset) { _, d in weekDay(d) }
                    }
                    if let day = comingDay {
                        let mine = rows.filter { $0["date"]?.stringValue == day }
                        if mine.isEmpty {
                            Text("Nothing that day.").font(.system(size: 14)).italic().foregroundStyle(Theme.textTertiary)
                        } else {
                            CardList {
                                ForEach(Array(mine.enumerated()), id: \.offset) { i, r in
                                    HStack(alignment: .top, spacing: 12) {
                                        Text((r["time"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? "All day")
                                            .font(.system(size: 13).monospacedDigit()).foregroundStyle(Theme.textTertiary)
                                            .frame(width: 62, alignment: .leading)
                                        Text(r["title"]?.stringValue ?? "").font(.system(size: 15)).foregroundStyle(Theme.text)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 14).padding(.vertical, 11)
                                    .contentShape(Rectangle())
                                    .onTapGesture { openComing(r) }
                                    .overlay(alignment: .bottom) { if i < mine.count - 1 { Rectangle().fill(Theme.borderLight).frame(height: 1).padding(.leading, 14) } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func weekDay(_ d: JSONValue) -> some View {
        let date = d["date"]?.stringValue ?? ""
        let count = Int(d["count"]?.numberValue ?? 0)
        let open = comingDay == date
        return Button { withAnimation(.easeOut(duration: 0.15)) { comingDay = open ? nil : date } } label: {
            VStack(spacing: 3) {
                Text(d["dow"]?.stringValue ?? "").font(.system(size: 11, weight: .medium))
                    .foregroundStyle(open ? Theme.accent : Theme.textTertiary)
                Text("\(Int(d["num"]?.numberValue ?? 0))").font(.system(size: 16, weight: open ? .semibold : .regular))
                    .foregroundStyle(count > 0 ? Theme.text : Theme.textQuaternary)
                HStack(spacing: 2) {
                    ForEach(0..<min(count, 4), id: \.self) { _ in Circle().fill(Theme.accent).frame(width: 4, height: 4) }
                }
                .frame(height: 4)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(open ? Theme.accentSoft : count > 0 ? Theme.blueWash : Color.clear))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(d["dow"]?.stringValue ?? "") \(count) \(count == 1 ? "thing" : "things")")
    }

    private func openComing(_ r: JSONValue) {
        guard let o = r["open"]?.objectValue else { return }
        if let t = o["task"]?.stringValue { router.push(.task(t)) }
        else if let m = o["matter"]?.stringValue { router.push(.matter(m)) }
        else if let u = o["url"]?.stringValue { openURL(u) }
    }

    // MARK: presence

    @ViewBuilder private var presenceLine: some View {
        let working = (now["working"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let looking = (now["looking"]?.arrayValue ?? []).compactMap { $0.stringValue }
        let status = now["status"]?.stringValue ?? ""
        if !working.isEmpty || !looking.isEmpty || !status.isEmpty || staleNote != nil {
            VStack(alignment: .leading, spacing: 3) {
                if !working.isEmpty { Text("Working on: " + working.joined(separator: ", ")) }
                if !looking.isEmpty { Text("Looking at: " + looking.joined(separator: " · ")) }
                if let s = staleNote { Text(s) } else if !status.isEmpty { Text(status) }
            }
            .font(.system(size: 12.5)).foregroundStyle(Theme.textTertiary)
        }
    }

    // MARK: pieces

    private func pill(_ label: String, filled: Bool, accent: Bool = false, small: Bool = false,
                      busy: Bool = false, action: @escaping () -> Void) -> some View {
        let fill: Color = filled ? (accent ? Theme.accent : Theme.text) : Theme.surface
        return Button(action: action) {
            Text(label).font(.system(size: small ? 13 : 15, weight: .semibold))
                .foregroundStyle(filled ? (accent ? Color.white : Theme.bg) : Theme.text)
                .padding(.horizontal, small ? 12 : 18).padding(.vertical, small ? 6 : 10)
                .background(Capsule().fill(fill))
                .overlay(Capsule().strokeBorder(filled ? Color.clear : Theme.border))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.5 : 1)
    }
}

/// Quiet text actions in a wrapping row ("Later · Talk it through").
private struct FlowLinks: View {
    let items: [(String, () -> Void)]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 18) { links }
            VStack(alignment: .leading, spacing: 10) { links }
        }
    }
    @ViewBuilder private var links: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, it in
            Button(it.0, action: it.1)
                .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                .buttonStyle(.plain)
                .lineLimit(1)
        }
    }
}
