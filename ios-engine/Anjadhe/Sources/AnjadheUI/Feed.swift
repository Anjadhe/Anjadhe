import SwiftUI
import AnjadheCore

// Feed — a read-only view of the Prompt Feed: outputs of routines that ran on
// the Mac, synced as the `promptFeed` blob (port of mobile/screens/feed.js).
// Model markdown renders through MarkdownView, the same structure the Mac
// shows; record links inside route through the Router.

private func feedMeta(_ it: JSONValue) -> String {
    [it["createdAt"]?.stringValue.map { DateLogic.relDate($0) } ?? "", it["model"]?.stringValue ?? ""]
        .filter { !$0.isEmpty }.joined(separator: " · ")
}

struct FeedView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var feed: [JSONValue] {
        store.items("promptFeed", "items").sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
    }

    var body: some View {
        let list = feed
        ScreenColumn(spacing: 14) {
            ScreenHead("Feed", sub: "Routine results from your Mac")
            if list.isEmpty {
                EmptyText("No feed entries yet. Routines run on your Mac and their results appear here.")
            } else {
                ForEach(Array(list.enumerated()), id: \.offset) { _, it in card(it) }
            }
        }
        .pushedScreen()
        .environment(\.openURL, OpenURLAction { url in router.handleLink(url); return .handled })
    }

    private func card(_ it: JSONValue) -> some View {
        let id = it["id"]?.stringValue ?? ""
        let err = it["error"]?.stringValue
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(it["promptTitle"]?.stringValue ?? "Untitled routine").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Text(feedMeta(it)).font(.caption2).foregroundStyle(Theme.textTertiary)
            }
            if let e = err {
                Text(e).font(.caption).foregroundStyle(Theme.danger)
            } else {
                let content = it["content"]?.stringValue ?? ""
                MarkdownView(text: content.isEmpty ? "Empty response" : content)
                    .font(.callout)
                    .frame(maxHeight: 96, alignment: .top)
                    .clipped()
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
            if let item = store.findItem("promptFeed", "items", id: id) {
                let content = item["content"]?.stringValue ?? ""
                ScreenColumn(spacing: 14) {
                    ScreenHead(item["promptTitle"]?.stringValue ?? "Untitled routine", sub: feedMeta(item)) {
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
    }
}
