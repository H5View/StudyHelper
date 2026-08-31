import AppKit
import ApplicationServices

enum SelectionCaptureError: Error {
    case accessibilityRequired
    case noTextSelected
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
