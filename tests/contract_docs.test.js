/**
 * Contract tests: Documentation drift detection
 * Checks that README does NOT contain known false claims,
 * and that config exports required SSOT keys.
 *
 * Run: node tests/contract_docs.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.SCHEDULE_MIN_SEC = '10';
process.env.SCHEDULE_MAX_SEC = '90';
process.env.DEFAULT_INTERVAL_SEC = '60';
process.env.LOG_DIR = path.join(__dirname, '../logs');
process.env.MEMORY_DIR = path.join(__dirname, '../memory');

const config = require('../agent/config');
const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

// ---- 1. Config SSOT exports ----
console.log('\n[1] Config exports required SSOT keys');

test('config exports scheduleMinSec', () => assert.ok('scheduleMinSec' in config));
test('config exports scheduleMaxSec', () => assert.ok('scheduleMaxSec' in config));
test('config exports defaultIntervalSec', () => assert.ok('defaultIntervalSec' in config));
test('scheduleMinSec < scheduleMaxSec', () =>
  assert.ok(config.scheduleMinSec < config.scheduleMaxSec));

// ---- 2. README: false claims removed ----
console.log('\n[2] README does not contain known false claims');

test('No mention of short_mem.json', () =>
  assert.ok(!readme.includes('short_mem.json'), 'Found old JSON memory claim'));

test('No mention of long_mem.json', () =>
  assert.ok(!readme.includes('long_mem.json'), 'Found old JSON memory claim'));

test('No --daemon flag claim', () =>
  assert.ok(!readme.includes('--daemon'), 'Found removed --daemon flag'));

test('No --web flag claim', () =>
  assert.ok(!readme.includes('--web'), 'Found removed --web flag'));

test('No "10 до 900 секунд" (old hardcoded limit)', () =>
  assert.ok(!readme.includes('10 до 900'), 'Found old "10 до 900" limit'));

test('No "telemetry/events.jsonl" (old interface claim)', () =>
  assert.ok(!readme.includes('telemetry/events.jsonl'), 'Found removed telemetry path'));

// ---- 3. README: required truths present ----
console.log('\n[3] README contains required truths');

test('README mentions SQLite', () =>
  assert.ok(readme.includes('SQLite'), 'README must mention SQLite storage'));

test('README mentions memory/agent.db', () =>
  assert.ok(readme.includes('agent.db'), 'README must document actual DB path'));

test('README mentions node server.js', () =>
  assert.ok(readme.includes('node server.js'), 'README must document actual run command'));

test('README mentions Documentation Constitution', () =>
  assert.ok(readme.includes('Documentation Constitution'), 'SSOT constitution must be in README'));

test('README mentions SCHEDULE_MIN_SEC', () =>
  assert.ok(readme.includes('SCHEDULE_MIN_SEC'), 'README must document env-configurable limits'));

test('README mentions inline MEM_FOCUS limitation', () =>
  assert.ok(readme.includes('Inline') || readme.includes('inline'), 'README must document inline focus limitation'));

// ---- Summary ----
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
else { console.log('All doc-drift tests pass. ✅'); }
