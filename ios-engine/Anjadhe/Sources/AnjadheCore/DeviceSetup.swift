import Foundation
import CryptoKit

/// Registration is a signed receipt, not proof of account ownership or a
/// grant to another device's data, cloud allowance or encryption keys.
public enum NativeRegistration {
    public static let publicKey = "EhX5QC71GfPXESUShSeL6JnntVb3RwMAUgWUeFj7vaw="
    public static let disclosure = "We store your email for registration, recovery, product updates and important notices. Unsubscribe anytime."

    public static func verify(_ license: String, email: String, publicKey: String = publicKey) throws {
        let parts = license.split(separator: ".", omittingEmptySubsequences: false)
        func decode(_ part: Substring) -> Data? {
            var text = String(part).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            text += String(repeating: "=", count: (4 - text.count % 4) % 4)
            return Data(base64Encoded: text)
        }
        guard parts.count == 3, parts[0] == "ANJ1", let payload = decode(parts[1]), let signature = decode(parts[2]),
              let key = Data(base64Encoded: publicKey), key.count == 32, signature.count == 64,
              try Curve25519.Signing.PublicKey(rawRepresentation: key).isValidSignature(signature, for: payload),
              let object = try JSONDecoder().decode(JSONValue.self, from: payload).objectValue else { throw DeviceSetupError.invalidRegistration }
        func matches(_ name: String, _ pattern: String) -> Bool {
            guard let text = object[name]?.stringValue else { return false }
            return text.range(of: pattern, options: .regularExpression) == text.startIndex..<text.endIndex
        }
        let subject = SHA256.hash(data: Data(email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().utf8))
            .map { String(format: "%02x", $0) }.joined().prefix(32)
        guard object["v"]?.numberValue == 1,
              ["alpha", "free", "paid"].contains(object["class"]?.stringValue ?? ""),
              matches("id", "^[a-f0-9]{16}$"), matches("sub", "^[a-f0-9]{32}$"),
              object["sub"]?.stringValue == String(subject), matches("issuedAt", "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
              object["updatesUntil"] == .null || matches("updatesUntil", "^[0-9]{4}-[0-9]{2}-[0-9]{2}$") else { throw DeviceSetupError.invalidRegistration }
    }
}

public enum DeviceSetupError: Error, Equatable, LocalizedError {
    case invalidRegistration, invalidEmail, invalidState, busy, registrationRequired, recoveryRequired, service(Int)
    public var errorDescription: String? {
        switch self {
        case .invalidRegistration: return "The registration receipt could not be verified. Try again."
        case .invalidEmail: return "Enter a valid email address."
        case .invalidState: return "This device’s setup could not be read. Its saved information has been kept."
        case .busy: return "Setup is already in progress."
        case .registrationRequired: return "Complete registration first."
        case .recoveryRequired: return "Cloud setup was interrupted and its key could not be recovered. Your local data is safe. Contact support to recover cloud access."
        case .service(let status): return status == 429 ? "Too many setup requests. Try again later." : "Couldn’t complete setup right now. Try again."
        }
    }
}

/// Implementations must distinguish missing from unreadable, and atomically
/// replace one local value. Never put this value in the synced record store.
public protocol DeviceSetupVault {
    func read() throws -> Data?
    func write(_ data: Data) throws
}

public struct DeviceSetupState: Codable, Equatable, Sendable {
    public var schema = 1
    public var installID: String
    public var email: String?
    public var registration: String?
    public var cloudKey: String?
    public var setupComplete: Bool?
    public var cloudModel: String?
    public init(installID: String = UUID().uuidString.lowercased()) { self.installID = installID }
}

/// Native provisioning foundation. No calls occur on initialization. The
/// registration method must only follow the disclosed user action; cloud
/// provisioning must only follow an explicit cloud-model choice. Production
/// entitlement linking and trial policy are separate gates.
public actor DeviceSetupService {
    public typealias Transport = (URLRequest) async throws -> (Data, Int)
    private let vault: DeviceSetupVault
    private let transport: Transport
    private let baseURL: URL
    private let signingKey: String
    private var state: DeviceSetupState
    private var busy = false
    // If secure persistence fails after minting, retry that exact write in
    // this process; never issue a second mint to recover from a disk failure.
    private var pendingCloudKey: String?

    public init(vault: DeviceSetupVault, baseURL: URL = URL(string: "https://api.nenva.co")!,
                publicKey: String = NativeRegistration.publicKey,
                transport: @escaping Transport = DeviceSetupService.send) throws {
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil else { throw DeviceSetupError.invalidState }
        self.vault = vault; self.transport = transport; self.baseURL = baseURL; signingKey = publicKey
        let loaded: DeviceSetupState
        if let data = try vault.read() {
            do { loaded = try JSONDecoder().decode(DeviceSetupState.self, from: data) }
            catch { throw DeviceSetupError.invalidState }
            guard loaded.schema == 1, UUID(uuidString: loaded.installID) != nil,
                  loaded.cloudKey == nil || !(loaded.cloudKey?.isEmpty ?? true),
                  (loaded.email == nil) == (loaded.registration == nil) else { throw DeviceSetupError.invalidState }
            if let registration = loaded.registration, let email = loaded.email {
                try NativeRegistration.verify(registration, email: email, publicKey: publicKey)
            }
            guard loaded.cloudKey == nil || loaded.registration != nil else { throw DeviceSetupError.invalidState }
            guard loaded.setupComplete != true || loaded.registration != nil,
                  loaded.cloudModel == nil || loaded.cloudKey != nil else { throw DeviceSetupError.invalidState }
        } else { loaded = DeviceSetupState() }
        state = loaded
    }

    public func snapshot() -> DeviceSetupState { state }

    public func finishSetup(model: String?) async throws {
        guard !busy else { throw DeviceSetupError.busy }
        guard state.registration != nil else { throw DeviceSetupError.registrationRequired }
        busy = true; defer { busy = false }
        if let model {
            guard !model.isEmpty, model.utf8.count <= 200, !model.contains("\n") else { throw DeviceSetupError.invalidState }
            _ = try await provisionCloudLocked()
        }
        var next = state
        next.cloudModel = model; next.setupComplete = true
        try save(next)
    }

    public func register(email: String, appVersion: String) async throws {
        guard !busy else { throw DeviceSetupError.busy }
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count <= 200,
              normalized.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil else { throw DeviceSetupError.invalidEmail }
        busy = true; defer { busy = false }
        let reply = try await post("v1/license/claim", body: .object([
            "email": .string(normalized), "appVersion": .string(String(appVersion.prefix(40))), "contact": .bool(true)
        ]))
        guard reply.1 == 200, let license = reply.0["license"]?.stringValue else { throw DeviceSetupError.service(reply.1) }
        try NativeRegistration.verify(license, email: normalized, publicKey: signingKey)
        var next = state; next.email = normalized; next.registration = license
        try save(next)
    }

    public func provisionCloud() async throws -> String {
        guard !busy else { throw DeviceSetupError.busy }
        guard state.registration != nil else { throw DeviceSetupError.registrationRequired }
        busy = true; defer { busy = false }
        return try await provisionCloudLocked()
    }

    /// Caller keeps `busy` for the entire operation, including saving the
    /// selected model after minting. Actor reentrancy cannot interleave setup.
    private func provisionCloudLocked() async throws -> String {
        if let key = state.cloudKey { return key }
        if pendingCloudKey == nil {
            // Persist the identity before a request can leave this device.
            // A lost response keeps this same identity on the next attempt.
            try save(state)
            let reply = try await post("v1/keys", body: .object(["installId": .string(state.installID)]))
            if reply.1 == 409 { throw DeviceSetupError.recoveryRequired }
            guard reply.1 == 200, let key = reply.0["apiKey"]?.stringValue, !key.isEmpty else { throw DeviceSetupError.service(reply.1) }
            pendingCloudKey = key
        }
        var next = state; next.cloudKey = pendingCloudKey
        try save(next)
        pendingCloudKey = nil
        return state.cloudKey!
    }

    private func save(_ next: DeviceSetupState) throws {
        try vault.write(JSONEncoder().encode(next))
        state = next
    }
    private func post(_ path: String, body: JSONValue) async throws -> (JSONValue, Int) {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, status) = try await transport(request)
        guard data.count <= 65_536 else { throw DeviceSetupError.service(status) }
        return ((try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null, status)
    }
    public static func send(_ request: URLRequest) async throws -> (Data, Int) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: SetupRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw DeviceSetupError.service(status) }
            data.append(byte)
        }
        return (data, status)
    }
}

private final class SetupRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // A setup POST must never forward registration data to a redirect
        // target. Endpoints can be updated explicitly in a reviewed release.
        completionHandler(nil)
    }
}
