import XCTest
@testable import AnjadheUI

final class RouterTests: XCTestCase {
    func testSwitchingTabsPreservesEachStackAndRetappingReturnsToRoot() {
        let router = Router()
        router.push(.matter("bill"))
        router.root(.apps)
        router.push(.app("documents"))
        router.push(.note("draft"))
        router.root(.home)
        XCTAssertEqual(router.homePath, [.matter("bill")])
        router.root(.apps)
        XCTAssertEqual(router.appsPath, [.app("documents"), .note("draft")])
        router.root(.apps)
        XCTAssertTrue(router.appsPath.isEmpty)
        XCTAssertEqual(router.homePath, [.matter("bill")])
    }
}
