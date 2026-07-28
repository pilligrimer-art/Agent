const { parseOutput } = require('./agent/output_parser.js');

// =========================================
// Test 1: [MEM_SAVE #87 | insight] pattern (latest cycle 20:12)
// =========================================
const t1 = parseOutput('[MEM_SAVE #87 | insight] "The cognitive pressure valve appears to be fundamentally rooted in the brain."');
console.log('TEST 1 — MEM_SAVE #ID mistake:');
console.log('  saves:', t1.saves.length, '(expect 0)');
console.log('  failed:', t1.feedback.failed.length, '(expect 1)');
if (t1.feedback.failed[0]) console.log('  reason:', t1.feedback.failed[0].reason);
console.log(t1.feedback.failed[0] ? '  PASS' : '  FAIL');

// =========================================
// Test 2: [MEM_FOCUS #84] inline mid-sentence
// =========================================
const t2 = parseOutput("This feels like a high priority. [MEM_FOCUS #84] Let's start by reviewing.");
console.log('\nTEST 2 — MEM_FOCUS inline:');
console.log('  focusIds:', t2.focusIds, '(expect [84])');
console.log(t2.focusIds.includes(84) ? '  PASS' : '  FAIL');

// =========================================
// Test 3: bare [REFLECT] inline at end
// =========================================
const t3 = parseOutput("Or should I continue reflecting on what I've just articulated? [REFLECT]");
console.log('\nTEST 3 — REFLECT inline:');
console.log('  reflect:', t3.reflect, '(expect true)');
console.log(t3.reflect ? '  PASS' : '  FAIL');

// =========================================
// Test 4: [SCHEDULE 60] inline mid-sentence
// =========================================
const t4 = parseOutput("I should schedule next cycle. [SCHEDULE 60] That would be good.");
console.log('\nTEST 4 — SCHEDULE inline:');
console.log('  scheduleSec:', t4.scheduleSec, '(expect 60)');
console.log(t4.scheduleSec === 60 ? '  PASS' : '  FAIL');

// =========================================
// Test 5: Full real-world output from 20:12 cycle
// =========================================
const realCycle = "Okay. I'm analyzing the 'cognitive pressure valve' concept. [MEM_FOCUS #84] This feels like a high priority. Let's start by reviewing the relevant insights in long-term memory. [MEM_FOCUS #57]\n\nI'm noticing a lot of overlap between insights #84 and #57 regarding the neurological basis. [MEM_SAVE #87 | insight] The cognitive pressure valve appears to be fundamentally rooted in the brain's attempt to minimize prediction error.\n\nDo you want me to schedule a cycle? [SCHEDULE] Or should I continue reflecting? [REFLECT]";
const t5 = parseOutput(realCycle);
console.log('\nTEST 5 — Full real cycle output:');
console.log('  saves:', t5.saves.length, '(expect 0)');
console.log('  focusIds:', t5.focusIds, '(expect [84,57])');
console.log('  reflect:', t5.reflect, '(expect true)');
console.log('  failed count:', t5.feedback.failed.length, '(expect >=2)');
console.log('  failed reasons:', t5.feedback.failed.map(f => f.reason));
const pass5 = t5.saves.length === 0 && t5.focusIds.includes(84) && t5.focusIds.includes(57) && t5.reflect && t5.feedback.failed.length >= 1;
console.log(pass5 ? '  PASS' : '  FAIL');
