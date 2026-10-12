import SwiftUI
import AnjadheCore

struct SettingsView: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var access: DeviceAccessModel
    var body: some View {
        ScreenColumn {
            ScreenHead("Settings")
            CardList {
                Button { router.push(.ai) } label: {
                    RowView("AI on this iPhone", sub: access.choice?.displayName ?? "Off")
                }.buttonStyle(.plain)
                Button { router.push(.lock) } label: {
                    RowView("Lock nenva", sub: "Face ID or your passcode")
                }.buttonStyle(.plain)
            }
            SectionLabel("Devices")
            Text("This iPhone keeps its own records. Device pairing is not available in this build yet.")
                .font(Theme.bodyFont).foregroundStyle(Theme.textSecondary)
            SectionLabel("About")
            Text("nenva is your personal AI. Your records live on this iPhone. When you choose a cloud model, the content needed to answer is sent to nenva cloud.")
                .font(Theme.bodyFont).foregroundStyle(Theme.textSecondary)
        }.rootScreen("Settings")
    }
}
