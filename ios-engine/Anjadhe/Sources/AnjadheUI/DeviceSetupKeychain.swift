import Foundation
import Security
import AnjadheCore

/// A device-only vault separate from the legacy borrowed-Mac credential.
/// Unpairing must never remove this installation's own registration/key.
struct DeviceSetupKeychain: DeviceSetupVault {
    private let service = "com.anjadhe.phone-ai"
    private let account = "standalone-device-v1"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }
    struct Failure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Couldn’t access this iPhone’s secure setup information (\(status)). Try again when the device is unlocked." }
    }
    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: AnyObject?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw Failure(status: status) }
        return data
    }
    func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var request = query
            attributes.forEach { request[$0.key] = $0.value }
            status = SecItemAdd(request as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            }
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }
}
