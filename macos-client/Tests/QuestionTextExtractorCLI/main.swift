import Foundation
import StudyHelperCore

let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
let extracted = QuestionTextExtractor.extract(from: input.components(separatedBy: .newlines))
FileHandle.standardOutput.write(Data(extracted.joined(separator: "\n").utf8))
