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
        .executableTarget(
            name: "StudyHelperMac",
            path: "Sources/StudyHelperMac"
        )
    ]
)
