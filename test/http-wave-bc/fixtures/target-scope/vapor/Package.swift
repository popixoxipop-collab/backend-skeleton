// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "VaporScopeFixture",
    platforms: [.macOS(.v13)],
    products: [.library(name: "App", targets: ["App"])],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", exact: "4.122.3")
    ],
    targets: [
        .target(name: "App", dependencies: [.product(name: "Vapor", package: "vapor")]),
        .testTarget(name: "AppTests", dependencies: [
            .target(name: "App"),
            .product(name: "VaporTesting", package: "vapor")
        ])
    ]
)
