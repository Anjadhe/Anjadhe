import SwiftUI
import AnjadheCore

// Feed — a read-only view of the routine results that ran on the Mac.
// Model markdown renders through MarkdownView, the same structure the Mac
// shows; record links inside route through the Router.
//
// A POST IS A NOTE (fixed 2026-09-20). The Mac writes each result into the
// `notes` blob as a note carrying a `feed` object — `{promptId, model,
// error, readAt}` — and the note's own `title` and `content` are the
// routine's name and the post. This screen read `promptFeed.items` instead,
// a legacy field the Mac has long left as an empty array, so the phone's
// Feed showed "No feed entries yet" no matter how many routines had run.

/// The routine results, newest first.
func feedPosts(_ store: AppStore) -> [JSONValue] {
    store.items("notes", "notes")
        .filter { $0["feed"]?.objectValue != nil }
        .sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
}

private func feedMeta(_ it: JSONValue) -> String {
    [it["createdAt"]?.stringValue.map { DateLogic.relDate($0) } ?? "",
     it["feed"]?["model"]?.stringValue ?? ""]
        .filter { !$0.isEmpty }.joined(separator: " · ")
}

struct FeedView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var feed: [JSONValue] { feedPosts(store) }

    var body: some View {
        let list = feed
        ScreenColumn(spacing: 14) {
            ScreenHead("Feed", sub: "Routine results from your Mac")
            if list.isEmpty {
                EmptyText("No feed entries yet. Routines run on your Mac and their results appear here.")
            } else {
                ForEach(list, id: \.self) { it in card(it) }
            }
        }
        .pushedScreen()
        .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
    }

    private func card(_ it: JSONValue) -> some View {
        let id = it["id"]?.stringValue ?? ""
        let err = it["feed"]?["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(it["title"]?.stringValue ?? "Untitled routine").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Text(feedMeta(it)).font(.caption2).foregroundStyle(Theme.textTertiary)
            }
            if let e = err {
                Text(e).font(.caption).foregroundStyle(Theme.danger)
            } else {
                // A CARD gets a plain preview, not a clipped render: a post
                // usually opens on a heading, and a heading cropped at 96pt
                // is a row of huge half-letters. Same idiom as the Notes and
                // Journal lists. The full post is one tap away.
                let content = it["content"]?.stringValue ?? ""
                let preview = PlainText.preview(content,
                                                id: it["id"]?.stringValue ?? "",
                                                stamp: it["modifiedAt"]?.stringValue ?? "",
                                                max: 220)
                Text(preview.isEmpty ? "Empty response" : preview)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSecondary)
                    .lineSpacing(3)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .themedCard()
        .contentShape(Rectangle())
        .onTapGesture { if err == nil, !id.isEmpty { router.push(.feedItem(id)) } }
    }
}

struct FeedDetail: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    var body: some View {
        Group {
            if let item = store.findItem("notes", "notes", id: id), item["feed"]?.objectValue != nil {
                let content = item["content"]?.stringValue ?? ""
                ScreenColumn(spacing: 14) {
                    ScreenHead(item["title"]?.stringValue ?? "Untitled routine", sub: feedMeta(item)) {
                        HeadAction(symbol: "doc.on.doc", label: "Copy") { copyToPasteboard(content); router.showToast("Copied") }
                    }
                    MarkdownView(text: content)
                }
                .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
            } else {
                ScreenColumn { EmptyText("This item is gone.") }
            }
        }
        .pushedScreen()
        .onAppear(perform: markRead)
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
