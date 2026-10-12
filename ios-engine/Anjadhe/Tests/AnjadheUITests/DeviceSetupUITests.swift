import XCTest
import CryptoKit
import AnjadheCore
@testable import AnjadheUI

final class DeviceSetupUITests: XCTestCase {
    private final class Vault: DeviceSetupVault {
        var data: Data?
        func read() throws -> Data? { data }
        func write(_ data: Data) throws { self.data = data }
    }
    @MainActor
    private func access() async throws -> DeviceAccessModel {
        let key = Curve25519.Signing.PrivateKey()
        let email = "fixture@example.invalid"
        let subject = SHA256.hash(data: Data(email.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
        let payload: JSONValue = .object(["v": .number(1), "id": .string("0123456789abcdef"), "class": .string("free"),
            "sub": .string(String(subject)), "issuedAt": .string("2026-10-09"), "updatesUntil": .null])
        let data = try JSONEncoder().encode(payload)
        func url64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        var state = DeviceSetupState()
        state.email = email
        state.registration = "ANJ1.\(url64(data)).\(url64(try key.signature(for: data)))"
        state.cloudKey = "fixture-key"
        state.setupComplete = true; state.cloudModel = "nenva-cloud-lite"
        let vault = Vault(); vault.data = try JSONEncoder().encode(state)
        let model = DeviceAccessModel {
            try DeviceSetupService(vault: vault, publicKey: key.publicKey.rawRepresentation.base64EncodedString()) { _ in
                XCTFail("a saved device setup must not provision again")
                throw URLError(.notConnectedToInternet)
            }
        }
        await model.open()
        return model
    }

    @MainActor
    func testIndependentRouteUsesOwnChoiceAndKeyWithoutMacOrImplicitFallback() async throws {
        let access = try await access()
        XCTAssertTrue(access.configured)
        XCTAssertEqual(access.choice?.model, "nenva-cloud-lite")
        XCTAssertEqual(access.credentials?.apiKey, "fixture-key")
        await access.choose(model: nil)
        XCTAssertNil(access.choice)
        XCTAssertEqual(access.state?.cloudKey, "fixture-key")
    }
}
