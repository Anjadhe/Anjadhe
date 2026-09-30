import SwiftUI
import AnjadheCore

/// Settings › Assistant › "When your Mac is away" (docs/MOBILE_NATIVE.md
/// "M5"). The same synced `phone-ai` choice as the Mac's Settings › AI
/// Assistant › Models card: set it on either device. Off is the default and
/// means the phone waits for the Mac (P1). Only nenva Cloud models are
/// offered — the one destination the phone can reach with the Mac's key.
struct PhoneAISettingsCard: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var sync: SyncCoordinator
    @EnvironmentObject var chat: ChatState
    @EnvironmentObject var router: Router
    @State private var models: [(id: String, label: String)] = []

    private var current: PhoneModelChoice? { PhoneModelChoice.from(store.blob("phone-ai")) }

    private var status: String {
        guard let c = current else { return "Off. The assistant waits for your Mac." }
        if CloudCredentials.load() != nil { return "Ready. When your Mac is away, \(c.displayName) answers and says so under each answer." }
        return sync.paired
            ? "Getting the nenva Cloud key from your Mac the next time they connect."
            : "Pair with your Mac first: the phone uses your Mac's nenva Cloud allowance."
    }

    private func choose(_ id: String?) {
        if let id = id {
            let label = models.first { $0.id == id }?.label ?? id
            store.saveBlob("phone-ai", PhoneModelChoice(engine: "anjadhe", model: id, label: label).blob(now: KVStore.nowISO()))
            router.showToast("When your Mac is away, \(label) answers")
        } else {
            store.saveBlob("phone-ai", ["fallback": .null, "updatedAt": .string(KVStore.nowISO())])
            CloudCredentials.clear()
            router.showToast("The assistant waits for your Mac")
        }
        // The Mac hands the key over only once it has the choice (P4): sync
        // it up, then ask.
        sync.triggerSync()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { chat.syncCloudKey() }
    }

    var body: some View {
        let _ = store.revision
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("When your Mac is away").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Menu {
                    Button("Off — wait for my Mac") { choose(nil) }
                    ForEach(menuModels, id: \.id) { m in
                        Button(m.label) { choose(m.id) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(current?.label ?? "Off").font(.system(size: 15))
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                    }
                    .foregroundStyle(Theme.text)
                }
            }
            Text(status)
                .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("On its own the phone can search the web and read your synced tasks, calendar, projects and notes. It changes nothing. Journal and wellness stay out unless Cloud Privacy on your Mac allows them. When your Mac is back, your next message hands the conversation back to it.")
                .font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .themedCard(padding: 14)
        .task {
            let base = CloudCredentials.load()?.baseURL ?? CloudClient.defaultBase
            let list = await CloudClient.models(baseURL: base)
            models = list.isEmpty ? [("anjadhe-cloud", "nenva Cloud")] : list
        }
    }

    /// The catalog, plus the saved choice if the catalog no longer lists it.
    private var menuModels: [(id: String, label: String)] {
        var list = models
        if let c = current, !list.contains(where: { $0.id == c.model }) { list.append((c.model, c.label)) }
        return list
    }
}
