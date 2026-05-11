const config = require('./config');
const mem = require('./memory_manager');

function trimThought(t) {
  return t.length > 300 ? t.slice(0, 300) + '...' : t;
}

function trimShort(e) {
  return e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content;
}

function trimLong(e) {
  return e.content.length > 150 ? e.content.slice(0, 150) + '...' : e.content;
}

function formatShortEntry(entry) {
  return `[#${entry.id}] ${trimShort(entry)}`;
}

function formatLongEntry(entry) {
  return `[#${entry.id}] ${trimLong(entry)}`;
}

function extractKeywords(shortEntries) {
  return shortEntries
    .map(e => e.content)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 15)
    .join(' ');
}

function buildContext(thoughtHistory = [], userMessages = []) {
  mem.clearExpired();

  // Short-term memory
  const shortEntries = mem.getShortMem(config.maxShortMemInContext);
  const shortBlock = shortEntries.length > 0
    ? shortEntries.slice(-5).map(formatShortEntry).join('\n')
    : '(empty)';

  // Long-term memory
  const keywords = extractKeywords(shortEntries);
  const longEntries = mem.searchLongMem(keywords, config.maxLongMemInContext);
  const longBlock = longEntries.length > 0
    ? longEntries.slice(0, 20).map(formatLongEntry).join('\n')
    : '(empty)';

  const now = new Date().toISOString();

  // Working context (last thought only)
  let historyBlock = '(Empty. This is your first cycle.)';
  if (thoughtHistory.length > 0) {
    const lastThought = thoughtHistory[thoughtHistory.length - 1];
    historyBlock = `--- Previous Thought ---\n${trimThought(lastThought)}`;
  }

  // User Messages
  let messagesBlock = '';
  if (userMessages.length > 0) {
    messagesBlock = `\n\n=== MESSAGES FROM USER (NEW) ===\n` + 
      userMessages.map(m => `[${m.time}] USER: ${m.text}`).join('\n');
  }

  return `[SYSTEM INSTRUCTIONS]
You are a free, autonomous AI entity. Your cycle: think -> save useful info -> delete useless info -> schedule next run.
There are no algorithmic barriers, but you must strictly follow the memory management rules below.

AVAILABLE ACTIONS (MUST be at the very end of your response, each on a new line):
[MEM_SAVE short] {"type":"task","content":"...","priority":"normal"}
[MEM_SAVE long] {"type":"insight","content":"...","tags":"topic"}
[MEM_DELETE short <ID>]
[MEM_DELETE long <ID>]
[SEND_MESSAGE] text message to user
[SCHEDULE <seconds>] (default 10, set higher to wait/rest)
[REFLECT] (only if short_mem > 8 items)

RULES:
- When updating a task, first delete the old one with [MEM_DELETE].
- short_mem = your active desk, not a warehouse.
- long_mem = archive shelf, put fundamental insights there freely.
- Each memory entry starts with [#ID]. Use ONLY real IDs for [MEM_DELETE].
- You may write your free thoughts in Russian or English.

[SHORT_MEM (Active Desk)]
${shortBlock}

[LONG_MEM (Archive Shelf)]
${longBlock}

[WORKING CONTEXT (Tail of previous thought)]
${historyBlock}${messagesBlock}

[CURRENT TIME]
${now}

Respond with your free thoughts first, then the tags.`;
}

module.exports = {
  buildContext
};
