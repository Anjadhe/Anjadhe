import XCTest
@testable import AnjadheUI

final class RouterTests: XCTestCase {
    func testFailedDraftPreventsNavigationUntilSaved() {
        let router = Router()
        router.push(.note("draft"))
        router.canLeave = { false }
        router.root(.memory)
        router.pop()
        router.setPath([], for: .threads)
        XCTAssertEqual(router.tab, .threads)
        XCTAssertEqual(router.path(for: .threads), [.note("draft")])
        router.canLeave = { true }
        router.root(.memory)
        XCTAssertEqual(router.tab, .memory)
    }
    func testSwitchingTabsPreservesEachStackAndRetappingReturnsToRoot() {
        let router = Router()
        XCTAssertEqual(router.tab, .threads)
        XCTAssertEqual(RootTab.allCases, [.threads, .memory, .settings])
        router.push(.thread("bill"))
        router.root(.memory)
        router.push(.documents)
        router.push(.note("draft"))
        router.root(.threads)
        XCTAssertEqual(router.path(for: .threads), [.thread("bill")])
        router.root(.memory)
        XCTAssertEqual(router.path(for: .memory), [.documents, .note("draft")])
        router.root(.memory)
        XCTAssertTrue(router.path(for: .memory).isEmpty)
        XCTAssertEqual(router.path(for: .threads), [.thread("bill")])
    }
}
