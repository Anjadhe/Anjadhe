import Foundation

/// Plain text extracted from a stored HTML body, for previews and search.
///
/// WHY THIS EXISTS. Notes and journal entries are stored as HTML (the desktop
/// RichEditor's own markup, so they round-trip). Every screen that previews
/// one, or searches inside one, used to run four regular expressions over the
/// whole body, inside a SwiftUI `body`, for every record in the blob.
/// Measured on 900 notes (4.2 MB) on an M-series Mac, release build — and a
/// phone is slower again:
///
///     HomeView.continueItems    269 ms   on EVERY render
///     SearchView.hits           318 ms   on EVERY keystroke
///
/// The two uses want different things, so they get different caches:
///
///   * A PREVIEW is a few dozen characters for a row on screen. There are
///     never many at once — Home shows three, a list renders what fits — so
///     the cache holds the finished short string and stays tiny. The bigger
///     win for previews is not here at all: a screen must sort FIRST and
///     preview only what survives. Home's 269 ms was 900 previews built to
///     throw 897 away.
///   * A SEARCH needs every body, lowercased, every time the query changes.
///     That is the one thing worth holding in full, so `contains` keeps the
///     lowercased text — ONE copy, not the original as well, because the
///     original is only ever wanted for the handful of rows being previewed.
///
/// Both are keyed by the record's identity plus its stamp (`modifiedAt` /
/// `updatedAt`), so a changed record recomputes itself and nothing has to
/// remember to invalidate anything.
///
/// TWO REJECTED IDEAS, both of which looked right and measured worse:
///
///   * Scanning the raw markup for the needle and converting only the
///     candidates. Slower (a case-insensitive search over megabytes of
///     markup costs more than the strip it avoids, and on real prose most
///     records are candidates anyway) and WRONG: stripping turns
///     `foo</b>bar` into `foo bar`, so a needle spanning a tag is in the
///     text but not in the markup. Measured 445 ms against 318 ms, with a
///     false negative over 4,500 comparisons.
///   * Caching the original and the lowercased form together under a 4 M
///     character budget. 900 notes need 8.2 M, so the cache cleared itself
///     partway through every pass and re-stripped everything: measured
///     321 ms warm, i.e. no cache at all. A budget smaller than one screen's
///     working set is worse than none, because it also pays the bookkeeping.
public enum PlainText {
    private static var previews: [String: String] = [:]
    private static var lowered: [String: String] = [:]
    private static var loweredChars = 0
    private static let lock = NSLock()

    /// Previews are short; this is thousands of rows' worth.
    private static let maxPreviews = 3000
    /// ~16 MB of Swift string storage. Sized to hold a large library's worth
    /// of bodies in ONE lowercased copy — see the rejected idea above.
    private static let maxLoweredChars = 8_000_000

    private static func key(_ id: String, _ stamp: String) -> String { id + "\u{1}" + stamp }

    /// A short plain-text preview of `html`, cached under `id`+`stamp`.
    public static func preview(_ html: String, id: String, stamp: String, max: Int = 80) -> String {
        let k = key(id, stamp) + "\u{1}\(max)"
        lock.lock()
        if let hit = previews[k] { lock.unlock(); return hit }
        lock.unlock()

        let value = truncate(strip(html), max)
        lock.lock()
        if previews.count >= maxPreviews { previews.removeAll(keepingCapacity: true) }
        previews[k] = value
        lock.unlock()
        return value
    }

    /// Does this body contain `needle` (already lowercased)? Matches against
    /// the TEXT, never the markup, so a tag name is not a hit and a phrase
    /// broken by a tag is.
    public static func contains(_ html: String, needle: String, id: String, stamp: String) -> Bool {
        guard !needle.isEmpty else { return true }
        let k = key(id, stamp)
        lock.lock()
        if let hit = lowered[k] { lock.unlock(); return hit.contains(needle) }
        lock.unlock()

        let value = strip(html).lowercased()
        lock.lock()
        if loweredChars >= maxLoweredChars { lowered.removeAll(keepingCapacity: true); loweredChars = 0 }
        if lowered.updateValue(value, forKey: k) == nil { loweredChars += value.count }
        lock.unlock()
        return value.contains(needle)
    }

    /// Convert these bodies for search AHEAD of being asked, off the calling
    /// thread. The first query of a session has to read every body once —
    /// there is no way around that — so it is done while the user is still
    /// reaching for the keyboard instead of after they type. Idempotent, and
    /// safe to call on every appearance: bodies already cached are skipped.
    public static func prewarm(_ bodies: [(html: String, id: String, stamp: String)]) {
        guard !bodies.isEmpty else { return }
        DispatchQueue.global(qos: .utility).async {
            for b in bodies {
                let k = key(b.id, b.stamp)
                lock.lock()
                let known = lowered[k] != nil
                lock.unlock()
                if known { continue }
                let value = strip(b.html).lowercased()
                lock.lock()
                if loweredChars >= maxLoweredChars { lowered.removeAll(keepingCapacity: true); loweredChars = 0 }
                if lowered.updateValue(value, forKey: k) == nil { loweredChars += value.count }
                lock.unlock()
            }
        }
    }

    /// Uncached conversion — tags out, entities out, whitespace collapsed.
    public static func strip(_ s: String) -> String {
        let noTags = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ", options: .caseInsensitive)
            .replacingOccurrences(of: "&[a-z]+;", with: " ", options: [.regularExpression, .caseInsensitive])
        return noTags.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Cut to `max` characters with an ellipsis.
    public static func truncate(_ text: String, _ max: Int) -> String {
        guard text.count > max else { return text }
        return String(text.prefix(max)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Test/diagnostic hook: forget everything cached.
    public static func clearCache() {
        lock.lock()
        previews.removeAll(); lowered.removeAll(); loweredChars = 0
        lock.unlock()
    }
}
