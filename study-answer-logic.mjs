const CHOICE_HEADING = /^(?:options?|answer choices|choices)\s*:?$/i;
const LABELLED_CHOICE = /^\s*(?:\(([A-Z])\)|([A-Z])\s*[.)]|([A-Z])\s*[-:])\s*(.*)$/i;
const NUMBERED_CHOICE = /^\s*option\s+(\d+)\s*[:.)-]\s*(.*)$/i;
const COMPLEX_CUE = /\b(?:analy[sz]e|compare|contrast|evaluate|justify|explain|infer|deduce|predict|mechanism|multi[- ]step|why|how\s+(?:does|would|can|did|could)|based on (?:the )?(?:data|results|evidence|experiment|passage))\b/i;
const FILL_IN_CUE = /(?:_+|\.{3,}|…{1,}|\[\s*(?:blank|text\s+field|input|\s{2,})\s*\]|\(\s*(?:blank|\s{2,})\s*\)|\bfill(?:ing)?\s+(?:in\s+)?(?:the\s+)?blank\b|\bcomplete\s+(?:the\s+)?(?:blank|sentence|statement)\b|\b(?:missing|insert|supply)\s+(?:the\s+)?(?:words?|terms?|phrases?)\b|\bmissing\s+terms?\b)/i;
const STRONG_FILL_IN_CUE = /(?:^\s*question\s+type\s*:\s*fill[- ]in[- ]the[- ]blank\b|^\s*fill\s+in\s+the\s+blank\s+question\s*$|\[\s*BLANK\s*\])/im;
const BLANK_MARKER = /\\?_+|\.{3,}|…+|\[\s*(?:blank|text\s+field|input|\s{2,})\s*\]|\(\s*(?:blank|\s{2,})\s*\)/gi;
const INCOMPLETE_FILL_ENDING = /\b(?:is|are|was|were|stands\s+for|called|known\s+as|equals|means|becomes?|converts?\s+into|results?\s+in|consists?\s+of)\s+(?:the|a|an|a\(n\))?\s*$/i;
const UNCERTAIN_START = /^\s*(?:unable to determine|cannot determine|can't determine|not enough information|insufficient information|cannot be determined|i (?:do not|don't) know|i am not sure|i'm not sure|ask google|search (?:google|online)|look it up)\b/i;

export function parseChoiceGroups(text) {
  // Explicit fill-in metadata/headings and real inline-field markers take
  // precedence over generic numbered UI labels in Accessibility captures.
  if (STRONG_FILL_IN_CUE.test(String(text ?? ''))) return [];

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

export function detectQuestionType(text) {
  const input = String(text ?? '').trim();
  if (STRONG_FILL_IN_CUE.test(input)) return 'fill-in-the-blank';
  if (parseChoiceGroups(input).some((group) => group.length >= 2)) return 'multiple-choice';
  if (FILL_IN_CUE.test(input) || INCOMPLETE_FILL_ENDING.test(input.replace(/[.!?\s]+$/g, ''))) {
    return 'fill-in-the-blank';
  }
  return 'short-answer';
}

export function extractFillInAnswer(modelOutput, questionText) {
  const formatted = formatFillInAnswer(modelOutput, questionText);
  return formatted.answer || 'Unable to determine';
}

export function formatFillInAnswer(modelOutput, questionText) {
  const output = cleanFillAnswer(modelOutput);
  if (!output) return { answer: '', reliable: false, extracted: false };

  const question = stripFillInInstruction(String(questionText ?? '').trim());
  const parts = question.split(BLANK_MARKER);
  if (parts.length > 1) {
    const anchors = parts.map((part) => part.trim());
    const anchorLength = anchors.reduce((total, anchor) => total + anchor.length, 0);
    const separatedBlanks = anchors.slice(1, -1).every((anchor) => anchor.length >= 2);
    if (anchorLength >= 8 && separatedBlanks) {
      let pattern = '^';
      for (let index = 0; index < anchors.length; index += 1) {
        pattern += flexibleAnchorPattern(anchors[index]);
        if (index < anchors.length - 1) {
          const finalBlankAtEnd = index === anchors.length - 2 && !anchors[index + 1];
          pattern += finalBlankAtEnd ? '([\\s\\S]+)' : '([\\s\\S]+?)';
        }
      }
      pattern += '[\\s\\S]*$';

      try {
        const match = output.match(new RegExp(pattern, 'i'));
        if (match) {
          const missingParts = match.slice(1).map((part) => cleanExtractedPhrase(part));
          if (missingParts.every((part) => part && part.length <= 180 && !containsUnfilledBlank(part))) {
            return { answer: missingParts.join('; '), reliable: true, extracted: true };
          }
        }
      } catch {}
    }
  }

  const stem = getIncompleteFillStem(question);
  if (stem && stem.length >= 8 && output.toLocaleLowerCase().startsWith(stem.toLocaleLowerCase())) {
    const missing = cleanExtractedPhrase(output.slice(stem.length));
    if (missing && missing.length <= 180 && !containsUnfilledBlank(missing)) {
      return { answer: missing, reliable: true, extracted: true };
    }
    return { answer: '', reliable: false, extracted: false };
  }

  if (isIncompleteQuestionEcho(output, question, parts)) {
    return { answer: '', reliable: false, extracted: false };
  }

  return { answer: output, reliable: true, extracted: false };
}

export function getThinkingDecision(text, mode = 'auto') {
  const normalizedMode = ['auto', 'on', 'off'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'auto';

  const input = String(text ?? '');
  const questionType = detectQuestionType(input);
  const groups = parseChoiceGroups(input);
  const choiceCount = Math.max(0, ...groups.map((group) => group.length));
  if (normalizedMode === 'on') return { think: true, reason: 'forced-on', questionType, choiceCount };
  if (normalizedMode === 'off') return { think: false, reason: 'forced-off', questionType, choiceCount };

  const wordCount = input.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const questionCount = (input.match(/\?/g) ?? []).length;
  const arithmeticCount = input.match(/\d\s*[+×÷*/−-]\s*\d/g)?.length ?? 0;
  const hasMultipleNumberedQuestions = input.split(/\r?\n/)
    .filter((line) => /^\s*\d+[.)]\s+\S/.test(line) && !parseChoiceLine(line)).length > 1;

  if (wordCount > 100) return { think: true, reason: 'long-input', questionType, choiceCount };
  if (questionCount > 1 || hasMultipleNumberedQuestions) return { think: true, reason: 'multiple-questions', questionType, choiceCount };
  if (arithmeticCount > 1 || COMPLEX_CUE.test(input)) return { think: true, reason: 'reasoning-cue', questionType, choiceCount };
  return {
    think: false,
    reason: questionType === 'multiple-choice' ? 'straightforward-multiple-choice' : `straightforward-${questionType}`,
    questionType,
    choiceCount
  };
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
      answer: matches.map((match, index) => `${index + 1}. ${match.answer}`).join('\n')
    };
  }
  return matchChoiceLine(answerLines.join(' '), groups[0]);
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
    if (selected) return matchedChoice(selected, firstLine);
  }

  const answerText = stripAnswerLead(firstLine);
  const normalizedAnswer = normalizeForMatch(answerText);
  if (!normalizedAnswer) return null;
  const selected = choices.find((choice) => {
    const normalizedChoice = normalizeForMatch(choice.text);
    if (normalizedChoice.length < 3) return false;
    return normalizedAnswer === normalizedChoice || normalizedAnswer.startsWith(`${normalizedChoice} `);
  });
  return selected ? matchedChoice(selected, firstLine) : null;
}

function matchedChoice(choice, answerLine) {
  const explanation = extractBriefExplanation(answerLine, choice.text);
  return {
    label: choice.label,
    text: choice.text,
    answer: `${choice.label} — ${choice.text}${explanation ? `. ${explanation}.` : ''}`
  };
}

function extractBriefExplanation(answerLine, choiceText) {
  const answer = String(answerLine ?? '').trim();
  const choiceStart = answer.toLocaleLowerCase().indexOf(choiceText.toLocaleLowerCase());
  if (choiceStart < 0) return '';
  const suffix = answer.slice(choiceStart + choiceText.length)
    .replace(/^[\s.,:;—–-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!suffix || /\b(?:ask google|search (?:google|online)|wording is unclear|not sure|if uncertain|i think)\b/i.test(suffix)) return '';
  const firstSentence = suffix.match(/^(.{1,180}?[.!?])(?:\s|$)/)?.[1] ?? suffix.slice(0, 140);
  return firstSentence.trim().replace(/[.!?]+$/, '');
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

function cleanFillAnswer(value) {
  let answer = String(value ?? '').trim();
  answer = answer.replace(/^```(?:[\w+-]+)?\s*|\s*```$/g, '').trim();
  answer = stripFillInInstruction(answer);
  answer = answer.replace(/^\s*option\s+\d+\s*[:.)—–-]\s*/i, '').trim();
  answer = answer.replace(
    /^(?:(?:the\s+)?answer|(?:the\s+)?missing\s+(?:word|term|phrase)|(?:the\s+)?completed\s+sentence)\s*(?::\s*|[-—–]\s*|\bis\b\s*:?\s*)/i,
    ''
  ).trim();
  if (answer.length >= 2 && ['""', "''", '“”', '‘’', '``'].some(([open, close]) => answer.startsWith(open) && answer.endsWith(close))) {
    answer = answer.slice(1, -1).trim();
  }
  return answer;
}

function cleanExtractedPhrase(value) {
  let phrase = String(value ?? '').trim();
  if (phrase.length > 1 && /[.!?]$/.test(phrase) && !/[.!?]/.test(phrase.slice(0, -1))) {
    phrase = phrase.slice(0, -1).trimEnd();
  }
  return phrase;
}

function containsUnfilledBlank(value) {
  return /(?:\\?_+|\.{3,}|…+|\[\s*(?:blank|text\s+field|input)\s*\]|\(\s*blank\s*\))/i.test(value);
}

function stripFillInInstruction(question) {
  return question.replace(
    /^\s*(?:(?:please\s+)?fill(?:ing)?\s+(?:in\s+)?(?:the\s+)?blank|complete\s+(?:the\s+)?(?:blank|sentence|statement)|missing\s+(?:word|term|phrase))\s*:?\s*/i,
    ''
  ).trim();
}

function flexibleAnchorPattern(anchor) {
  return anchor.split(/\s+/).filter(Boolean).map(escapeRegExp).join('\\s+');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getIncompleteFillStem(question) {
  const text = stripFillInInstruction(String(question ?? '').trim());
  const markerAtEnd = /(?:\\?_+|\.{3,}|…+|\[\s*(?:blank|\s{2,})\s*\]|\(\s*(?:blank|\s{2,})\s*\))\s*[.!?]*\s*$/i;
  const trailingBlank = text.match(markerAtEnd);
  const stem = trailingBlank ? text.slice(0, trailingBlank.index) : text;
  return stem.replace(/[.!?\s]+$/g, '').trim();
}

function isIncompleteQuestionEcho(output, question, parts) {
  const normalizedOutput = normalizeForMatch(output);
  if (!normalizedOutput) return false;

  const prefix = normalizeForMatch(parts[0] ?? '');
  const suffix = normalizeForMatch(parts.at(-1) ?? '');
  if (prefix && normalizedOutput.startsWith(prefix)) return true;
  if (suffix && normalizedOutput.endsWith(suffix)) return true;
  if (sharesQuestionAnchor(normalizedOutput, prefix, 'start')) return true;
  if (sharesQuestionAnchor(normalizedOutput, suffix, 'end')) return true;

  const stem = normalizeForMatch(getIncompleteFillStem(question));
  return Boolean(stem && normalizedOutput === stem);
}

function sharesQuestionAnchor(output, anchor, edge) {
  const outputWords = output.split(/\s+/).filter(Boolean);
  const anchorWords = anchor.split(/\s+/).filter(Boolean);
  if (anchorWords.length < 4 || outputWords.length < 4) return false;

  let matched = 0;
  while (
    matched < anchorWords.length
    && matched < outputWords.length
    && anchorWords[edge === 'start' ? matched : anchorWords.length - matched - 1]
      === outputWords[edge === 'start' ? matched : outputWords.length - matched - 1]
  ) {
    matched += 1;
  }

  return matched >= 4 && matched / anchorWords.length >= 0.75;
}
