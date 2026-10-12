import Foundation

/// HTTPS adapter for the experimental Connect mailbox. Construction does not
/// enroll a device or initiate sync. Pairing must supply a dedicated credential;
/// inference credentials and registration receipts are deliberately rejected.
public actor SyncHTTPTransport: MergeMailboxTransport {
    public typealias Transport = (URLRequest) async throws -> (Data, Int)
    public enum Failure: Error, Equatable { case invalidConfiguration, invalidResponse, service(Int, String) }
    private static let responseLimit = 13 * 1024 * 1024
    private let baseURL: URL
    private let credential: String
    private let transport: Transport

    public init(baseURL: URL = URL(string: "https://api.nenva.co")!, credential: String,
                transport: @escaping Transport = SyncHTTPTransport.send) throws {
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, ["", "/"].contains(baseURL.path),
              credential.utf8.count == 70,
              credential.range(of: "^nsync_[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.invalidConfiguration }
        self.baseURL = baseURL; self.credential = credential; self.transport = transport
    }

    public func upload(datasetID: String, epoch: Int, envelopes: [JSONValue]) async throws -> Int {
        guard !envelopes.isEmpty, envelopes.count <= 256 else { throw Failure.invalidResponse }
        let result = try await request(datasetID, epoch: epoch, resource: "operations", body: .object(["envelopes": .array(envelopes)]))
        guard let sequence = result["storedThrough"]?.numberValue, sequence > 0, sequence <= 9_007_199_254_740_991,
              sequence.rounded() == sequence else { throw Failure.invalidResponse }
        return Int(sequence)
    }
    public func download(datasetID: String, epoch: Int, after cursor: String) async throws -> MergeMailboxPage {
        guard cursor.utf8.count <= 2048, !cursor.contains("\0") else { throw Failure.invalidResponse }
        let result = try await request(datasetID, epoch: epoch, resource: "operations", cursor: cursor)
        guard let envelopes = result["envelopes"]?.arrayValue, envelopes.count <= 256,
              let next = result["nextCursor"]?.stringValue, next.utf8.count <= 2048, !next.contains("\0"),
              let more = result["hasMore"]?.boolValue else { throw Failure.invalidResponse }
        return MergeMailboxPage(envelopes: envelopes, nextCursor: next, hasMore: more)
    }
    public func acknowledgeApplied(datasetID: String, epoch: Int, frontier: [String: Int]) async throws {
        guard frontier.count <= 32, frontier.allSatisfy({ RecordMerge.token($0.key) && $0.value >= 0 && $0.value <= 9_007_199_254_740_991 }) else { throw Failure.invalidResponse }
        let result = try await request(datasetID, epoch: epoch, resource: "receipts",
            body: .object(["frontier": .object(frontier.mapValues { .number(Double($0)) })]))
        guard result["accepted"]?.boolValue == true else { throw Failure.invalidResponse }
    }

    private func request(_ dataset: String, epoch: Int, resource: String, cursor: String? = nil, body: JSONValue? = nil) async throws -> JSONValue {
        guard RecordMerge.token(dataset), epoch > 0, epoch <= 9_007_199_254_740_991 else { throw Failure.invalidConfiguration }
        var components = URLComponents(url: baseURL.appendingPathComponent("v2/sync/datasets/\(dataset)/\(resource)"), resolvingAgainstBaseURL: false)!
        if let cursor { components.queryItems = [URLQueryItem(name: "after", value: cursor)] }
        guard let url = components.url else { throw Failure.invalidConfiguration }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"; request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        request.setValue(String(epoch), forHTTPHeaderField: "X-Sync-Epoch")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(body)
            guard data.count <= Self.responseLimit else { throw Failure.invalidResponse }
            request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, status) = try await transport(request)
        guard data.count <= Self.responseLimit else { throw Failure.invalidResponse }
        let result = try? JSONDecoder().decode(JSONValue.self, from: data)
        guard status == 200 else {
            // Preserve only protocol error codes, never an arbitrary server
            // body that might echo credentials or record content.
            let known: Set<String> = ["unauthorized", "epoch_changed", "identity_reused", "sequence_gap", "invalid_envelope",
                "invalid_cursor", "frontier_ahead", "storage_quota", "rate_limited", "storage_unavailable", "batch_too_large"]
            let code = result?["error"]?.stringValue ?? ""
            throw Failure.service(status, known.contains(code) ? code : "request_failed")
        }
        guard let result, result.objectValue != nil else { throw Failure.invalidResponse }
        return result
    }

    public static func send(_ request: URLRequest) async throws -> (Data, Int) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: SyncRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        var data = Data()
        for try await byte in bytes {
            guard data.count < responseLimit else { throw Failure.invalidResponse }
            data.append(byte)
        }
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

private final class SyncRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward a dataset credential to a redirect.
    }
}
