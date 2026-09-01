import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

const env = loadEnvFile();

const HOST = env.STUDY_ASSISTANT_HOST || '0.0.0.0';
const PORT = parsePort(env.STUDY_ASSISTANT_PORT, 8788);
const TOKEN = env.STUDY_ASSISTANT_TOKEN || 'change-me';
const OLLAMA_BASE_URL = (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'gemma4:latest';
const OLLAMA_TIMEOUT_MS = parsePositiveInt(env.OLLAMA_TIMEOUT_MS, 180000);
const MAX_INPUT_LENGTH = parsePositiveInt(env.STUDY_ASSISTANT_MAX_INPUT_LENGTH, 4000);
const VALID_OUTPUT_MODES = new Set(['mac', 'windows', 'both']);
const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StudyHelper Viewer</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: linear-gradient(180deg, #111827, #0f172a);
      color: #f8fafc;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(720px, 100%);
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      padding: 20px;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 12px;
    }
    .answer {
      white-space: pre-wrap;
      font-size: clamp(24px, 4vw, 38px);
      line-height: 1.3;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="meta">
      <div id="updated">Waiting for answer…</div>
      <div id="mode"></div>
    </div>
    <div class="answer" id="answer">No answer yet</div>
  </div>
  <script>
    let lastTimestamp = '';
    async function refresh() {
      try {
        const response = await fetch('/latest-answer', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (data.timestamp === lastTimestamp) return;
        lastTimestamp = data.timestamp || '';
        document.getElementById('answer').textContent = data.answer || 'No answer yet';
        document.getElementById('updated').textContent = data.timestamp ? 'Updated: ' + new Date(data.timestamp).toLocaleString() : 'Waiting for answer…';
        document.getElementById('mode').textContent = data.outputMode ? 'Mode: ' + data.outputMode : '';
      } catch {}
    }
    refresh();
    setInterval(refresh, 750);
  </script>
</body>
</html>`;

let latestAnswerState = {
  answer: '',
  timestamp: null,
  outputMode: null
};

const SYSTEM_PROMPT = [
  'Answer study/practice questions.',
  'Detect whether there is one question or multiple questions.',
  "For one question, return only 'LETTER — answer' or a short answer.",
  "For multiple questions, answer every question, preserve numbering, keep the same order, and return only lines like '1. LETTER — answer'.",
  'Never combine multiple questions into one answer.',
  'No explanations or reasoning.',
  'Keep responses extremely concise.',
  "If unclear, return exactly 'Unable to determine'."
].join(' ');

const server = createServer(async (req, res) => {
  try {
    setJsonHeaders(res);

    if (req.method === 'GET' && req.url === '/health') {
      const healthy = await checkOllama();
      return sendJson(res, healthy.ok ? 200 : 503, {
        bridge: 'ok',
        ollama: healthy.ok ? 'ok' : 'unreachable',
        model: OLLAMA_MODEL
      });
    }

    if (req.method === 'GET' && req.url === '/latest-answer') {
      return sendJson(res, 200, latestAnswerState);
    }

    if (req.method === 'GET' && req.url === '/viewer') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(VIEWER_HTML);
      return;
    }

    if (req.method === 'POST' && req.url === '/study-answer') {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }

      const body = await readJsonBody(req);
      const rawText = typeof body.text === 'string' ? body.text : '';
      const text = normalizeInput(rawText);

      if (!text) {
        return sendJson(res, 400, { error: 'The text field is required.' });
      }

      if (text.length > MAX_INPUT_LENGTH) {
        return sendJson(res, 413, {
          error: `Input exceeds maximum length of ${MAX_INPUT_LENGTH} characters.`
        });
      }

      const outputMode = normalizeOutputMode(body.outputMode);
      const answer = await generateAnswer(text);
      if (outputMode === 'windows' || outputMode === 'both') {
        latestAnswerState = {
          answer,
          timestamp: new Date().toISOString(),
          outputMode
        };
      }
      return sendJson(res, 200, { answer });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    const message = error?.expose ? error.message : 'Internal server error';
    return sendJson(res, statusCode, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  const lanAddresses = getLanIPv4Addresses();
  console.log(`Study assistant bridge listening on http://${HOST}:${PORT}`);
  console.log(`Ollama base URL: ${OLLAMA_BASE_URL}`);
  console.log(`Model: ${OLLAMA_MODEL}`);
  if (lanAddresses.length > 0) {
    console.log(`LAN access: ${lanAddresses.map((address) => `http://${address}:${PORT}`).join(', ')}`);
  }
});

async function generateAnswer(text) {
  const payload = {
    model: OLLAMA_MODEL,
    stream: false,
    options: {
      temperature: 0
    },
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: text
      }
    ]
  };

  const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await safeReadText(response);
    throw createHttpError(502, `Ollama request failed${details ? `: ${details}` : '.'}`);
  }

  const data = await response.json();
  const content = normalizeModelAnswer(data?.message?.content);
  return content || 'Unable to determine';
}

async function checkOllama() {
  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET'
    }, Math.min(OLLAMA_TIMEOUT_MS, 5000));

    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_INPUT_LENGTH * 4) {
      throw createHttpError(413, 'Request body is too large.', true);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    throw createHttpError(400, 'Request body must be valid JSON.', true);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(400, 'Request body must be valid JSON.', true);
  }
}

function isAuthorized(req) {
  const receivedToken = req.headers['x-study-assistant-token'];
  return typeof receivedToken === 'string' && receivedToken === TOKEN;
}

function normalizeInput(value) {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function normalizeOutputMode(value) {
  if (typeof value !== 'string') {
    return 'mac';
  }

  const mode = value.trim().toLowerCase();
  return VALID_OUTPUT_MODES.has(mode) ? mode : 'mac';
}

function normalizeModelAnswer(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let answer = value.replace(/\r\n/g, '\n').trim();
  answer = answer.replace(/^['"\s]+|['"\s]+$/g, '');
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  answer = lines.join('\n').trim();
  return answer.slice(0, 500) || 'Unable to determine';
}

function setJsonHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createHttpError(statusCode, message, expose = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = expose;
  return error;
}

async function fetchWithTimeout(url, options, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createHttpError(504, `Request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeReadText(response) {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return '';
  }
}

function loadEnvFile() {
  const result = {};

  try {
    const raw = readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key && !(key in result)) {
        result[key] = stripQuotes(value);
      }
    }
  } catch {}

  return {
    ...result,
    ...process.env
  };
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getLanIPv4Addresses() {
  const interfaces = networkInterfaces();
  const addresses = [];

  for (const details of Object.values(interfaces)) {
    for (const item of details || []) {
      if (item && item.family === 'IPv4' && !item.internal) {
        addresses.push(item.address);
      }
    }
  }

  return [...new Set(addresses)];
}
