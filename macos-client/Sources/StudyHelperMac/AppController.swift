import AppKit
import Foundation

private enum DefaultsKey {
    static let answerDisplayMode = "answerDisplayMode"
}

@MainActor
final class AppController: NSObject {
    private let configuration = AppConfiguration()
    private lazy var bridgeClient = BridgeClient(configuration: configuration)
    private let selectionCaptureService = SelectionCaptureService()
    private let popupController = PopupController()
    private var hotKeyMonitor: HotKeyMonitor?
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var answerDisplayMenuItem: NSMenuItem?
    private var activeRequest: Task<Void, Never>?
    private var latestRequestID = UUID()
    private var lastHotKeyTime = Date.distantPast
    private var answerDisplayMode = UserDefaults.standard.answerDisplayMode {
        didSet {
            UserDefaults.standard.answerDisplayMode = answerDisplayMode
            refreshAnswerDisplayMenu()
        }
    }

    func start() {
        setupStatusItem()
        updateStatus(text: selectionCaptureService.isAccessibilityTrusted(prompt: false) ? "Ready" : "Accessibility required")

        let monitor = HotKeyMonitor { [weak self] in
            Task { @MainActor in
                self?.handleHotKey()
            }
        }
        monitor.start()
        hotKeyMonitor = monitor
    }

    func stop() {
        activeRequest?.cancel()
        hotKeyMonitor?.stop()
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "SH"

        let menu = NSMenu()

        let statusItem = NSMenuItem(title: "Status: Starting…", action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        menu.addItem(
            withTitle: "Test Connection",
            action: #selector(testConnection),
            keyEquivalent: ""
        ).target = self

        menu.addItem(
            withTitle: "Open Accessibility Settings",
            action: #selector(openAccessibilitySettings),
            keyEquivalent: ""
        ).target = self

        let answerDisplayItem = NSMenuItem(title: "Answer Display", action: nil, keyEquivalent: "")
        answerDisplayItem.submenu = makeAnswerDisplayMenu()
        menu.addItem(answerDisplayItem)
        self.answerDisplayMenuItem = answerDisplayItem

        menu.addItem(.separator())

        menu.addItem(
            withTitle: "Quit",
            action: #selector(quitApp),
            keyEquivalent: "q"
        ).target = self

        item.menu = menu
        self.statusItem = item
        self.statusMenuItem = statusItem
        refreshAnswerDisplayMenu()
    }

    private func makeAnswerDisplayMenu() -> NSMenu {
        let submenu = NSMenu(title: "Answer Display")

        for mode in [AnswerDisplayMode.mac, .windows] {
            let item = NSMenuItem(
                title: mode.menuTitle,
                action: #selector(selectAnswerDisplayMode(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = mode.rawValue
            submenu.addItem(item)
        }

        return submenu
    }

    private func refreshAnswerDisplayMenu() {
        guard let items = answerDisplayMenuItem?.submenu?.items else { return }

        for item in items {
            let rawValue = item.representedObject as? String
            item.state = rawValue == answerDisplayMode.rawValue ? .on : .off
        }
    }

    private func handleHotKey() {
        let now = Date()
        guard now.timeIntervalSince(lastHotKeyTime) >= configuration.hotKeyDebounceInterval else {
            return
        }

        lastHotKeyTime = now
        latestRequestID = UUID()
        let requestID = latestRequestID
        let outputMode = answerDisplayMode

        activeRequest?.cancel()
        if outputMode.sendsPopupToMac {
            popupController.showLoading()
        } else {
            popupController.dismiss()
        }
        updateStatus(text: "Looking up answer…")

        activeRequest = Task { [weak self] in
            guard let self else { return }

            do {
                let selectedText = try await self.selectionCaptureService.captureSelectedText()
                try Task.checkCancellation()

                let answer = try await self.bridgeClient.fetchStudyAnswer(for: selectedText, outputMode: outputMode)
                try Task.checkCancellation()

                await MainActor.run {
                    guard self.latestRequestID == requestID else { return }
                    if outputMode.sendsPopupToMac {
                        self.popupController.showMessage(answer, autoDismissAfter: self.configuration.popupDuration)
                    } else {
                        self.popupController.dismiss()
                    }
                    self.updateStatus(text: "Ready")
                }
            } catch is CancellationError {
                await MainActor.run {
                    guard self.latestRequestID == requestID else { return }
                    self.updateStatus(text: "Ready")
                }
            } catch {
                await MainActor.run {
                    guard self.latestRequestID == requestID else { return }
                    self.popupController.showMessage(self.message(for: error), autoDismissAfter: self.configuration.popupDuration)
                    self.updateStatus(text: "Ready")
                }
            }
        }
    }

    private func updateStatus(text: String) {
        statusMenuItem?.title = "Status: \(text)"
    }

    private func message(for error: Error) -> String {
        switch error {
        case SelectionCaptureError.accessibilityRequired:
            return "Accessibility required"
        case SelectionCaptureError.noTextSelected:
            return "No text selected"
        case BridgeClientError.pcUnavailable:
            return "PC unavailable"
        case BridgeClientError.answerTimedOut:
            return "Answer timed out"
        case BridgeClientError.modelUnavailable:
            return "Model unavailable"
        default:
            return "Request failed"
        }
    }

    @objc
    private func selectAnswerDisplayMode(_ sender: NSMenuItem) {
        guard
            let rawValue = sender.representedObject as? String,
            let mode = AnswerDisplayMode(rawValue: rawValue)
        else {
            return
        }

        answerDisplayMode = mode
    }

    @objc
    private func testConnection() {
        updateStatus(text: "Testing connection…")
        popupController.showLoading(text: "Checking…")

        Task { [weak self] in
            guard let self else { return }
            let message: String

            do {
                let health = try await self.bridgeClient.fetchHealth()
                message = "Connected — \(health.model)"
            } catch {
                message = "Bridge unavailable"
            }

            await MainActor.run {
                self.popupController.showMessage(message, autoDismissAfter: self.configuration.popupDuration)
                self.updateStatus(text: "Ready")
            }
        }
    }

    @objc
    private func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    @objc
    private func quitApp() {
        NSApp.terminate(nil)
    }
}

private extension UserDefaults {
    var answerDisplayMode: AnswerDisplayMode {
        get {
            guard
                let rawValue = string(forKey: DefaultsKey.answerDisplayMode),
                let mode = AnswerDisplayMode(rawValue: rawValue)
            else {
                return .mac
            }

            return mode
        }
        set {
            set(newValue.rawValue, forKey: DefaultsKey.answerDisplayMode)
        }
    }
}
