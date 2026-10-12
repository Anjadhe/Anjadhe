import XCTest
@testable import AnjadheCore

/// `PlainText` is what Home previews with and what Search matches on, so a
/// mistake here is either a wrong preview or a missing search result. The
/// performance shape is covered by the comments in the source; these pin the
/// BEHAVIOUR, including the two bugs the fast paths invited.
final class PlainTextTests: XCTestCase {
    override func setUp() { PlainText.clearCache() }

    func testStripRemovesMarkupEntitiesAndWhitespace() {
        XCTAssertEqual(PlainText.strip("<p>Hello <b>there</b></p>"), "Hello there")
        XCTAssertEqual(PlainText.strip("a&nbsp;b"), "a b")
        XCTAssertEqual(PlainText.strip("a&amp;b"), "a b")
        XCTAssertEqual(PlainText.strip("  lots\n\n of   space \t"), "lots of space")
        XCTAssertEqual(PlainText.strip(""), "")
    }

    /// The bug the rejected "scan the markup first" optimisation had: a
    /// phrase split by a tag is in the TEXT but not in the markup.
    func testMatchesAPhraseBrokenByATag() {
        let html = "<p>foo</b>bar</p>"
        XCTAssertEqual(PlainText.strip(html), "foo bar")
        XCTAssertTrue(PlainText.contains(html, needle: "foo bar", id: "n1", stamp: "s1"))
    }

    /// And its mirror: markup must never be searchable content.
    func testDoesNotMatchTagNames() {
        XCTAssertFalse(PlainText.contains("<blockquote>hi</blockquote>", needle: "blockquote", id: "n2", stamp: "s1"))
        XCTAssertTrue(PlainText.contains("<blockquote>hi</blockquote>", needle: "hi", id: "n2", stamp: "s1"))
    }

    func testMatchingIsCaseInsensitiveOnTheBodySide() {
        // The caller lowercases the needle; the body must be folded for it.
        XCTAssertTrue(PlainText.contains("<p>Anjadhe</p>", needle: "anjadhe", id: "n3", stamp: "s1"))
    }

    func testEmptyNeedleMatchesAnything() {
        XCTAssertTrue(PlainText.contains("<p>x</p>", needle: "", id: "n4", stamp: "s1"))
    }

    /// The stamp IS the invalidation. A record edited in place must not keep
    /// answering from the copy taken before the edit.
    func testANewStampRecomputes() {
        XCTAssertEqual(PlainText.preview("<p>before</p>", id: "n5", stamp: "s1", max: 80), "before")
        XCTAssertEqual(PlainText.preview("<p>after</p>", id: "n5", stamp: "s2", max: 80), "after")
        XCTAssertTrue(PlainText.contains("<p>after</p>", needle: "after", id: "n5", stamp: "s2"))
        XCTAssertFalse(PlainText.contains("<p>after</p>", needle: "before", id: "n5", stamp: "s2"))
    }

    /// Two records that happen to share a stamp must not share an entry.
    func testDifferentRecordsSameStampStaySeparate() {
        XCTAssertEqual(PlainText.preview("<p>one</p>", id: "a", stamp: "s", max: 80), "one")
        XCTAssertEqual(PlainText.preview("<p>two</p>", id: "b", stamp: "s", max: 80), "two")
    }

    func testPreviewTruncatesWithAnEllipsis() {
        let long = "<p>" + String(repeating: "x", count: 200) + "</p>"
        let p = PlainText.preview(long, id: "n6", stamp: "s1", max: 20)
        XCTAssertEqual(p.count, 21) // 20 + the ellipsis
        XCTAssertTrue(p.hasSuffix("…"))
        // The same body at a different width is a different answer.
        XCTAssertEqual(PlainText.preview(long, id: "n6", stamp: "s1", max: 30).count, 31)
    }

    func testTruncateLeavesShortTextAlone() {
        XCTAssertEqual(PlainText.truncate("short", 80), "short")
    }

    /// Prewarming is an optimisation, so it must change no answer — only
    /// when the work happens.
    func testPrewarmAgreesWithTheDirectAnswer() {
        let bodies = (0..<50).map { i in
            (html: "<p>body number \(i) about dogs</p>", id: "p\(i)", stamp: "s")
        }
        PlainText.prewarm(bodies)
        // Whether or not the background pass has landed, the answers match.
        for (i, b) in bodies.enumerated() {
            XCTAssertTrue(PlainText.contains(b.html, needle: "dogs", id: b.id, stamp: b.stamp))
            XCTAssertTrue(PlainText.contains(b.html, needle: "number \(i)", id: b.id, stamp: b.stamp))
            XCTAssertFalse(PlainText.contains(b.html, needle: "cats", id: b.id, stamp: b.stamp))
        }
    }

    func testClearingTheCacheChangesNothingButTiming() {
        let html = "<p>durable</p>"
        XCTAssertTrue(PlainText.contains(html, needle: "durable", id: "n7", stamp: "s1"))
        PlainText.clearCache()
        XCTAssertTrue(PlainText.contains(html, needle: "durable", id: "n7", stamp: "s1"))
        XCTAssertEqual(PlainText.preview(html, id: "n7", stamp: "s1", max: 80), "durable")
    }
}
