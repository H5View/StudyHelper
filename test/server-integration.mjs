import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const calls = [];

const ollama = createServer(async (request, response) => {
  if (request.url === '/api/tags') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
    return;
  }

  let requestBody = '';
  for await (const chunk of request) requestBody += chunk;
  const payload = JSON.parse(requestBody);
  calls.push(payload);
  const question = payload.messages.at(-1).content;
  const uncertainRetryCase = question.includes('RETRY_CASE');
  const retryNumber = calls.filter((call) => call.messages.at(-1).content.includes('RETRY_CASE')).length;
  const answer = uncertainRetryCase && retryNumber === 2 ? 'D) stomata' :
    uncertainRetryCase ? 'Ask Google' :
      question.includes('Option 4: stomata') ? 'stomata' : 'D — stomata. The wording is unclear.';

  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.write(`${JSON.stringify({ message: { thinking: 'PRIVATE_TRACE: ask Google, unclear' }, done: false })}\n`);
  const parts = answer.match(/.{1,8}/gu) ?? [answer];
  for (const part of parts) {
    response.write(`${JSON.stringify({ message: { content: part }, done: false })}\n`);
    await delay(2);
  }
  response.end(`${JSON.stringify({
    message: { content: '' },
    done: true,
    prompt_eval_count: 100,
    prompt_eval_duration: 20_000_000,
    eval_count: 5,
    eval_duration: 50_000_000,
    total_duration: 80_000_000,
    load_duration: 2_000_000
  })}\n`);
});

await new Promise((resolveListen, rejectListen) => {
  ollama.once('error', rejectListen);
  ollama.listen(0, '127.0.0.1', resolveListen);
});
const ollamaPort = ollama.address().port;
const bridgePort = await getFreePort();
const bridge = spawn(process.execPath, ['server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    STUDY_ASSISTANT_HOST: '127.0.0.1',
    STUDY_ASSISTANT_PORT: String(bridgePort),
    STUDY_ASSISTANT_TOKEN: 'integration-test-token',
    OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
    OLLAMA_MODEL: 'gemma4:12b-it-q4_K_M',
    OLLAMA_NUM_CTX: '8192',
    OLLAMA_THINKING_MODE: 'auto',
    OLLAMA_KEEP_ALIVE: '5m',
    OLLAMA_RETRY_NUM_PREDICT: '128',
    STUDY_ASSISTANT_DEBUG_INPUT: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
bridge.stdout.on('data', (chunk) => { logs += chunk.toString(); });
bridge.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  await waitForBridge(bridgePort);

  const labeledQuestion = [
    'Name: Sample Student',
    'sample.student@example.test',
    'Plant leaves contain small openings called ________, through which carbon dioxide enters the plant.',
    '(A)trichomes', '(B)internodes', '(C)stipules', '(D)stomata'
  ].join('\n');
  const labeled = await postStream(bridgePort, labeledQuestion);
  assert.equal(labeled.answer, 'D — stomata');
  assert.equal(calls.length, 1, 'a valid answer with a misleading thinking trace triggered a retry');
  assert.equal(calls[0].think, false, 'simple parenthesized/no-space choices enabled thinking');
  assert.equal(calls[0].options.num_ctx, 8192);
  assert.equal(calls[0].model, 'gemma4:12b-it-q4_K_M');
  assert.equal(calls[0].keep_alive, '5m');
  assert.match(calls[0].messages[0].content, /Do not browse or recommend outside research/);
  assert.doesNotMatch(calls[0].messages[0].content, /google/i);
  assert.doesNotMatch(JSON.stringify(labeled.events), /PRIVATE_TRACE|Ask Google/);

  const unlabeledQuestion = [
    'Plant leaves contain small openings called ________, through which carbon dioxide enters the plant.',
    'Option 1: trichomes', 'Option 2: internodes', 'Option 3: stipules', 'Option 4: stomata'
  ].join('\n');
  const unlabeled = await postStream(bridgePort, unlabeledQuestion);
  assert.equal(unlabeled.answer, 'Option 4 — stomata');
  assert.equal(calls.length, 2, 'a valid unlabeled-choice answer triggered a retry');
  assert.equal(calls[1].think, false);

  const retryQuestion = `RETRY_CASE\nExplain why plants need stomata.\nA) trichomes\nB) internodes\nC) stipules\nD) stomata`;
  const retried = await postStream(bridgePort, retryQuestion);
  assert.equal(retried.answer, 'D — stomata');
  assert.equal(calls.length, 4, 'uncertain answer should receive exactly one retry');
  assert.equal(calls[2].think, true, 'complex initial request should permit thinking');
  assert.equal(calls[3].think, false, 'short retry should disable thinking');
  assert.equal(calls[3].options.num_predict, 128, 'retry token limit was not applied');

  assert.match(logs, /think=false thinkReason=straightforward-multiple-choice detectedChoices=4/);
  assert.match(logs, /Name: \[redacted\]/);
  assert.match(logs, /\[email\]/);
  assert.equal(logs.includes('sample.student@example.test'), false, 'opt-in trace did not redact email');
  assert.equal(logs.includes('PRIVATE_TRACE'), false, 'hidden thinking was logged');
  console.log('Bridge integration regressions passed: model/context, thinking, retries, hidden thinking, choice mapping, and redacted input trace.');
} finally {
  bridge.kill('SIGTERM');
  await Promise.race([once(bridge, 'exit'), delay(3000)]);
  await new Promise((resolveClose) => ollama.close(resolveClose));
}

async function postStream(port, text) {
  const response = await fetch(`http://127.0.0.1:${port}/study-answer/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-study-assistant-token': 'integration-test-token' },
    body: JSON.stringify({ text, outputMode: 'mac' })
  });
  assert.equal(response.status, 200);
  const events = [];
  for await (const line of response.body.pipeThrough(new TextDecoderStream()).pipeThrough(splitLines())) {
    if (line.trim()) events.push(JSON.parse(line));
  }
  return { events, answer: events.findLast((event) => event.type === 'done')?.answer };
}

async function waitForBridge(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (bridge.exitCode !== null) throw new Error(`bridge exited early: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error('bridge did not start');
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function splitLines() {
  let pending = '';
  return new TransformStream({
    transform(chunk, controller) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(line);
    },
    flush(controller) {
      if (pending) controller.enqueue(pending);
    }
  });
}
