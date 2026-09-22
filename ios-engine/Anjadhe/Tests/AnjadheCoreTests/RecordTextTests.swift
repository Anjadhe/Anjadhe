import XCTest
@testable import AnjadheCore

/// A record's body reaches the phone in whichever format the Mac stored it —
/// HTML for a note, a journal entry or a routine result; Markdown for an
/// assistant reply. The phone has ONE read-only renderer, so the translation
/// has to be right or `<p>` ends up on the screen (which is what it did).
///
/// The fixtures here are the shapes `AgentUI.formatContent` and the desktop
/// RichEditor actually emit.
final class RecordTextTests: XCTestCase {

    // MARK: what is HTML and what is not

    func testMarkdownIsLeftAlone() {
        // Prose with angle brackets is not markup.
        let md = "Totals below.\n\n- a < b, and b > c\n- `Array<String>` is fine\n\n**Done.**"
        XCTAssertFalse(RecordText.looksLikeHTML(md))
        XCTAssertEqual(RecordText.markdown(md), md, "a Markdown body must pass through untouched")
    }

    /// An assistant reply ABOUT HTML keeps its code sample intact. This is
    /// the one case where real tags appear in a Markdown body.
    func testACodeSampleInAFenceIsNotTreatedAsMarkup() {
        let reply = "Use a paragraph:\n\n```html\n<p>Hello</p>\n```\n\nThat renders as text."
        XCTAssertFalse(RecordText.looksLikeHTML(reply))
        XCTAssertEqual(RecordText.markdown(reply), reply)
    }

    /// …but a stored body that merely mentions a fence in its prose is still
    /// a stored body, because the markup starts it.
    func testStoredBodyMentioningAFenceIsStillMarkup() {
        let html = "<p>Wrap it in ``` to make a block.</p>"
        XCTAssertTrue(RecordText.looksLikeHTML(html))
        XCTAssertEqual(RecordText.markdown(html), "Wrap it in ``` to make a block.")
    }

    func testStoredBodiesAreRecognised() {
        XCTAssertTrue(RecordText.looksLikeHTML("<p>Hello</p>"))
        XCTAssertTrue(RecordText.looksLikeHTML("<ol><li>One</li></ol>"))
        XCTAssertTrue(RecordText.looksLikeHTML("Some text<br>more"))
    }

    // MARK: blocks

    func testParagraphsAndLineBreaks() {
        let html = "<p>First line<br>second line</p><p>A new paragraph.</p>"
        XCTAssertEqual(RecordText.markdown(html),
                       "First line\nsecond line\n\nA new paragraph.")
    }

    func testHeadingsKeepTheirLevel() {
        let html = "<h2>Overview</h2><p>Body.</p><h4>Detail</h4><p>More.</p>"
        XCTAssertEqual(RecordText.markdown(html),
                       "## Overview\n\nBody.\n\n#### Detail\n\nMore.")
    }

    func testBulletsAndNumbers() {
        let html = "<ul><li>Alpha</li><li>Beta</li></ul>"
        XCTAssertEqual(RecordText.markdown(html), "- Alpha\n- Beta")
        let ordered = "<ol><li>First</li><li>Second</li><li>Third</li></ol>"
        XCTAssertEqual(RecordText.markdown(ordered), "1. First\n2. Second\n3. Third")
    }

    /// The nesting `formatContent` builds: a sublist opens INSIDE the parent
    /// `<li>`, which is what stopped four news items all rendering as "1.".
    func testNestedListsIndentRatherThanRestart() {
        let html = "<ol><li>Parent<ul><li>Child</li><li>Sibling</li></ul></li><li>Next</li></ol>"
        XCTAssertEqual(RecordText.markdown(html),
                       "1. Parent\n    - Child\n    - Sibling\n2. Next")
    }

    func testQuoteAndRule() {
        XCTAssertEqual(RecordText.markdown("<blockquote>Said so.</blockquote>"), "> Said so.")
        XCTAssertEqual(RecordText.markdown("<p>A</p><hr><p>B</p>"), "A\n\n---\n\nB")
    }

    func testCodeBlockKeepsItsContentLiteral() {
        let html = "<p>Run:</p><pre><code>npm test\nnpm start</code></pre>"
        XCTAssertEqual(RecordText.markdown(html), "Run:\n\n```\nnpm test\nnpm start\n```")
    }

    func testInlineStyling() {
        let html = "<p>A <strong>bold</strong> and <em>italic</em> and <code>code</code> word.</p>"
        XCTAssertEqual(RecordText.markdown(html),
                       "A **bold** and *italic* and `code` word.")
    }

    // MARK: links — the part that was silently broken

    func testOrdinaryLink() {
        let html = "<p>See <a href=\"https://example.com/x\">the page</a>.</p>"
        XCTAssertEqual(RecordText.markdown(html), "See [the page](https://example.com/x).")
    }

    /// A record link keeps its destination on the data attributes and leaves
    /// `href="#"`. Read naively it becomes a link to nowhere; it has to come
    /// out as the scheme `Router.openRecordLink` opens.
    func testRecordLinkBecomesTheAppScheme() {
        let html = "<p>Do <a href=\"#\" class=\"record-link\" data-record-link=\"task\" "
            + "data-record-id=\"t_42\" title=\"Open task\">Pay water bill</a> today.</p>"
        XCTAssertEqual(RecordText.markdown(html),
                       "Do [Pay water bill](anjadhe://task/t_42) today.")
    }

    func testDeadLinkDegradesToItsWords() {
        let html = "<p>A <a href=\"#\">dead one</a> here.</p>"
        XCTAssertEqual(RecordText.markdown(html), "A dead one here.")
    }

    // MARK: entities

    func testEntitiesComeBackAsCharacters() {
        let html = "<p>Tom &amp; Jerry said &quot;hi&quot; &lt;loudly&gt;</p>"
        XCTAssertEqual(RecordText.markdown(html), "Tom & Jerry said \"hi\" <loudly>")
    }

    /// `formatContent` escapes the source first, so a body that talked ABOUT
    /// an entity stored it double-escaped. Unescaping must not go too far.
    func testDoubleEscapingIsUnwoundOnce() {
        XCTAssertEqual(RecordText.markdown("<p>Write &amp;lt; for less-than</p>"),
                       "Write &lt; for less-than")
    }

    // MARK: shapes seen in the wild

    /// A routine result, end to end.
    func testARoutineResultReads() {
        let html = "<h3>Morning news</h3><p>Three things today.</p>"
            + "<ol><li><strong>Markets</strong> opened up.</li>"
            + "<li>Rain <em>likely</em> after 3pm.</li></ol>"
            + "<p>See <a href=\"https://news.example/1\">the story</a>.</p>"
        XCTAssertEqual(RecordText.markdown(html),
            """
            ### Morning news

            Three things today.

            1. **Markets** opened up.
            2. Rain *likely* after 3pm.

            See [the story](https://news.example/1).
            """)
    }

    /// The desktop RichEditor's own markup for a note.
    func testANoteBodyReads() {
        let html = "<p>Groceries</p><ul><li>Milk</li><li>Eggs</li></ul><p>&nbsp;</p>"
        let out = RecordText.markdown(html)
        XCTAssertTrue(out.hasPrefix("Groceries\n\n- Milk\n- Eggs"), "got: \(out)")
        XCTAssertFalse(out.contains("<"), "no markup may survive")
    }

    func testEmptyAndJunkAreSafe() {
        XCTAssertEqual(RecordText.markdown(""), "")
        XCTAssertEqual(RecordText.markdown("<p></p>"), "")
        // An unterminated tag must not hang or leak markup.
        XCTAssertFalse(RecordText.markdown("<p>text<a href=\"x\">label").contains("<"))
    }
}
