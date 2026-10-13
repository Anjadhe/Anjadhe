import XCTest
@testable import AnjadheCore

final class RecordMergeTests: XCTestCase {
    func testSharedGoldenFixturesAcrossDeliveryOrders() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("fixtures/record-merge/cases.json"))
        let fixtures = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).arrayValue)
        var seed: UInt64 = 731
        for fixture in fixtures {
            let name = try XCTUnwrap(fixture["name"]?.stringValue)
            let original = try XCTUnwrap(fixture["operations"]?.arrayValue)
            for pass in 0..<12 {
                var operations = pass == 0 ? original : original + original
                if pass > 0, operations.count > 1 {
                    for i in stride(from: operations.count - 1, through: 1, by: -1) {
                        seed = (seed &* 1664525 &+ 1013904223) & 0xffffffff
                        operations.swapAt(i, Int(seed % UInt64(i + 1)))
                    }
                }
                if fixture["error"]?.boolValue == true {
                    XCTAssertThrowsError(try RecordMerge.reduce(operations, datasetID: "fixture"), name)
                } else {
                    let result = try RecordMerge.reduce(operations, datasetID: "fixture")
                    // JSONValue/String equality uses Unicode canonical equivalence;
                    // compare encoded bytes to catch loss of distinct user text.
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                    XCTAssertEqual(try encoder.encode(result), try encoder.encode(XCTUnwrap(fixture["expected"])), name)
                }
            }
        }
    }
}
