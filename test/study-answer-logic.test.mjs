import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectQuestionType,
  extractFillInAnswer,
  getThinkingDecision,
  isUncertainAnswer,
  matchAnswerToChoices,
  parseChoiceGroups,
  redactInputForDebug,
  resolveAnswer
} from '../study-answer-logic.mjs';
import { readOllamaEventStream } from '../ollama-stream.mjs';

const stomataQuestion = [
  'Plant leaves contain small openings called ________, through which carbon dioxide enters the plant.',
  'A) trichomes',
  'B) internodes',
  'C) stipules',
  'D) stomata'
].join('\n');

test('stomata multiple-choice is classified as a fast, no-thinking request', () => {
  assert.deepEqual(getThinkingDecision(stomataQuestion, 'auto'), {
    think: false,
    reason: 'straightforward-multiple-choice',
    questionType: 'multiple-choice',
    choiceCount: 4
  });
});

test('fill-in-the-blank and short-answer types do not enable thinking just because there are no choices', () => {
  const fillIns = [
    'The powerhouse of the cell is the _____.',
    'DNA stands for ____.',
    'The process by which plants convert sunlight into chemical energy is ____.'
  ];
  for (const question of fillIns) {
    assert.equal(detectQuestionType(question), 'fill-in-the-blank');
    assert.deepEqual(getThinkingDecision(question), {
      think: false,
      reason: 'straightforward-fill-in-the-blank',
      questionType: 'fill-in-the-blank',
      choiceCount: 0
    });
  }
  assert.equal(detectQuestionType('Fill in the blank: DNA stands for'), 'fill-in-the-blank');
  assert.equal(detectQuestionType('DNA stands for _'), 'fill-in-the-blank');
  assert.equal(detectQuestionType('What is osmosis?'), 'short-answer');
  assert.equal(getThinkingDecision('What is osmosis?').think, false);
});

test('fill-in formatting extracts only reliable blank spans at the beginning, middle, or end', () => {
  assert.equal(
    extractFillInAnswer(
      'The powerhouse of the cell is the mitochondrion.',
      'The powerhouse of the cell is the ____.'
    ),
    'mitochondrion'
  );
  assert.equal(
    extractFillInAnswer('DNA stands for deoxyribonucleic acid.', 'DNA stands for ____.'),
    'deoxyribonucleic acid'
  );
  assert.equal(
    extractFillInAnswer(
      'Photosynthesis is the process by which plants convert sunlight into chemical energy.',
      '____ is the process by which plants convert sunlight into chemical energy.'
    ),
    'Photosynthesis'
  );
  assert.equal(
    extractFillInAnswer('Plants convert sunlight into chemical energy.', 'Plants convert sunlight into ____ energy.'),
    'chemical'
  );
  assert.equal(
    extractFillInAnswer(
      'The two main products of photosynthesis are glucose and oxygen.',
      'The two main products of photosynthesis are ____ and ____.'
    ),
    'glucose; oxygen'
  );
  assert.equal(
    extractFillInAnswer('Answer: “mitochondrion”', 'The powerhouse of the cell is the ____.'),
    'mitochondrion'
  );
  assert.equal(
    extractFillInAnswer('The answer is: “deoxyribonucleic acid”', 'DNA stands for ____.'),
    'deoxyribonucleic acid'
  );
  const unrelatedAnswer = 'Mitochondrion is the organelle that produces most cellular ATP.';
  assert.equal(
    extractFillInAnswer(unrelatedAnswer, 'The powerhouse of the cell is the ____.'),
    unrelatedAnswer,
    'formatter changed an answer when the missing span could not be identified'
  );
});

test('parenthesized and no-space labels are detected as choices', () => {
  const text = 'Which structure carries oxygen?\n(A) alveoli\n(B) stomata\n(C) xylem\n(D) villi';
  assert.equal(parseChoiceGroups(text)[0].length, 4);
  assert.equal(getThinkingDecision(text).think, false);
});

test('other simple multiple-choice questions also disable thinking', () => {
  const questions = [
    'Which planet is closest to the Sun?\nA. Mercury\nB. Venus\nC. Earth\nD. Mars',
    'What is 2 + 2?\nA) 3\nB) 4\nC) 5'
  ];
  for (const question of questions) assert.equal(getThinkingDecision(question).think, false);
});

test('complex questions and explicit thinking overrides retain their behavior', () => {
  const complex = 'Explain why stomata open in daylight.\nA) water enters\nB) guard cells gain turgor';
  assert.equal(getThinkingDecision(complex).think, true);
  assert.equal(getThinkingDecision(stomataQuestion, 'on').think, true);
  assert.equal(getThinkingDecision(complex, 'off').think, false);
  assert.equal(getThinkingDecision('Explain why photosynthesis needs light.').think, true);
});

test('answers map back to the selected labeled or synthetic unlabeled choice', () => {
  assert.equal(matchAnswerToChoices('D — stomata. Ask Google if uncertain.', stomataQuestion)?.answer, 'D — stomata');
  assert.equal(
    matchAnswerToChoices('D — stomata. Stomata allow carbon dioxide to enter the leaf.', stomataQuestion)?.answer,
    'D — stomata. Stomata allow carbon dioxide to enter the leaf.'
  );

  const unlabeled = [
    'Plant leaves contain small openings called ________, through which carbon dioxide enters the plant.',
    'Option 1: trichomes',
    'Option 2: internodes',
    'Option 3: stipules',
    'Option 4: stomata'
  ].join('\n');
  assert.equal(matchAnswerToChoices('Option 4 — stomata', unlabeled)?.answer, 'Option 4 — stomata');
  assert.equal(matchAnswerToChoices('stomata', unlabeled)?.answer, 'Option 4 — stomata');
});

test('valid answers to multiple choice groups are canonicalized without retry', () => {
  const questions = [
    '1. Which structure controls gas exchange?',
    'A) stomata', 'B) trichomes',
    '2. Which tissue carries water?',
    'A) phloem', 'B) xylem'
  ].join('\n');
  const answer = '1. A — stomata\n2. B — xylem. The wording is unclear.';
  const resolved = resolveAnswer(answer, questions);
  assert.equal(resolved.matchedChoice, true);
  assert.equal(resolved.shouldRetry, false);
  assert.equal(resolved.answer, '1. A — stomata\n2. B — xylem');
});

test('uncertainty detection is anchored and does not retry a selected answer', () => {
  assert.equal(isUncertainAnswer('Unable to determine; ask Google.'), true);
  assert.equal(isUncertainAnswer('The wording is unclear, but the answer is D — stomata.'), false);
  const answer = 'The wording is unclear, but the answer is D — stomata.';
  assert.ok(matchAnswerToChoices(answer, stomataQuestion));
  assert.equal(resolveAnswer('D — stomata. Ask Google if uncertain.', stomataQuestion).shouldRetry, false);
});

test('opt-in input trace redacts common identifiers', () => {
  const trace = redactInputForDebug('Name: Jamie Example\njamie@example.com\nhttps://example.test/path\n555-555-0199\nID 12345678');
  assert.doesNotMatch(trace, /jamie@example\.com|https:\/\/|555-555-0199|12345678/);
  assert.match(trace, /\[email\]/);
  assert.match(trace, /\[url\]/);
  assert.match(trace, /\[phone\/id\]/);
  assert.match(trace, /\[number\]/);
});

test('Ollama thinking chunks never appear as answer content', async () => {
  const wireText = [
    JSON.stringify({ message: { thinking: 'Ask Google. The options seem unclear.' }, done: false }),
    JSON.stringify({ message: { content: 'D — ' }, done: false }),
    JSON.stringify({ message: { content: 'stomata' }, done: false }),
    JSON.stringify({ message: { content: '' }, done: true, eval_count: 3 })
  ].join('\n') + '\n';
  const bytes = new TextEncoder().encode(wireText);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37, 102));
      controller.enqueue(bytes.slice(102));
      controller.close();
    }
  });
  const visibleChunks = [];
  const result = await readOllamaEventStream(body, (_accumulated, delta) => visibleChunks.push(delta));
  assert.equal(result.content, 'D — stomata');
  assert.deepEqual(visibleChunks, ['D — ', 'stomata']);
  assert.equal(JSON.stringify(visibleChunks).includes('Ask Google'), false);
  assert.equal(result.finalEvent.eval_count, 3);
});
