const { parseOutput } = require('./agent/output_parser');

const tests = [
  {
    name: '1. Valid MEM_SAVE short executes',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":"task."}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.priority === 'high' && r.parserHints.length === 0
  },
  {
    name: '2. MEM_SAVE with smart quote repairs and executes',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":\u201ctask.\u201d}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.priority === 'high' && r.parserHints.length === 0
  },
  {
    name: '3. MEM_SAVE tags string -> array repairs and executes',
    input: `[MEM_SAVE long] {"type":"insight","content":"Test","tags":"a, b, c","why":"reason"}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.tags === 'a, b, c' && r.parserHints.length === 0
  },
  {
    name: '4. bare [MEM_SAVE] creates hint, no save',
    input: `[MEM_SAVE]`,
    check: r => r.saves.length === 0 && r.parserHints.some(h => h.intent === 'MEM_SAVE') && r.helpRequests.includes('MEM_SAVE')
  },
  {
    name: '5. [MEM_SAVE] - "text" soft parses into save AND creates minor hint',
    input: `[MEM_SAVE] \u2013 "Initial assessment: We need more sleep."`,
    check: r => r.saves.length === 1 && r.saves[0].entry.content === 'Initial assessment: We need more sleep.' && r.parserHints.some(h => h.intent === 'MEM_SAVE')
  },
  {
    name: '6. broken JSON [MEM_SAVE] {"type" ...} graceful fallback to raw text',
    input: `[MEM_SAVE] {"type":"thought", "content": "missing quotes}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.content.includes('missing quotes') && r.parserHints.some(h => h.intent === 'MEM_SAVE' && h.explanation.includes('JSON error'))
  },
  {
    name: '7. [MEM_SAVE #61] creates MEM_FOCUS hint AND focuses',
    input: `[MEM_SAVE #61]`,
    check: r => r.focusIds.length === 1 && r.focusIds[0] === 61 && r.parserHints.some(h => h.intent === 'MEM_FOCUS')
  },
  {
    name: '8. valid MEM_FOCUS IDs works',
    input: `[MEM_FOCUS #61 #62]`,
    check: r => r.focusIds.length === 2 && r.focusIds[0] === 61 && r.parserHints.length === 0
  },
  {
    name: '9. smart extraction MEM_FOCUS <41>',
    input: `[MEM_FOCUS <41>]`,
    check: r => r.focusIds.length === 1 && r.focusIds[0] === 41
  },
  {
    name: '10. valid MEM_FOCUS topic works',
    input: `[MEM_FOCUS] {"topic":"cognitive pressure valve","limit":3}`,
    check: r => r.focusTopics.length === 1 && r.focusTopics[0].topic === 'cognitive pressure valve' && r.parserHints.length === 0
  },
  {
    name: '11. prose MEM_FOCUS topic soft parse',
    input: `[MEM_FOCUS] \u2013 cognitive pressure valve`,
    check: r => r.focusTopics.length === 1 && r.focusTopics[0].topic === 'cognitive pressure valve' && r.parserHints.some(h => h.intent === 'MEM_FOCUS')
  },
  {
    name: '12. valid SEND_MESSAGE JSON works',
    input: `[SEND_MESSAGE] {"text":"Hello","why":"Greeting"}`,
    check: r => r.messages.length === 1 && r.messages[0] === 'Hello' && r.parserHints.length === 0
  },
  {
    name: '13. [SEND_MESSAGE] - "hello" soft parses',
    input: `[SEND_MESSAGE] \u2013 "Hello user, I have finished my task."`,
    check: r => r.messages.length === 1 && r.messages[0] === 'Hello user, I have finished my task.' && r.parserHints.some(h => h.intent === 'SEND_MESSAGE')
  },
  {
    name: '14. valid SCHEDULE 60 works',
    input: `[SCHEDULE 60]`,
    check: r => r.scheduleSec === 60 && r.parserHints.length === 0
  },
  {
    name: '15. smart extraction SCHEDULE 15 mins',
    input: `[SCHEDULE] 15 mins`,
    check: r => r.scheduleSec === 900 && r.parserHints.some(h => h.intent === 'SCHEDULE')
  },
  {
    name: '16. valid MEM_ADAPT works',
    input: `[MEM_ADAPT] {"type":"suppress","target":"debug","rule":"less debug","why":"noisy"}`,
    check: r => r.adapts.length === 1 && r.parserHints.length === 0
  },
  {
    name: '17. [MEM_ADAPT] - "text" soft parses into strengthen rule',
    input: `[MEM_ADAPT] \u2013 Need to reframe the tool usage priority`,
    check: r => r.adapts.length === 1 && r.adapts[0].rule === 'Need to reframe the tool usage priority' && r.parserHints.some(h => h.intent === 'MEM_ADAPT')
  },
  {
    name: '18. [REFLECT] works',
    input: `[REFLECT]`,
    check: r => r.reflect === true && r.parserHints.length === 0
  },
  {
    name: '19. [REFLECT] - "question" saves question AND reflects',
    input: `[REFLECT] \u2013 Question: Why did the chicken cross the road?`,
    check: r => r.reflect === true && r.saves.length === 1 && r.saves[0].entry.content === 'Question: Why did the chicken cross the road?'
  },
  {
    name: '20. Weak intent: "I should save this"',
    input: `This is interesting. I should save this.`,
    check: r => r.saves.length === 0 && r.parserHints.some(h => h.intent === 'MEM_SAVE')
  },
  {
    name: '21. Non-interference mode disables minor hints during deep reflection',
    input: `[REFLECT]\nThis is a long thought.\n[MEM_SAVE] - "I am thinking."`,
    check: r => r.reflect === true && r.saves.length === 2 && r.parserHints.length === 0
  }
];

let failed = 0;

for (const t of tests) {
  console.log(`\n--- Test: ${t.name} ---`);
  try {
    const result = parseOutput(t.input);
    if (t.check(result)) {
      console.log('✅ Pass');
    } else {
      console.log('❌ Fail');
      console.log(JSON.stringify(result, null, 2));
      failed++;
    }
  } catch (err) {
    console.log(`❌ Crash: ${err.message}`);
    failed++;
  }
}

if (failed === 0) {
  console.log('\n✅ ALL TESTS PASSED');
} else {
  console.log(`\n❌ ${failed} TESTS FAILED`);
}
