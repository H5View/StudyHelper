import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { biologyQuestions, confidenceControls } from './multiple-choice-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const debug of [false, true]) {
  test(`A–E Mac → Ollama → extraction → viewer (debug ${debug ? 'on' : 'off'})`, { timeout: 60000 }, async (t) => {
    const calls = [];
    let releaseOld;
    let oldStarted;
    const oldGate = new Promise((resolve) => { releaseOld = resolve; });
    const oldStart = new Promise((resolve) => { oldStarted = resolve; });
    const rawAnswers = biologyQuestions.map(({ expected, label }) => {
      if (label === 'A') return `**${expected}**`;
      if (label === 'B') return 'The correct answer is B.';
      if (label === 'E') return `\`\`\`text\n${expected}\n\`\`\``;
      return `${expected}.\nChoice B — is a distractor.`;
    });
    const ollama = createServer(async (req, res) => {
      if (req.url === '/api/tags') return res.end('{"models":[]}');
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      const question = payload.messages.at(-1).content;
      const index = biologyQuestions.findIndex(({ stem }) => question.includes(stem));
      assert.ok(index >= 0, 'unexpected model request');
      const raw = rawAnswers[index];
      calls.push({ payload, raw });
      if (question.includes('OLD_REQUEST')) {
        oldStarted();
        await oldGate;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { thinking: 'PRIVATE_THINKING_ONLY' }, done: false })}\n`);
      // Fragment both NDJSON and content, including newline/code fence answers.
      for (let offset = 0; offset < raw.length; offset += 7) {
        const event = `${JSON.stringify({ message: { content: raw.slice(offset, offset + 7) }, done: false })}\n`;
        res.write(event.slice(0, 13));
        res.write(event.slice(13));
      }
      res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    });
    await listen(ollama);
    t.after(() => { releaseOld(); ollama.closeAllConnections(); ollama.close(); });
    const reserved = createServer();
    await listen(reserved);
    const port = reserved.address().port;
    await new Promise((resolve) => reserved.close(resolve));
    const bridge = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        STUDY_ASSISTANT_HOST: '127.0.0.1', STUDY_ASSISTANT_PORT: String(port),
        STUDY_ASSISTANT_TOKEN: 'mc-regression-token',
        OLLAMA_BASE_URL: `http://127.0.0.1:${ollama.address().port}`,
        OLLAMA_MODEL: 'gemma4:12b-it-q4_K_M', OLLAMA_NUM_CTX: '8192',
        OLLAMA_THINKING_MODE: 'auto', OLLAMA_NUM_PREDICT: '256',
        STUDY_ASSISTANT_DEBUG_INPUT: '0', STUDY_ASSISTANT_DEBUG_ANSWERS: debug ? '1' : '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    bridge.stdout.on('data', (chunk) => { logs += chunk; });
    bridge.stderr.on('data', (chunk) => { logs += chunk; });
    t.after(async () => {
      bridge.kill();
      if (bridge.exitCode === null) await Promise.race([once(bridge, 'exit'), delay(3000)]);
    });
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt += 1) {
      try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
      if (attempt >= 80 || bridge.exitCode !== null) throw new Error(`bridge did not start: ${logs}`);
      await delay(50);
    }

    const viewerHTML = await (await fetch(`${url}/viewer`)).text();
    const nodes = new Map();
    const viewerRefresh = runInNewContext(`${viewerHTML.match(/<script>([\s\S]*?)<\/script>/)[1]}\nrefresh;`, {
      document: { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { toggle(_name, value) { this.working = value; } } });
        return nodes.get(id);
      } },
      fetch: (path, options) => fetch(`${url}${path}`, options),
      setInterval() {}, Date
    });

    for (const fixture of biologyQuestions) {
      // This raw capture used to become eight synthetic options and lose E.
      const screen = [fixture.stem, ...fixture.choices.flatMap((text, index) => ['ABCDE'[index], text]), ...confidenceControls].join('\n');
      const macText = execFileSync('swift', ['run', '--quiet', '--package-path', `${root}macos-client`, 'QuestionTextExtractorCLI'], {
        cwd: root, input: screen, encoding: 'utf8'
      }).trim();
      const expectedMac = [fixture.stem, ...fixture.choices.flatMap((text, index) => ['ABCDE'[index], text])].join('\n');
      assert.equal(macText, expectedMac, 'Mac renumbered, clipped, or contaminated A–E');
      for (const endpoint of ['study-answer', 'study-answer/stream']) {
        const before = calls.length;
        // Also test server filtering for selected text/older captures containing controls.
        const text = `Name: Regression Student\nregression@example.test\n${macText}\n${confidenceControls.join('\n')}`;
        const answer = await post(url, endpoint, text, endpoint.endsWith('stream') ? 'both' : 'windows');
        assert.match(answer, new RegExp(`^${fixture.label} — `));
        assert.ok(answer.startsWith(fixture.expected));
        assert.equal(calls.length, before + 1, 'valid answer added a model call');
        assert.equal(calls.at(-1).raw, rawAnswers['ABCDE'.indexOf(fixture.label)]);
        assert.equal(calls.at(-1).payload.messages.at(-1).content, `Name: Regression Student\nregression@example.test\n${macText}`);
        assert.equal(calls.at(-1).payload.think, false);
        assert.equal(calls.at(-1).payload.options.num_ctx, 8192);
        assert.equal(calls.at(-1).payload.model, 'gemma4:12b-it-q4_K_M');
        const latest = await (await fetch(`${url}/latest-answer`)).json();
        assert.equal(latest.answer, answer, 'viewer state differed from endpoint final answer');
        assert.equal(latest.status, 'ready');
        await viewerRefresh();
        assert.equal(nodes.get('answer').textContent, answer, '/viewer rendered a different answer');
        assert.equal(nodes.get('answer').classList.working, false);
      }
    }

    const beforeMac = await (await fetch(`${url}/latest-answer`)).json();
    await post(url, 'study-answer/stream', biologyQuestions[0].question, 'mac');
    assert.deepEqual(await (await fetch(`${url}/latest-answer`)).json(), beforeMac, 'Mac-only request changed viewer state');

    // Newer C completes first; old B then emits chunks and completes last.
    const old = post(url, 'study-answer/stream', `OLD_REQUEST\n${biologyQuestions[1].question}`, 'windows');
    await oldStart;
    const newer = await post(url, 'study-answer', biologyQuestions[2].question, 'windows');
    releaseOld();
    assert.match(await old, /^B — /);
    assert.equal((await (await fetch(`${url}/latest-answer`)).json()).answer, newer, 'old B overwrote new C');
    await viewerRefresh();
    assert.equal(nodes.get('answer').textContent, newer);

    // Wait for the stdout pipe to deliver the final diagnostic records.
    for (let attempt = 0; attempt < 40 && (logs.match(/study-answer finished/g) ?? []).length < calls.length; attempt += 1) await delay(10);
    assert.doesNotMatch(logs, /PRIVATE_THINKING_ONLY|regression@example\.test|Regression Student/);
    assert.doesNotMatch(logs, /detectedChoices=8/);
    assert.equal((logs.match(/detectedChoices=5/g) ?? []).length, calls.length);
    const records = logs.split('\n').filter((line) => line.startsWith('study-answer debug ')).map((line) => JSON.parse(line.slice('study-answer debug '.length)));
    if (debug) {
      for (let requestId = 1; requestId <= calls.length; requestId += 1) {
        const trace = records.filter((record) => record.requestId === requestId);
        assert.deepEqual(trace.map((record) => record.stage), ['question', 'model', 'extracted', 'viewer']);
        assert.equal(trace[0].choices.length, 1);
        assert.equal(trace[0].choices[0].length, 5);
        assert.equal(trace[1].rawModelResponse, calls[requestId - 1].raw);
        assert.equal(trace[2].extractedAnswer, trace[3].finalAnswer);
        if (trace[3].viewerUpdated) assert.equal(trace[3].viewerAnswer, trace[2].extractedAnswer);
      }
      const stale = records.filter((record) => record.stage === 'viewer').find((record) => record.requestId === calls.length - 1);
      assert.equal(stale.viewerUpdated, false);
      assert.match(stale.finalAnswer, /^B — /);
      assert.match(stale.viewerAnswer, /^C — /);
    } else {
      assert.equal(records.length, 0, 'disabled answer debugging logged content');
      assert.doesNotMatch(logs, /Chloroplast|Nucleus|Ribosome|Mitochondrion|Stomata|Xylem/);
    }
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}

async function post(url, endpoint, text, outputMode) {
  const response = await fetch(`${url}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-study-assistant-token': 'mc-regression-token' },
    body: JSON.stringify({ text, outputMode })
  });
  assert.equal(response.status, 200);
  if (!endpoint.endsWith('stream')) return (await response.json()).answer;
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_THINKING_ONLY/);
  const done = events.findLast((event) => event.type === 'done');
  assert.ok(done, 'stream did not deliver a final answer');
  return done.answer;
}
