import XCTest
import Foundation
import AnjadheCore
@testable import AnjadheUI

private final class CloudFixtureProtocol: URLProtocol {
    static var inspect: ((URLRequest) -> Void)?
    static var status = 200
    static var body = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.inspect?(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class CloudChatTransportTests: XCTestCase {
    override func tearDown() { CloudFixtureProtocol.inspect = nil }
    private func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudFixtureProtocol.self]
        return config
    }
    func testOwnCredentialEndpointAndResponseShapeWithoutLiveNetwork() async throws {
        CloudFixtureProtocol.status = 200
        CloudFixtureProtocol.body = Data(#"{"choices":[{"message":{"role":"assistant","content":"Hello"}}]}"#.utf8)
        let inspected = expectation(description: "request")
        CloudFixtureProtocol.inspect = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://api.nenva.co/v1/llm/chat/completions")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Nenva-Work"), "chat")
            inspected.fulfill()
        }
        let value = try await CloudClient.complete(.object(["requestId": .string("local-run-only"), "model": .string("nenva-cloud"), "messages": .array([])]),
                                                   credential: .init(apiKey: "fixture-only", baseURL: CloudClient.defaultBase), configuration: configuration())
        XCTAssertEqual(value["content"], .string("Hello"))
        await fulfillment(of: [inspected], timeout: 2)
    }
    func testRefusalDoesNotRetryAndCannotChooseAnotherEndpoint() async throws {
        var requests = 0
        CloudFixtureProtocol.inspect = { _ in requests += 1 }
        CloudFixtureProtocol.status = 429
        CloudFixtureProtocol.body = Data(#"{"error":"limit"}"#.utf8)
        do {
            _ = try await CloudClient.complete(.object([:]), credential: .init(apiKey: "fixture-only", baseURL: CloudClient.defaultBase), configuration: configuration())
            XCTFail("A refusal must surface")
        } catch { XCTAssertTrue(error is CloudClient.Failure) }
        XCTAssertEqual(requests, 1)
        do {
            _ = try await CloudClient.complete(.object([:]), credential: .init(apiKey: "fixture-only", baseURL: "https://other.invalid"), configuration: configuration())
            XCTFail("Credentials must stay on their provisioned endpoint")
        } catch { XCTAssertTrue(error is CloudClient.Failure) }
        XCTAssertEqual(requests, 1)
    }
}
