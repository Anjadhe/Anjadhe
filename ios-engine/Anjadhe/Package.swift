// swift-tools-version:5.9
import PackageDescription

// Native UI, transactional local storage, shared JavaScriptCore rules and v2 sync primitives.
let package = Package(
    name: "Anjadhe",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AnjadheCore", targets: ["AnjadheCore"]),
        .library(name: "AnjadheUI", targets: ["AnjadheUI"]),
    ],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .target(name: "AnjadheCore", dependencies: ["CSQLite"], resources: [.process("Resources")]),
        .target(name: "AnjadheUI", dependencies: ["AnjadheCore"]),
        .testTarget(name: "AnjadheCoreTests", dependencies: ["AnjadheCore", "CSQLite"]),
        .testTarget(name: "AnjadheUITests", dependencies: ["AnjadheUI"]),
    ]
)
