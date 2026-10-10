#if DEBUG
import SwiftUI

/// In-memory component fixture for Xcode previews and simulator review.
/// Starts no sync, AI, registration or persistence services.
public struct MobileFoundationPreview: View {
    @StateObject private var router = Router()
    @State private var complete = false

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            ScreenColumn {
                ScreenHead("Your day", sub: "A little space for what matters.") {
                    HeadAction(symbol: "plus", label: "Add") {}
                }
                SectionLabel("Commitments", count: 2)
                CardList {
                    RowView("Book a dentist appointment and ask about the follow-up visit",
                            sub: "Today · Personal", done: complete) {
                        CheckButton(on: complete) { complete.toggle() }
                    } trailing: {
                        Text("Today").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    }
                    RowView("Prepare questions for the appointment",
                            sub: "Bring the notes from last time and the new insurance details.", last: true) {
                        Image(systemName: "doc.text").frame(width: 44, height: 44)
                    } trailing: {
                        EmptyView()
                    }
                }
                AskDoor(label: "Help me plan the rest of my day") {}
                PrimaryButton(label: "Add a commitment") {}
                SecondaryButton(label: "Browse documents") {}
            }
            FunctionBar().environmentObject(router)
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.text)
    }
}

struct MobileFoundationPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            MobileFoundationPreview().previewDisplayName("Default")
            MobileFoundationPreview().environment(\.dynamicTypeSize, .accessibility3)
                .previewDisplayName("Large text")
            MobileFoundationPreview().preferredColorScheme(.dark)
                .previewDisplayName("Dark")
        }
    }
}
#endif
