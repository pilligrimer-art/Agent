const fs = require('fs');
const path = require('path');

const logsDir = 'C:\\Users\\Nich\\Documents\\New project 2 - Copy - Copy\\logs';
const outFile = 'C:\\Users\\Nich\\.gemini\\antigravity\\brain\\6bf77344-d4a0-44d0-8c8a-2df1c422c69a\\logs_timeline_v2.md';

const events = [
  { time: '2026-07-28T22:28:05.000Z', desc: '### Правка кода: Нейтрализация промпта и список самовопросов\\n**Файл:** gent/context_builder.js\\n**Факты:**\\n1. Удалены фразы "You are NOT a helpful assistant...".\\n2. Добавлена фраза "Answer to the point, do not apologize without reason, do not offer help unless explicitly asked."\\n3. В контекст добавлен блок [RECENT SELF-QUESTIONS] со списком последних вопросов из curiosityState.questionHistory.' },
  { time: '2026-07-28T22:28:35.000Z', desc: '### Правка кода: Защита от спама сообщений\\n**Файл:** gent/index.js\\n**Факты:**\\n1. Добавлен фильтр для SEND_MESSAGE.\\n2. Последние 3 отправленных агентом сообщения сверяются через isLoopDetected.\\n3. При совпадении сообщение не отправляется, в контекст подается системное предупреждение [MALFORMED_INTENT "duplicate_send_message"].' },
  { time: '2026-07-28T22:28:46.000Z', desc: '### Перезапуск сервера\\nСервер (server.js) и Ollama (ollama serve) перезапущены для применения новых правил.' }
];

let allLogs = [];
const files = ['session_2026-07-28_22-15.txt', 'session_2026-07-28_22-28.txt'];

for (const f of files) {
  if (fs.existsSync(path.join(logsDir, f))) {
    const content = fs.readFileSync(path.join(logsDir, f), 'utf-8');
    allLogs.push(content);
  }
}

let fullText = allLogs.join('\\n');
let outText = '# Хронология правок и логов (с 01:20 до текущего времени)\\n\\n';

const chunks = fullText.split('[CURRENT TIME]');
let firstAdded = false;

for (let i = 1; i < chunks.length; i++) {
  const chunk = chunks[i];
  const timeMatch = chunk.match(/^\s*(2026-07-28T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
  if (timeMatch) {
    const chunkTime = timeMatch[1];
    if (chunkTime >= '2026-07-28T22:20:00.000Z') {
      while (events.length > 0 && events[0].time <= chunkTime) {
        const ev = events.shift();
        outText += '\\n\\n' + ev.desc + '\\n\\n';
      }
      outText += '\\n\\n[CURRENT TIME]' + chunk;
    }
  }
}

while (events.length > 0) {
  outText += '\\n\\n' + events.shift().desc + '\\n\\n';
}

fs.writeFileSync(outFile, outText);
console.log('Artifact written to ' + outFile);
