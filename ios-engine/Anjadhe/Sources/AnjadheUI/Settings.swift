import SwiftUI
import AnjadheCore

// Settings — a root since 2026-10-08, and since the same day the desktop's
// shape (SIMPLE_EXPERIENCE.md "Settings as ONE page"): one short list of
// rows, each with its value, each opening a small page of its own. Only what
// THIS phone has: Your Mac (pairing and sync), Model (who answers when the
// Mac is away), Email (which app opens a message), Lock (shared with the Mac), About, and Advanced (the
// connection log, re-download, forget). The old page stacked all of it.

struct SettingsView: View {
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @EnvironmentObject var chat: ChatState
    @EnvironmentObject var store: AppStore

    var body: some View {
        let _ = store.revision
        ScreenColumn(spacing: 18) {
            ScreenHead("Settings")
            SettingsGroup {
                SettingsRow("Your Mac", symbol: "laptopcomputer", value: macValue) { router.push(.settingsPage("mac")) }
                SettingsRow("Model", symbol: "cpu", value: modelValue, last: true) { router.push(.settingsPage("model")) }
            }
            SettingsGroup {
                SettingsRow("Email", symbol: "envelope", value: emailValue) { router.push(.settingsPage("email")) }
                SettingsRow("Lock", symbol: "lock", value: AppLock.enabled(store) ? "On" : "Off", last: true) { router.push(.settingsPage("lock")) }
            }
            SettingsGroup {
                SettingsRow("About", symbol: "info.circle", value: SettingsPageView.version, last: true) { router.push(.settingsPage("about")) }
            }
            SettingsGroup {
                SettingsRow("Advanced", symbol: "gearshape.2", value: "Sync log, re-download", last: true) { router.push(.settingsPage("advanced")) }
            }
        }
        .rootScreen("Settings")
    }

    private var macValue: String {
        guard sync.paired else { return "Not paired" }
        switch sync.state {
        case "idle", "syncing":
            switch sync.via ?? sync.transport {
            case "lan", "direct": return "Connected"
            case "tailscale": return "Via Tailscale"
            default: return "Via relay"
            }
        case "connecting": return "Connecting…"
        default: return "Offline"
        }
    }
    private var modelValue: String {
        if let c = chat.choice { return c.displayName }
        return PhoneModelChoice.explicitlyOff(store.blob("phone-ai")) ? "Waits for your Mac" : "Follows your Mac"
    }
    private var emailValue: String {
        switch MailDoor.choice { case "gmail": return "Gmail"; case "mail": return "Mail"; default: return "Ask" }
    }
}

/// One white group of rows (the desktop's `.ss-group`).
struct SettingsGroup<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View { CardList { content() } }
}

/// One row: a quiet icon tile, the label, its value, a chevron (`.ss-row`).
struct SettingsRow: View {
    let label: String
    let symbol: String
    var value: String? = nil
    var last = false
    let action: () -> Void
    init(_ label: String, symbol: String, value: String? = nil, last: Bool = false, action: @escaping () -> Void) {
        self.label = label; self.symbol = symbol; self.value = value; self.last = last; self.action = action
    }
    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(Theme.text)
                        .frame(width: 28, height: 28)
                        .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.bg))
                    Text(label).font(.system(size: 16)).foregroundStyle(Theme.text)
                    Spacer(minLength: 8)
                    if let v = value, !v.isEmpty {
                        Text(v).font(.system(size: 15)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textQuaternary)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .contentShape(Rectangle())
                if !last { Divider().padding(.leading, 52) }
            }
        }
        .buttonStyle(.plain)
    }
}

/// A Settings page (`Route.settingsPage`).
struct SettingsPageView: View {
    let id: String
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @State private var showPairing = false
    @State private var confirmForget = false
    @State private var showFullLog = false

    static var version: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return b.isEmpty ? v : "\(v) (\(b))"
    }

    var body: some View {
        ScreenColumn(spacing: 18) {
            switch id {
            case "mac": macPage
            case "model": ScreenHead("Model"); PhoneAISettingsCard()
            case "email": ScreenHead("Email"); MailDoorSettingsCard()
            case "lock": ScreenHead("Lock"); LockSettingsCard()
            case "about": aboutPage
            case "advanced": advancedPage
            default: EmptyText("Nothing here.")
            }
        }
        .pushedScreen()
        .alert("Forget this Mac?", isPresented: $confirmForget) {
            Button("Forget", role: .destructive) { sync.forgetPairing() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone will stop syncing until you pair again.")
        }
        .sheet(isPresented: $showPairing) { PairingSheet() }
    }

    private var pairedSub: String {
        switch sync.via ?? sync.transport {
        case "lan", "direct": return "Connected directly to your Mac on this network."
        case "tailscale": return "Connected directly to your Mac through Tailscale."
        case "relay": return "Connected through the encrypted relay."
        default: return sync.state == "connecting" ? "Connecting to your Mac…" : "Your Mac can’t be reached right now. The phone keeps what it has and syncs when it can."
        }
    }

    @ViewBuilder private var macPage: some View {
        ScreenHead("Your Mac")
        if sync.paired {
            SettingsStatusCard(on: sync.state == "idle" || sync.state == "syncing", title: "Paired with your Mac", sub: pairedSub, detail: nil)
            PrimaryButton(label: "Sync now") { sync.triggerSync() }
            SecondaryButton(label: "Pair again") { showPairing = true }
            Text("Mac stopped syncing, or removed this phone? Pair again to reconnect.")
                .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            SettingsStatusCard(on: false, title: "Not paired",
                               sub: "Pair this phone with your Mac to sync over a direct, encrypted connection.", detail: nil)
            PrimaryButton(label: "Pair with your Mac") { showPairing = true }
        }
    }

    @ViewBuilder private var aboutPage: some View {
        ScreenHead("About", sub: "nenva " + Self.version)
        Text("nenva runs on your Mac. Your data and your model stay there, and this phone reaches it over the same encrypted connection as sync: straight to your Mac on your home network, and through a relay that cannot read it when you are away. When your Mac is away, a model you chose under Model can answer here, and says so under each answer.")
            .font(.system(size: 15)).foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .themedCard(padding: 14)
    }

    @ViewBuilder private var advancedPage: some View {
        ScreenHead("Advanced")
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Connection log")
            if sync.logLines.isEmpty {
                EmptyText("Nothing yet.")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(sync.logLines.suffix(showFullLog ? 60 : 8).enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .themedCard(padding: 12)
                HStack(spacing: 14) {
                    Button(showFullLog ? "Show less" : "Show more") { showFullLog.toggle() }
                    Button("Copy") { copyToPasteboard(sync.logLines.joined(separator: "\n")); router.showToast("Copied") }
                }
                .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text).buttonStyle(.plain)
            }
        }
        if sync.paired { DangerButton(label: "Forget this Mac") { confirmForget = true } }
    }
}

/// The pairing status card: a dot (on/off), a title and a secondary line.
struct SettingsStatusCard: View {
    let on: Bool
    let title: String
    let sub: String
    let detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(on ? Theme.text : Theme.border)
                .frame(width: 10, height: 10)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Text(sub).font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let d = detail {
                    Text(d).font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .themedCard(padding: 14)
    }
}

/// Scan the Mac's pairing QR (camera) or paste the code, then run the
/// handshake through the sync host. Closes itself once paired.
struct PairingSheet: View {
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @State private var offer = ""
    @State private var showScanner = false
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            ScreenColumn(spacing: 16) {
                ScreenHead("Pair with your Mac")
                Text("On your Mac: open nenva, then Settings → Paired Devices → \"Pair a device\". Scan the code it shows, or paste it below.")
                    .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                #if os(iOS)
                PrimaryButton(label: "Scan your Mac's code") { showScanner = true }
                #endif
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Paste pairing code")
                    TextField("Pairing code", text: $offer, axis: .vertical)
                        .lineLimit(2...5)
                        .font(.system(size: 14, design: .monospaced))
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
                    SecondaryButton(label: pairing ? "Pairing…" : "Pair") { start(offer) }
                        .disabled(offer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pairing)
                }
                if let e = sync.lastPairError {
                    Text(e).font(.system(size: 14)).foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .background(Theme.bg)
            .navigationTitle("").inlineNavTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .tint(Theme.text)
        #if os(iOS)
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                showScanner = false
                start(code)
            }
            .ignoresSafeArea()
        }
        #endif
        .onChange(of: sync.paired) { paired in
            if paired {
                pairing = false
                router.showToast("Paired with your Mac")
                dismiss()
            }
        }
        .onChange(of: sync.lastPairError) { e in if e != nil { pairing = false } }
    }

    private func start(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        pairing = true
        sync.pair(offerText: t)
    }
}
