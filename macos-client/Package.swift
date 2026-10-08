// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "StudyHelperMac",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "StudyHelperMac", targets: ["StudyHelperMac"])
    ],
    targets: [
        .target(
            name: "StudyHelperCore",
            path: "Sources/StudyHelperCore"
        ),
        .executableTarget(
            name: "StudyHelperMac",
            dependencies: ["StudyHelperCore"],
            path: "Sources/StudyHelperMac"
        ),
        .executableTarget(
            name: "StudyHelperCoreRegression",
            dependencies: ["StudyHelperCore"],
            path: "Tests/StudyHelperCoreRegression"
        )
    ]
)
