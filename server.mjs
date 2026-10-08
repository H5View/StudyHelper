import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { getThinkingDecision, matchAnswerToChoices, redactInputForDebug, resolveAnswer } from './study-answer-logic.mjs';
import { readOllamaEventStream } from './ollama-stream.mjs';

const env = loadEnvFile();

const HOST = env.STUDY_ASSISTANT_HOST || '0.0.0.0';
const PORT = parsePort(env.STUDY_ASSISTANT_PORT, 8788);
const TOKEN = env.STUDY_ASSISTANT_TOKEN || 'change-me';
const OLLAMA_BASE_URL = (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'gemma4:12b-it-q4_K_M';
const OLLAMA_TIMEOUT_MS = parsePositiveInt(env.OLLAMA_TIMEOUT_MS, 600000);
const OLLAMA_NUM_CTX = parsePositiveInt(env.OLLAMA_NUM_CTX, 8192);
const MAX_INPUT_LENGTH = parsePositiveInt(env.STUDY_ASSISTANT_MAX_INPUT_LENGTH, 16000);
const OLLAMA_KEEP_ALIVE = env.OLLAMA_KEEP_ALIVE || '5m';
const OLLAMA_THINKING_MODE = normalizeThinkingMode(env.OLLAMA_THINKING_MODE);
const OLLAMA_NUM_PREDICT = parsePositiveInt(env.OLLAMA_NUM_PREDICT, 256);
const OLLAMA_RETRY_NUM_PREDICT = parsePositiveInt(env.OLLAMA_RETRY_NUM_PREDICT, 128);
const DEBUG_INPUT = env.STUDY_ASSISTANT_DEBUG_INPUT === '1';
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
    .answer.working {
      color: #93c5fd;
      animation: pulse 1.1s ease-in-out infinite alternate;
    }
    @keyframes pulse {
      from { opacity: 0.55; }
      to { opacity: 1; }
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
        const answer = document.getElementById('answer');
        answer.textContent = data.answer || 'No answer yet';
        answer.classList.toggle('working', data.status === 'working');
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
  outputMode: null,
  status: 'idle'
};
let nextStudyRequestId = 0;

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

    if (req.method === 'POST' && ['/study-answer', '/study-answer/stream'].includes(req.url)) {
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
      const shouldShowOnWindows = outputMode === 'windows' || outputMode === 'both';
      const streamsToMac = req.url === '/study-answer/stream';

      if (shouldShowOnWindows) {
        setLatestAnswerState('Finding answer...', outputMode, 'working');
      }

      if (streamsToMac) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }

      const sendStreamEvent = (event) => {
        if (streamsToMac && !res.writableEnded && !res.destroyed) {
          res.write(`${JSON.stringify(event)}\n`);
        }
      };

      let answer;
      try {
        answer = await generateAnswer(text, {
          onContent: (accumulated, delta) => {
            if (shouldShowOnWindows) {
              setLatestAnswerState(accumulated, outputMode, 'working');
            }
            sendStreamEvent({ type: 'delta', content: delta });
          },
          onRetry: () => {
            if (shouldShowOnWindows) {
              setLatestAnswerState('Rechecking answer...', outputMode, 'working');
            }
            sendStreamEvent({ type: 'reset' });
            sendStreamEvent({ type: 'status', message: 'Rechecking answer…' });
          }
        });
      } catch (error) {
        if (shouldShowOnWindows) {
          setLatestAnswerState('Request failed', outputMode, 'error');
        }
        if (streamsToMac) {
          sendStreamEvent({ type: 'error', error: 'The model request failed.' });
          res.end();
          return;
        }
        throw error;
      }

      if (shouldShowOnWindows) {
        setLatestAnswerState(answer, outputMode, 'ready');
      }
      if (streamsToMac) {
        sendStreamEvent({ type: 'done', answer });
        res.end();
        return;
      }
      return sendJson(res, 200, { answer });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
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
  console.log(`Ollama context window: ${OLLAMA_NUM_CTX} tokens`);
  console.log(`Ollama keep_alive: ${OLLAMA_KEEP_ALIVE}`);
  console.log(`Ollama thinking mode: ${OLLAMA_THINKING_MODE}`);
  console.log(`Ollama output token limit: ${OLLAMA_NUM_PREDICT}`);
  console.log(`Uncertain-answer retry token limit: ${OLLAMA_RETRY_NUM_PREDICT}`);
  console.log(`Input debug logging: ${DEBUG_INPUT ? 'enabled (redacted)' : 'disabled'}`);
  console.log(`Maximum input: ${MAX_INPUT_LENGTH} characters`);
  if (lanAddresses.length > 0) {
    console.log(`LAN access: ${lanAddresses.map((address) => `http://${address}:${PORT}`).join(', ')}`);
  }
});

async function generateAnswer(text, handlers = {}) {
  const requestId = ++nextStudyRequestId;
  const startedAt = performance.now();
  let attempts = 0;
  const thinkingDecision = getThinkingDecision(text, OLLAMA_THINKING_MODE);
  const think = thinkingDecision.think;
  const questionType = thinkingDecision.questionType;

  console.log(
    `study-answer started requestId=${requestId} questionType=${questionType} chars=${text.length} lines=${text.split(/\r?\n/).length} num_ctx=${OLLAMA_NUM_CTX} num_predict=${OLLAMA_NUM_PREDICT} think=${think} thinkReason=${thinkingDecision.reason} detectedChoices=${thinkingDecision.choiceCount} keep_alive=${OLLAMA_KEEP_ALIVE}`
  );
  if (DEBUG_INPUT) {
    console.log(`study input debug requestId=${requestId} text=${JSON.stringify(redactInputForDebug(text))}`);
  }
  try {
    attempts += 1;
    const firstAnswer = await requestModel(
      text,
      buildSystemPrompt(questionType, text),
      requestId,
      'initial',
      think,
      handlers.onContent,
      OLLAMA_NUM_PREDICT
    );
    if (questionType !== 'multiple-choice') {
      return firstAnswer;
    }

    const firstResolution = resolveAnswer(firstAnswer, text);
    if (firstResolution.matchedChoice) {
      console.log(`study-answer choice matched requestId=${requestId} label=${firstResolution.choice.label}`);
      return firstResolution.answer;
    }
    if (!firstResolution.shouldRetry) {
      return firstAnswer;
    }

    console.log(`study-answer retrying requestId=${requestId} reason=uncertain-without-matched-choice`);
    handlers.onRetry?.();
    const bestGuessPrompt = [
      'Choose the most plausible answer from the supplied choices.',
      'Do not browse, refuse, or add an explanation.',
      'Return only the selected choice label and exact choice text, or the exact choice text for unlabeled choices.'
    ].join(' ');
    attempts += 1;
    const retryAnswer = await requestModel(
      text,
      bestGuessPrompt,
      requestId,
      'best-guess',
      false,
      handlers.onContent,
      Math.min(OLLAMA_RETRY_NUM_PREDICT, OLLAMA_NUM_PREDICT)
    );
    return matchAnswerToChoices(retryAnswer, text)?.answer ?? retryAnswer;
  } finally {
    console.log(
      `study-answer finished requestId=${requestId} elapsedMs=${Math.round(performance.now() - startedAt)} attempts=${attempts} chars=${text.length}`
    );
  }
}

function buildSystemPrompt(questionType, text) {
  const shared = [
    'Use only the supplied question text; do not browse or recommend outside research.',
    'Ignore interface text if any remains in the input.',
    'If multiple questions are present, answer each in order on separate lines.'
  ];
  if (questionType === 'multiple-choice') {
    return [
      ...shared,
      'For each multiple-choice question, select the best-supported option. If uncertain, choose the closest supported answer rather than refusing.',
      'Return the answer letter and exact choice text, followed by one short explanatory sentence. For unlabeled choices, use the provided Option N label.',
      'Do not include long reasoning, uncertainty disclaimers, or follow-up advice.'
    ].join(' ');
  }

  if (questionType === 'fill-in-the-blank') {
    const explanationRequested = /\b(?:explain|why|how|show (?:your )?work|give (?:an )?explanation)\b/i.test(text);
    return [
      ...shared,
      'This is a fill-in-the-blank question. Supply the missing word or shortest correct phrase directly.',
      'Do not choose an answer letter or invent answer choices.',
      explanationRequested
        ? 'The question requests an explanation, so give the missing word or phrase first, followed by a concise explanation.'
        : 'Return only the missing word or phrase. Do not add an explanation, preamble, uncertainty disclaimer, or follow-up advice.'
    ].join(' ');
  }

  return [
    ...shared,
    'This is a short-answer question. Give a concise, direct answer without requiring or inventing answer choices.',
    'Use one short sentence unless the question explicitly requests an explanation or more detail.'
  ].join(' ');
}

async function requestModel(text, systemPrompt, requestId, attempt, think, onContent, numPredict = null) {
  const payload = {
    model: OLLAMA_MODEL,
    stream: true,
    think,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: {
      temperature: 0,
      num_ctx: OLLAMA_NUM_CTX,
      num_predict: numPredict ?? OLLAMA_NUM_PREDICT
    },
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: text
      }
    ]
  };

  const startedAt = performance.now();
  let accumulatedContent = '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  console.log(
    `ollama request started requestId=${requestId} attempt=${attempt} model=${OLLAMA_MODEL} num_ctx=${OLLAMA_NUM_CTX} num_predict=${numPredict ?? OLLAMA_NUM_PREDICT} think=${think} keep_alive=${OLLAMA_KEEP_ALIVE} inputChars=${text.length}`
  );

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw createHttpError(502, `Ollama request failed${details ? `: ${details}` : '.'}`);
    }

    let streamResult;
    try {
      streamResult = await readOllamaEventStream(response.body, (accumulated, delta) => {
        accumulatedContent = accumulated;
        onContent?.(accumulated, delta, attempt);
      }, startedAt);
    } catch (error) {
      throw createHttpError(502, error.message || 'Ollama returned an invalid streaming response.');
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    accumulatedContent = streamResult.content;
    logOllamaUsage(
      streamResult.finalEvent ?? {},
      elapsedMs,
      requestId,
      attempt,
      streamResult.timeToFirstTokenMs,
      think
    );
    const content = normalizeModelAnswer(accumulatedContent);
    return content || 'Unable to determine';
  } catch (error) {
    const requestError = error?.name === 'AbortError'
      ? createHttpError(504, `Request timed out after ${OLLAMA_TIMEOUT_MS} ms.`)
      : error;
    console.log(
      `ollama request failed requestId=${requestId} attempt=${attempt} elapsedMs=${Math.round(performance.now() - startedAt)} error=${requestError?.statusCode || requestError?.name || 'Error'}`
    );
    throw requestError;
  } finally {
    clearTimeout(timeout);
  }
}

function logOllamaUsage(data, elapsedMs, requestId, attempt, timeToFirstTokenMs, think) {
  const promptTokens = finiteNumber(data?.prompt_eval_count);
  const completionTokens = finiteNumber(data?.eval_count);
  const contextTokens = promptTokens === null || completionTokens === null
    ? null
    : promptTokens + completionTokens;
  const contextUsagePercent = contextTokens === null
    ? null
    : Math.round((contextTokens / OLLAMA_NUM_CTX) * 100);
  const promptEvalMs = nanosecondsToMilliseconds(data?.prompt_eval_duration);
  const evalMs = nanosecondsToMilliseconds(data?.eval_duration);
  const generationTokensPerSecond = completionTokens !== null && evalMs > 0
    ? Math.round((completionTokens / (evalMs / 1000)) * 10) / 10
    : null;

  console.log([
    'ollama request finished',
    `requestId=${requestId}`,
    `attempt=${attempt}`,
    `elapsedMs=${elapsedMs}`,
    `timeToFirstTokenMs=${timeToFirstTokenMs ?? 'unknown'}`,
    `think=${think}`,
    `num_ctx=${OLLAMA_NUM_CTX}`,
    `promptTokens=${promptTokens ?? 'unknown'}`,
    `completionTokens=${completionTokens ?? 'unknown'}`,
    `contextTokens=${contextTokens ?? 'unknown'}`,
    `contextUsagePercent=${contextUsagePercent ?? 'unknown'}`,
    `promptEvalMs=${promptEvalMs ?? 'unknown'}`,
    `evalMs=${evalMs ?? 'unknown'}`,
    `ollamaTotalMs=${nanosecondsToMilliseconds(data?.total_duration) ?? 'unknown'}`,
    `loadMs=${nanosecondsToMilliseconds(data?.load_duration) ?? 'unknown'}`,
    `generationTokensPerSecond=${generationTokensPerSecond ?? 'unknown'}`
  ].join(' '));
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function nanosecondsToMilliseconds(value) {
  const nanoseconds = finiteNumber(value);
  return nanoseconds === null ? null : Math.round(nanoseconds / 1_000_000);
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

function setLatestAnswerState(answer, outputMode, status) {
  latestAnswerState = {
    answer,
    timestamp: new Date().toISOString(),
    outputMode,
    status
  };
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

function normalizeThinkingMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
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
