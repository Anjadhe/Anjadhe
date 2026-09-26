import Foundation

/// Date helpers ported from the `--- dates ---` block in `mobile/app.js`.
/// `today`/`cal` are injectable so the screens use the live clock while tests
/// stay deterministic.
public enum DateLogic {

    /// "2026-06-18" in the given calendar's timezone (JS `dateStr`).
    public static func dateStr(_ date: Date, _ cal: Calendar = .current) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    public static func todayStr(_ today: Date = Date(), _ cal: Calendar = .current) -> String {
        dateStr(today, cal)
    }

    /// 0=Sunday … 6=Saturday, matching JS `Date.getDay()` (Swift weekday is 1=Sun).
    public static func weekday(_ date: Date, _ cal: Calendar = .current) -> Int {
        cal.component(.weekday, from: date) - 1
    }

    /// "Today" / "Yesterday" / "N days ago" / "MMM d" (JS `relDate`).
    public static func relDate(_ iso: String, today: Date = Date(), cal: Calendar = .current, locale: Locale = .current) -> String {
        guard !iso.isEmpty, let d = parseISO(iso) else { return "" }
        let t0 = cal.startOfDay(for: today)
        let d0 = cal.startOfDay(for: d)
        let days = cal.dateComponents([.day], from: d0, to: t0).day ?? 0
        if days == 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        if days > 1 && days < 7 { return "\(days) days ago" }
        let f = DateFormatter()
        f.locale = locale
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f.string(from: d)
    }

    /// "14:30" → "2:30 PM"; returns the input unchanged if it isn't HH:MM
    /// (JS `fmtTime`).
    public static func fmtTime(_ hhmm: String) -> String {
        let ns = hhmm as NSString
        guard let m = timeRE.firstMatch(in: hhmm, range: NSRange(location: 0, length: ns.length)) else { return hhmm }
        let h = Int(ns.substring(with: m.range(at: 1))) ?? 0
        let mm = ns.substring(with: m.range(at: 2))
        let ap = h < 12 ? "AM" : "PM"
        let h12 = (h % 12) == 0 ? 12 : (h % 12)
        return "\(h12):\(mm) \(ap)"
    }

    // MARK: internals
    private static let timeRE = try! NSRegularExpression(pattern: "^(\\d{1,2}):(\\d{2})")

    // Built once, not per call. Constructing a date formatter builds ICU
    // state and costs far more than the parse: three of them per call made
    // `parseISO` 0.15 ms, which is 15 ms to look at a hundred calendar
    // events — inside a view body, on every render. Configured once and only
    // read afterwards, which is what makes them safe to share (the same
    // pattern KVStore's own formatters use).
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let isoDayUTC: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Parse a full ISO-8601 timestamp or a bare `yyyy-MM-dd` (treated as UTC).
    public static func parseISO(_ iso: String) -> Date? {
        if let d = isoFractional.date(from: iso) { return d }
        if let d = isoPlain.date(from: iso) { return d }
        return isoDayUTC.date(from: iso)
    }
}
