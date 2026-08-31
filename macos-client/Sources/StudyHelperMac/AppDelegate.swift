import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let appController = AppController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        appController.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        appController.stop()
    }
}
