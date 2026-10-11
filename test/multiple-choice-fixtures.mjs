// Known biology answers: mock responses test transport/extraction, not model knowledge.
export const biologyQuestions = [
  { label: 'A', stem: 'Which structures regulate gas exchange in leaves?', choices: ['Stomata', 'Trichomes', 'Roots', 'Stipules', 'Internodes'] },
  { label: 'B', stem: 'Which plant tissue transports water from roots?', choices: ['Phloem', 'Xylem', 'Epidermis', 'Cork', 'Cambium'] },
  { label: 'C', stem: 'Which organelle carries out photosynthesis?', choices: ['Nucleus', 'Mitochondrion', 'Chloroplast', 'Ribosome', 'Golgi apparatus'] },
  { label: 'D', stem: 'Which structure synthesizes proteins?', choices: ['Lysosome', 'Vacuole', 'Chloroplast', 'Ribosome', 'Golgi apparatus'] },
  { label: 'E', stem: 'Which organelle houses most DNA in a plant cell?', choices: ['Vacuole', 'Ribosome', 'Golgi apparatus', 'Lysosome', 'Nucleus'] }
].map((fixture) => ({
  ...fixture,
  question: [fixture.stem, ...fixture.choices.map((text, index) => `${'ABCDE'[index]}. ${text}`)].join('\n'),
  expected: `${fixture.label} — ${fixture.choices['ABCDE'.indexOf(fixture.label)]}`
}));

export const confidenceControls = [
  'Option 1: Rate your confidence to submit your answer.',
  'Option 2: High',
  'Option 3: Medium',
  'Option 4: Low'
];
