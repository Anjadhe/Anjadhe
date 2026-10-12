import SwiftUI
import AnjadheCore

final class DeviceAccessModel: ObservableObject {
    @Published private(set) var state: DeviceSetupState?
    @Published private(set) var loaded = false
    @Published private(set) var working = false
    @Published var error: String?
    private var service: DeviceSetupService?
    private let makeService: () throws -> DeviceSetupService

    init(makeService: @escaping () throws -> DeviceSetupService = { try DeviceSetupService(vault: DeviceSetupKeychain()) }) {
        self.makeService = makeService
    }
    var configured: Bool { state?.setupComplete == true }
    var choice: PhoneModelChoice? {
        guard configured, let model = state?.cloudModel else { return nil }
        return .init(engine: "anjadhe", model: model, label: ModelTiers.cloudName(model: model, label: nil))
    }
    var credentials: DeviceCloudCredential? {
        guard configured, let key = state?.cloudKey else { return nil }
        return .init(apiKey: key, baseURL: CloudClient.defaultBase)
    }
    #if DEBUG
    static func preview(registered: Bool, configured: Bool = false) -> DeviceAccessModel {
        let model = DeviceAccessModel { throw URLError(.notConnectedToInternet) }
        var state = DeviceSetupState()
        if registered { state.registration = "preview-only"; state.email = "preview@example.invalid" }
        if configured { state.setupComplete = true; state.cloudModel = ModelTiers.defaultCloudModel }
        model.state = state; model.loaded = true
        return model
    }
    #endif
    @MainActor func open() async {
        guard !loaded, !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            let service = try makeService()
            self.service = service
            state = await service.snapshot()
            loaded = true
        } catch { self.error = error.localizedDescription }
    }
    @MainActor func register(_ email: String) async {
        guard let service, !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            try await service.register(email: email, appVersion: version)
            state = await service.snapshot()
        } catch { self.error = error.localizedDescription }
    }
    @MainActor func choose(model: String?) async {
        guard let service, !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            try await service.finishSetup(model: model)
            state = await service.snapshot()
        } catch { self.error = error.localizedDescription }
    }
}

/// A phone-first setup flow. No pairing offer, Mac credential request or
/// registration-email lookup is involved in provisioning this installation.
struct DeviceSetupView: View {
    @EnvironmentObject var access: DeviceAccessModel
    @State private var email = ""
    @State private var selectedModel = ModelTiers.defaultCloudModel
    @State private var models: [(id: String, label: String)] = []
    var onboarding = false
    var catalog: () async -> [(id: String, label: String)] = { await CloudClient.models() }

    var body: some View {
        ScreenColumn(spacing: 22) {
            ScreenHead(onboarding ? "Welcome to nenva" : "AI on this iPhone")
            if !access.loaded {
                if let error = access.error {
                    Text(error).font(Theme.bodyFont)
                    PrimaryButton(label: "Try again") { Task { await access.open() } }
                } else { ProgressView("Opening secure settings…") }
            } else if access.state?.registration == nil {
                Text("Your records live on this iPhone. No Mac is needed.")
                    .font(Theme.bodyFont).foregroundStyle(Theme.textSecondary)
                VStack(alignment: .leading, spacing: 10) {
                    Text("Email").font(Theme.detailFont)
                    TextField("you@example.com", text: $email)
                        .font(Theme.bodyFont)
                        .autocorrectionDisabled()
                        .disabled(access.working)
                        #if os(iOS)
                        .textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                        #endif
                        .padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusMd))
                    Text(NativeRegistration.disclosure).font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                }
                PrimaryButton(label: access.working ? "Registering…" : "Get started") {
                    Task { await access.register(email) }
                }
                .disabled(access.working || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                Text("Choose a model for this iPhone.").font(Theme.bodyFont)
                VStack(alignment: .leading, spacing: 16) {
                    Menu {
                        ForEach(menuModels, id: \.id) { model in
                            Button(model.label) { selectedModel = model.id }
                        }
                    } label: {
                        HStack(alignment: .center, spacing: 12) {
                            Text(ModelTiers.cloudName(model: selectedModel, label: nil))
                                .font(Theme.bodyFont).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 16))
                        }
                        .foregroundStyle(Theme.text).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .disabled(access.working)
                    .accessibilityLabel("Cloud model")
                    .accessibilityValue(ModelTiers.cloudName(model: selectedModel, label: nil))
                    Text("Chat runs from this iPhone using your chosen model. Your questions and relevant records are sent to nenva cloud. Changes to commitments ask for your approval before saving.")
                        .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    Text("Your records remain on this iPhone. Cloud AI needs internet and available allowance. Choosing a model does not purchase a plan.")
                        .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                }
                .themedCard(padding: 16)
                PrimaryButton(label: access.working ? "Saving…" : "Save model choice") {
                    Task { await access.choose(model: selectedModel) }
                }
                .disabled(access.working)
                SecondaryButton(label: "Use without AI") {
                    Task { await access.choose(model: nil) }
                }
                .disabled(access.working)
                if access.configured {
                    Text(access.choice.map { "Current model: \($0.displayName)" } ?? "AI is off on this iPhone.")
                        .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                }
            }
            if access.loaded, let error = access.error {
                Text(error).font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            Link("Privacy", destination: URL(string: "https://nenva.co/privacy")!)
                .font(Theme.detailFont).frame(minHeight: 44)
        }
        .background(Theme.bg.ignoresSafeArea())
        .task {
            await access.open()
            selectedModel = access.state?.cloudModel ?? ModelTiers.defaultCloudModel
            // Catalog lookup carries no registration address or device key.
            models = await catalog()
        }
    }
    private var menuModels: [(id: String, label: String)] {
        var result = models
        if !result.contains(where: { $0.id == selectedModel }) {
            result.append((selectedModel, ModelTiers.cloudName(model: selectedModel, label: nil)))
        }
        return result
    }
}

#if DEBUG
/// Layout-only fixture. No Keychain, persistence, registration or network.
public struct MobileSetupPreview: View {
    @StateObject private var access: DeviceAccessModel
    public init(registered: Bool = false) { _access = StateObject(wrappedValue: .preview(registered: registered)) }
    public var body: some View {
        DeviceSetupView(onboarding: true, catalog: { [] }).environmentObject(access)
    }
}
#endif
