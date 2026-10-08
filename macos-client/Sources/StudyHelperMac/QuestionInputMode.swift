enum QuestionInputMode: String {
    case selectedText
    case readScreen

    var menuTitle: String {
        switch self {
        case .selectedText:
            return "Selected Text"
        case .readScreen:
            return "Read Screen"
        }
    }
}
