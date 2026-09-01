import Foundation

enum AnswerDisplayMode: String, CaseIterable {
    case mac
    case windows
    case both

    var menuTitle: String {
        switch self {
        case .mac:
            return "MacBook"
        case .windows:
            return "Windows PC"
        case .both:
            return "MacBook + Windows PC"
        }
    }

    var sendsPopupToMac: Bool {
        self == .mac || self == .both
    }
}
