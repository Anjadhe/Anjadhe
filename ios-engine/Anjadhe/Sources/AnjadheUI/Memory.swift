import SwiftUI
import AnjadheCore

struct MemoryView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    var body: some View {
        ScreenColumn {
            ScreenHead("Memory", sub: "Kept on this iPhone")
            CardList {
                Button { router.push(.documents) } label: { RowView("Documents", sub: "Your written documents") }.buttonStyle(.plain)
                ForEach(MemoryFacts(store: store).groups, id: \.id) { group in
                    Button { router.push(.memoryPage(group.id)) } label: {
                        RowView(group.label, sub: "\(group.facts.count) facts")
                    }.buttonStyle(.plain)
                }
            }
        }.rootScreen("Memory")
    }
}
struct MemoryFactsView: View {
    let id: String
    @EnvironmentObject var store: AppStore
    var body: some View {
        let group = MemoryFacts(store: store).groups.first { $0.id == id }
        ScreenColumn {
            ScreenHead(group?.label ?? "Memory")
            if group?.facts.isEmpty != false { EmptyText("Nothing kept here yet.") }
            ForEach(Array((group?.facts ?? []).enumerated()), id: \.offset) { _, fact in
                Text(fact["text"]?.stringValue ?? "").font(Theme.bodyFont).textSelection(.enabled)
            }
        }.pushedScreen()
    }
}
