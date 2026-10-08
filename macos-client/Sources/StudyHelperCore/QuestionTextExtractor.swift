import Foundation

public enum QuestionTextExtractor {
    private static let blankMarker = #"(?:_+|\.{3,}|…+|\[\s*(?:blank|text\s+field|input)\s*\]|\(\s*blank\s*\))"#

    public static func extract(from lines: [String]) -> [String] {
        let normalizedLines = lines
            .flatMap { $0.components(separatedBy: .newlines) }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let documentMenuIndex = normalizedLines.firstIndex {
            $0.localizedCaseInsensitiveContains("File Edit View Insert Format")
        }
        let browserAddressIndex = normalizedLines.firstIndex {
            $0.localizedCaseInsensitiveContains("docs.google.com/document/")
        }
        let contentStart = documentMenuIndex ?? browserAddressIndex
        let content = contentStart.map { Array(normalizedLines.dropFirst($0 + 1)) } ?? normalizedLines

        // Connect exposes a clear question-type heading. Treat it as a boundary
        // and extract the prompt that follows instead of interpreting nearby
        // accessibility labels (which can include unrelated controls) as choices.
        if let fillInHeading = content.firstIndex(where: isFillInBlankHeading) {
            return extractFillInQuestion(after: fillInHeading, in: content)
        }

        let choiceIndices = content.indices.filter { isAnswerChoiceLine(content[$0]) }
        let questionIndices = content.indices.filter { index in
            guard isQuestionLine(content[index]) else { return false }
            if index + 1 < content.count && isStandaloneInputMarker(content[index + 1]) {
                return false
            }
            return !isStandaloneInputMarker(content[index]) || hasQuestionTextAround(index, in: content)
        }

        guard !questionIndices.isEmpty else {
            if choiceIndices.count >= 2 {
                var selectedIndices = Set<Int>()
                for index in choiceIndices where index == 0 || !isAnswerChoiceLine(content[index - 1]) {
                    var previousIndex = index - 1
                    var contextLines = 0
                    while previousIndex >= 0 && contextLines < 3 && !isAnswerChoiceLine(content[previousIndex]) {
                        selectedIndices.insert(previousIndex)
                        previousIndex -= 1
                        contextLines += 1
                    }
                    _ = addAnswerChoiceGroup(startingAt: index, in: content, selectedIndices: &selectedIndices)
                }
                return content.indices.filter { selectedIndices.contains($0) }.map { content[$0] }
            }

            if let headingIndex = content.firstIndex(where: isChoiceHeading),
               let options = unlabeledOptions(startingAt: headingIndex + 1, in: content),
               options.count >= 2 {
                var result = Array(content[max(0, headingIndex - 3)...headingIndex])
                result.append(contentsOf: options.enumerated().map { "Option \($0.offset + 1): \($0.element)" })
                return result
            }
            return content.filter { !isScreenControl($0) && !isStandaloneInputMarker($0) }
        }

        var selectedIndices = Set<Int>()
        var syntheticOptions: [Int: String] = [:]
        for index in questionIndices {
            let precedingQuestion = questionIndices.last(where: { $0 < index }) ?? -1
            let precedingChoice = choiceIndices.last(where: { $0 < index }) ?? -1
            var previousIndex = index - 1
            var contextLines = 0
            while previousIndex > max(precedingQuestion, precedingChoice) && contextLines < 2 {
                selectedIndices.insert(previousIndex)
                previousIndex -= 1
                contextLines += 1
            }

            selectedIndices.insert(index)
            var nextIndex = index + 1
            if nextIndex < content.count && isChoiceHeading(content[nextIndex]) {
                selectedIndices.insert(nextIndex)
                nextIndex += 1
            }

            if nextIndex < content.count && isAnswerChoiceLine(content[nextIndex]) {
                _ = addAnswerChoiceGroup(startingAt: nextIndex, in: content, selectedIndices: &selectedIndices)
                continue
            }

            if containsInlineInputMarker(content[index]) {
                var continuationCount = 0
                while nextIndex < content.count && !questionIndices.contains(nextIndex) {
                    if isScreenControl(content[nextIndex]) || isAnswerChoiceLine(content[nextIndex]) || isChoiceHeading(content[nextIndex]) {
                        break
                    }
                    guard continuationCount < 8 else { break }
                    selectedIndices.insert(nextIndex)
                    let continuation = content[nextIndex].trimmingCharacters(in: .whitespacesAndNewlines)
                    nextIndex += 1
                    continuationCount += 1
                    if continuation.range(of: #"[.!?][\"'’”)]*$"#, options: .regularExpression) != nil {
                        break
                    }
                }
                continue
            }

            let questionLine = content[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if let options = unlabeledOptions(startingAt: nextIndex, in: content, questionIndices: questionIndices),
               options.count >= 2,
               isLikelyMultipleChoicePrompt(questionLine) {
                for (offset, option) in options.enumerated() {
                    syntheticOptions[nextIndex + offset] = "Option \(offset + 1): \(option)"
                    selectedIndices.insert(nextIndex + offset)
                }
                continue
            }

            let questionIsComplete = questionLine.contains("?") || questionLine.hasSuffix("=")
            var continuationCount = 0
            while nextIndex < content.count && !questionIndices.contains(nextIndex) {
                if isScreenControl(content[nextIndex]) { break }
                if isAnswerChoiceLine(content[nextIndex]) { break }
                guard !questionIsComplete && continuationCount < 4 else { break }
                selectedIndices.insert(nextIndex)
                nextIndex += 1
                continuationCount += 1
                let continuation = content[nextIndex - 1].trimmingCharacters(in: .whitespacesAndNewlines)
                if continuation.contains("?") || continuation.hasSuffix("=") { break }
            }
        }

        let selectedLines = content.indices
            .filter {
                selectedIndices.contains($0)
                    && (!isStandaloneInputMarker(content[$0]) || questionIndices.contains($0))
            }
            .map { syntheticOptions[$0] ?? content[$0] }
        return mergeInlineBlankLines(selectedLines)
    }

    /// Replaces a selected prefix or suffix with its full accessibility-captured
    /// question when the selection was interrupted by an inline form field.
    public static func recoverInlineBlankQuestion(selectedText: String, accessibilityText: String) -> String? {
        let selected = normalizeForComparison(selectedText)
        guard selected.split(separator: " ").count >= 4 else { return nil }

        let candidates = extract(from: accessibilityText.components(separatedBy: .newlines))
        return candidates.first { candidate in
            guard containsBlankMarker(candidate) else { return false }
            return normalizeForComparison(candidate).hasPrefix(selected)
        }
    }

    private static func isAnswerChoiceLine(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:Option\s+\d+\s*[:.)-]|\([A-Za-z]\)|[A-Za-z][.)]|[A-Za-z]\s*[-:])(?:\s*\S.*)?\s*$"#,
            options: .regularExpression
        ) != nil
    }

    private static func isFillInBlankHeading(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:fill\s+in\s+the\s+blank\s+question|fill\s+in\s+the\s+blank)\s*:?\s*$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func extractFillInQuestion(after headingIndex: Int, in content: [String]) -> [String] {
        var questionLines: [String] = []
        for rawLine in content.dropFirst(headingIndex + 1) {
            if isFillInSectionBoundary(rawLine) {
                if !questionLines.isEmpty { break }
                continue
            }

            let line = strippingGeneratedOptionLabel(rawLine)
            guard !line.isEmpty, !isQuestionIdentifier(line) else { continue }

            if questionLines.isEmpty {
                guard wordCount(line) >= 6, !isScreenControl(line) else { continue }
            } else if isScreenControl(line) || isAnswerChoiceLine(rawLine) {
                break
            }

            questionLines.append(line)
            if line.range(of: #"[.!?][\"'’”)]*$"#, options: .regularExpression) != nil {
                break
            }
        }

        guard !questionLines.isEmpty else {
            return [
                "Question type: fill-in-the-blank",
                "Capture incomplete: question text unavailable"
            ]
        }

        var question = mergeInlineBlankLines(questionLines).joined(separator: " ")
        // In the captured Connect screen, the inline field follows the visible
        // article in the explicit fill-in stem; normalize its trailing AX text
        // artifact to the answer slot expected at that position.
        question = question.replacingOccurrences(
            of: #"(?i)(\bis\s+called\s+)al\s*$"#,
            with: "$1a [BLANK]",
            options: .regularExpression
        )
        if question.range(of: #"\[\s*BLANK\s*\]$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            question += "."
        }

        return ["Question type: fill-in-the-blank", question]
    }

    private static func strippingGeneratedOptionLabel(_ line: String) -> String {
        line.replacingOccurrences(
            of: #"^\s*Option\s+\d+\s*[:.)-]\s*"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isQuestionIdentifier(_ line: String) -> Bool {
        line.range(of: #"^\s*\d{1,3}\s*[A-Z]\)?\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isFillInSectionBoundary(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:[•·]\s*)?(?:need help\?|rate your confidence|high$|medium$|low$|he reading$|©|privacy center$|terms of use$|submit\b|ask gemini\b|ask google\b|learning\.mheducation\.com\b)"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func isAnswerChoiceLabelOnly(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:Option\s+\d+\s*[:.)-]?|\([A-Za-z]\)|[A-Za-z][.)]|[A-Za-z]\s*[-:])\s*$"#,
            options: .regularExpression
        ) != nil
    }

    @discardableResult
    private static func addAnswerChoiceGroup(
        startingAt startIndex: Int,
        in content: [String],
        selectedIndices: inout Set<Int>
    ) -> Int {
        var nextIndex = startIndex
        var choiceCount = 0
        while nextIndex < content.count && isAnswerChoiceLine(content[nextIndex]) && choiceCount < 26 {
            let labelOnly = isAnswerChoiceLabelOnly(content[nextIndex])
            selectedIndices.insert(nextIndex)
            nextIndex += 1
            choiceCount += 1

            if labelOnly && nextIndex < content.count && !isAnswerChoiceLine(content[nextIndex]) {
                selectedIndices.insert(nextIndex)
                nextIndex += 1
                continue
            }

            var continuationCount = 0
            while nextIndex < content.count && !isAnswerChoiceLine(content[nextIndex]) && continuationCount < 3 {
                let continuation = content[nextIndex].trimmingCharacters(in: .whitespacesAndNewlines)
                let previousChoiceText = content[nextIndex - 1].trimmingCharacters(in: .whitespacesAndNewlines)
                guard isLikelyChoiceContinuation(continuation, following: previousChoiceText) else { break }
                selectedIndices.insert(nextIndex)
                nextIndex += 1
                continuationCount += 1
            }
        }
        return choiceCount
    }

    private static func isLikelyChoiceContinuation(_ line: String, following previousLine: String) -> Bool {
        guard let firstCharacter = line.first else { return false }
        let beginsLikeContinuation = firstCharacter.isLowercase || ",;:)–-".contains(firstCharacter)
        let previousEndsMidThought = previousLine.range(
            of: #"\b(?:and|or|of|to|in|on|for|with|by|from|that|which|a|an|the|because|as|is|are|was|were|into|through|between|than|more|less|,|[-–])$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
        return beginsLikeContinuation || previousEndsMidThought
    }

    private static func isQuestionLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isAnswerChoiceLine(trimmed), !isScreenControl(trimmed) else { return false }
        if trimmed.contains("?") || containsBlankMarker(trimmed) || trimmed.range(
            of: #"\d\s*[+×÷*/−-]\s*\d|\bfill(?:ing)?\s+(?:in\s+)?(?:the\s+)?blank\b|\bcomplete\s+(?:the\s+)?(?:blank|sentence|statement)\b|\b(?:missing|insert|supply)\s+(?:the\s+)?(?:words?|terms?|phrases?)\b|\b(?:stands\s+for|is\s+the|are\s+the|is\s+called|is\s+known\s+as)\s*(?:a\(n\))?\s*[.!]?\s*$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return true
        }
        let lowercased = trimmed.lowercased()
        let numberedPrefix = lowercased.range(of: #"^\d+[.)]\s*"#, options: .regularExpression)
        let questionStart = numberedPrefix.map { String(lowercased[$0.upperBound...]) } ?? lowercased
        return [
            "what ", "which ", "why ", "how ", "when ", "where ", "who ",
            "solve ", "calculate ", "compute ", "evaluate ", "determine ",
            "identify ", "select ", "find ", "name "
        ].contains { questionStart.hasPrefix($0) }
    }

    private static func isChoiceHeading(_ line: String) -> Bool {
        line.range(of: #"^(?:options?|answer choices|choices)\s*:?$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isLikelyMultipleChoicePrompt(_ line: String) -> Bool {
        containsBlankMarker(line)
            || line.contains("?")
            || line.range(
                of: #"^\s*(?:choose|select|which|what|identify|name|pick)\b"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
    }

    private static func unlabeledOptions(
        startingAt startIndex: Int,
        in content: [String],
        questionIndices: [Int] = []
    ) -> [String]? {
        guard startIndex < content.count else { return nil }
        var options: [String] = []
        for index in startIndex..<content.count {
            let line = content[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if questionIndices.contains(index) || isAnswerChoiceLine(line) || isScreenControl(line) || isChoiceHeading(line) { break }
            guard line.count <= 240, line.split(whereSeparator: \.isWhitespace).count <= 40 else { break }
            options.append(line)
            if options.count == 8 { break }
        }
        return options.count >= 2 ? options : nil
    }

    private static func isScreenControl(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:[•·]\s*)?(?:submit|next|previous|back|check answer|save and continue|time left|question\s+\d+|review|clear my choice|ask google|ask gemini|need help\?|rate your confidence|high$|medium$|low$|privacy center$|terms of use$|he reading$|©|learning\.mheducation\.com)(?:\b|[^a-z]|$)"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func containsBlankMarker(_ line: String) -> Bool {
        line.range(of: blankMarker, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isStandaloneInputMarker(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: #"^\[BLANK\]$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func hasQuestionTextAround(_ index: Int, in content: [String]) -> Bool {
        let precedingLines = Array(content[..<index].reversed().prefix(2))
        let preceding = precedingLines
            .filter { !isScreenControl($0) && !isAnswerChoiceLine($0) }
            .joined(separator: " ")
        let followingLines = Array(content.dropFirst(index + 1).prefix(3))
        let following = followingLines
            .prefix { !isScreenControl($0) && !isAnswerChoiceLine($0) && !isChoiceHeading($0) }
            .joined(separator: " ")
        let immediatePrefixIsIncomplete = precedingLines.first.map(isIncompleteQuestionStem) ?? false
        let hasQuestionPrefix = precedingLines.contains(where: isQuestionLine) && !immediatePrefixIsIncomplete
        let startsWithAnotherQuestion = followingLines.first.map(isQuestionLine) ?? false
        return (!hasQuestionPrefix && wordCount(preceding) >= 4)
            || (!startsWithAnotherQuestion && wordCount(following) >= 4)
    }

    private static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).count
    }

    private static func isIncompleteQuestionStem(_ line: String) -> Bool {
        line.range(
            of: #"\b(?:stands\s+for|is\s+the|are\s+the|is\s+called|is\s+known\s+as)\s*(?:a\(n\))?\s*$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func mergeInlineBlankLines(_ lines: [String]) -> [String] {
        var result: [String] = []
        for line in lines {
            guard let previous = result.last else {
                result.append(line)
                continue
            }
            if containsInlineInputMarker(previous) || containsInlineInputMarker(line) {
                let separator = line.first.map { ",.;:!?)]»”’".contains($0) } == true ? "" : " "
                result[result.count - 1] = "\(previous)\(separator)\(line)"
            } else {
                result.append(line)
            }
        }
        return result
    }

    private static func normalizeForComparison(_ text: String) -> String {
        text.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .joined(separator: " ")
    }

    private static func containsInlineInputMarker(_ line: String) -> Bool {
        line.range(
            of: #"\[\s*(?:blank|text\s+field|input)\s*\]"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }
}
