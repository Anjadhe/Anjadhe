import Foundation
import CryptoKit

/// Durable compatibility storage for the existing KVStore/UI and v1 sync.
/// T1 Never modify the legacy file or discard an unrecognized/damaged store.
/// T2 Import every key and its migration marker in one transaction, once.
/// T3 Commit an entry + recovery history before cache publication/callbacks.
/// T4 Failure is an error, never an empty install or a successful save.
/// T5 A legacy writer changing the old file after cutover requires recovery;
///    silently choosing either copy would lose edits.
/// This is not the v2 merge protocol, credentials migration or sync outbox.
public final class TransactionalStore {
    public enum Failure: Error, LocalizedError {
        case legacyChanged, backupMismatch, notReady, resetDisabled
        public var errorDescription: String? {
            switch self {
            case .legacyChanged: return "The previous store changed after migration. Both copies have been kept for recovery."
            case .backupMismatch: return "The migration backup differs from the previous store. Both files have been kept."
            case .notReady: return "Your data is still loading. Try again when it has finished."
            case .resetDisabled: return "Replacing this phone’s data from another device is no longer supported."
            }
        }
    }

    public let databaseURL: URL
    public let legacyURL: URL
    public let backupURL: URL
    let records: LocalRecordStore

    public init(directory: URL? = nil) throws {
        let base = try directory ?? FileManager.default.url(for: .applicationSupportDirectory,
                            in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = base.appendingPathComponent("Anjadhe", isDirectory: true)
        legacyURL = folder.appendingPathComponent("anjadhe-store.json")
        backupURL = folder.appendingPathComponent("anjadhe-store.pre-sqlite.json")
        databaseURL = folder.appendingPathComponent("anjadhe.sqlite")
        // Read strictly before opening/creating a database. Missing is a fresh
        // install; unreadable or malformed is never treated as empty.
        let data: Data?
        do { data = try Data(contentsOf: legacyURL) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { data = nil }
        let fingerprint = data.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "absent"
        records = try LocalRecordStore(databaseURL: databaseURL)
        if let previous = try records.legacyFingerprint() {
            guard previous == fingerprint else { throw Failure.legacyChanged }
            return
        }
        let rows = try data.map { try JSONDecoder().decode([String: RemoteEntry].self, from: $0) } ?? [:]
        if let data {
            if FileManager.default.fileExists(atPath: backupURL.path) {
                guard try Data(contentsOf: backupURL) == data else { throw Failure.backupMismatch }
            } else {
                // Publish a complete backup without ever replacing an
                // existing recovery artifact, including another opener's.
                let staged = folder.appendingPathComponent("migration-\(UUID().uuidString).json")
                defer { try? FileManager.default.removeItem(at: staged) }
                try data.write(to: staged, options: .atomic)
                do { try FileManager.default.linkItem(at: staged, to: backupURL) }
                catch {
                    guard try Data(contentsOf: backupURL) == data else { throw Failure.backupMismatch }
                }
            }
        }
        try records.importLegacy(rows, fingerprint: fingerprint)
        guard try records.legacySnapshot() == rows else { throw LocalRecordStore.StoreError.corruptData }
    }

    public func snapshot() throws -> [String: RemoteEntry] { try records.legacySnapshot() }

    /// The caller retains this backer and hydrates only after open succeeds.
    public func attach(to kv: KVStore, rows: [String: RemoteEntry]) {
        kv.hydrate(rows)
        kv.commit = { [self] key, entry, before, origin in
            try records.commitLegacy(key, entry: entry, expected: before, origin: origin)
        }
        kv.authorizePurge = { throw Failure.resetDisabled }
    }
}
