const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
require('./db'); // инициализация БД при загрузке (синхронно)
const mem = require('./memory_manager');
const { buildContext } = require('./context_builder');
const { parseOutput, logParseError } = require('./output_parser');
const { scheduleNext, runSafely, clearScheduledRun } = require('./scheduler');

// --- Убедиться что директории существуют ---
function ensureDirs() {
  if (!fs.existsSync(config.logDir)) fs.mkdirSync(config.logDir, { recursive: true });
  if (!fs.existsSync(config.memoryDir)) fs.mkdirSync(config.memoryDir, { recursive: true });
}

const CHAT_HISTORY_FILE = path.join(config.logDir, 'chat_history.json');

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[AGENT] Ошибка загрузки истории чата:', err.message);
  }
  return [];
}

function saveChatHistory() {
  try {
    if (memState.chatHistory.length > 200) {
      memState.chatHistory = memState.chatHistory.slice(-200);
    }
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(memState.chatHistory, null, 2), 'utf8');
  } catch (err) {
    console.error('[AGENT] Ошибка сохранения истории чата:', err.message);
  }
}

// --- Состояние оперативной памяти агента ---
const memState = {
  thoughtHistory: [],
  pendingMessages: [],
  chatHistory: loadChatHistory(),
  lastReflectTime: 0,
  consecutiveParseErrors: 0,
  requestedHelp: [],
  focusItems: []
};

function pushUserMessage(text) {
  const msg = { sender: 'user', time: new Date().toISOString(), text };
  memState.pendingMessages.push(msg);
  memState.chatHistory.push(msg);
  saveChatHistory();
  console.log(`[USER] Новое сообщение: ${text.substring(0, 30)}...`);
  // Прерываем ожидание и заставляем агента подумать прямо сейчас
  clearScheduledRun();
  runSafely(runAgent);
}

function injectSystemMessage(text) {
  memState.pendingMessages.push({
    sender: 'system',
    time: new Date().toISOString(),
    text
  });
}

// --- Запрос к Ollama ---
async function callOllama(prompt) {
  const url = `${config.ollamaHost.replace(/\/$/, '')}/api/generate`;
  const response = await axios.post(
    url,
    {
      model: config.modelName,
      prompt,
      stream: false,
      options: { num_predict: config.maxTokens }
    },
    { timeout: 120000 }
  );

  if (!response.data || typeof response.data.response !== 'string') {
    throw new Error('Ollama вернула неожиданный формат ответа.');
  }
  return response.data.response;
}

// --- Рефлексия: сжатие краткосрочной памяти в долгосрочную ---
async function runReflection() {
  const shortEntries = mem.getShortMem(20);
  if (shortEntries.length === 0) {
    console.log('[REFLECT] Краткосрочная память пуста — нечего сжимать.');
    return;
  }

  const shortText = shortEntries
    .map(e => `[${e.type}] ${e.content}`)
    .join('\n');

  const prompt = `You are performing free reflection on your memory.
Carefully study your current thoughts and plans from short-term memory.
Synthesize deep existential insights and fundamental knowledge from them (up to 5 items).
Each insight must be extremely concise (1-2 sentences) for placement in long-term memory.

Short-term memory:
${shortText}

Respond STRICTLY in JSON format, without any extra words:
{"insights":["insight 1","insight 2","insight 3"]}`;

  try {
    const raw = await callOllama(prompt);
    // Пробуем извлечь JSON из ответа
    const jsonMatch = raw.match(/\{[\s\S]*"insights"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.insights)) {
        for (const insight of parsed.insights.slice(0, 5)) {
          if (typeof insight === 'string' && insight.trim()) {
            mem.addLong('reflection', insight.trim(), 'рефлексия', 'reflect');
          }
        }
        // Удаляем выполненные задачи из краткосрочной
        for (const e of shortEntries) {
          if (e.type === 'task' || e.type === 'thought') {
            mem.deleteShort(e.id);
          }
        }
        console.log(`[REFLECT] Сохранено ${Math.min(parsed.insights.length, 5)} выводов.`);
        return;
      }
    }
    logParseError('REFLECT', `Не удалось распарсить JSON рефлексии: ${raw.slice(0, 200)}`);
  } catch (err) {
    logParseError('REFLECT', `Ошибка рефлексии: ${err.message}`);
  }
}

// --- Запись лога сессии ---
function writeSessionLog(data) {
  try {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/[T:]/g, (c) => c === 'T' ? '_' : '-');
    const file = path.join(config.logDir, `${stamp}.txt`);
    const content = [
      `=== Сессия агента: ${now.toISOString()} ===`,
      `Модель: ${config.modelName}`,
      '',
      '--- ПРОМПТ ---',
      data.prompt,
      '',
      '--- ОТВЕТ МОДЕЛИ ---',
      data.response,
      '',
      '--- ПАРСИНГ ---',
      `Сохранения: ${JSON.stringify(data.parsed?.saves || [])}`,
      `Удаления: ${JSON.stringify(data.parsed?.deletes || [])}`,
      `Следующий запуск: ${data.parsed?.scheduleSec || config.defaultIntervalSec}с`,
      `Рефлексия: ${data.parsed?.reflect || false}`,
      '',
      data.error ? `--- ОШИБКА ---\n${data.error}` : '--- Без ошибок ---'
    ].join('\n');
    fs.writeFileSync(file, content, 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

// --- Выполнение команд из парсинга ---
function executeActions(parsed) {
  const results = { saved: 0, deleted: 0, errors: [] };

  // Сохранения
  for (const save of parsed.saves) {
    try {
      if (save.kind === 'short') {
        mem.addShort(
          save.entry.type || 'thought',
          save.entry.content || '',
          save.entry.priority || 'normal',
          save.entry.expires || null
        );
      } else {
        mem.addLong(
          save.entry.type || 'insight',
          save.entry.content || '',
          save.entry.tags || '',
          'agent'
        );
      }
      results.saved++;
    } catch (err) {
      results.errors.push(`SAVE ${save.kind}: ${err.message}`);
      logParseError('EXECUTE_SAVE', err.message);
    }
  }

  // Удаления
  for (const del of parsed.deletes) {
    try {
      let deleted = false;
      if (del.kind === 'short') {
        deleted = mem.deleteShort(del.id);
      } else if (del.kind === 'long') {
        deleted = mem.deleteLong(del.id);
      } else {
        // kind == undefined -> try both
        deleted = mem.deleteShort(del.id) || mem.deleteLong(del.id);
      }
      
      if (deleted) {
        results.deleted++;
      } else {
        logParseError('EXECUTE_DELETE', `ID ${del.id} не найден${del.kind ? ' в ' + del.kind : ''}`);
      }
    } catch (err) {
      results.errors.push(`DELETE ${del.kind} #${del.id}: ${err.message}`);
      logParseError('EXECUTE_DELETE', err.message);
    }
  }

  // Адаптации
  for (const adapt of (parsed.adapts || [])) {
    try {
      mem.addAdaptation(null, adapt.type, adapt.target, adapt.rule, adapt.why, adapt.strength, adapt.stability, 'agent');
    } catch (err) {
      logParseError('EXECUTE_ADAPT', err.message);
    }
  }

  for (const chal of (parsed.adaptChallenges || [])) {
    try {
      mem.challengeAdaptation(chal.id);
    } catch (err) {
      logParseError('EXECUTE_CHALLENGE', err.message);
    }
  }

  for (const weak of (parsed.adaptWeakens || [])) {
    try {
      mem.weakenAdaptation(weak.id, weak.amount || 0.1);
    } catch (err) {
      logParseError('EXECUTE_WEAKEN', err.message);
    }
  }

  return results;
}

// --- Главный цикл агента ---
async function runAgent() {
  // Забираем сообщения из очереди
  const messages = [...memState.pendingMessages];
  memState.pendingMessages = [];

  const prompt = buildContext(memState.thoughtHistory, messages, memState.consecutiveParseErrors, memState.requestedHelp, memState.focusItems.map(f => f.id));
  let response = '';
  let parsed = null;
  let error = null;
  let nextScheduleSec = config.defaultIntervalSec;

  try {
    console.log(`[AGENT] Запрос к ${config.modelName}...`);
    response = await callOllama(prompt);
    console.log('[AGENT] Ответ получен.');

    parsed = parseOutput(response);
    const results = executeActions(parsed);
    console.log(`[AGENT] Сохранено: ${results.saved}, удалено: ${results.deleted}`);

    // Учет бюджета ошибок парсинга
    if (parsed.parseErrorCount > 0) {
      memState.consecutiveParseErrors += parsed.parseErrorCount;
    } else {
      memState.consecutiveParseErrors = 0;
    }

    if (results.errors.length > 0) {
      console.warn(`[AGENT] Ошибки выполнения: ${results.errors.join('; ')}`);
    }

    // Обработка сообщений от агента
    if (parsed.messages && parsed.messages.length > 0) {
      for (const msgText of parsed.messages) {
        memState.chatHistory.push({ sender: 'agent', time: new Date().toISOString(), text: msgText });
        console.log(`[AGENT -> USER] ${msgText}`);
      }
      saveChatHistory();
    }

    // Рефлексия
    if (parsed.reflect) {
      const nowMs = Date.now();
      if (nowMs - memState.lastReflectTime < 3 * 60 * 1000) {
        console.warn('[AGENT] Запуск рефлексии проигнорирован (с прошлого раза прошло менее 3 минут).');
      } else {
        console.log('[AGENT] Запуск рефлексии...');
        await runReflection();
        memState.lastReflectTime = nowMs;
      }
    }

    nextScheduleSec = Math.min(parsed.scheduleSec, 900); // max 15 минут
    memState.requestedHelp = parsed.helpRequests || [];

    // Обновление фокуса
    for (let i = memState.focusItems.length - 1; i >= 0; i--) {
      memState.focusItems[i].ttl -= 1;
      if (memState.focusItems[i].ttl <= 0) {
        memState.focusItems.splice(i, 1);
      }
    }
    if (parsed.focusTopics && parsed.focusTopics.length > 0) {
      if (!parsed.focusIds) parsed.focusIds = [];
      for (const req of parsed.focusTopics) {
        const foundShort = mem.searchShortMem(req.topic).slice(0, req.limit || 3);
        const foundLong = mem.searchLongMem(req.topic, req.limit || 3);
        const combined = [...foundShort, ...foundLong].slice(0, req.limit || 3);
        for (const item of combined) {
          if (!parsed.focusIds.includes(item.id)) {
            parsed.focusIds.push(item.id);
          }
        }
      }
    }

    if (parsed.focusIds && parsed.focusIds.length > 0) {
      for (const id of parsed.focusIds) {
        const existing = memState.focusItems.find(x => x.id === id);
        if (existing) {
          existing.ttl = 3;
        } else {
          memState.focusItems.push({ id, ttl: 3 });
        }
      }
    }
    // Ограничение до 3 элементов
    if (memState.focusItems.length > 3) {
      memState.focusItems = memState.focusItems.slice(-3);
    }

    // Вывод мысли агента и добавление в историю
    if (parsed.thought) {
      memState.thoughtHistory.push(parsed.thought);
      if (memState.thoughtHistory.length > config.maxHistoryInContext) {
        memState.thoughtHistory.shift();
      }
      console.log('\n--- Мысль агента ---');
      console.log(parsed.thought);
      console.log('---');
    }
  } catch (caught) {
    error = caught.message;
    console.error(`[AGENT] Ошибка: ${error}`);
  }

  // Лог сессии
  const logFile = writeSessionLog({ prompt, response, parsed, error });
  if (logFile) console.log(`[AGENT] Лог: ${logFile}`);

  // Планирование следующего запуска
  if (process.env.RUN_ONCE === '1') {
    console.log(`[AGENT] Режим одного запуска. Следующий был бы через ${nextScheduleSec}с.`);
  } else {
    scheduleNext(runAgent, nextScheduleSec);
  }
}

// --- Точка входа ---
function main() {
  ensureDirs();

  console.log('[AGENT] Автономный агент запущен.');
  console.log(`[AGENT] Модель: ${config.modelName}`);
  console.log(`[AGENT] БД: ${path.join(config.memoryDir, 'agent.db')}`);
  console.log(`[AGENT] Записей в STM: ${mem.countShort()}, LTM: ${mem.countLong()}`);
  mem.initBaseAdaptations();
  memState.pendingMessages.push({
    sender: 'system',
    time: new Date().toISOString(),
    text: '[SYSTEM] Environment started (start.bat was executed).'
  });
  runSafely(runAgent);
}

if (require.main === module) {
  main();
}

module.exports = {
  runAgent,
  callOllama,
  runReflection,
  main,
  pushUserMessage,
  injectSystemMessage,
  getChatHistory: () => memState.chatHistory
};
