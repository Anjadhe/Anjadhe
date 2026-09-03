import SwiftUI
import AnjadheCore

// Settings — a pushed screen reached from the gear in the Home header.
// Hosts Paired Devices (pair this phone with a Mac, sync on demand, forget
// the pairing) and the Assistant's honest copy. Port of
// mobile/screens/settings.js + the old SyncContent pairing page.

struct SettingsView: View {
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var router: Router
    @State private var showPairing = false
    @State private var confirmForget = false
    @State private var confirmResync = false
    @State private var showFullLog = false

    private var pairedSub: String {
        switch sync.transport {
        case "direct": return "Connected directly to your Mac on this network."
        case "relay": return "Connected through the encrypted relay."
        default: return "Your notes, tasks and journal sync both ways."
        }
    }

    var body: some View {
        ScreenColumn {
            ScreenHead("Settings")

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel("Paired Devices")
                if sync.paired {
                    SettingsStatusCard(on: true, title: "Paired with your Mac", sub: pairedSub,
                                       detail: "Connection: \(sync.state)")
                    PrimaryButton(label: "Sync now") { sync.triggerSync() }
                    SecondaryButton(label: "Pair again") { showPairing = true }
                    Text("Mac stopped syncing — or removed this phone? Pair again to reconnect.")
                        .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    SecondaryButton(label: "Re-download from Mac") { confirmResync = true }
                    Text("Replaces this phone's copy of your data with your Mac's. Use it if the phone shows things your Mac no longer has.")
                        .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    DangerButton(label: "Forget this Mac") { confirmForget = true }
                } else {
                    SettingsStatusCard(on: false, title: "Not paired",
                                       sub: "Pair this phone with your Mac to sync your notes, tasks and journal over a direct, encrypted connection.",
                                       detail: nil)
                    PrimaryButton(label: "Pair with your Mac") { showPairing = true }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
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

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel("Assistant")
                Text("The assistant runs on your Mac — your data and your model stay there, and this phone reaches it over the same encrypted connection as sync. On your home network the phone talks straight to your Mac; away from home, an encrypted relay forwards data it cannot read. Actions that need approval are confirmed on the Mac.")
                    .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .themedCard(padding: 14)
            }
        }
        .pushedScreen()
        .alert("Forget this Mac?", isPresented: $confirmForget) {
            Button("Forget", role: .destructive) { sync.forgetPairing() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone will stop syncing until you pair again.")
        }
        .alert("Re-download from your Mac?", isPresented: $confirmResync) {
            Button("Re-download", role: .destructive) { sync.resyncFromMac(); router.showToast("Syncing from your Mac…") }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone's copy is replaced with your Mac's data. Anything edited only on this phone and not yet synced is lost.")
        }
        .sheet(isPresented: $showPairing) {
            PairingSheet()
        }
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
                Text("On your Mac: open Anjadhe, then Settings → Paired Devices → \"Pair a device\". Scan the code it shows, or paste it below.")
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
