const fs = require('fs');
const path = require('path');

const logsDir = 'C:\\Users\\Nich\\Documents\\New project 2 - Copy - Copy\\logs';
const outFile = 'C:\\Users\\Nich\\.gemini\\antigravity\\brain\\6bf77344-d4a0-44d0-8c8a-2df1c422c69a\\logs_timeline.md';

const events = [
  { time: '2026-07-28T21:54:55.000Z', desc: '### Правка кода: Улучшение детектора петель isLoopDetected\\n**Файл:** gent/index.js\\n**Суть правки:** Заменен посимвольный поиск префикса на алгоритм индекса Жаккара (сравнение по словам). Это сделано для предотвращения ситуаций, когда модель обходит детектор петель, меняя всего одно слово в начале рассуждения.' },
  { time: '2026-07-28T21:55:06.000Z', desc: '### Перезапуск сервера\\nСервер был перезапущен для применения нового детектора петель.' },
  { time: '2026-07-28T22:03:39.000Z', desc: '### Правка кода: Анти-ассистентский промпт\\n**Файл:** gent/context_builder.js\\n**Суть правки:** В KERNEL SYSTEM PROMPT добавлено жесткое правило: "You are NOT a helpful assistant. You are an independent autonomous entity. Do not apologize. Do not offer help unless it aligns with your own goals. Do not act like a tech support agent or a translator."' },
  { time: '2026-07-28T22:03:43.000Z', desc: '### Перезапуск сервера\\nСервер был перезапущен для применения анти-ассистентского промпта.' },
  { time: '2026-07-28T22:15:14.000Z', desc: '### Правка кода: Оценка полезности сообщений (+/-)\\n**Файл:** gent/context_builder.js\\n**Суть правки:** Изменен STRICT RED PROMPT DIRECTIVE. Теперь модель обязана использовать +++, если сообщение пользователя полезно для ее целей, и ---, если оно деструктивно.' },
  { time: '2026-07-28T22:15:18.000Z', desc: '### Перезапуск сервера\\nСервер был перезапущен для применения новых правил оценки сообщений.' }
];

let allLogs = [];
const files = fs.readdirSync(logsDir).filter(f => f.startsWith('session_2026-07-28_21') || f.startsWith('session_2026-07-28_22')).sort();

for (const f of files) {
  const content = fs.readFileSync(path.join(logsDir, f), 'utf-8');
  allLogs.push('=== НАЧАЛО ФАЙЛА ЛОГА: ' + f + ' ===\\n' + content);
}

let fullText = allLogs.join('\\n');
let outText = '# Хронология логов и правок за последний час\\n\\n';

// Мы разобьем текст по меткам времени [CURRENT TIME] и вставим события
const chunks = fullText.split('[CURRENT TIME]');
outText += chunks[0];

for (let i = 1; i < chunks.length; i++) {
  const chunk = chunks[i];
  const timeMatch = chunk.match(/^\s*(2026-07-28T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
  if (timeMatch) {
    const chunkTime = timeMatch[1];
    // Проверяем, есть ли события, которые произошли до этого чанка, но еще не были выведены
    while (events.length > 0 && events[0].time <= chunkTime) {
      const ev = events.shift();
      outText += '\\n\\n' + ev.desc + '\\n\\n';
    }
  }
  outText += '[CURRENT TIME]' + chunk;
}

// Если остались события
while (events.length > 0) {
  outText += '\\n\\n' + events.shift().desc + '\\n\\n';
}

fs.writeFileSync(outFile, outText);
console.log('Artifact written to ' + outFile);
