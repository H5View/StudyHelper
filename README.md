# Study Assistant Bridge

Minimal standalone Node.js bridge for sending selected study text to a local Ollama server and returning a short answer.

## Features

- `GET /health` for bridge and Ollama reachability checks
- `POST /study-answer` protected by `X-Study-Assistant-Token`
- `POST /study-answer/stream` for streamed Mac client answers
- `GET /latest-answer` for the Windows-side viewer state
- `GET /viewer` for the Windows-side local browser viewer
- Standalone Node.js server using built-in APIs only
- Configurable host, port, model, context, thinking, keep-alive, timeout, and input length

## Files

- `server.mjs`
- `.env.example`
- `start-study-server.cmd`

## Setup

1. Make sure Ollama is running on the Windows PC at `http://127.0.0.1:11434`.
2. Edit `.env` and set a real `STUDY_ASSISTANT_TOKEN`.
3. Start the bridge:

```bat
npm.cmd start
```

Or use:

```bat
start-study-server.cmd
```

The helper starts a native Windows answer popup automatically. In `Windows PC` or `Both` mode, it appears with `Finding answer...` when a request begins, then shows the completed answer. It closes itself after a few seconds; press Escape to close it sooner.

## Environment

```env
STUDY_ASSISTANT_HOST=0.0.0.0
STUDY_ASSISTANT_PORT=8788
STUDY_ASSISTANT_TOKEN=change-me
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:12b-it-q4_K_M
OLLAMA_NUM_CTX=8192
OLLAMA_THINKING_MODE=auto
OLLAMA_KEEP_ALIVE=5m
OLLAMA_TIMEOUT_MS=600000
STUDY_ASSISTANT_MAX_INPUT_LENGTH=16000
```

`OLLAMA_NUM_CTX` is sent to Ollama as `options.num_ctx` on every chat request. The default is 8,192 tokens; set it to `4096` in `.env` and restart the bridge if the larger context causes GPU memory pressure. The bridge logs the configured context, Ollama's prompt and generated token counts, estimated context utilization, and request timings. These logs do not include question text or model answers.

`OLLAMA_MODEL` selects the model for the bridge and defaults to `gemma4:12b-it-q4_K_M`. Change this environment value to move to another Ollama model; the Mac client displays the model reported by `/health` and does not choose a model itself.

`OLLAMA_THINKING_MODE` accepts `auto`, `on`, or `off`. In `auto` mode, straightforward single multiple-choice questions run with `think: false`; open-ended, long, multi-question, or reasoning-heavy prompts use `think: true`. The bridge sends Ollama's top-level `think` field and never displays or logs the model's private thinking output. Set `on` or `off` to override the heuristic.

`OLLAMA_KEEP_ALIVE` is sent as Ollama's `keep_alive` field and defaults to `5m`. Set it to `0` to unload the model after a request or choose a longer duration when you want fewer reloads. Avoid `-1` on a GPU with limited free memory unless you intend to keep the model resident indefinitely.

Ollama responses stream to the Mac popup and update the Windows viewer as answer text arrives. The existing `/study-answer` endpoint continues to return its JSON response for other clients. Bridge logs report time to first model token, prompt evaluation time, generation time, model load time, Ollama total time, and end-to-end time. Thinking text and screen content are excluded from logs and client output.

## Endpoints

### `GET /health`

Unauthenticated health check. It verifies the bridge is running and whether Ollama is reachable without doing a model generation.

Example response:

```json
{
  "bridge": "ok",
  "ollama": "ok",
  "model": "gemma4:12b-it-q4_K_M"
}
```

### `POST /study-answer`

Headers:

```text
Content-Type: application/json
X-Study-Assistant-Token: your-token
```

Body:

```json
{
  "text": "Which planet is closest to the Sun?\nA. Venus\nB. Mercury\nC. Earth\nD. Mars",
  "outputMode": "windows"
}
```

Example response:

```json
{
  "answer": "B — Mercury"
}
```

If the model initially says it cannot determine an answer, the bridge retries once with stricter best-guess instructions. When answer choices are visible, it should choose the most plausible option. The retry can add time only for questions the model initially declines.

For example, if there are no usable choices and no reasonable answer can be inferred:

```json
{
  "answer": "Unable to determine"
}
```

`outputMode` supports:

- `mac`
- `windows`
- `both`

Requests without `outputMode` still default to `mac`.

### `POST /study-answer/stream`

Uses the same authentication header and request body as `/study-answer`, and returns newline-delimited JSON events (`delta`, `status`, `reset`, `done`, or `error`). The Mac client uses this endpoint to update the existing answer popup as content arrives. Older bridges that do not have this route continue to work through the Mac client's JSON fallback.

### `GET /latest-answer`

Returns the latest Windows-viewer answer stored in memory.

Example:

```json
{
  "answer": "1. B — Mercury",
  "timestamp": "2026-08-31T16:00:00.000Z",
  "outputMode": "windows"
}
```

### `GET /viewer`

Serves a tiny local viewer page that polls `/latest-answer` and shows the newest Windows-side answer.

On the Windows PC, open this page if it is not already open:

```text
http://127.0.0.1:8788/viewer
```

This optional browser viewer updates shortly after each Mac request sent in `windows` or `both` mode. The default `start-study-server.cmd` launcher uses the native Windows popup instead.

## Firewall

If the Mac cannot reach the Windows PC over Wi-Fi, allow inbound TCP port `8788` in Windows Defender Firewall:

1. Open `Windows Defender Firewall with Advanced Security`.
2. Select `Inbound Rules`.
3. Choose `New Rule...`.
4. Select `Port`.
5. Choose `TCP` and enter `8788`.
6. Select `Allow the connection`.
7. Apply it to the network profiles you use.
8. Give the rule a name like `Study Assistant Bridge 8788`.

## Test Commands

### From Windows

Health:

```powershell
curl http://127.0.0.1:8788/health
```

Answer:

```powershell
curl -X POST http://127.0.0.1:8788/study-answer `
  -H "Content-Type: application/json" `
  -H "X-Study-Assistant-Token: change-me" `
  -d "{\"text\":\"Which planet is closest to the Sun?\nA. Venus\nB. Mercury\nC. Earth\nD. Mars\"}"
```

### From Mac

Replace `192.168.x.x` with the Windows PC LAN IP:

Health:

```bash
curl http://192.168.x.x:8788/health
```

Answer:

```bash
curl -X POST http://192.168.x.x:8788/study-answer \
  -H 'Content-Type: application/json' \
  -H 'X-Study-Assistant-Token: change-me' \
  -d '{"text":"Which planet is closest to the Sun?\nA. Venus\nB. Mercury\nC. Earth\nD. Mars"}'
```

## Notes

- The configured model is loaded by Ollama on the first real request; you do not need to start it manually.
- `GET /health` checks Ollama reachability only.
- The bridge trims input, rejects empty requests, and accepts up to 16,000 characters by default (configurable with `STUDY_ASSISTANT_MAX_INPUT_LENGTH`). There is no 4,000-character input cap; requests above the configured limit are rejected with an error instead of being silently clipped. The Mac screen extractor sends the question and labeled choices, including wrapped choice text, within its 16,000-character capture limit and logs whether extracted output hit that cap without logging screen text.
