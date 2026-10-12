import Foundation
import JavaScriptCore

/// Executes the bundled desktop rules. Only JSON values cross this actor;
/// neither JSContext nor JSValue escapes it. There is no WebView, network,
/// storage bridge, downloaded code, tool execution or UI-thread dependency.
public actor SharedCore {
    public enum Operation: String, Sendable {
        case senderSyncPlan = "senders.syncPlan"
        case senderSyncProject = "senders.syncProject"
        case conversationSyncPlan = "conversations.plan"
        case conversationSyncProject = "conversations.project"
        case claimWorthLooking = "claims.worthLooking"
        case claimPrompt = "claims.prompt"
        case claimVet = "claims.vet"
        case claimParse = "claims.parse"
        case claimNudge = "claims.nudge"
        case chatTransition = "chat.transition"
        case captureInspect = "capture.inspect"
        case prepareRecords = "records.prepare"
        case snapshot = "threads.snapshot"
        case timeline = "threads.timeline"
        case commitmentTimeline = "threads.commitmentTimeline"
        case commitmentWhen = "threads.commitmentWhen"
        case ledgerWords = "threads.ledgerWords"
        case senderTimeline = "threads.senderTimeline"
        case senderInfo = "threads.senderInfo"
        case goalRow = "threads.goalRow"
        case pinnedFirst = "threads.pinnedFirst"
        case events = "threads.events"
        case statusOf = "threads.statusOf"
        case lastAt = "threads.lastAt"
        case lastEventAt = "threads.lastEventAt"
        case preview = "threads.preview"
        case timeLabel = "threads.timeLabel"
        case stampLabel = "threads.stampLabel"
        case order = "threads.order"
        case workState = "threads.workState"
        case readDoneText = "threads.readDoneText"
        case copy = "threads.copy"
        case today = "calendar.today"
        case day = "calendar.day"
        case time = "calendar.time"
        case repeats = "calendar.repeats"
        case occursOn = "calendar.occursOn"
        case madeOn = "calendar.madeOn"
        case nextOn = "calendar.nextOn"
        case timeOn = "calendar.timeOn"
        case isDone = "calendar.isDone"
    }
    public enum Failure: Error, Equatable {
        case unavailable, invalidArguments, payloadTooLarge, executionFailed, invalidResult
    }

    public static let maximumPayloadBytes = 8 * 1024 * 1024
    static var resourceURL: URL? { Bundle.module.url(forResource: "shared-core", withExtension: "js") }
    private var context: JSContext?
    private var entry: JSValue?

    public init() {}

    /// Load only our signed-app resource. Input strings are passed as values,
    /// never interpolated into source. JS exceptions are not logged or exposed:
    /// an exception can contain a person's record text.
    public func call(_ operation: Operation, arguments: [JSONValue] = []) throws -> JSONValue {
        try Task.checkCancellation()
        guard arguments.count <= 8 else { throw Failure.invalidArguments }
        let input: Data
        do { input = try JSONEncoder().encode(arguments) }
        catch { throw Failure.invalidArguments }
        guard input.count <= Self.maximumPayloadBytes else { throw Failure.payloadTooLarge }
        try load()
        guard let context, let entry else { throw Failure.unavailable }
        context.exception = nil
        let output = entry.call(withArguments: [operation.rawValue, String(decoding: input, as: UTF8.self)])
        guard context.exception == nil else {
            context.exception = nil
            throw Failure.executionFailed
        }
        guard let output, output.isString, let text = output.toString() else { throw Failure.invalidResult }
        let data = Data(text.utf8)
        guard data.count <= Self.maximumPayloadBytes else { throw Failure.payloadTooLarge }
        try Task.checkCancellation()
        do { return try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw Failure.invalidResult }
    }

    private func load() throws {
        if context != nil { return }
        guard let url = Self.resourceURL,
              let source = try? String(contentsOf: url, encoding: .utf8),
              let vm = JSVirtualMachine(), let candidate = JSContext(virtualMachine: vm) else { throw Failure.unavailable }
        candidate.name = "nenva shared core"
        // Default exception handling preserves the exception for our check.
        candidate.evaluateScript(source, withSourceURL: url)
        guard candidate.exception == nil,
              let function = candidate.evaluateScript("NenvaCore.call"), !function.isUndefined,
              candidate.exception == nil else { throw Failure.unavailable }
        context = candidate
        entry = function
    }
}
