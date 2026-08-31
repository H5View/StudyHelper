# StudyHelper macOS Client

Native macOS menu bar utility for the local StudyHelper bridge.

## Build

```bash
cd macos-client
swift build
```

## Run

```bash
cd macos-client
swift run StudyHelperMac
```

## Current bridge configuration

- URL: `http://192.168.86.51:8788`
- Token: `change-me`

## Permissions

Accessibility is required for selected-text capture and the clipboard fallback.

Path:

`System Settings > Privacy & Security > Accessibility`

## Menu

- `Status`
- `Test Connection`
- `Open Accessibility Settings`
- `Quit`

## Hotkey

- Global shortcut: `Option+Space`

## Notes

- The app uses Accessibility selected-text retrieval first.
- If that fails, it temporarily simulates `Command+C`, reads the clipboard, and restores the prior clipboard contents.
- The popup is top-right, always on top, and auto-dismisses after 5 seconds.
