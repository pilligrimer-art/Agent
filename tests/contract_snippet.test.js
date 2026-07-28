/**
 * Contract tests: Memory Snippet & Loop Detection Invariants
 * Verifies that structured memory cards contain no ellipses,
 * listing echoes are detected/prevented, and loops are reliably broken.
 *
 * Run: node tests/contract_snippet.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

// Setup environment mock variables
process.env.SCHEDULE_MIN_SEC = '10';
process.env.SCHEDULE_MAX_SEC = '90';
process.env.DEFAULT_INTERVAL_SEC = '60';
process.env.LOG_DIR = path.join(__dirname, '../logs');
process.env.MEMORY_DIR = path.join(__dirname, '../memory');

const { getReducedSnippet, formatShortEntry, formatLongEntry } = require('../agent/context_builder');
const { isLoopDetected, isListingEcho } = require('../agent/index');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}\n     ${e.stack}`);
    failed++;
  }
}

console.log('\n=== RUNNING MEMORY CARD & LOOP BREAKING CONTRACT TESTS ===');

// ---- 1. getReducedSnippet Invariants ----
console.log('\n[1] getReducedSnippet Rendering Rules');

test('getReducedSnippet outputs hash and keywords without ellipses', () => {
  const text = 'Anticipatory error correction is a key driver of the cognitive pressure valve, reflecting a biologically-rooted drive to minimize uncertainty and maximize reward prediction accuracy.';
  const snippet = getReducedSnippet(text);
  
  assert.ok(!snippet.includes('...'), 'Snippet must not contain ellipses (...)');
  assert.ok(!snippet.includes('…'), 'Snippet must not contain unicode ellipses');
  assert.ok(snippet.includes('h:'), 'Snippet must include hash header "h:"');
  assert.ok(snippet.includes('keywords:'), 'Snippet must include keyword section');
});

test('getReducedSnippet filters out stop words cleanly', () => {
  const text = 'the and of is insight task thought okay reference';
  const snippet = getReducedSnippet(text);
  assert.ok(snippet.includes('keywords: none'), 'Snippet should output "keywords: none" if only stop words / short words are present');
});

// ---- 2. Entry Format Rendering ----
console.log('\n[2] formatShortEntry & formatLongEntry Invariants');

test('formatShortEntry outputs correct structured card without ellipses', () => {
  const entry = { id: 105, type: 'thought', priority: 'high', content: 'Bayesian update on predictive processing model' };
  const card = formatShortEntry(entry);
  
  assert.ok(!card.includes('...'), 'Card must not contain ellipses (...)');
  assert.ok(card.includes('[#S105'), 'Card must contain short memory prefix #S105');
  assert.ok(card.includes('type:thought'), 'Card must contain correct memory type');
  assert.ok(card.includes('pr:high'), 'Card must contain priority field');
  assert.ok(card.includes('h:'), 'Card must contain hash');
  assert.ok(card.includes('keywords:'), 'Card must contain keywords');
});

test('formatLongEntry outputs correct structured card without ellipses', () => {
  const entry = { id: 56, type: 'insight', tags: 'dopamine, prediction', content: 'Dopamine prediction error update cycle' };
  const card = formatLongEntry(entry);
  
  assert.ok(!card.includes('...'), 'Card must not contain ellipses (...)');
  assert.ok(card.includes('[#L56'), 'Card must contain long memory prefix #L56');
  assert.ok(card.includes('type:insight'), 'Card must contain correct memory type');
  assert.ok(card.includes('tags:dopamine, prediction'), 'Card must contain tags');
  assert.ok(card.includes('h:'), 'Card must contain hash');
  assert.ok(card.includes('keywords:'), 'Card must contain keywords');
});

// ---- 3. Listing Echo Filter ----
console.log('\n[3] isListingEcho Filtering Invariants');

test('isListingEcho detects verbatim memory card echoes', () => {
  const echoedThought = '[#S105 | type:thought | pr:high | h:8f2c] keywords: bayesian | update | predictive\n' +
                         '[#S106 | type:thought | pr:normal | h:7a1e] keywords: dopamine | reinforcement\n' +
                         '[#L56 | type:insight | tags:dopamine | h:3b9f] keywords: reward | prediction';
  
  assert.strictEqual(isListingEcho(echoedThought), true, 'Verbatim list echoes must be filtered');
});

test('isListingEcho detects repeated card structures', () => {
  const repetitiveProse = 'I will examine h:8f2c and h:7a1e to update keywords dopamine and keywords bayesian.';
  assert.strictEqual(isListingEcho(repetitiveProse), true, 'Repetitive card meta keys must trigger echo filter');
});

test('isListingEcho allows normal reasoning and thoughts', () => {
  const normalThought = 'I need to focus on Bayesian updates and dopamine reward prediction errors to complete the task.';
  assert.strictEqual(isListingEcho(normalThought), false, 'Normal abstract thoughts should not be filtered');
});

// ---- 4. Loop Detector Upgrades ----
console.log('\n[4] isLoopDetected Upgraded Checks');

test('isLoopDetected catches exact repetitions', () => {
  const thought = 'Updating the database with latest user test results.';
  assert.strictEqual(isLoopDetected(thought, [thought]), true, 'Exact thought repetition must be blocked');
});

test('isLoopDetected catches prefix overlaps with trailing additions', () => {
  const prev = 'Let us focus on #S87. I will save this thought to long memory and ask the user.';
  const next = 'Let us focus on #S87. I will save this thought to long memory and ask the user. Additionally, I should scheduled next cycle.';
  assert.strictEqual(isLoopDetected(next, [prev]), true, 'High prefix overlap repetition must be blocked');
});

test('isLoopDetected catches sentence-level repetitions', () => {
  const prev = 'The cognitive pressure valve is highly active. We must balance dopamine and predictive processing systems. This is the third cycle. The environment is verified as stable.';
  const next = 'We must balance dopamine and predictive processing systems. The cognitive pressure valve is highly active. The environment is verified as stable. This is a new thought cycle.';
  assert.strictEqual(isLoopDetected(next, [prev]), true, 'Over 75% of long sentences overlapping must trigger loop breaker');
});

test('isLoopDetected catches memory listing echo loops', () => {
  const repetitiveCardStrcut = 'Reflecting on: h:3f4e and h:9b2a keywords dopamine keywords update.';
  assert.strictEqual(isLoopDetected(repetitiveCardStrcut, []), true, 'Thought containing repeated card structures must trigger loop detector');
});

// ---- Summary ----
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All snippet and loop-breaking contract tests passed beautifully! ✅');
}
