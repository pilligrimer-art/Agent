const fs = require('fs');
const path = require('path');

const logsDir = 'C:\\Users\\Nich\\Documents\\New project 2 - Copy - Copy\\logs';
const outFile = 'C:\\Users\\Nich\\.gemini\\antigravity\\brain\\6bf77344-d4a0-44d0-8c8a-2df1c422c69a\\logs_timeline_v3.md';

const events = [
  { time: '2026-07-28T22:42:00.000Z', desc: '### Code Edit: SELF_QUESTION capture and procedural alert\n**Files:** gent/output_parser.js, gent/context_builder.js\n**Facts:**\n1. output_parser.js updated regex backreference \\1 for matching quote pairs.\n2. context_builder.js added hasUnansweredUser check to suppress curiosityBlock and inject [SYSTEM: USER WAITING].' },
  { time: '2026-07-28T22:47:38.000Z', desc: '### Code Edit: Symmetric Language Relevance Guard\n**File:** gent/index.js\n**Facts:**\n1. Added bidirectional cyrillicRatio check in unAgent loop prior to calling 	elegramBridge.sendMessage().\n2. Skips sending message if user/agent language ratio mismatches and injects [MALFORMED_INTENT "irrelevant_language"].' },
  { time: '2026-07-28T22:47:43.000Z', desc: '### Server Restart\n
ode server.js process restarted.' }
];

let allLogs = [];
const files = ['session_2026-07-28_22-43.txt', 'session_2026-07-28_22-46.txt', 'session_2026-07-28_22-47.txt'];

for (const f of files) {
  if (fs.existsSync(path.join(logsDir, f))) {
    const content = fs.readFileSync(path.join(logsDir, f), 'utf-8');
    allLogs.push(content);
  }
}

let fullText = allLogs.join('\n');
let outText = '# Хронология правок и логов (с 01:35 до 01:57)\n\n';

const chunks = fullText.split('[CURRENT TIME]');

for (let i = 1; i < chunks.length; i++) {
  const chunk = chunks[i];
  const timeMatch = chunk.match(/^\s*(2026-07-28T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
  if (timeMatch) {
    const chunkTime = timeMatch[1];
    if (chunkTime >= '2026-07-28T22:35:00.000Z') {
      while (events.length > 0 && events[0].time <= chunkTime) {
        const ev = events.shift();
        outText += '\n\n' + ev.desc + '\n\n';
      }
      outText += '\n\n[CURRENT TIME]' + chunk;
    }
  }
}

while (events.length > 0) {
  outText += '\n\n' + events.shift().desc + '\n\n';
}

fs.writeFileSync(outFile, outText, 'utf-8');
console.log('Artifact written to ' + outFile);
