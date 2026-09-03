// swift-tools-version:5.9
import PackageDescription

// The Anjadhe iPhone app's Swift package (docs/MOBILE_NATIVE.md).
//   • AnjadheCore — JSONValue + the on-device KV store (the sync seam that
//                   mirrors js/adapter/native-bridge.js), date/schedule logic.
//                   Platform-agnostic, `swift test`s on the command line.
//   • AnjadheUI   — the SwiftUI app: shell, every screen, the sync
//                   coordinator that hosts the JS channel in a hidden
//                   WKWebView. Compiles on macOS (so `swift build`
//                   type-checks it); runs in the iOS app (ios/App). Bundles
//                   the Nunito display font so titles match the Mac.
let package = Package(
    name: "Anjadhe",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AnjadheCore", targets: ["AnjadheCore"]),
        .library(name: "AnjadheUI", targets: ["AnjadheUI"]),
    ],
    targets: [
        .target(name: "AnjadheCore"),
        .target(name: "AnjadheUI", dependencies: ["AnjadheCore"],
                resources: [.process("Resources")]),
        .testTarget(name: "AnjadheCoreTests", dependencies: ["AnjadheCore"]),
    ]
)
