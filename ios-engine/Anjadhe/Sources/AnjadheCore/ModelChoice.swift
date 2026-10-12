import Foundation

public enum ModelTiers {
    public static let defaultCloudModel = "nenva-cloud-lite"
    public static let cloudLabel = "nenva cloud"
    public static let localLabel = "nenva local"
    static let tiers: [String: String] = [
        "nenva-cloud-lite": "nenva cloud lite",
        "nenva-cloud-pro": "nenva cloud pro",
    ]
    /// A cloud id, trimmed.
    public static func publicId(_ id: String) -> String {
        id.trimmingCharacters(in: .whitespaces)
    }

    /// A hosted model's name: its tier when known, else an operator label
    /// that already speaks as nenva, else "nenva cloud" — never a model's own name.
    public static func cloudName(model: String, label: String?) -> String {
        if let tier = tiers[publicId(model)] { return tier }
        let l = (label ?? "").trimmingCharacters(in: .whitespaces)
        if l.lowercased().hasPrefix("nenva") {
            if l.lowercased().hasPrefix("nenva cloud") { return "nenva cloud" + l.dropFirst("nenva cloud".count) }
            return l
        }
        return cloudLabel
    }

    /// A model name stored with no entry (an answer's signature), relabelled.
    public static func displayForStored(_ name: String) -> String {
        let s = name.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return s }
        let low = s.lowercased()
        if low.hasPrefix("anjadhe-cloud") || low.hasPrefix("nenva-cloud") { return cloudName(model: s, label: s) }
        if low.hasPrefix("nenva cloud") { return cloudName(model: "", label: s) }
        if low == localLabel || low.hasSuffix(".gguf") || s.contains("/") || low.hasPrefix("anjadhe-") { return localLabel }
        return s
    }
}

/// The model chosen for this installation, stored with its own credential.
public struct PhoneModelChoice: Equatable {
    public let engine: String
    public let model: String
    public let label: String

    public init(engine: String, model: String, label: String) {
        self.engine = engine; self.model = model; self.label = label
    }

    public var displayName: String { ModelTiers.cloudName(model: model, label: label) }
}
