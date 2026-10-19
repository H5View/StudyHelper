import AppKit
import CoreGraphics
import ScreenCaptureKit

enum ScreenshotCaptureError: Error {
    case screenRecordingRequired
    case captureFailed
    case encodingFailed
}

@MainActor
final class ScreenshotCaptureService {
    private let maximumDimension = 2_048
    private let maximumJPEGBytes = 4 * 1_024 * 1_024

    func captureJPEG() async throws -> Data {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw ScreenshotCaptureError.screenRecordingRequired
        }

        let image: CGImage
        do {
            image = try await capturePrimaryDisplay()
        } catch {
            if !CGPreflightScreenCaptureAccess() {
                throw ScreenshotCaptureError.screenRecordingRequired
            }
            throw ScreenshotCaptureError.captureFailed
        }

        guard let data = encodeJPEG(image), !data.isEmpty else {
            throw ScreenshotCaptureError.encodingFailed
        }
        return data
    }

    private func capturePrimaryDisplay() async throws -> CGImage {
        if #available(macOS 14.0, *) {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                    ?? content.displays.first else {
                throw ScreenshotCaptureError.captureFailed
            }

            let ownBundleID = Bundle.main.bundleIdentifier
            let excludedApps = content.applications.filter { $0.bundleIdentifier == ownBundleID }
            let filter = SCContentFilter(
                display: display,
                excludingApplications: excludedApps,
                exceptingWindows: []
            )
            let scale = min(1, Double(maximumDimension) / Double(max(display.width, display.height)))
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(Double(display.width) * scale))
            configuration.height = max(1, Int(Double(display.height) * scale))
            configuration.showsCursor = false

            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        }

        // Keep the existing macOS 13 deployment target working. This fallback
        // captures the frontmost application window through Apple's public API.
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            throw ScreenshotCaptureError.captureFailed
        }

        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == frontmostPID,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let windowID = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let image = CGWindowListCreateImage(
                    .null,
                    .optionIncludingWindow,
                    windowID,
                    [.boundsIgnoreFraming]
                  ),
                  image.width > 100,
                  image.height > 100 else {
                continue
            }
            return image
        }
        throw ScreenshotCaptureError.captureFailed
    }

    private func encodeJPEG(_ image: CGImage) -> Data? {
        for dimensionLimit in [maximumDimension, 1_536, 1_280] {
            let longestSide = max(image.width, image.height)
            let scale = min(1, Double(dimensionLimit) / Double(longestSide))
            let width = max(1, Int(Double(image.width) * scale))
            let height = max(1, Int(Double(image.height) * scale))
            guard let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else {
                continue
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
            guard let resizedImage = context.makeImage() else { continue }

            let representation = NSBitmapImageRep(cgImage: resizedImage)
            for quality in [0.82, 0.72, 0.62] {
                guard let data = representation.representation(
                    using: .jpeg,
                    properties: [.compressionFactor: quality]
                ) else {
                    continue
                }
                if data.count <= maximumJPEGBytes {
                    return data
                }
            }
        }
        return nil
    }
}
