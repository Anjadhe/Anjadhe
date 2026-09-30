import SwiftUI
import AnjadheCore

// Feed — what your routines wrote, read on the phone.
// Model markdown renders through MarkdownView, the same structure the Mac
// shows; record links inside route through the Router.
//
// A POST IS A NOTE (fixed 2026-09-20). The Mac writes each result into the
// `notes` blob as a note carrying a `feed` object — `{promptId, model,
// error, readAt}` — and the note's own `title` and `content` are the
// routine's name and the post. This screen read `promptFeed.items` instead,
// a legacy field the Mac has long left as an empty array, so the phone's
// Feed showed "No feed entries yet" no matter how many routines had run.
//
// THE FEED IS A DIGEST OF SERIES (2026-09-23, the Mac's shape). A routine
// that runs every morning is one newsletter with dated editions, so the list
// shows one row per ROUTINE — its newest edition leads, the rest are "earlier"
// — never one card per post (a daily routine buried everything else). New
// (unread) series sit above what you have read. The reader is a white sheet
// on the ground, walks you to the next new post, and lists the routine's
// earlier editions under the one you are reading. Every word shown is the
// post's own: previews are cut from its text, never written about it.

/// The routine results, newest first.
func feedPosts(_ store: AppStore) -> [JSONValue] {
    store.items("notes", "notes")
        .filter { $0["feed"]?.objectValue != nil }
        .sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
}

/// One routine's posts, newest first.
struct FeedSeries: Identifiable {
    let id: String
    let title: String
    let posts: [JSONValue]
    var latest: JSONValue { posts[0] }
    var unread: Int { posts.filter(isUnread).count }
}

/// Which routine a post belongs to: its routine id, else (older posts) its title.
private func seriesKey(_ it: JSONValue) -> String {
    if let p = it["feed"]?["promptId"]?.stringValue, !p.isEmpty { return "prompt:" + p }
    return "title:" + (it["title"]?.stringValue ?? "")
}

func isUnread(_ it: JSONValue) -> Bool { (it["feed"]?["readAt"]?.stringValue ?? "").isEmpty }

private func feedError(_ it: JSONValue) -> String? {
    it["feed"]?["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
}

/// Posts grouped by routine; series ordered by their newest post.
func feedSeries(_ store: AppStore) -> [FeedSeries] {
    var order: [String] = []
    var groups: [String: [JSONValue]] = [:]
    for p in feedPosts(store) {
        let k = seriesKey(p)
        if groups[k] == nil { order.append(k) }
        groups[k, default: []].append(p)
    }
    return order.map { k in
        let posts = groups[k] ?? []
        return FeedSeries(id: k, title: posts.first?["title"]?.stringValue ?? "Untitled routine", posts: posts)
    }
}

/// "Tue, Sep 22 · 9:02 AM" for an ISO stamp; empty when it will not parse.
func feedFullDate(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "" }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = f.date(from: iso)
    if date == nil { f.formatOptions = [.withInternetDateTime]; date = f.date(from: iso) }
    guard let d = date else { return "" }
    let out = DateFormatter()
    out.dateFormat = "EEE, MMM d · h:mm a"
    return out.string(from: d)
}

private func feedAgo(_ it: JSONValue) -> String {
    it["createdAt"]?.stringValue.map { DateLogic.relDate($0) } ?? ""
}

/// A post's opening words as plain text: headings skipped when there is
/// body text after them (a post opening "## Your morning" should preview its
/// first sentence, not its heading), Markdown marks removed, link text kept.
/// Cut from the post, never written about it.
func feedPreview(_ it: JSONValue, max: Int) -> String {
    feedPreviewText(it["content"]?.stringValue ?? "",
                    id: it["id"]?.stringValue ?? "", stamp: it["modifiedAt"]?.stringValue ?? "", max: max)
}

/// The same, from a post's raw text (the simple home's routine rows).
func feedPreviewText(_ raw: String, id: String, stamp: String, max: Int) -> String {
    if raw.contains("<") && raw.contains(">") && !raw.contains("\n#") {
        // An HTML note (older posts): the shared stripper already handles it.
        return PlainText.preview(raw, id: id, stamp: stamp, max: max)
    }
    let lines = raw.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let body = lines.filter { !$0.hasPrefix("#") }
    var text = (body.isEmpty ? lines : body).joined(separator: " ")
    let rules: [(String, String)] = [
        ("^#+\\s*", ""), ("(?<=\\s)#+\\s", ""),              // heading marks
        ("\\[([^\\]]*)\\]\\([^)]*\\)", "$1"),               // [text](url) -> text
        ("(\\*\\*|__|`)", ""),                              // bold, code
        ("(?<![A-Za-z0-9])[*_](?=\\S)|(?<=\\S)[*_](?![A-Za-z0-9])", ""), // italics
        ("(^|\\s)([-*+]|\\d+\\.)\\s+", "$1"),                  // list markers
        ("^>\\s*|\\s>\\s", " "),                              // quotes
        ("\\s+", " "),
    ]
    for (pattern, template) in rules {
        text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
    }
    text = text.trimmingCharacters(in: .whitespaces)
    return text.count > max ? String(text.prefix(max)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : text
}

/// The small accent dot that marks something new.
private struct NewDot: View {
    var body: some View { Circle().fill(Theme.accent).frame(width: 8, height: 8) }
}

struct FeedView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        let series = feedSeries(store)
        let fresh = series.filter { $0.unread > 0 }
        let read = series.filter { $0.unread == 0 }
        let newCount = fresh.reduce(0) { $0 + $1.unread }
        ScreenColumn(spacing: 14) {
            ScreenHead("Feed", sub: series.isEmpty ? "What your routines write, from your Mac"
                                                   : (newCount > 0 ? "\(newCount) new" : "All caught up"))
            if series.isEmpty {
                EmptyText("Nothing yet. Routines run on your Mac, and what they write appears here.")
            } else {
                if !fresh.isEmpty {
                    SectionLabel("New").padding(.top, 4)
                    ForEach(fresh) { s in row(s) }
                }
                if !read.isEmpty {
                    SectionLabel("Earlier").padding(.top, fresh.isEmpty ? 4 : 12)
                    ForEach(read) { s in row(s) }
                }
            }
        }
        .pushedScreen()
        .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
    }

    private func row(_ s: FeedSeries) -> some View {
        let post = s.latest
        let id = post["id"]?.stringValue ?? ""
        let err = feedError(post)
        let unread = s.unread
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if unread > 0 { NewDot().alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 1 } }
                Text(s.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(feedAgo(post)).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
            }
            if let e = err {
                Text("Couldn\u{2019}t finish: \(e)")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.danger)
                    .lineLimit(2)
            } else {
                let preview = feedPreview(post, max: 240)
                Text(preview.isEmpty ? "Nothing to report." : preview)
                    .font(.system(size: 15))
                    .foregroundStyle(unread > 0 ? Theme.textSecondary : Theme.textTertiary)
                    .lineSpacing(4)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let more = s.posts.count - 1
            if unread > 1 || more > 0 {
                Text(unread > 1 ? "\(unread) new" + (more >= unread ? " · \(more - unread + 1) earlier" : "")
                                : "+ \(more) earlier")
                    .font(.system(size: 13, weight: unread > 1 ? .medium : .regular))
                    .foregroundStyle(unread > 1 ? Theme.accent : Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .themedCard()
        .contentShape(Rectangle())
        .onTapGesture { if !id.isEmpty { router.push(.feedItem(id)) } }
        .accessibilityElement(children: .combine)
        .accessibilityHint(unread > 0 ? "New. Opens the post." : "Opens the post.")
    }
}

struct FeedDetail: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        Group {
            if let item = store.findItem("notes", "notes", id: id), item["feed"]?.objectValue != nil {
                reader(item)
            } else {
                ScreenColumn { EmptyText("This post is gone.") }
            }
        }
        .pushedScreen()
        .onAppear(perform: markRead)
    }

    private func reader(_ item: JSONValue) -> some View {
        let content = item["content"]?.stringValue ?? ""
        let series = feedSeries(store).first { s in s.posts.contains { $0["id"]?.stringValue == id } }
        let earlier = (series?.posts ?? []).filter { ($0["createdAt"]?.stringValue ?? "") < (item["createdAt"]?.stringValue ?? "") }
        let nextNew = feedPosts(store).first { isUnread($0) && $0["id"]?.stringValue != id }
        return ScreenColumn(spacing: 16) {
            // Head: which routine, when — then the post itself.
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text((item["title"]?.stringValue ?? "Untitled routine"))
                        .sectionHeaderStyle()
                        .foregroundStyle(Theme.textSecondary)
                    Text(feedFullDate(item["createdAt"]?.stringValue))
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer(minLength: 0)
                if feedError(item) == nil {
                    HeadAction(symbol: "doc.on.doc", label: "Copy") { copyToPasteboard(content); router.showToast("Copied") }
                }
            }
            .padding(.top, 6)

            // The post: a white reading sheet on the ground.
            VStack(alignment: .leading, spacing: 0) {
                if let e = feedError(item) {
                    Text("This run couldn\u{2019}t finish").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(e).font(.system(size: 15)).foregroundStyle(Theme.danger).lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                    Text("It will try again on its next run. You can change or run it from Routines on your Mac.")
                        .font(.system(size: 14)).foregroundStyle(Theme.textTertiary).lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
                } else if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Nothing to report this time.").font(.system(size: 16)).foregroundStyle(Theme.textTertiary)
                } else {
                    MarkdownView(text: content)
                }
            }
            .padding(.horizontal, 18).padding(.vertical, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.border))

            // Walk the new posts in order without going back to the list.
            if let n = nextNew, let nid = n["id"]?.stringValue {
                Button { router.push(.feedItem(nid)) } label: {
                    HStack(spacing: 10) {
                        NewDot()
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Next new post \u{00B7} \(feedAgo(n))").font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                            Text(n["title"]?.stringValue ?? "Untitled routine")
                                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                    }
                    .themedCard()
                }
                .buttonStyle(.plain)
            }

            // The routine's earlier editions, one tap each.
            if !earlier.isEmpty {
                SectionLabel("Earlier from this routine", count: earlier.count).padding(.top, 8)
                CardList {
                    ForEach(Array(earlier.prefix(12).enumerated()), id: \.offset) { i, p in
                        let pid = p["id"]?.stringValue ?? ""
                        Button { if !pid.isEmpty { router.push(.feedItem(pid)) } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    if isUnread(p) { NewDot() }
                                    Text(feedFullDate(p["createdAt"]?.stringValue))
                                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                }
                                let pv = feedError(p).map { "Couldn\u{2019}t finish: \($0)" } ?? feedPreview(p, max: 120)
                                if !pv.isEmpty {
                                    Text(pv).font(.system(size: 13)).foregroundStyle(Theme.textTertiary).lineLimit(2)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14).padding(.vertical, 11)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if i < min(earlier.count, 12) - 1 { Divider().overlay(Theme.borderLight) }
                    }
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
    }

    /// Opening a post marks it read — the same lifecycle the Mac uses, and
    /// what makes the simple home's "From your routines" section empty
    /// itself as you work through it.
    private func markRead() {
        // NOT `patchItem`: that stamps `modifiedAt`, and on the Mac reading a
        // post is deliberately not an edit — it must not reorder Notes. The
        // record merge knows this and folds `feed.readAt` into a record's
        // stamp itself (main.js `_recordStamp`), so the read still travels.
        var notes = store.items("notes", "notes")
        guard let i = notes.firstIndex(where: { $0["id"]?.stringValue == id }),
              case .object(var note) = notes[i],
              var feed = note["feed"]?.objectValue,
              (feed["readAt"]?.stringValue ?? "").isEmpty else { return }
        feed["readAt"] = .string(KVStore.nowISO())
        note["feed"] = .object(feed)
        notes[i] = .object(note)
        store.saveItems("notes", "notes", notes)
    }
}
