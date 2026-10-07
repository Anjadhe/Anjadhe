import Foundation

/// Where launch time actually goes, printed to the device console.
///
/// Added 2026-09-21 because "it takes forever to load" needs a number
/// before it needs a fix. Each mark is milliseconds since the process
/// started, so the gaps between them are the answer. Debug builds only —
/// a release build compiles the calls away to nothing.
public enum LaunchTrace {
    private static let start = Date()
    private static var marks: [(String, Double)] = []
    private static let lock = NSLock()

    public static func mark(_ label: String) {
        #if DEBUG
        let ms = Date().timeIntervalSince(start) * 1000
        lock.lock()
        let previous = marks.last?.1 ?? 0
        marks.append((label, ms))
        lock.unlock()
        print(String(format: "[launch] %-28@ %7.0f ms  (+%.0f)", label as NSString, ms, ms - previous))
        #endif
    }
}
