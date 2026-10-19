import Foundation
import StudyHelperCore

let screenshotBytes = Data([0xff, 0xd8, 0xff, 0xd9])
let screenshotRequest = ScreenshotStudyRequest(image: screenshotBytes, mimeType: "image/jpeg", outputMode: "both")
let screenshotJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(screenshotRequest)) as? [String: String]
precondition(screenshotJSON?["image"] == screenshotBytes.base64EncodedString(), "screenshot bytes were not base64 encoded for the bridge")
precondition(screenshotJSON?["mimeType"] == "image/jpeg", "screenshot MIME type was not sent to the bridge")
precondition(screenshotJSON?["outputMode"] == "both", "screenshot request lost its output mode")

let stomataQuestion = "Plant leaves contain small openings called ________, through which carbon dioxide enters the plant."
let stomataInput = [
    "File Edit View Insert Format",
    stomataQuestion,
    "A) trichomes",
    "B) internodes",
    "C) stipules",
    "D) stomata",
    "Submit",
    "Ask Google"
]
let stomataExpected = [
    stomataQuestion,
    "A) trichomes",
    "B) internodes",
    "C) stipules",
    "D) stomata"
]
precondition(QuestionTextExtractor.extract(from: stomataInput) == stomataExpected, "stomata extraction lost the question or a choice")

let fillInPrompt = "Fill in the blank: DNA stands for"
precondition(
    QuestionTextExtractor.extract(from: ["File Edit View Insert Format", fillInPrompt, "Submit", "Ask Google"]) == [fillInPrompt],
    "fill-in-the-blank extraction included screen controls or dropped the prompt"
)

let chloroplastQuestion = "The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n) ____."
precondition(
    QuestionTextExtractor.extract(from: ["File Edit View Insert Format", chloroplastQuestion, "Submit", "Ask Google"]) == [chloroplastQuestion],
    "chloroplast fill-in extraction changed or dropped the trailing blank"
)

let chloroplastQuestionWithoutOCRBlank = "The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n)"
precondition(
    QuestionTextExtractor.extract(from: ["File Edit View Insert Format", chloroplastQuestionWithoutOCRBlank, "Submit", "Ask Google"]) == [chloroplastQuestionWithoutOCRBlank],
    "chloroplast question capture failed when OCR omitted the trailing blank marker"
)

let inlineRootsPrefix = "Plants absorb water from the ground through their"
let inlineRootsSuffix = "This water then moves in vascular tissue up the stem to a leaf by way of leaf veins."
let inlineRootsAccessibilityText = [inlineRootsPrefix, "[BLANK]", inlineRootsSuffix, "Submit", "Ask Google"].joined(separator: "\n")
let inlineRootsQuestion = "\(inlineRootsPrefix) [BLANK] \(inlineRootsSuffix)"
precondition(
    QuestionTextExtractor.extract(from: inlineRootsAccessibilityText.components(separatedBy: .newlines)) == [inlineRootsQuestion],
    "inline McGraw Hill input did not preserve the question prefix, blank marker, and suffix"
)
precondition(
    QuestionTextExtractor.recoverInlineBlankQuestion(
        selectedText: inlineRootsPrefix,
        accessibilityText: inlineRootsAccessibilityText
    ) == inlineRootsQuestion,
    "selection interrupted by the inline input did not recover the full Accessibility question"
)

let inlineChloroplastPrefix = "The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n)"
let inlineChloroplastQuestion = "\(inlineChloroplastPrefix) [BLANK]."
let inlineChloroplastExtracted = QuestionTextExtractor.extract(from: [inlineChloroplastPrefix, "[BLANK]", ".", "Submit"])
precondition(
    inlineChloroplastExtracted == [inlineChloroplastQuestion],
    "inline chloroplast input was not retained as a trailing blank in the sentence: \(inlineChloroplastExtracted)"
)

let chloroplastChoices = [
    "File Edit View Insert Format",
    chloroplastQuestion,
    "Option 1: mitochondrion",
    "Option 2: chloroplast",
    "Submit",
    "Ask Google"
]
precondition(
    QuestionTextExtractor.extract(from: chloroplastChoices) == [
        chloroplastQuestion,
        "Option 1: mitochondrion",
        "Option 2: chloroplast"
    ],
    "Option N choice lines were dropped or screen controls leaked into the Mac input"
)

let splitLabelInput = [
    "Which structure allows gas exchange?",
    "(A)", "stomata",
    "(B)", "trichomes"
]
precondition(
    QuestionTextExtractor.extract(from: splitLabelInput) == ["Which structure allows gas exchange?", "(A)", "stomata", "(B)", "trichomes"],
    "split parenthesized choice labels were not preserved"
)

let unrelatedInputBeforeChoice = ["[BLANK]", "Which structure allows gas exchange?", "(A) stomata", "(B) trichomes"]
precondition(
    QuestionTextExtractor.extract(from: unrelatedInputBeforeChoice) == Array(unrelatedInputBeforeChoice.dropFirst()),
    "an unrelated browser input changed multiple-choice extraction"
)

let compactLabelInput = [
    "Which structure allows gas exchange?",
    "(A)stomata",
    "(B)trichomes"
]
precondition(
    QuestionTextExtractor.extract(from: compactLabelInput) == compactLabelInput,
    "choice labels without OCR whitespace were not preserved"
)

let unlabeledInput = [
    stomataQuestion,
    "trichomes",
    "internodes",
    "stipules",
    "stomata",
    "Submit"
]
let unlabeledExpected = [
    stomataQuestion,
    "Option 1: trichomes",
    "Option 2: internodes",
    "Option 3: stipules",
    "Option 4: stomata"
]
precondition(QuestionTextExtractor.extract(from: unlabeledInput) == unlabeledExpected, "unlabeled choices were not retained and identified")

let headingInput = ["Choose the correct term.", "Options:", "trichomes", "internodes", "stipules", "stomata"]
let headingExpected = [
    "Choose the correct term.",
    "Options:",
    "Option 1: trichomes",
    "Option 2: internodes",
    "Option 3: stipules",
    "Option 4: stomata"
]
precondition(QuestionTextExtractor.extract(from: headingInput) == headingExpected, "unlabeled options after a heading were not labeled")

let questionWithOnlyControls = [
    "Which structure allows gas exchange?",
    "• Need help? Review these concept resources.",
    "Rate your confidence to submit your answer.",
    "High",
    "Medium",
    "Low"
]
precondition(
    QuestionTextExtractor.extract(from: questionWithOnlyControls) == ["Which structure allows gas exchange?"],
    "screen controls were mislabeled as answer choices: \(QuestionTextExtractor.extract(from: questionWithOnlyControls))"
)

let capturedConnectFillInText = [
    "• Ask Gemini",
    "→",
    "• learning.mheducation.com/static/awd/index.html",
    "Option 1: # School",
    "Option 2: Mc",
    "Option 3: Hill",
    "Option 4: Graw",
    "Option 5: Exit Assignment ×",
    "Option 6: 8 of 54 Concepts completed",
    "Fill in the Blank Question",
    "Option 1: 5D)",
    "Option 2: In a chloroplast, a stack of flattened thylakoid sacs is called al",
    "• Need help? Review these concept resources.",
    "Option 1: Rate your confidence to submit your answer.",
    "Option 2: High",
    "Option 3: Medium",
    "Option 4: Low",
    "Option 5: HE Reading",
    "Option 6: © 2026 McGraw Hill. All Rights Reserved. Privacy Center",
    "Option 7: Terms of Use"
]
let cleanedConnectFillInQuestion = [
    "Question type: fill-in-the-blank",
    "In a chloroplast, a stack of flattened thylakoid sacs is called a [BLANK]."
]
precondition(
    QuestionTextExtractor.extract(from: capturedConnectFillInText) == cleanedConnectFillInQuestion,
    "Connect Accessibility labels or page controls contaminated the fill-in question"
)

let fiveChoiceStem = "Which organelle carries out photosynthesis?"
let fiveChoiceTexts = ["Nucleus", "Mitochondrion", "Chloroplast", "Ribosome", "Golgi apparatus"]
let wrappedConfidenceControls = [
    "Option 1: Rate your confidence to submit your answer.",
    "Option 2: High", "Option 3: Medium", "Option 4: Low"
]
for labels in [["A", "B", "C", "D", "E"], ["(A)", "(B)", "(C)", "(D)", "(E)"]] {
    let splitChoices = zip(labels, fiveChoiceTexts).flatMap { [$0.0, $0.1] }
    let expected = [fiveChoiceStem] + splitChoices
    precondition(
        QuestionTextExtractor.extract(from: expected + wrappedConfidenceControls) == expected,
        "five split A–E choices were numbered as eight options, truncated, or contaminated by confidence controls"
    )
}
let fiveUnlabeledChoices = [fiveChoiceStem] + fiveChoiceTexts
let nucleotideChoices = ["Which base pairs with thymine?", "(A)", "A", "(B)", "G", "(C)", "C", "(D)", "T"]
precondition(
    QuestionTextExtractor.extract(from: nucleotideChoices) == nucleotideChoices,
    "one-letter choice values were confused with bare labels"
)
precondition(
    QuestionTextExtractor.extract(from: fiveUnlabeledChoices + wrappedConfidenceControls) == [fiveChoiceStem] + fiveChoiceTexts.enumerated().map { "Option \($0.offset + 1): \($0.element)" },
    "confidence controls were included in synthetic choices"
)
precondition(
    QuestionTextExtractor.extract(from: [fiveChoiceStem, "A. A structure consisting of", "flattened sacs", "B. Another structure", "submit"]) == [fiveChoiceStem, "A. A structure consisting of", "flattened sacs", "B. Another structure"],
    "wrapped choice text was lost or lowercase submit was appended"
)
let wrappedSplitChoices = [fiveChoiceStem, "A", "A structure consisting of", "flattened sacs", "B", "Another structure"]
precondition(
    QuestionTextExtractor.extract(from: wrappedSplitChoices + ["submit"]) == wrappedSplitChoices,
    "a choice with a split bare label lost its wrapped text"
)

print("Mac extraction regressions passed: split A–E labels, five-choice capture, inline inputs, fill-in prompts, and screen-control removal.")
