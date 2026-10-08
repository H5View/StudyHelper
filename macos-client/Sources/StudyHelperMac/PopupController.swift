import AppKit
import SwiftUI

@MainActor
final class PopupController {
    private let panelWidth: CGFloat = 260
    private let minimumPanelHeight: CGFloat = 80
    private let maximumPanelHeight: CGFloat = 220
    private let viewModel = PopupViewModel()
    private var panel: NSPanel?
    private var dismissTask: Task<Void, Never>?
    private var escapeMonitor: Any?

    func showLoading(text: String = "Loading…") {
        dismissTask?.cancel()
        viewModel.message = text
        viewModel.isLoading = true
        showPanel()
    }

    func showStreamingMessage(_ message: String) {
        dismissTask?.cancel()
        viewModel.message = message
        viewModel.isLoading = false
        showPanel()
    }

    func showMessage(_ message: String, autoDismissAfter duration: TimeInterval) {
        dismissTask?.cancel()
        viewModel.message = message
        viewModel.isLoading = false
        showPanel()

        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.dismiss()
            }
        }
    }

    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        panel?.orderOut(nil)
        removeEscapeMonitor()
    }

    private func showPanel() {
        let panel = makePanelIfNeeded()
        installEscapeMonitorIfNeeded()
        resize(panel: panel)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.layoutIfNeeded()
        position(panel: panel)
        panel.orderFrontRegardless()
    }

    private func makePanelIfNeeded() -> NSPanel {
        if let panel {
            return panel
        }

        let rootView = PopupView(viewModel: viewModel)
        let hostingView = NSHostingView(rootView: rootView)
        hostingView.frame = CGRect(x: 0, y: 0, width: panelWidth, height: minimumPanelHeight)

        let panel = NSPanel(
            contentRect: CGRect(x: 0, y: 0, width: panelWidth, height: minimumPanelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.contentView = hostingView

        self.panel = panel
        return panel
    }

    private func resize(panel: NSPanel) {
        guard let hostingView = panel.contentView else { return }

        let fittingHeight = hostingView.fittingSize.height
        let height = min(max(fittingHeight, minimumPanelHeight), maximumPanelHeight)
        let size = CGSize(width: panelWidth, height: height)
        hostingView.frame = CGRect(origin: .zero, size: size)
        panel.setContentSize(size)
    }

    private func position(panel: NSPanel) {
        guard let screen = preferredScreen() else { return }
        let frame = panel.frame
        let visibleFrame = screen.visibleFrame
        let origin = CGPoint(
            x: visibleFrame.maxX - frame.width - 16,
            y: visibleFrame.maxY - frame.height - 16
        )
        panel.setFrameOrigin(origin)
    }

    private func preferredScreen() -> NSScreen? {
        let mouseLocation = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(mouseLocation, $0.frame, false) }) ?? NSScreen.main
    }

    private func installEscapeMonitorIfNeeded() {
        guard escapeMonitor == nil else { return }

        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return }
            Task { @MainActor in
                self?.dismiss()
            }
        }
    }

    private func removeEscapeMonitor() {
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
    }
}

@MainActor
final class PopupViewModel: ObservableObject {
    @Published var message = ""
    @Published var isLoading = false
}
