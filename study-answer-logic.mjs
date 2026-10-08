const CHOICE_HEADING = /^(?:options?|answer choices|choices)\s*:?$/i;
const LABELLED_CHOICE = /^\s*(?:\(([A-Z])\)|([A-Z])\s*[.)]|([A-Z])\s*[-:])\s*(.*)$/i;
const NUMBERED_CHOICE = /^\s*option\s+(\d+)\s*[:.)-]\s*(.*)$/i;
const COMPLEX_CUE = /\b(?:analy[sz]e|compare|contrast|evaluate|justify|explain|infer|deduce|predict|mechanism|multi[- ]step|why|how\s+(?:does|would|can|did|could)|based on (?:the )?(?:data|results|evidence|experiment|passage))\b/i;
const UNCERTAIN_START = /^\s*(?:unable to determine|cannot determine|can't determine|not enough information|insufficient information|cannot be determined|i (?:do not|don't) know|i am not sure|i'm not sure|ask google|search (?:google|online)|look it up)\b/i;

export function parseChoiceGroups(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const groups = [];
  let activeGroup = null;

  for (const line of lines) {
    const parsed = parseChoiceLine(line);
    if (parsed) {
      const startNewGroup = !activeGroup
        || activeGroup.some((choice) => choice.label === parsed.label)
        || parsed.label === 'A'
        || parsed.label === 'Option 1';
      if (startNewGroup) {
        activeGroup = [];
        groups.push(activeGroup);
      }
      activeGroup.push(parsed);
      continue;
    }

    if (activeGroup?.length) {
      const previousChoice = activeGroup.at(-1);
      if (isLikelyContinuation(line, previousChoice.text)) {
        previousChoice.text = `${previousChoice.text} ${line}`.trim();
      } else {
        activeGroup = null;
      }
    }
  }

  if (groups.some((group) => group.length >= 2)) return groups.filter((group) => group.length >= 2);

  const headingIndex = lines.findIndex((line) => CHOICE_HEADING.test(line));
  if (headingIndex === -1) return groups.filter((group) => group.length >= 2);

  const unlabeled = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (parseChoiceLine(line) || isSectionBoundary(line)) break;
    if (isQuestionLine(line) || line.length > 240) break;
    unlabeled.push(line);
    if (unlabeled.length === 26) break;
  }
  if (unlabeled.length >= 2) {
    return [[...unlabeled.map((choice, index) => ({ label: `Option ${index + 1}`, text: choice }))]];
  }
  return groups.filter((group) => group.length >= 2);
}

export function getThinkingDecision(text, mode = 'auto') {
  const normalizedMode = ['auto', 'on', 'off'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'auto';
  if (normalizedMode === 'on') return { think: true, reason: 'forced-on', choiceCount: 0 };
  if (normalizedMode === 'off') return { think: false, reason: 'forced-off', choiceCount: 0 };

  const input = String(text ?? '');
  const groups = parseChoiceGroups(input);
  const choiceCount = Math.max(0, ...groups.map((group) => group.length));
  const wordCount = input.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const questionCount = (input.match(/\?/g) ?? []).length;
  const arithmeticCount = input.match(/\d\s*[+×÷*/−-]\s*\d/g)?.length ?? 0;
  const hasMultipleNumberedQuestions = input.split(/\r?\n/)
    .filter((line) => /^\s*\d+[.)]\s+\S/.test(line) && !parseChoiceLine(line)).length > 1;

  if (choiceCount < 2) return { think: true, reason: 'choices-not-detected', choiceCount };
  if (wordCount > 100) return { think: true, reason: 'long-input', choiceCount };
  if (questionCount > 1 || hasMultipleNumberedQuestions) return { think: true, reason: 'multiple-questions', choiceCount };
  if (arithmeticCount > 1 || COMPLEX_CUE.test(input)) return { think: true, reason: 'reasoning-cue', choiceCount };
  return { think: false, reason: 'straightforward-multiple-choice', choiceCount };
}

export function matchAnswerToChoices(answer, text) {
  const groups = parseChoiceGroups(text);
  if (groups.length === 0 || groups.some((group) => group.length < 2)) return null;
  const answerLines = String(answer ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (groups.length > 1) {
    if (answerLines.length < groups.length) return null;
    const matches = groups.map((choices, index) => matchChoiceLine(answerLines[index], choices));
    if (matches.some((match) => !match)) return null;
    return {
      label: 'multiple',
      text: '',
      answer: matches.map((match, index) => `${index + 1}. ${match.label} — ${match.text}`).join('\n')
    };
  }
  return matchChoiceLine(answerLines[0] ?? '', groups[0]);
}

function matchChoiceLine(answerLine, choices) {
  const firstLine = String(answerLine ?? '').trim().replace(/^\s*\d+[.)]\s*/, '');
  const lead = /^(?:(?:the\s+)?(?:correct\s+)?(?:answer|choice)\s*(?:is\s*)?[:—–-]?\s*)?/i;
  const labelledText = firstLine.replace(lead, '');
  const numberedMatch = labelledText.match(/^option\s+(\d+)(?:\s*[:.)—–-]|$)/i);
  const letterMatch = labelledText.match(/^(?:\(([A-Z])\)|([A-Z])(?:\s*[.)—–:-]|$))/i);
  const contextualLetterMatch = firstLine.match(/\b(?:answer|correct choice|choice|therefore|thus|so)\s*(?:is\s*)?[:—–-]?\s*(?:\(([A-Z])\)|([A-Z])\s*[.)—–:-])/i);
  const label = numberedMatch
    ? `Option ${Number(numberedMatch[1])}`
    : contextualLetterMatch?.[1]?.toUpperCase() ?? contextualLetterMatch?.[2]?.toUpperCase()
      ?? letterMatch?.[1]?.toUpperCase() ?? letterMatch?.[2]?.toUpperCase();
  if (label) {
    const selected = choices.find((choice) => choice.label.toLowerCase() === label.toLowerCase());
    if (selected) return { label: selected.label, text: selected.text, answer: `${selected.label} — ${selected.text}` };
  }

  const answerText = stripAnswerLead(firstLine);
  const normalizedAnswer = normalizeForMatch(answerText);
  if (!normalizedAnswer) return null;
  const selected = choices.find((choice) => {
    const normalizedChoice = normalizeForMatch(choice.text);
    if (normalizedChoice.length < 3) return false;
    return normalizedAnswer === normalizedChoice || normalizedAnswer.startsWith(`${normalizedChoice} `);
  });
  return selected
    ? { label: selected.label, text: selected.text, answer: `${selected.label} — ${selected.text}` }
    : null;
}

export function resolveAnswer(answer, text) {
  const matchedChoice = matchAnswerToChoices(answer, text);
  return {
    answer: matchedChoice?.answer ?? answer,
    matchedChoice: Boolean(matchedChoice),
    choice: matchedChoice,
    shouldRetry: !matchedChoice && isUncertainAnswer(answer)
  };
}

export function isUncertainAnswer(answer) {
  return UNCERTAIN_START.test(String(answer ?? '')) || /\b(?:ask|search) google\b/i.test(String(answer ?? ''));
}

export function redactInputForDebug(text) {
  return String(text ?? '')
    .replace(/\b(?:student\s+)?name\s*[:#]\s*[^\n,;]+/gi, 'Name: [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:\+?\d[\d .()/-]{7,}\d)\b/g, '[phone/id]')
    .replace(/\b\d{6,}\b/g, '[number]');
}

function parseChoiceLine(line) {
  const numbered = line.match(NUMBERED_CHOICE);
  if (numbered) return { label: `Option ${Number(numbered[1])}`, text: numbered[2].trim() };
  const labelled = line.match(LABELLED_CHOICE);
  if (!labelled) return null;
  return {
    label: (labelled[1] ?? labelled[2] ?? labelled[3]).toUpperCase(),
    text: labelled[4].trim()
  };
}

function isLikelyContinuation(line, previousLine) {
  const first = line[0];
  const startsLikeContinuation = Boolean(first && (/\p{Ll}/u.test(first) || ',;:)–-'.includes(first)));
  const previousEndsMidThought = /\b(?:and|or|of|to|in|on|for|with|by|from|that|which|a|an|the|because|as|is|are|was|were|into|through|between|than|more|less|,|[-–])$/i.test(previousLine);
  return startsLikeContinuation || previousEndsMidThought;
}

function isQuestionLine(line) {
  return line.includes('?') || /_{2,}|\.{3,}/.test(line);
}

function isSectionBoundary(line) {
  return /^(?:submit|next|previous|back|check answer|save and continue|time left|question\s+\d+|review|clear my choice|ask google|search with google|continue|cancel)\b/i.test(line);
}

function stripAnswerLead(value) {
  return value.replace(/^\s*(?:(?:the\s+)?(?:correct\s+)?(?:answer|choice)\s*(?:is\s*)?[:—–-]?\s*)/i, '').trim();
}

function normalizeForMatch(value) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
