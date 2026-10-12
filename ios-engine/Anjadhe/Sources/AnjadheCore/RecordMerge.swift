import Foundation

/// Pure v2 reference reducer; laws R1–R5 and fixture contract are shared with
/// js/sync/record-merge.js. Never executes actions, reads a clock or does I/O.
/// Unknown record schemas remain pending and cannot advance the frontier.
public enum RecordMerge {
    public enum Failure: Error, Equatable { case invalidOperation, reusedIdentity }
    struct Operation {
        let raw: JSONValue
        let writer: String
        let sequence: Int
        let dependencies: [String: Int]
        let type: String
        let recordID: String
        let schema: Int
        let mutation: [String: JSONValue]
        var dot: String { "\(writer):\(sequence)" }
        var key: String { "\(type)/\(recordID)" }
        var kind: String { mutation["kind"]?.stringValue ?? "" }
        var supported: Bool { schema == 1 && ["note", "task"].contains(type) }
        func observes(_ other: Operation) -> Bool { (dependencies[other.writer] ?? 0) >= other.sequence }
    }
    private struct Write { let operation: Operation; let value: JSONValue }
    private static let maximumInteger = 9_007_199_254_740_991.0
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    }
    static func token(_ value: String) -> Bool { matches(value, "^[a-z0-9-]{1,80}$") }
    private static func recordID(_ value: String) -> Bool { matches(value, "^[A-Za-z0-9._:-]{1,160}$") }
    private static func calendarDate(_ text: String) -> Bool {
        guard matches(text, "^[0-9]{4}-[0-9]{2}-[0-9]{2}$") else { return false }
        let values = text.split(separator: "-").compactMap { Int($0) }
        guard values.count == 3 else { return false }
        let year = values[0], month = values[1], day = values[2]
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return year > 0 && (1...12).contains(month) && day >= 1 && day <= days[month - 1]
    }
    private static func integer(_ value: JSONValue?) -> Int? {
        guard let number = value?.numberValue, number.isFinite, number >= 0,
              number <= maximumInteger, number.rounded() == number else { return nil }
        return Int(number)
    }
    private static func ordered(_ a: Operation, _ b: Operation) -> Bool {
        a.writer == b.writer ? a.sequence < b.sequence : a.writer < b.writer
    }
    /// Byte comparison keeps canonically equivalent but differently encoded
    /// user text distinct, like JavaScript, rather than Swift String equality.
    private static func bytes(_ value: JSONValue) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(canonicalNumbers(value))
    }
    private static func canonicalNumbers(_ value: JSONValue) -> JSONValue {
        switch value {
        case .number(let number) where number == 0: return .number(0)
        case .object(let object): return .object(object.mapValues(canonicalNumbers))
        case .array(let values): return .array(values.map(canonicalNumbers))
        default: return value
        }
    }
    static func equivalent(_ a: JSONValue, _ b: JSONValue) throws -> Bool { try bytes(a) == bytes(b) }
    private static func validField(_ type: String, _ key: String, _ value: JSONValue) -> Bool {
        if key == "title" || (type == "note" && key == "content") || (type == "task" && key == "description") { return value.stringValue != nil }
        if type == "note" && key == "pinned" { return value.boolValue != nil }
        guard type == "task", key == "schedule" else { return false }
        if value == .null { return true }
        guard let object = value.objectValue else { return false }
        for (key, value) in object {
            switch key {
            case "startTime", "endTime":
                if value == .null { continue }
                guard let text = value.stringValue, text.isEmpty || matches(text, "^([01][0-9]|2[0-3]):[0-5][0-9]$") else { return false }
            case "scheduledDate":
                if value == .null { continue }
                guard let text = value.stringValue, calendarDate(text) else { return false }
            case "repeat":
                guard let text = value.stringValue, ["none", "daily", "weekdays", "weekly", "monthly", "annually", "custom"].contains(text) else { return false }
            case "dayOfWeek", "notifyBefore":
                if value == .null { continue }
                guard let number = integer(value), key != "dayOfWeek" || number <= 6 else { return false }
            case "repeatDays", "reminderDaysBefore":
                guard let values = value.arrayValue, values.allSatisfy({ integer($0).map { key != "repeatDays" || $0 <= 6 } == true }) else { return false }
            default: return false
            }
        }
        if let start = object["startTime"]?.stringValue, !start.isEmpty,
           let end = object["endTime"]?.stringValue, !end.isEmpty, end < start { return false }
        return true
    }

    static func parse(_ raw: JSONValue, datasetID: String, epoch: Int) throws -> Operation {
        let normalized = canonicalNumbers(raw)
        guard let value = normalized.objectValue, integer(value["protocolVersion"]) == 2,
              let schema = integer(value["schemaVersion"]), schema >= 1,
              value["datasetId"]?.stringValue == datasetID, integer(value["membershipEpoch"]) == epoch,
              let writer = value["deviceId"]?.stringValue, token(writer),
              let sequence = integer(value["sequence"]), sequence >= 1,
              let deps = value["dependencies"]?.objectValue,
              let type = value["recordType"]?.stringValue, token(type),
              let id = value["recordId"]?.stringValue, recordID(id),
              let mutation = value["mutation"]?.objectValue else { throw Failure.invalidOperation }
        let keys: Set<String> = ["protocolVersion", "schemaVersion", "datasetId", "membershipEpoch", "deviceId", "sequence", "dependencies", "recordType", "recordId", "mutation", "modifiedAt"]
        guard Set(value.keys).isSubset(of: keys), value["modifiedAt"] == nil || value["modifiedAt"]?.stringValue != nil else { throw Failure.invalidOperation }
        var dependencies: [String: Int] = [:]
        for (key, value) in deps {
            guard token(key), let count = integer(value) else { throw Failure.invalidOperation }
            dependencies[key] = count
        }
        guard (dependencies[writer] ?? 0) == sequence - 1 else { throw Failure.invalidOperation }
        let op = Operation(raw: normalized, writer: writer, sequence: sequence, dependencies: dependencies,
                           type: type, recordID: id, schema: schema, mutation: mutation)
        guard op.supported else { return op }
        guard ["edit", "delete", "restore"].contains(op.kind), Set(mutation.keys).isSubset(of: ["kind", "fields", "tagAdds", "tagRemoves", "completion"]) else { throw Failure.invalidOperation }
        if let fields = mutation["fields"] {
            guard let fields = fields.objectValue, fields.allSatisfy({ validField(type, $0.key, $0.value) }) else { throw Failure.invalidOperation }
        }
        for key in ["tagAdds", "tagRemoves"] {
            if let value = mutation[key] {
                guard let array = value.arrayValue, array.allSatisfy({ $0.stringValue.map { !$0.isEmpty && $0.utf16.count <= 512 } == true }) else { throw Failure.invalidOperation }
            }
        }
        if let completion = mutation["completion"] {
            guard type == "task", let object = completion.objectValue, object.count == 2,
                  let occurrence = object["occurrence"]?.stringValue, recordID(occurrence), object["done"]?.boolValue != nil else { throw Failure.invalidOperation }
        }
        let changes = (mutation["fields"]?.objectValue?.count ?? 0) + (mutation["tagAdds"]?.arrayValue?.count ?? 0)
            + (mutation["tagRemoves"]?.arrayValue?.count ?? 0) + (mutation["completion"] == nil ? 0 : 1)
        guard !(op.kind == "delete" && changes != 0), !(op.kind == "edit" && changes == 0) else { throw Failure.invalidOperation }
        return op
    }

    public static func reduce(_ operations: [JSONValue], datasetID: String, membershipEpoch: Int = 1) throws -> JSONValue {
        guard token(datasetID), membershipEpoch >= 1, Double(membershipEpoch) <= maximumInteger else { throw Failure.invalidOperation }
        var all: [String: Operation] = [:]
        for raw in operations {
            let operation = try parse(raw, datasetID: datasetID, epoch: membershipEpoch)
            if let existing = all[operation.dot], try bytes(existing.raw) != bytes(raw) { throw Failure.reusedIdentity }
            all[operation.dot] = operation
        }
        var remaining = all.values.sorted(by: ordered), applied: [Operation] = [], frontier: [String: Int] = [:]
        var progress = true
        while progress {
            progress = false
            var index = 0
            while index < remaining.count {
                let op = remaining[index]
                guard op.supported, op.dependencies.allSatisfy({ (frontier[$0.key] ?? 0) >= $0.value }) else { index += 1; continue }
                try validateReady(op, lookup: { all["\($0):\($1)"] }, observedDelete: {
                    applied.contains { $0.key == op.key && $0.kind == "delete" && op.observes($0) }
                })
                applied.append(op); frontier[op.writer] = op.sequence
                remaining.remove(at: index); progress = true
            }
        }
        let groups = Dictionary(grouping: applied, by: \.key)
        let records = try groups.keys.sorted().map { try materialize(groups[$0]!) }
        return .object([
            "frontier": .object(frontier.mapValues { .number(Double($0)) }),
            "applied": .array(applied.sorted(by: ordered).map { .string($0.dot) }),
            "pending": .array(remaining.map { .object(["operation": .string($0.dot), "reason": .string($0.supported ? "dependencies" : "unsupported-schema")]) }),
            "records": .array(records)
        ])
    }

    /// Shared by full replay and the transactional inbox. The caller has
    /// already established a supported operation's complete dependency frontier.
    static func validateReady(_ op: Operation, lookup: (String, Int) throws -> Operation?,
                              observedDelete: () throws -> Bool) throws {
        for (writer, sequence) in op.dependencies where sequence > 0 {
            guard let parent = try lookup(writer, sequence),
                  parent.dependencies.allSatisfy({ (op.dependencies[$0.key] ?? 0) >= $0.value }) else { throw Failure.invalidOperation }
        }
        if op.kind == "restore", try !observedDelete() { throw Failure.invalidOperation }
        for removed in op.mutation["tagRemoves"]?.arrayValue ?? [] {
            guard let text = removed.stringValue else { throw Failure.invalidOperation }
            let parts = text.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 3, token(parts[0]), let sequence = Int(parts[1]), sequence > 0,
                  let index = Int(parts[2]), index >= 0, String(sequence) == parts[1], String(index) == parts[2],
                  let add = try lookup(parts[0], sequence), add.key == op.key, op.observes(add),
                  let tags = add.mutation["tagAdds"]?.arrayValue, index < tags.count else { throw Failure.invalidOperation }
        }
    }

    static func materialize(_ operations: [Operation]) throws -> JSONValue {
        var fields: [String: [Write]] = [:], completions: [String: [Write]] = [:]
        var additions: [String: String] = [:], removed = Set<String>()
        for op in operations {
            for (key, value) in op.mutation["fields"]?.objectValue ?? [:] {
                fields[key, default: []].append(Write(operation: op, value: value))
            }
            if let completion = op.mutation["completion"]?.objectValue, let occurrence = completion["occurrence"]?.stringValue, let done = completion["done"] {
                completions[occurrence, default: []].append(Write(operation: op, value: done))
            }
            for (index, tag) in (op.mutation["tagAdds"]?.arrayValue ?? []).enumerated() {
                additions["\(op.dot):\(index)"] = tag.stringValue!.precomposedStringWithCanonicalMapping
            }
            for id in op.mutation["tagRemoves"]?.arrayValue ?? [] { removed.insert(id.stringValue!) }
        }
        func registers(_ writes: [String: [Write]]) throws -> (JSONValue, JSONValue) {
            var values: [String: JSONValue] = [:], conflicts: [JSONValue] = []
            for key in writes.keys.sorted() {
                let versions = writes[key]!
                var heads: [Write] = []
                for write in versions {
                    if heads.contains(where: { $0.operation.observes(write.operation) }) { continue }
                    heads.removeAll { write.operation.observes($0.operation) }
                    heads.append(write)
                }
                heads.sort { ordered($0.operation, $1.operation) }
                values[key] = .object(["value": heads.last!.value, "versions": .array(heads.map {
                    .object(["operation": .string($0.operation.dot), "value": $0.value])
                })])
                if Set(try heads.map { try bytes($0.value) }).count > 1 { conflicts.append(.string(key)) }
            }
            return (.object(values), .array(conflicts))
        }
        let (fieldValues, fieldConflicts) = try registers(fields)
        let (completionValues, completionConflicts) = try registers(completions)
        let deletes = operations.filter { d in d.kind == "delete" && !operations.contains { r in ["restore", "delete"].contains(r.kind) && r.observes(d) } }
        let deletionConflicts = operations.filter { op in op.kind != "delete" && deletes.contains { d in !d.observes(op) && !op.observes(d) } }.sorted(by: ordered)
        let tags = Set(additions.filter { !removed.contains($0.key) }.map(\.value))
            .sorted { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }
        return .object([
            "type": .string(operations[0].type), "id": .string(operations[0].recordID), "deleted": .bool(!deletes.isEmpty),
            "fields": fieldValues, "completions": completionValues, "tags": .array(tags.map(JSONValue.string)),
            "conflicts": .object(["fields": fieldConflicts, "completions": completionConflicts,
                                   "deletion": .array(deletionConflicts.map { .string($0.dot) })])
        ])
    }
}
