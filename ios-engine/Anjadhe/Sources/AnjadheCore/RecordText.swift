import Foundation

/// A record's body, whatever format it was stored in (2026-09-21).
///
/// WHY THIS EXISTS. The phone has one read-only renderer for a body,
/// `MarkdownView`, and records do not all arrive as Markdown:
///
///   * a NOTE or a JOURNAL entry is HTML — the desktop RichEditor's own
///     markup, kept verbatim so it round-trips;
///   * a ROUTINE RESULT is HTML too — `PromptFeed._format` runs the model's
///     Markdown through `AgentUI.formatContent` before storing it;
///   * an ASSISTANT reply is Markdown, straight from the model.
///
/// Feeding the first two to a Markdown renderer put `<p>` and `<li>` on the
/// screen, which is what Ram reported. Stripping the tags instead would be
/// worse than it sounds: a routine result is mostly headings, lists and
/// links, and flattening it to one grey paragraph loses the structure that
/// makes it readable at all.
///
/// So: convert back to Markdown and let the one renderer do its job. The
/// vocabulary is small and known — `formatContent` escapes everything first
/// and then reintroduces only a whitelist — so this is a translation between
/// two formats we control, not an HTML parser.
///
/// The detail that is easy to miss: an in-app RECORD LINK is stored as
/// `<a href="#" data-record-link="task" data-record-id="…">`, with the real
/// destination on the attributes and a dead `#` in the href. Read naively it
/// becomes a link that goes nowhere; here it becomes `anjadhe://task/<id>`,
/// which is exactly what `Router.openRecordLink` knows how to open.
public enum RecordText {

    /// The one entry point: Markdown, whatever came in.
    public static func markdown(_ body: String) -> String {
        looksLikeHTML(body) ? htmlToMarkdown(body) : body
    }

    /// Is this stored markup rather than Markdown?
    ///
    /// Keyed on BLOCK tags, because prose legitimately contains `<` ("a < b",
    /// "<3", a generic) while `<p>`, `<li>` or `<blockquote>` means it came
    /// out of the editor or the formatter.
    ///
    /// Two discriminators, in order, and the second one matters: an assistant
    /// reply ABOUT HTML puts real tags inside a ``` fence, and converting
    /// that would eat the code sample the user asked for. A stored body never
    /// contains a fence — `formatContent` writes `<pre><code>` — so a fence
    /// is proof of Markdown. It cannot simply outrank everything though: a
    /// note could mention ``` in its prose, so markup that STARTS the body
    /// (which is how both writers always emit it) is decided first.
    public static func looksLikeHTML(_ s: String) -> Bool {
        let body = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        let blockTag = "</?(p|br|li|ul|ol|pre|blockquote|div|h[1-6])\\b[^>]*>"
        if body.range(of: "^" + blockTag, options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        if body.contains("```") { return false }
        return body.range(of: blockTag, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Translate the stored HTML vocabulary back to Markdown.
    public static func htmlToMarkdown(_ html: String) -> String {
        var out = ""
        // Open ordered/unordered lists, deepest last, each with its counter.
        var lists: [(ordered: Bool, index: Int)] = []
        // Inside <pre>, everything is literal until the close tag.
        var pre = false
        var preBuffer = ""
        // The <a> currently open: its destination, and the label so far.
        var linkHref: String? = nil
        var linkLabel: String? = nil

        func append(_ s: String) {
            if linkLabel != nil { linkLabel! += s } else { out += s }
        }
        /// Start a block: exactly one blank line between blocks, never more.
        func breakBlock() {
            while out.hasSuffix(" ") { out.removeLast() }
            if out.isEmpty { return }
            if out.hasSuffix("\n\n") { return }
            out += out.hasSuffix("\n") ? "\n" : "\n\n"
        }

        var i = html.startIndex
        while i < html.endIndex {
            let c = html[i]
            guard c == "<" , let close = html[i...].firstIndex(of: ">") else {
                // An ordinary text RUN, up to the next tag. Taken whole
                // rather than per character because an entity is several
                // characters long and would never match one at a time.
                let next = html[html.index(after: i)...].firstIndex(of: "<")
                let end = (c == "<") ? html.index(after: i) : (next ?? html.endIndex)
                let run = String(html[i..<end])
                if pre { preBuffer += run } else { append(entity(run)) }
                i = end
                continue
            }
            let raw = String(html[html.index(after: i)..<close])
            i = html.index(after: close)
            let isClose = raw.hasPrefix("/")
            let body = isClose ? String(raw.dropFirst()) : raw
            let name = body.prefix(while: { !$0.isWhitespace && $0 != "/" }).lowercased()

            if pre && !(isClose && name == "pre") { continue }   // literal inside <pre>

            switch name {
            case "p", "div":
                breakBlock()
            case "br":
                out += "\n"
            case "hr":
                breakBlock(); out += "---"; breakBlock()
            case "h1", "h2", "h3", "h4", "h5", "h6":
                if isClose { breakBlock() } else {
                    breakBlock()
                    let level = Int(name.dropFirst()) ?? 3
                    out += String(repeating: "#", count: level) + " "
                }
            case "ul", "ol":
                if isClose {
                    if !lists.isEmpty { lists.removeLast() }
                    if lists.isEmpty { breakBlock() }
                } else {
                    // A nested list opens inside its parent's <li>, which has
                    // already written that line; start the sublist below it.
                    if !lists.isEmpty && !out.hasSuffix("\n") { out += "\n" }
                    else if lists.isEmpty { breakBlock() }
                    lists.append((ordered: name == "ol", index: 0))
                }
            case "li":
                if isClose { break }
                if !out.isEmpty && !out.hasSuffix("\n") { out += "\n" }
                // `formatContent` can emit <li> with no enclosing list when a
                // stray bullet survives; treat that as a plain bullet.
                let depth = max(0, lists.count - 1)
                let indent = String(repeating: "    ", count: depth)
                if lists.isEmpty {
                    out += indent + "- "
                } else {
                    lists[lists.count - 1].index += 1
                    let cur = lists[lists.count - 1]
                    out += indent + (cur.ordered ? "\(cur.index). " : "- ")
                }
            case "blockquote":
                if isClose { breakBlock() } else { breakBlock(); out += "> " }
            case "pre":
                if isClose {
                    pre = false
                    let text = entity(preBuffer)
                        .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                    preBuffer = ""
                    breakBlock()
                    out += "```\n" + text.trimmingCharacters(in: .newlines) + "\n```"
                    breakBlock()
                } else {
                    pre = true
                    preBuffer = ""
                }
            case "code":
                // A fenced block is handled by <pre>; this is an inline span.
                append("`")
            case "strong", "b":
                append("**")
            case "em", "i":
                append("*")
            case "del", "s", "strike":
                append("~~")
            case "a":
                if isClose {
                    let label = (linkLabel ?? "").trimmingCharacters(in: .whitespaces)
                    let href = linkHref ?? ""
                    linkLabel = nil
                    linkHref = nil
                    if label.isEmpty { break }
                    // A link to nowhere is just words.
                    out += href.isEmpty || href == "#" ? label : "[\(label)](\(href))"
                } else {
                    linkHref = destination(body)
                    linkLabel = ""
                }
            default:
                break   // anything else contributes nothing but its text
            }
        }
        if let label = linkLabel, !label.isEmpty { out += label }   // unclosed <a>

        // Collapse the runs of blank lines the block breaks can leave behind.
        let tidied = out.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return tidied.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Where an `<a>` actually points. A record link keeps its destination on
    /// `data-record-link` / `data-record-id` and leaves `href="#"`, so those
    /// win; `Router.openRecordLink` reads the scheme this builds.
    private static func destination(_ tag: String) -> String {
        let type = attribute("data-record-link", tag)
        let id = attribute("data-record-id", tag)
        if !type.isEmpty && !id.isEmpty { return "anjadhe://\(type)/\(id)" }
        return attribute("href", tag)
    }

    private static func attribute(_ name: String, _ tag: String) -> String {
        guard let r = tag.range(of: "\(name)\\s*=\\s*[\"']([^\"']*)[\"']",
                                options: [.regularExpression, .caseInsensitive]) else { return "" }
        let hit = String(tag[r])
        guard let q = hit.range(of: "[\"']", options: .regularExpression) else { return "" }
        let value = hit[q.upperBound...].dropLast()
        return entity(String(value))
    }

    /// The entities `formatContent` and the editor emit.
    public static func entity(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = s
        for (k, v) in [("&nbsp;", "\u{00a0}"), ("&lt;", "<"), ("&gt;", ">"),
                       ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"),
                       ("&mdash;", "—"), ("&ndash;", "–"), ("&hellip;", "…")] {
            out = out.replacingOccurrences(of: k, with: v)
        }
        // Last, so a literal "&amp;lt;" survives as "&lt;".
        return out.replacingOccurrences(of: "&amp;", with: "&")
    }
}
