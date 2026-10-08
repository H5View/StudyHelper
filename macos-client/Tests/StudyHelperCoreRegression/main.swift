import Foundation
import StudyHelperCore

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

print("Mac extraction regressions passed: fill-in prompt, stomata question, all labeled choices, split labels, unlabeled choices, and screen-control removal.")
