import XCTest
@testable import AnjadheUI

final class RouterTests: XCTestCase {
    func testFailedDraftPreventsNavigationUntilSaved() {
        let router = Router()
        router.push(.note("draft"))
        router.canLeave = { false }
        router.root(.threads)
        router.pop()
        router.setPath([], for: .now)
        XCTAssertEqual(router.tab, .now)
        XCTAssertEqual(router.path(for: .now), [.note("draft")])
        router.canLeave = { true }
        router.root(.threads)
        XCTAssertEqual(router.tab, .threads)
    }
    func testSwitchingTabsPreservesEachStackAndRetappingReturnsToRoot() {
        let router = Router()
        XCTAssertEqual(RootTab.allCases, [.now, .threads, .memory, .settings])
        router.push(.thread("bill"))
        router.root(.memory)
        router.push(.documents)
        router.push(.note("draft"))
        router.root(.now)
        XCTAssertEqual(router.path(for: .now), [.thread("bill")])
        router.root(.memory)
        XCTAssertEqual(router.path(for: .memory), [.documents, .note("draft")])
        router.root(.memory)
        XCTAssertTrue(router.path(for: .memory).isEmpty)
        XCTAssertEqual(router.path(for: .now), [.thread("bill")])
    }
}
