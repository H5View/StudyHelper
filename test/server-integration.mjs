import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const calls = [];
const rawModelResponses = [];

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
  const powerhouseRequestCount = calls.filter((call) => call.messages.at(-1).content === question).length;
  const answer = uncertainRetryCase && retryNumber === 2 ? 'D) stomata' :
    uncertainRetryCase ? 'Ask Google' :
      question.includes('NO_RETRY_FILL') ? 'Unable to determine' :
      question.includes('Option 4: stomata') ? 'stomata' :
        question.includes('double membrane-bounded organelle')
          ? powerhouseRequestCount === 1
            ? 'Option 2: The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n)'
            : 'chloroplast' :
        question.includes('powerhouse of the cell')
          ? powerhouseRequestCount === 1 ? 'The powerhouse of the cell is the' : 'mitochondrion' :
          question.includes('DNA stands for') ? 'DNA stands for deoxyribonucleic acid.' :
            question.startsWith('____ is the process of cell division') ? 'mitosis is the process of cell division.' :
              question.startsWith('____ is the process') ? 'Photosynthesis is the process by which plants convert sunlight into chemical energy.' :
                question.includes('contains genetic information') ? 'The nucleus contains genetic information.' :
              question.includes('Plants convert sunlight into ____ energy') ? 'Plants convert sunlight into chemical energy.' :
                question.includes('two main products of photosynthesis') ? 'The two main products of photosynthesis are glucose and oxygen.' :
                  question.includes('convert sunlight into chemical energy') ? 'The process by which plants convert sunlight into chemical energy is photosynthesis.' :
              question.includes('What is osmosis?') ? 'Osmosis is the movement of water across a selectively permeable membrane.' :
                'D — stomata. Stomata allow carbon dioxide to enter the leaf.';
  rawModelResponses.push({
    question,
    answer,
    think: payload.think,
    systemPrompt: payload.messages[0].content
  });

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
    OLLAMA_NUM_PREDICT: '96',
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
  assert.equal(labeled.answer, 'D — stomata. Stomata allow carbon dioxide to enter the leaf.');
  assert.equal(calls.length, 1, 'a valid answer with a misleading thinking trace triggered a retry');
  assert.equal(calls[0].think, false, 'simple parenthesized/no-space choices enabled thinking');
  assert.equal(calls[0].options.num_ctx, 8192);
  assert.equal(calls[0].model, 'gemma4:12b-it-q4_K_M');
  assert.equal(calls[0].keep_alive, '5m');
  assert.match(calls[0].messages[0].content, /do not browse or recommend outside research/i);
  assert.doesNotMatch(calls[0].messages[0].content, /google/i);
  assert.equal(calls[0].options.num_predict, 96, 'configured output token limit was not applied');
  assert.match(labeled.answer, /^D — stomata\. Stomata allow carbon dioxide/);
  assert.doesNotMatch(JSON.stringify(labeled.events), /PRIVATE_TRACE|Ask Google/);

  const unlabeledQuestion = [
    'Plant leaves contain small openings called ________, through which carbon dioxide enters the plant.',
    'Option 1: trichomes', 'Option 2: internodes', 'Option 3: stipules', 'Option 4: stomata'
  ].join('\n');
  const unlabeled = await postStream(bridgePort, unlabeledQuestion);
  assert.equal(unlabeled.answer, 'Option 4 — stomata');
  assert.equal(calls.length, 2, 'a valid unlabeled-choice answer triggered a retry');
  assert.equal(calls[1].think, false);

  const fillIns = [
    ['The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n) ____.', 'chloroplast'],
    ['The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n)', 'chloroplast'],
    ['The powerhouse of the cell is the _____.', 'mitochondrion'],
    ['DNA stands for ____.', 'deoxyribonucleic acid'],
    ['____ is the process of cell division.', 'mitosis'],
    ['The ____ contains genetic information.', 'nucleus'],
    ['The process by which plants convert sunlight into chemical energy is ____.', 'photosynthesis'],
    ['____ is the process by which plants convert sunlight into chemical energy.', 'Photosynthesis'],
    ['Plants convert sunlight into ____ energy.', 'chemical'],
    ['The two main products of photosynthesis are ____ and ____.', 'glucose; oxygen']
  ];
  for (const [question, expectedAnswer] of fillIns) {
    const before = calls.length;
    const response = await postStream(bridgePort, question);
    assert.equal(response.answer, expectedAnswer);
    assert.equal(
      response.events.filter((event) => event.type === 'delta').map((event) => event.content).join(''),
      expectedAnswer,
      'stream exposed the model completed sentence instead of only the missing span'
    );
    const neededRetry = question.includes('powerhouse of the cell') || question.includes('double membrane-bounded organelle');
    const expectedRequestCount = neededRetry ? 2 : 1;
    assert.equal(calls.length, before + expectedRequestCount, 'only an unreliable fill-in response should trigger one retry');
    const initialPayload = calls[before];
    assert.equal(initialPayload.think, false, 'straightforward fill-in-the-blank enabled thinking');
    assert.equal(initialPayload.options.num_predict, 96);
    assert.equal(initialPayload.options.num_ctx, 8192);
    assert.match(initialPayload.messages[0].content, /This is a fill-in-the-blank question/);
    assert.match(initialPayload.messages[0].content, /Do not choose an answer letter/);
    assert.match(initialPayload.messages[0].content, /Return only the missing word or phrase/);
    assert.match(initialPayload.messages[0].content, /never repeat the question or return the completed sentence/);
    assert.match(initialPayload.messages[0].content, /Do not include an explanation, introduction, quotation marks, or labels/);
    if (neededRetry) {
      const rawPrefix = question.includes('double membrane-bounded organelle')
        ? 'Option 2: The double membrane-bounded organelle in algae and plants, where photosynthesis takes place, is called a(n)'
        : 'The powerhouse of the cell is the';
      const retryAnswer = question.includes('double membrane-bounded organelle') ? 'chloroplast' : 'mitochondrion';
      assert.equal(rawModelResponses[before].answer, rawPrefix, 'test must compare the raw Ollama final response');
      const retryPayload = calls[before + 1];
      assert.equal(retryPayload.think, false, 'fill-in extraction retry must disable thinking');
      assert.match(retryPayload.messages[0].content, /Return ONLY the missing word or shortest correct phrase/);
      assert.match(retryPayload.messages[0].content, /Do not repeat any part of the question/);
      assert.equal(rawModelResponses[before + 1].answer, retryAnswer);
      assert.ok(response.events.some((event) => event.type === 'reset'), 'Mac stream did not receive a reset before the corrected answer');
      assert.equal(
        JSON.stringify(response.events).includes(rawPrefix),
        false,
        'the incomplete model prefix reached the Mac stream'
      );
    }
    const payload = calls.at(-1);
    assert.equal(payload.think, false, 'straightforward fill-in-the-blank enabled thinking');
    assert.equal(payload.options.num_predict, 96);
    assert.equal(payload.options.num_ctx, 8192);
  }

  assert.deepEqual(
    fillIns.map(([, expectedAnswer]) => expectedAnswer),
    ['chloroplast', 'chloroplast', 'mitochondrion', 'deoxyribonucleic acid', 'mitosis', 'nucleus', 'photosynthesis', 'Photosynthesis', 'chemical', 'glucose; oxygen']
  );

  const jsonFillAnswer = await postJson(bridgePort, 'DNA stands for ____.');
  assert.equal(rawModelResponses.at(-1).answer, 'DNA stands for deoxyribonucleic acid.');
  assert.equal(jsonFillAnswer.answer, 'deoxyribonucleic acid', 'JSON endpoint did not return the missing term alone');

  const noRetryQuestion = 'NO_RETRY_FILL\nFill in the blank: A plant cell wall is primarily made of ____.';
  const callsBeforeNoRetry = calls.length;
  const noRetry = await postStream(bridgePort, noRetryQuestion);
  assert.equal(noRetry.answer, 'Unable to determine');
  assert.equal(calls.length, callsBeforeNoRetry + 1, 'uncertainty in a fill-in-the-blank triggered a multiple-choice retry');
  assert.equal(calls.at(-1).think, false);

  const shortAnswer = await postStream(bridgePort, 'What is osmosis?');
  assert.equal(shortAnswer.answer, 'Osmosis is the movement of water across a selectively permeable membrane.');
  assert.equal(calls.at(-1).think, false);
  assert.match(calls.at(-1).messages[0].content, /This is a short-answer question/);
  assert.doesNotMatch(calls.at(-1).messages[0].content, /choose an answer letter/i);

  const retryQuestion = `RETRY_CASE\nExplain why plants need stomata.\nA) trichomes\nB) internodes\nC) stipules\nD) stomata`;
  const retried = await postStream(bridgePort, retryQuestion);
  assert.equal(retried.answer, 'D — stomata');
  assert.equal(calls.length, 20, 'uncertain multiple-choice answer should receive exactly one retry');
  assert.equal(calls[18].think, true, 'complex initial request should permit thinking');
  assert.equal(calls[19].think, false, 'short retry should disable thinking');
  assert.equal(calls[19].options.num_predict, 96, 'retry must respect the configured output token limit');

  assert.match(logs, /questionType=multiple-choice .*think=false thinkReason=straightforward-multiple-choice detectedChoices=4/);
  assert.match(logs, /questionType=fill-in-the-blank .*think=false thinkReason=straightforward-fill-in-the-blank detectedChoices=0/);
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

async function postJson(port, text) {
  const response = await fetch(`http://127.0.0.1:${port}/study-answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-study-assistant-token': 'integration-test-token' },
    body: JSON.stringify({ text, outputMode: 'mac' })
  });
  assert.equal(response.status, 200);
  return response.json();
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
