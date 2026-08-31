import Carbon
import Foundation

final class HotKeyMonitor {
    private static let hotKeySignature: OSType = 0x5354484C

    private let onTrigger: () -> Void
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private var eventHandler: EventHandlerUPP?

    init(onTrigger: @escaping () -> Void) {
        self.onTrigger = onTrigger
    }

    deinit {
        stop()
    }

    func start() {
        stop()

        var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

        eventHandler = hotKeyEventHandler

        if let eventHandler {
            InstallEventHandler(GetApplicationEventTarget(), eventHandler, 1, &eventSpec, userData, &eventHandlerRef)
        }

        let hotKeyID = EventHotKeyID(signature: Self.hotKeySignature, id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    func stop() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }

        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
            self.eventHandlerRef = nil
        }

        eventHandler = nil
    }
}

private let hotKeyEventHandler: EventHandlerUPP = { _, event, userData in
    guard let userData else {
        return noErr
    }

    let monitor = Unmanaged<HotKeyMonitor>.fromOpaque(userData).takeUnretainedValue()

    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )

    guard status == noErr, hotKeyID.signature == 0x5354484C else {
        return noErr
    }

    monitor.trigger()
    return noErr
}

private extension HotKeyMonitor {
    func trigger() {
        onTrigger()
    }
}
