const { parseOutput } = require('./agent/output_parser');

const tests = [
  {
    name: '1. Smart quotes in MEM_SAVE',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":\u201ctask.\u201d}`,
    check: r => r.saves.length > 0 && r.saves[0].entry.priority === 'high'
  },
  {
    name: '2. Topic-based MEM_FOCUS',
    input: `[MEM_FOCUS] {"topic":"cognitive pressure valve","limit":3}`,
    check: r => r.focusTopics.length > 0 && r.focusTopics[0].topic === 'cognitive pressure valve'
  },
  {
    name: '3. Bare MEM_SAVE prose fallback',
    input: `[MEM_SAVE] \u2013 "Initial assessment: We need more sleep."`,
    check: r => r.saves.length > 0 && r.saves[0].entry.type === 'insight'
  },
  {
    name: '4. Empty MEM_SAVE requests help',
    input: `[MEM_SAVE]`,
    check: r => r.saves.length === 0 && r.helpRequests.includes('MEM_SAVE')
  },
  {
    name: '5. Bare MEM_DELETE with IDs',
    input: `[MEM_DELETE #61 #62]`,
    check: r => r.deletes.length === 2 && r.deletes[0].id === 61
  },
  {
    name: '6. REFLECT with prose',
    input: `[REFLECT] \u2013 Question: Why did the chicken cross the road?`,
    check: r => r.reflect === true && r.saves.some(s => s.entry.type === 'reflection_request')
  },
  {
    name: '7. SCHEDULE inside brackets',
    input: `[SCHEDULE 60]`,
    check: r => r.scheduleSec === 60
  },
  {
    name: '8. SEND_MESSAGE with prose',
    input: `[SEND_MESSAGE] \u2013 "Hello user, I have finished my task."`,
    check: r => r.messages.includes('Hello user, I have finished my task.')
  },
  {
    name: '9. MEM_ADAPT with prose fallback',
    input: `[MEM_ADAPT] \u2013 Need to reframe the tool usage priority`,
    check: r => r.saves.some(s => s.entry.content.includes('reframe the tool usage')) && r.helpRequests.includes('MEM_ADAPT')
  },
  {
    name: '10. MEM_SAVE long with string tags (comma-separated)',
    input: `[MEM_SAVE long] {"type":"insight","content":"Biases shape narrative","tags":"cognitive bias, predictive processing, narrative construction"}`,
    check: r => r.saves.length > 0 && r.saves[0].kind === 'long' && r.saves[0].entry.tags === 'cognitive bias, predictive processing, narrative construction' && r.saves[0].entry.why === 'Agent expressed stable save intent.'
  },
  {
    name: '11. MEM_SAVE long with array tags',
    input: `[MEM_SAVE long] {"type":"insight","content":"Test","tags":["a","b","c"],"why":"reason"}`,
    check: r => r.saves.length > 0 && r.saves[0].entry.tags === 'a, b, c' && r.saves[0].entry.why === 'reason'
  },
  {
    name: '12. JSON with trailing prose (MEM_ADAPT_CHALLENGE)',
    input: `[MEM_ADAPT_CHALLENGE] {"id":"bio_1","why":"outdated","replacement":"new rule"} Strength: 0.6 Stability: 0.5`,
    check: r => r.adaptChallenges.length > 0 && r.adaptChallenges[0].id === 'bio_1'
  },
  {
    name: '13. SCHEDULE outside brackets',
    input: `[SCHEDULE] 120`,
    check: r => r.scheduleSec === 120
  },
  {
    name: '14. MEM_FOCUS prose topic (no JSON)',
    input: `[MEM_FOCUS] \u2013 "cognitive pressure valve"`,
    check: r => r.focusTopics.length > 0 && r.focusTopics[0].topic.includes('cognitive pressure valve')
  },
  {
    name: '15. MEM_DELETE with kind specified',
    input: `[MEM_DELETE short 42]`,
    check: r => r.deletes.length > 0 && r.deletes[0].id === 42 && r.deletes[0].kind === 'short'
  }
];

let failed = 0;

for (const t of tests) {
  console.log(`\\n--- Test: ${t.name} ---`);
  try {
    const result = parseOutput(t.input);
    if (t.check(result)) {
      console.log('\u2705 Pass');
    } else {
      console.log('\u274C Fail');
      console.log(JSON.stringify(result, null, 2));
      failed++;
    }
  } catch (err) {
    console.log(`\u274C Crash: ${err.message}`);
    failed++;
  }
}

if (failed === 0) {
  console.log('\\n\u2705 ALL TESTS PASSED');
} else {
  console.log(`\\n\u274C ${failed} TESTS FAILED`);
}
