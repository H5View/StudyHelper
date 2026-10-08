import AppKit
import ApplicationServices
import StudyHelperCore
import Vision

private let maxScreenTextLength = 16_000
private let maxAccessibilityCaptureLength = 32_000

enum SelectionCaptureError: Error {
    case accessibilityRequired
    case noTextSelected
    case noReadableScreenText
    case screenRecordingRequired
}

@MainActor
struct SelectionCaptureService {
    func isAccessibilityTrusted(prompt: Bool) -> Bool {
        let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func captureSelectedText() async throws -> String {
        guard isAccessibilityTrusted(prompt: true) else {
            throw SelectionCaptureError.accessibilityRequired
        }

        if let selectedText = copySelectedTextUsingAccessibility(), !selectedText.isEmpty {
            return selectedText
        }

        if let selectedText = try await copySelectedTextViaClipboardFallback(), !selectedText.isEmpty {
            return selectedText
        }

        throw SelectionCaptureError.noTextSelected
    }

    func focusedApplicationPID() -> pid_t? {
        let systemWideElement = AXUIElementCreateSystemWide()
        if let application = copyElementAttribute(kAXFocusedApplicationAttribute as CFString, from: systemWideElement) {
            var pid: pid_t = 0
            if AXUIElementGetPid(application, &pid) == .success, pid != 0 {
                return pid
            }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    func captureReadableScreenText(from targetPID: pid_t?) throws -> String {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw SelectionCaptureError.screenRecordingRequired
        }

        if let image = captureFrontmostWindow(of: targetPID), let text = recognizeText(in: image), !text.isEmpty {
            debugLog("screenRead OCR characters=\(text.count) outputAtLimit=\(text.count >= maxScreenTextLength)")
            return text
        }

        // Some apps expose their text to Accessibility even when the image has no OCR results.
        guard isAccessibilityTrusted(prompt: true) else {
            throw SelectionCaptureError.noReadableScreenText
        }

        let systemWideElement = AXUIElementCreateSystemWide()
        guard let focusedApplication = copyElementAttribute(
            kAXFocusedApplicationAttribute as CFString,
            from: systemWideElement
        ) else {
            throw SelectionCaptureError.noReadableScreenText
        }

        let focusedElement = copyElementAttribute(
            kAXFocusedUIElementAttribute as CFString,
            from: systemWideElement
        )
        let focusedWindow = copyElementAttribute(
            kAXFocusedWindowAttribute as CFString,
            from: focusedApplication
        )
        let result = collectReadableText(from: [focusedElement, focusedWindow, focusedApplication].compactMap { $0 })
        debugLog(
            "screenRead inspected=\(result.inspectedElementCount) strings=\(result.stringCount) characters=\(result.text.count) sourceTruncated=\(result.sourceTruncated) outputTruncated=\(result.outputTruncated)"
        )

        guard !result.text.isEmpty else {
            throw SelectionCaptureError.noReadableScreenText
        }

        return result.text
    }

    private func captureFrontmostWindow(of pid: pid_t?) -> CGImage? {
        guard let pid,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else {
            return nil
        }

        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let windowID = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            else {
                continue
            }

            if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming]),
               image.width > 100, image.height > 100 {
                return image
            }
        }

        return nil
    }

    private func recognizeText(in image: CGImage) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            debugLog("screenRead OCR error=\(error)")
            return nil
        }

        let lines = (request.results ?? [])
            .sorted { left, right in
                let verticalDifference = abs(left.boundingBox.midY - right.boundingBox.midY)
                if verticalDifference < 0.015 {
                    return left.boundingBox.minX < right.boundingBox.minX
                }
                return left.boundingBox.midY > right.boundingBox.midY
            }
            .compactMap { $0.topCandidates(1).first?.string }

        let extractedText = normalizeSelection(QuestionTextExtractor.extract(from: lines).joined(separator: "\n"))
        let text = String(extractedText.prefix(maxScreenTextLength))
        debugLog(
            "screenRead OCR extractedCharacters=\(extractedText.count) sentCharacters=\(text.count) outputTruncated=\(extractedText.count > maxScreenTextLength)"
        )
        return text
    }

    private func copySelectedTextUsingAccessibility() -> String? {
        let systemWideElement = AXUIElementCreateSystemWide()

        guard
            let focusedElement = copyElementAttribute(kAXFocusedUIElementAttribute as CFString, from: systemWideElement)
        else {
            return nil
        }

        if let selectedText = copyAttribute(kAXSelectedTextAttribute as CFString, from: focusedElement) as? String {
            let trimmed = normalizeSelection(selectedText)
            return trimmed.isEmpty ? nil : trimmed
        }

        return nil
    }

    private func collectReadableText(from rootElements: [AXUIElement]) -> ScreenReadResult {
        var queue = rootElements.map { (element: $0, depth: 0) }
        var strings: [String] = []
        var uniqueStrings = Set<String>()
        var inspectedElementCount = 0
        var characterCount = 0

        while !queue.isEmpty && inspectedElementCount < 1_500 && characterCount < maxAccessibilityCaptureLength {
            let next = queue.removeFirst()
            inspectedElementCount += 1

            for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                guard let value = copyAttribute(attribute as CFString, from: next.element) as? String else {
                    continue
                }

                let normalized = normalizeSelection(value)
                if !normalized.isEmpty && uniqueStrings.insert(normalized).inserted {
                    strings.append(normalized)
                    characterCount += normalized.count + 1
                }
            }

            guard next.depth < 18 else { continue }
            let children = copyVisibleChildren(from: next.element)
            queue.append(contentsOf: children.map { (element: $0, depth: next.depth + 1) })
        }

        let rawText = strings.joined(separator: "\n")
        let extractedText = normalizeSelection(
            QuestionTextExtractor.extract(from: rawText.components(separatedBy: .newlines)).joined(separator: "\n")
        )
        return ScreenReadResult(
            text: String(extractedText.prefix(maxScreenTextLength)),
            inspectedElementCount: inspectedElementCount,
            stringCount: strings.count,
            sourceTruncated: !queue.isEmpty && (inspectedElementCount >= 1_500 || characterCount >= maxAccessibilityCaptureLength),
            outputTruncated: extractedText.count > maxScreenTextLength
        )
    }

    private func copyVisibleChildren(from element: AXUIElement) -> [AXUIElement] {
        if let children = copyAttribute(kAXVisibleChildrenAttribute as CFString, from: element) as? [AXUIElement], !children.isEmpty {
            return children
        }

        return copyAttribute(kAXChildrenAttribute as CFString, from: element) as? [AXUIElement] ?? []
    }

    private func copySelectedTextViaClipboardFallback() async throws -> String? {
        let pasteboard = NSPasteboard.general
        let snapshot = PasteboardSnapshot(pasteboard: pasteboard)
        let startingChangeCount = pasteboard.changeCount

        simulateCommandC()

        for _ in 0..<12 {
            try await Task.sleep(for: .milliseconds(50))
            if pasteboard.changeCount != startingChangeCount {
                break
            }
        }

        let selectedText = normalizeSelection(pasteboard.string(forType: .string) ?? "")
        snapshot.restore(to: pasteboard)

        return selectedText.isEmpty ? nil : selectedText
    }

    private func simulateCommandC() {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }

        let keyCode: CGKeyCode = 8
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        keyDown?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)

        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        keyUp?.flags = .maskCommand
        keyUp?.post(tap: .cghidEventTap)
    }

    private func copyAttribute(_ attribute: CFString, from element: AXUIElement) -> AnyObject? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success else {
            return nil
        }

        return value as AnyObject?
    }

    private func copyElementAttribute(_ attribute: CFString, from element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else {
            return nil
        }

        return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
    }

    private func normalizeSelection(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func debugLog(_ message: String) {
#if DEBUG
        print("[StudyHelper DEBUG] \(message)")
#endif
    }
}

private struct ScreenReadResult {
    let text: String
    let inspectedElementCount: Int
    let stringCount: Int
    let sourceTruncated: Bool
    let outputTruncated: Bool
}

private struct PasteboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init(pasteboard: NSPasteboard) {
        self.items = (pasteboard.pasteboardItems ?? []).map { item in
            var values: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    values[type] = data
                }
            }
            return values
        }
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()

        guard !items.isEmpty else {
            return
        }

        let restoredItems = items.map { entry -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in entry {
                item.setData(data, forType: type)
            }
            return item
        }

        pasteboard.writeObjects(restoredItems)
    }
}
