import Foundation

struct AppConfiguration {
    let bridgeBaseURL = URL(string: "http://192.168.86.51:8788")!
    let studyToken = "change-me"
    let healthRequestTimeout: TimeInterval = 5
    let studyAnswerRequestTimeout: TimeInterval = 90
    let popupDuration: TimeInterval = 5
    let maxSelectionLength = 4000
    let hotKeyDebounceInterval: TimeInterval = 0.35
}
