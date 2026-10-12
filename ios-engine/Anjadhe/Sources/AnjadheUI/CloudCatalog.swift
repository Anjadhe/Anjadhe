import Foundation
import AnjadheCore

struct DeviceCloudCredential { let apiKey: String; let baseURL: String }

enum CloudClient {
    static let defaultBase = "https://api.nenva.co"

    /// The catalog — keyless, so Settings can list models before a key exists.
    static func models(baseURL: String = defaultBase) async -> [(id: String, label: String)] {
        guard let url = URL(string: baseURL + "/v1/llm/models") else { return [] }
        var req = URLRequest(url: url); req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONValue.parse(String(decoding: data, as: UTF8.self)) else { return [] }
        // Named by tier (ModelTiers): no row carries an upstream model's name.
        var seen = Set<String>()
        return (json["models"]?.arrayValue ?? []).compactMap { m in
            guard let raw = m["id"]?.stringValue?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
            let id = ModelTiers.publicId(raw)
            guard seen.insert(id).inserted else { return nil }
            return (id, ModelTiers.cloudName(model: id, label: m["label"]?.stringValue))
        }
    }

}

private final class NoCloudRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

extension CloudClient {
    enum Failure: Error { case invalidEndpoint, invalidResponse, responseTooLarge, refused }
    /// One foreground request, no fallback or retry. The turn journal owns
    /// resumption. Credentials stay in the native transport and out of logs.
    static func complete(_ input: JSONValue, credential: DeviceCloudCredential, configuration: URLSessionConfiguration = .ephemeral) async throws -> JSONValue {
        guard credential.baseURL == defaultBase, !credential.apiKey.isEmpty,
              let url = URL(string: credential.baseURL + "/v1/llm/chat/completions") else { throw Failure.invalidEndpoint }
        var payload = input.objectValue ?? [:]; payload.removeValue(forKey: "requestId")
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 90
        request.httpBody = try JSONEncoder().encode(JSONValue.object(payload))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + credential.apiKey, forHTTPHeaderField: "Authorization")
        request.setValue("chat", forHTTPHeaderField: "X-Nenva-Work")
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: NoCloudRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw Failure.refused }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2 * 1024 * 1024 else { throw Failure.responseTooLarge }
            data.append(byte)
        }
        let body = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let message = body["choices"]?.arrayValue?.first?["message"] else { throw Failure.invalidResponse }
        return message
    }
}
