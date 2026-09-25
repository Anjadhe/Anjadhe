import Foundation

/// Debounced record writes, and the one guarantee that none is lost.
///
/// WHY. Every editor on the phone wrote through on each keystroke —
/// `.onChange(of: title) { patchItem(...) }`. One character in a note cost:
/// rebuild the notes array, re-encode the WHOLE blob to JSON, hand WebKit a
/// multi-megabyte JS source string for the sync mirror, invalidate every
/// SwiftUI view observing the store, and queue a full-store disk re-encode.
/// On this developer's library that is roughly 17 ms of encoding per
/// keystroke on a Mac, more on a phone, before any of the rest.
///
/// So writes are debounced — and the moment you debounce a write you owe the
/// user a promise that it still lands. That promise is `flushAll`, called
/// when an editor disappears and when the app leaves the foreground, exactly
/// as the desktop's `SaveStatus` does it (CLAUDE.md, "Auto-save: one
/// indicator, one flush-on-leave").
///
/// Work is keyed, so a pending title does not cancel a pending body; a
/// second change to the SAME field replaces the first, which is the point.
public final class PendingWrites {
    public static let shared = PendingWrites()

    /// Long enough to swallow a burst of typing, short enough that a pause
    /// mid-sentence has already saved. For a plain text field, which has
    /// nothing else coalescing it.
    public static let delay: TimeInterval = 0.4

    /// For a source that ALREADY debounced — the rich editor coalesces
    /// keystrokes in its own page before posting. Debouncing that again
    /// would only widen the window in which a backgrounded app loses the
    /// last characters; this just coalesces the posts themselves.
    public static let shortDelay: TimeInterval = 0.05

    private var work: [String: (item: DispatchWorkItem, run: () -> Void)] = [:]
    private let lock = NSLock()

    private init() {}

    /// Replace any pending write for `key` and run this one after the delay.
    public func schedule(_ key: String, after: TimeInterval = PendingWrites.delay, _ run: @escaping () -> Void) {
        lock.lock()
        work[key]?.item.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let pending = self.work.removeValue(forKey: key)
            self.lock.unlock()
            if pending != nil { run() }
        }
        work[key] = (item, run)
        lock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + after, execute: item)
    }

    /// Run a pending write for `key` now, if there is one.
    public func flush(_ key: String) {
        lock.lock()
        let pending = work.removeValue(forKey: key)
        lock.unlock()
        pending?.item.cancel()
        pending?.run()
    }

    /// Run every pending write now. Called on leaving an editor and on the
    /// app leaving the foreground — the debounce's side of the bargain.
    public func flushAll() {
        lock.lock()
        let all = work
        work.removeAll()
        lock.unlock()
        for (_, pending) in all {
            pending.item.cancel()
            pending.run()
        }
    }

    /// Is anything waiting? (Diagnostics and tests.)
    public var isEmpty: Bool {
        lock.lock(); defer { lock.unlock() }
        return work.isEmpty
    }
}
