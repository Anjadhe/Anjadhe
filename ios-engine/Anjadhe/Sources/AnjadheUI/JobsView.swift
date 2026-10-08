import SwiftUI
import AnjadheCore

// Jobs and Chats on the phone (2026-10-02) — the desktop's nenva shell has
// Now · Chats · Jobs, and so does the phone.
//
// JOBS is the Mac's own page (mobile-views.js `_jobs` / `_job`, over
// SimpleExperience.jobs / jobStatus / jobTitle and TeamJobs): every word is
// the job record's, nothing computed here. A running job's page re-asks every
// few seconds while it is on screen, so the steps tick over the way they do
// on the Mac. Stop / Continue / a routine run's wait are the Mac's buttons,
// sent as `job-action`; the full report lives in the job's chat, which opens
// in the Chat tab.
//
// CHATS is the synced conversation list (the one record-merged list across
// the Mac and the phone): any saved chat opens in the Chat tab and a reply
// continues it, whichever device it started on.

private let JOBS_TTL: TimeInterval = 30

struct JobsView: View {
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @EnvironmentObject var sync: SyncCoordinator

    var body: some View {
        let _ = views.revision
        let snap = views.view("jobs", ttl: JOBS_TTL, dependsOn: ["app_agent-conversations"])
        let jobs = snap.data?["jobs"]?.arrayValue ?? []
        return ScreenColumn(spacing: 18) {
            ScreenHead("Jobs", sub: subline(snap))
            if jobs.isEmpty {
                EmptyText(!sync.paired ? "Pair with your Mac in Settings to see your jobs."
                          : snap.data == nil ? "Waiting to hear from your Mac."
                          : "Hand nenva a job: research something, compare options, plan something. It works on it and reports back.")
            } else {
                CardList {
                    ForEach(Array(jobs.enumerated()), id: \.offset) { i, j in
                        RowView(j["title"]?.stringValue ?? "A job", sub: j["when"]?.stringValue, last: i == jobs.count - 1) {
                            JobStatusText(job: j)
                        }
                        .onTapGesture { if let id = j["id"]?.stringValue { router.push(.job(id)) } }
                    }
                }
            }
        }
        .refreshable { views.refresh("jobs") }
        .rootScreen("Jobs")
    }

    private func subline(_ snap: MacViews.Snapshot) -> String? {
        guard let at = snap.at else { return nil }
        if snap.error != nil { return "Could not reach your Mac · " + MacViews.agoLabel(at) }
        return nil
    }
}

struct JobStatusText: View {
    let job: JSONValue
    var body: some View {
        let attn = job["attn"]?.boolValue ?? false
        let live = job["live"]?.boolValue ?? false
        Text(job["status"]?.stringValue ?? "")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(attn ? Theme.warning : live ? Theme.accent : Theme.textTertiary)
    }
}

struct JobDetailView: View {
    let id: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router
    @EnvironmentObject var chat: ChatState
    @State private var busy = false
    @State private var tick = 0
    @State private var timer: Timer?

    private var slot: String { "job:" + id }

    var body: some View {
        let _ = views.revision
        let _ = tick
        let snap = views.view(slot, ttl: 4, request: "job", params: ["id": .string(id)])
        let j = snap.data
        return ScreenColumn(spacing: 16) {
            if let j = j {
                HStack(spacing: 10) {
                    JobStatusText(job: j)
                    Spacer(minLength: 0)
                    if j["canStop"]?.boolValue == true { smallButton("Stop") { act("stop") } }
                    if j["canContinue"]?.boolValue == true { smallButton("Continue") { act("continue") } }
                }
                Text(j["title"]?.stringValue ?? "A job").displayStyle(24)
                    .fixedSize(horizontal: false, vertical: true)
                if let note = j["note"]?.stringValue, !note.isEmpty {
                    Text(note).font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let wait = j["wait"]?.objectValue { waitCard(wait) }
                let steps = j["steps"]?.arrayValue ?? []
                if !steps.isEmpty { stepList(steps) }
                let changes = (j["changes"]?.arrayValue ?? []).compactMap { $0.stringValue }
                if !changes.isEmpty {
                    Text("Changed: " + changes.joined(separator: "; "))
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                doors(j)
            } else if let err = snap.error {
                EmptyText(err)
            } else {
                EmptyText("Asking your Mac…")
            }
        }
        .pushedScreen()
        .onAppear { startTicking() }
        .onDisappear { timer?.invalidate(); timer = nil }
    }

    /// While the job runs, re-ask every few seconds; a job that has
    /// finished needs no clock.
    private func startTicking() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            DispatchQueue.main.async {
                let live = views.view(slot, ttl: 4, request: "job", params: ["id": .string(id)]).data?["live"]?.boolValue ?? false
                if live { tick += 1 }
            }
        }
    }

    private func act(_ a: String) {
        guard !busy else { return }
        busy = true
        views.request("job-action", params: ["id": .string(id), "act": .string(a)]) { result in
            busy = false
            if case .failure(let err) = result { router.showToast(err.localizedDescription) }
            views.refresh(slot)
            views.refresh("jobs")
        }
    }

    private func waitCard(_ w: [String: JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(w["label"]?.stringValue ?? "nenva") wants to: \(w["text"]?.stringValue ?? "")")
                .font(.system(size: 15)).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button { act("allow") } label: {
                    Text("Allow").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.white)
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(Capsule().fill(Theme.accent))
                }.buttonStyle(.plain)
                smallButton("Don’t allow") { act("deny") }
                Spacer(minLength: 0)
                Text("Just this once").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
            }
            .disabled(busy).opacity(busy ? 0.5 : 1)
        }
        .themedCard(padding: 14)
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.accent, lineWidth: 1.5))
    }

    private func stepList(_ steps: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
                let status = s["status"]?.stringValue ?? "pending"
                HStack(alignment: .top, spacing: 10) {
                    Group {
                        if status == "running" { ProgressView().controlSize(.small) }
                        else {
                            Text(status == "done" ? "✓" : status == "failed" ? "✗" : status == "skipped" ? "–" : "·")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(status == "failed" ? Theme.danger : Theme.textTertiary)
                        }
                    }
                    .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s["step"]?.stringValue ?? "")
                            .font(.system(size: 15))
                            .foregroundStyle(status == "pending" ? Theme.textTertiary : Theme.text)
                            .fixedSize(horizontal: false, vertical: true)
                        if let n = s["note"]?.stringValue, !n.isEmpty {
                            Text(n).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .themedCard(padding: 14)
    }

    @ViewBuilder private func doors(_ j: JSONValue) -> some View {
        if let conv = j["conversationId"]?.stringValue {
            SecondaryButton(label: (j["attn"]?.boolValue ?? false) ? "Review in chat" : "Open the chat") {
                chat.open(conv)
                router.root(.assistant)
            }
        } else if let rid = j["routineId"]?.stringValue {
            SecondaryButton(label: "Open the routine") { router.push(.prompt(rid)) }
        }
    }

    private func smallButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(Capsule().fill(Theme.surface))
                .overlay(Capsule().strokeBorder(Theme.border))
        }
        .buttonStyle(.plain)
        .disabled(busy).opacity(busy ? 0.5 : 1)
    }
}

// MARK: - Chats

/// Chats is a ROOT since 2026-10-08 (the desktop's Now · Chats · Memory ·
/// Settings): Conversations and Standing (a routine is a Standing chat, the
/// desktop's 2026-10-07 fold), a running job's status on its chat's row
/// (the Jobs page left the nav 2026-10-06), and a chat opens as a page.
struct ChatsListView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var chat: ChatState
    @EnvironmentObject var views: MacViews
    @State private var query = ""
    @State private var standing = false

    var body: some View {
        let _ = store.revision
        let _ = views.revision
        let convsAll = (store.blob("agent-conversations")["conversations"]?.arrayValue ?? [])
            .filter { $0["private"]?.boolValue != true }
        let routines = convsAll.filter { StandingChats.isStanding($0) }
            .sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }
        let chats = convsAll
            .filter { !StandingChats.isStanding($0) && !($0["messages"]?.arrayValue ?? []).isEmpty }
            .sorted { ($0["updatedAt"]?.stringValue ?? "") > ($1["updatedAt"]?.stringValue ?? "") }
        let all = standing ? routines : chats
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let convs = q.isEmpty ? Array(all.prefix(100)) : all.filter { c in
            (c["title"]?.stringValue ?? "").lowercased().contains(q)
                || (c["messages"]?.arrayValue ?? []).contains { ($0["content"]?.stringValue ?? "").lowercased().contains(q) }
        }.prefix(100).map { $0 }
        // A job's status rides its chat's row (the Mac's `jobs` view names
        // the conversation; an older Mac names none and rows stay plain).
        let jobs = views.view("jobs", ttl: 30, dependsOn: ["app_agent-conversations"]).data?["jobs"]?.arrayValue ?? []
        var jobByConv: [String: JSONValue] = [:]
        for j in jobs { if let c = j["conversationId"]?.stringValue, jobByConv[c] == nil { jobByConv[c] = j } }
        return ScreenColumn(spacing: 14) {
            ScreenHead("Chats") {
                HeadAction(symbol: "square.and.pencil", label: "New chat") {
                    chat.newChat()
                    router.openCompose()
                }
            }
            HStack(spacing: 18) {
                tab("Conversations", count: chats.count, on: !standing) { standing = false }
                tab("Standing", count: routines.count, on: standing) { standing = true }
                Spacer(minLength: 0)
            }
            SearchField(placeholder: standing ? "Search routines…" : "Search chats…", text: $query)
            if convs.isEmpty {
                EmptyText(!q.isEmpty ? "No chats match."
                          : standing ? "A routine is a chat nenva keeps on its own: a morning brief, a weekly look at your money. Ask for one in a chat."
                          : "Ask nenva anything, or hand it a job.")
            } else {
                CardList {
                    ForEach(Array(convs.enumerated()), id: \.offset) { i, c in
                        let id = c["id"]?.stringValue ?? ""
                        RowView(title(c), sub: standing ? routineLine(c) : preview(c), last: i == convs.count - 1) {
                            if let j = jobByConv[id], !(j["status"]?.stringValue ?? "").isEmpty {
                                JobStatusText(job: j)
                            } else {
                                Text(DateLogic.relDate(c["updatedAt"]?.stringValue ?? ""))
                                    .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                            }
                        }
                        .onTapGesture {
                            guard !id.isEmpty else { return }
                            chat.open(id)
                            router.push(.conversation)
                        }
                    }
                }
            }
        }
        .refreshable { views.refresh("jobs") }
        .rootScreen("Chats")
    }

    private func tab(_ label: String, count: Int, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 15, weight: on ? .semibold : .regular))
                if count > 0 { Text("\(count)").font(.system(size: 12)).foregroundStyle(Theme.textTertiary) }
            }
            .foregroundStyle(on ? Theme.text : Theme.textTertiary)
            .padding(.vertical, 4)
            .overlay(alignment: .bottom) { if on { Rectangle().fill(Theme.accent).frame(height: 2).offset(y: 4) } }
        }
        .buttonStyle(.plain)
    }

    private func title(_ c: JSONValue) -> String {
        let t = c["title"]?.stringValue ?? ""
        return t.hasPrefix("Phone: ") ? String(t.dropFirst(7)) : (t.isEmpty ? "A chat" : t)
    }

    /// The person's own last words — never a summary of the chat.
    private func preview(_ c: JSONValue) -> String {
        let msgs = c["messages"]?.arrayValue ?? []
        let last = msgs.last { $0["role"]?.stringValue == "user" }
        return stripHTML(last?["content"]?.stringValue ?? "", 80)
    }

    /// A routine's row: when it last ran, from its own run records.
    private func routineLine(_ c: JSONValue) -> String {
        let runs = (c["messages"]?.arrayValue ?? []).filter { StandingChats.isRun($0) }
        guard let last = runs.last,
              let at = last["metadata"]?["routineRun"]?["at"]?.stringValue ?? last["timestamp"]?.stringValue else { return "Not run yet" }
        return "Last ran " + DateLogic.relDate(at)
    }
}
