import XCTest
import CryptoKit
@testable import AnjadheCore

final class DeviceSetupTests: XCTestCase {
    private actor Gate {
        private var resume: CheckedContinuation<Void, Never>?
        private var entered = false
        func suspend() async { entered = true; await withCheckedContinuation { resume = $0 } }
        func hasEntered() -> Bool { entered }
        func release() { resume?.resume(); resume = nil }
    }
    private final class Vault: DeviceSetupVault {
        var data: Data?
        var failWrites = false
        func read() throws -> Data? { data }
        func write(_ data: Data) throws {
            if failWrites { throw DeviceSetupError.invalidState }
            self.data = data
        }
    }
    private let email = "test@example.invalid"
    private var signingKey: Curve25519.Signing.PrivateKey { try! .init(rawRepresentation: Data(repeating: 9, count: 32)) }
    private var publicKey: String { signingKey.publicKey.rawRepresentation.base64EncodedString() }
    private func license(email: String = "test@example.invalid") throws -> String {
        let subject = SHA256.hash(data: Data(email.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
        let body: JSONValue = .object(["v": .number(1), "id": .string("0123456789abcdef"), "class": .string("free"),
            "sub": .string(String(subject)), "issuedAt": .string("2026-10-09"), "updatesUntil": .null])
        let data = try JSONEncoder().encode(body)
        func url64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        return "ANJ1.\(url64(data)).\(url64(try signingKey.signature(for: data)))"
    }
    private func reply(_ object: [String: JSONValue]) throws -> Data { try JSONEncoder().encode(JSONValue.object(object)) }

    func testRegistrationVerifiesSignatureSubjectAndPersistsBeforeSuccess() async throws {
        let vault = Vault(), signed = try license()
        var requests: [URLRequest] = []
        let service = try DeviceSetupService(vault: vault, publicKey: publicKey) { request in
            requests.append(request)
            return (try self.reply(["license": .string(signed)]), 200)
        }
        XCTAssertNil(vault.data, "constructing setup cannot register or provision anything")
        try await service.register(email: " TEST@example.invalid ", appVersion: "test")
        let state = await service.snapshot()
        XCTAssertEqual(state.email, email); XCTAssertEqual(state.registration, signed)
        XCTAssertNil(state.cloudKey, "registration is not an inference credential")
        XCTAssertEqual(requests.first?.url?.path, "/v1/license/claim")
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(requests.first?.httpBody))
        XCTAssertEqual(body["contact"], .bool(true)); XCTAssertEqual(body["email"], .string(email))
        let reopened = try DeviceSetupService(vault: vault, publicKey: publicKey)
        let saved = await reopened.snapshot()
        XCTAssertEqual(saved, state)
        XCTAssertThrowsError(try NativeRegistration.verify(signed, email: "other@example.invalid", publicKey: publicKey))
        XCTAssertThrowsError(try NativeRegistration.verify(signed, email: email))
    }

    func testFailedRegistrationWriteDoesNotPublishStateOrProvision() async throws {
        let vault = Vault(), signed = try license()
        vault.failWrites = true
        var count = 0
        let service = try DeviceSetupService(vault: vault, publicKey: publicKey) { _ in
            count += 1; return (try self.reply(["license": .string(signed)]), 200)
        }
        do { try await service.register(email: email, appVersion: "test"); XCTFail("must fail") } catch {}
        let state = await service.snapshot()
        XCTAssertNil(state.registration)
        do { _ = try await service.provisionCloud(); XCTFail("must require registration") }
        catch { XCTAssertEqual(error as? DeviceSetupError, .registrationRequired) }
        XCTAssertEqual(count, 1)
    }

    func testCloudMintUsesDurableDeviceIdentityAndRetriesOnlyPersistence() async throws {
        let vault = Vault(), signed = try license()
        var mintCount = 0
        let service = try DeviceSetupService(vault: vault, publicKey: publicKey) { request in
            if request.url?.path == "/v1/license/claim" { return (try self.reply(["license": .string(signed)]), 200) }
            mintCount += 1
            let state = try JSONDecoder().decode(DeviceSetupState.self, from: XCTUnwrap(vault.data))
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
            XCTAssertEqual(body, .object(["installId": .string(state.installID)]))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            vault.failWrites = true
            return (try self.reply(["apiKey": .string("fixture-device-key")]), 200)
        }
        try await service.register(email: email, appVersion: "test")
        do { _ = try await service.provisionCloud(); XCTFail("must report secure-write failure") } catch {}
        let beforeRetry = await service.snapshot()
        XCTAssertNil(beforeRetry.cloudKey)
        vault.failWrites = false
        let key = try await service.provisionCloud()
        XCTAssertEqual(key, "fixture-device-key"); XCTAssertEqual(mintCount, 1)
        let reused = try await service.provisionCloud()
        XCTAssertEqual(reused, key); XCTAssertEqual(mintCount, 1)
        let reopened = try DeviceSetupService(vault: vault, publicKey: publicKey)
        let state = await reopened.snapshot()
        XCTAssertEqual(state.cloudKey, key); XCTAssertEqual(state.installID, beforeRetry.installID)
    }

    func testFinishingSetupRejectsConcurrentChangesWhileCloudMintIsSuspended() async throws {
        let vault = Vault(), signed = try license(), gate = Gate()
        let service = try DeviceSetupService(vault: vault, publicKey: publicKey) { request in
            if request.url?.path == "/v1/license/claim" { return (try self.reply(["license": .string(signed)]), 200) }
            await gate.suspend()
            return (try self.reply(["apiKey": .string("fixture-key")]), 200)
        }
        try await service.register(email: email, appVersion: "test")
        let finishing = Task { try await service.finishSetup(model: "anjadhe-cloud") }
        while !(await gate.hasEntered()) { await Task.yield() }
        do { try await service.finishSetup(model: nil); XCTFail("must reject concurrent setup") }
        catch { XCTAssertEqual(error as? DeviceSetupError, .busy) }
        do { _ = try await service.provisionCloud(); XCTFail("must reject second mint") }
        catch { XCTAssertEqual(error as? DeviceSetupError, .busy) }
        do { try await service.register(email: "other@example.invalid", appVersion: "test"); XCTFail("must reject identity change") }
        catch { XCTAssertEqual(error as? DeviceSetupError, .busy) }
        await gate.release(); try await finishing.value
        let saved = await service.snapshot()
        XCTAssertEqual(saved.cloudModel, "anjadhe-cloud")
        XCTAssertEqual(saved.setupComplete, true); XCTAssertEqual(saved.email, email)
    }

    func testLostMintResponseDoesNotRotateIdentityOrGrantAnotherAllowance() async throws {
        let vault = Vault(), signed = try license()
        var mintCount = 0
        let service = try DeviceSetupService(vault: vault, publicKey: publicKey) { request in
            if request.url?.path == "/v1/license/claim" { return (try self.reply(["license": .string(signed)]), 200) }
            mintCount += 1
            if mintCount == 1 { throw URLError(.timedOut) }
            return (Data(), 409)
        }
        try await service.register(email: email, appVersion: "test")
        let original = await service.snapshot()
        do { _ = try await service.provisionCloud(); XCTFail("must fail") } catch {}
        do { _ = try await service.provisionCloud(); XCTFail("must need recovery") }
        catch { XCTAssertEqual(error as? DeviceSetupError, .recoveryRequired) }
        let after = await service.snapshot()
        XCTAssertEqual(after.installID, original.installID); XCTAssertNil(after.cloudKey)
        XCTAssertEqual(mintCount, 2)
    }

    func testUnreadableVaultOrForgedReceiptCannotBecomeFreshSetup() throws {
        let vault = Vault()
        vault.data = Data("broken".utf8)
        XCTAssertThrowsError(try DeviceSetupService(vault: vault))
        var state = DeviceSetupState(); state.email = email; state.registration = try license()
        vault.data = try JSONEncoder().encode(state)
        XCTAssertThrowsError(try DeviceSetupService(vault: vault))
        XCTAssertThrowsError(try DeviceSetupService(vault: Vault(), baseURL: URL(string: "http://example.invalid")!))
    }
}
