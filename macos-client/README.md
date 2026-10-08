# StudyHelper macOS Client

Native macOS menu bar utility for the local StudyHelper bridge.

## Build

```bash
cd macos-client
swift build
```

Run the pure question extraction regression checks with:

```bash
cd macos-client
swift run StudyHelperCoreRegression
```

## Run

```bash
cd macos-client
swift run StudyHelperMac
```

## Current bridge configuration

- URL: `http://192.168.86.51:8788`
- Token: `change-me`

The Windows bridge selects the Ollama model through its `OLLAMA_MODEL` setting. The Mac client shows the active model returned by `GET /health`; it has no separate model selection setting.

## Permissions

Accessibility is required for selected-text capture and the clipboard fallback. Read Screen needs Screen Recording permission so macOS can capture the frontmost window for text recognition.

Path:

`System Settings > Privacy & Security > Accessibility`

`System Settings > Privacy & Security > Screen Recording`

After enabling Screen Recording for StudyHelper, quit and reopen the Mac app.

## Menu

- `Status`
- `Test Connection`
- `Open Accessibility Settings`
- `Open Screen Recording Settings`
- `Answer Display`
- `Question Input`
- `Copy Last Screen Text`
- `Quit`

### Answer Display

- `MacBook`: answer popup appears only on the Mac
- `Windows PC`: answer is sent to the Windows viewer and the Mac suppresses the success popup

The selected mode is saved with `UserDefaults` and survives app restarts.

### Question Input

- `Selected Text`: the default. It keeps the existing highlighted-text retrieval and clipboard-preserving fallback.
- `Read Screen`: captures the frontmost app window in memory, recognizes its visible text, and sends likely question lines with their answer choices. Accessibility text is checked first for browser text inputs, which are represented as `[BLANK]` in context so text on both sides of an inline field is retained. OCR and Accessibility text use the same question extraction. It recognizes fill-in-the-blank questions, labeled choices split across lines, and unlabeled choices (which it labels `Option 1`, `Option 2`, and so on for matching). It filters common screen controls such as `Submit` and `Ask Google`. It does not save a screenshot. Screen text is capped at 16,000 characters after extraction.

Study answers stream into the existing Mac popup as the model produces answer text. Thinking traces are not shown. The Mac client falls back to the JSON answer endpoint when connected to an older bridge that does not support streaming.

If Screen Recording access is missing, StudyHelper displays `Screen Recording required`. If the frontmost window contains no recognizable text, it displays `No readable screen text`. The selected input mode is saved with `UserDefaults` and survives app restarts.

If an answer is unclear, choose `Copy Last Screen Text` from the SH menu after using Read Screen, then paste it into a text editor to inspect exactly what was sent to the bridge. The text is kept only in the running Mac app until you copy it.

## Hotkey

- Global shortcut: `Option+Space`

## Notes

- The app uses Accessibility selected-text retrieval first.
- When selected text stops at an inline browser input, the app checks the ordered Accessibility text for the matching full question and uses `[BLANK]` to preserve the field and its suffix.
- If that fails, it temporarily simulates `Command+C`, reads the clipboard, and restores the prior clipboard contents.
- The popup is top-right, always on top, and auto-dismisses after 5 seconds.
