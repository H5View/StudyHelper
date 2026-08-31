# Study Assistant Bridge

Minimal standalone Node.js bridge for sending selected study text to a local Ollama server and returning a short answer.

## Features

- `GET /health` for bridge and Ollama reachability checks
- `POST /study-answer` protected by `X-Study-Assistant-Token`
- Standalone Node.js server using built-in APIs only
- Configurable host, port, model, timeout, and input length

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

## Environment

```env
STUDY_ASSISTANT_HOST=0.0.0.0
STUDY_ASSISTANT_PORT=8788
STUDY_ASSISTANT_TOKEN=change-me
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:latest
OLLAMA_TIMEOUT_MS=180000
STUDY_ASSISTANT_MAX_INPUT_LENGTH=4000
```

## Endpoints

### `GET /health`

Unauthenticated health check. It verifies the bridge is running and whether Ollama is reachable without doing a model generation.

Example response:

```json
{
  "bridge": "ok",
  "ollama": "ok",
  "model": "gemma4:latest"
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
  "text": "Which planet is closest to the Sun?\nA. Venus\nB. Mercury\nC. Earth\nD. Mars"
}
```

Example response:

```json
{
  "answer": "B — Mercury"
}
```

If the input is unclear, the bridge returns:

```json
{
  "answer": "Unable to determine"
}
```

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

- The model is loaded by Ollama on the first real request; you do not need to run `ollama run gemma4:latest` manually.
- `GET /health` checks Ollama reachability only.
- The bridge trims input, rejects empty requests, limits selected text size, and returns clean JSON errors.
