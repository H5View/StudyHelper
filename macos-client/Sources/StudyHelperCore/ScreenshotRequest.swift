import Foundation

public struct ScreenshotStudyRequest: Encodable {
    public let image: Data
    public let mimeType: String
    public let outputMode: String

    public init(image: Data, mimeType: String, outputMode: String) {
        self.image = image
        self.mimeType = mimeType
        self.outputMode = outputMode
    }
}
