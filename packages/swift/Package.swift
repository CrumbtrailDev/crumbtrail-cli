// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Crumbtrail",
    // iOS 13 is the floor because the lifecycle collector uses the scene
    // notifications. macOS is supported so the contract, session, queue and
    // redaction layers can be exercised by `swift test` on a developer machine
    // and in CI without a simulator; the UIKit collectors compile out there.
    platforms: [.iOS(.v13), .macOS(.v10_15), .tvOS(.v13)],
    products: [
        .library(name: "Crumbtrail", targets: ["Crumbtrail"])
    ],
    targets: [
        .target(name: "Crumbtrail"),
        // The wire-contract fixtures are shared with the Kotlin and Dart SDKs
        // and are read from the repo root at test time (see FixtureLoader),
        // deliberately NOT declared as a bundled resource. A copied resource is
        // a second source of truth, and a fixture set that can drift per SDK
        // fails to catch the exact cross-language drift it exists to catch.
        .testTarget(name: "CrumbtrailTests", dependencies: ["Crumbtrail"]),
    ]
)
