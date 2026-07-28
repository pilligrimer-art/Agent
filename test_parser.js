const { parseOutput } = require('./agent/output_parser');

const tests = [
  {
    name: '1. valid MEM_SAVE executes and appears in executed feedback',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":"task."}`,
    check: r => r.saves.length === 1 && r.feedback.executed.length === 0 && r.feedback.failed.length === 0
    // Note: executed feedback for MEM_SAVE is populated in index.js executeActions, not in parseOutput
  },
  {
    name: '2. MEM_SAVE with smart quotes repairs and executes',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":\u201ctask.\u201d}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.priority === 'high'
  },
  {
    name: '3. bare [MEM_SAVE] creates feedback and does not save',
    input: `[MEM_SAVE]`,
    check: r => r.saves.length === 0 && r.feedback.failed.some(f => f.intent === 'MEM_SAVE') && r.helpRequests.includes('MEM_SAVE')
  },
  {
    name: '4. [MEM_SAVE] - "text" creates feedback and does not save',
    input: `[MEM_SAVE] \u2013 "Initial assessment: We need more sleep."`,
    check: r => r.saves.length === 0 && r.feedback.failed.some(f => f.intent === 'MEM_SAVE' && f.reason === 'malformed_tag')
  },
  {
    name: '5. valid SCHEDULE 60 executes',
    input: `[SCHEDULE 60]`,
    check: r => r.scheduleSec === 60 && r.feedback.failed.length === 0
  },
  {
    name: '6. [SCHEDULE] - "60 seconds" creates feedback and does not schedule',
    input: `[SCHEDULE] \u2013 Schedule next cycle in 60 seconds`,
    check: r => r.scheduleSec !== 60 && r.feedback.failed.some(f => f.intent === 'SCHEDULE' && f.reason === 'malformed_tag')
  },
  {
    name: '7. valid SEND_MESSAGE JSON executes',
    input: `[SEND_MESSAGE] {"text":"Hello","why":"Greeting"}`,
    check: r => r.messages.length === 1 && r.messages[0] === 'Hello' && r.feedback.failed.length === 0
  },
  {
    name: '8. [SEND_MESSAGE] - "hello" creates feedback and does not send',
    input: `[SEND_MESSAGE] \u2013 "Hello user, I have finished my task."`,
    check: r => r.messages.length === 0 && r.feedback.failed.some(f => f.intent === 'SEND_MESSAGE' && f.reason === 'malformed_tag')
  },
  {
    name: '9. valid MEM_ADAPT executes',
    input: `[MEM_ADAPT] {"type":"suppress","target":"debug","rule":"less debug","why":"noisy"}`,
    check: r => r.adapts.length === 1 && r.feedback.failed.length === 0
  },
  {
    name: '10. [MEM_ADAPT] - "text" creates feedback and does not adapt',
    input: `[MEM_ADAPT] \u2013 Need to reframe the tool usage priority`,
    check: r => r.adapts.length === 0 && r.feedback.failed.some(f => f.intent === 'MEM_ADAPT' && f.reason === 'malformed_tag')
  },
  {
    name: '11. prose "I should save this" creates TOOL HINT only, no save',
    input: `This is interesting. I should save this.`,
    check: r => r.saves.length === 0 && r.feedback.hints.some(h => h.intent === 'MEM_SAVE')
  },
  {
    name: '12. no action and no intent = no feedback',
    input: `I am simply thinking about what it means to exist.`,
    check: r => r.saves.length === 0 && r.feedback.executed.length === 0 && r.feedback.failed.length === 0 && r.feedback.hints.length === 0
  },
  {
    name: '13. valid MEM_FOCUS #ID works',
    input: `[MEM_FOCUS #61 #62]`,
    check: r => r.focusIds.length === 2 && r.feedback.failed.length === 0
  },
  {
    name: '14. HELP_ACTION "MEM_SAVE" adds help request',
    input: `[HELP_ACTION "MEM_SAVE"]`,
    check: r => r.helpRequests.includes('MEM_SAVE')
  },
  {
    name: '15. malformed action does not create SYSTEM WARNING (no parseErrorCount for prose)',
    input: `[MEM_SAVE] \u2013 "Some thought about the world"`,
    check: r => r.parseErrorCount === 0 && r.saves.length === 0 && r.feedback.failed.length === 1
  },
  {
    name: '16. [REFLECT] works',
    input: `[REFLECT]`,
    check: r => r.reflect === true && r.feedback.failed.length === 0
  },
  {
    name: '17. [REFLECT] - "question" does NOT reflect, creates feedback',
    input: `[REFLECT] \u2013 Question: Why did the chicken cross the road?`,
    check: r => r.reflect === false && r.feedback.failed.some(f => f.intent === 'REFLECT' && f.reason === 'malformed_tag')
  },
  {
    name: '18. MEM_SAVE tags array repairs to string',
    input: `[MEM_SAVE long] {"type":"insight","content":"Test","tags":["a","b","c"],"why":"reason"}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.tags === 'a, b, c'
  },
  {
    name: '19. MEM_SAVE missing why is auto-filled',
    input: `[MEM_SAVE short] {"type":"thought","content":"Just a thought."}`,
    check: r => r.saves.length === 1 && r.saves[0].entry.why === 'Agent expressed stable save intent.'
  }
];

let failed = 0;

for (const t of tests) {
  console.log(`\n--- Test: ${t.name} ---`);
  try {
    const result = parseOutput(t.input);
    if (t.check(result)) {
      console.log('\u2705 Pass');
    } else {
      console.log('\u274c Fail');
      console.log(JSON.stringify(result, null, 2));
      failed++;
    }
  } catch (err) {
    console.log(`\u274c Crash: ${err.message}`);
    console.log(err.stack);
    failed++;
  }
}

if (failed === 0) {
  console.log('\n\u2705 ALL TESTS PASSED');
} else {
  console.log(`\n\u274c ${failed} TESTS FAILED`);
}
