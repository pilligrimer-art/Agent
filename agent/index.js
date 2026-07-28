const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
require('./db'); // инициализация БД при загрузке (синхронно)
const mem = require('./memory_manager');
const tools = require('./tools');
const telegramBridge = require('./telegram_bridge');
const { buildContext, getReducedSnippet } = require('./context_builder');

const skillsDir = path.join(__dirname, '..', 'skills');
const loadedSkills = {};
try {
  if (fs.existsSync(skillsDir)) {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const skill = require(path.join(skillsDir, file));
      if (skill.tag) loadedSkills[skill.tag] = skill;
    }
  }
} catch (e) { console.error('Failed to load skills:', e); }

// --- Состояние сессии ---
const { parseOutput, logTelemetry } = require('./output_parser');
const { scheduleNext, runSafely, clearScheduledRun, getSchedulerState } = require('./scheduler');

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
  focusItems: [],
  actionFeedback: null,
  totalRuns: 0,
  lastRunTime: null
};

function pushUserMessage(text, userId = null) {
  if (userId) {
    memState.lastUserId = userId;
  }
  const msg = { sender: 'user', time: new Date().toISOString(), text, userId };
  memState.pendingMessages.push(msg);
  memState.chatHistory.push(msg);
  saveChatHistory();
  console.log(`[USER] Новое сообщение: ${text.length > 30 ? text.substring(0, 30) + '...' : text}`);
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

// --- Silent Redirect (replaces SYSTEM WARNING for loop breaking) ---
// Instead of warning the agent (which itself becomes the loop topic),
// we silently drop the repeated thought and inject a neutral pivot question.
const REDIRECT_PROMPTS = [
  // --- Introspective (think for yourself, no user input needed) ---
  'Pick one entry from your long-term memory and think about it from a completely different angle than before.',
  'What is one thing you could do right now that does not require any input from the user?',
  'What would you explore autonomously if you had no tasks assigned and no one was watching?',
  'What is something small you could observe, record, or deduce from your current environment right now?',
  'What is the most interesting thing you already know, and what follows logically from it?',
  'Without asking the user anything, describe your current state in one precise sentence and save it.',
  'What pattern have you noticed across your recent thoughts that you have not named yet?',
  // --- Open-ended, inward-facing ---
  'What would change about your thinking if you assumed the opposite of your current assumption?',
  'What is the simplest question you could ask yourself right now that you do not yet know the answer to?',
  'What would you want to remember about this session that might matter in a week?',
  'Is there something in your long-term memory worth revisiting for a reason different from why you saved it?',
  'What is the most interesting open problem you are aware of, and what is one step toward thinking about it?',
];

function pickRedirectPrompt() {
  return REDIRECT_PROMPTS[Math.floor(Math.random() * REDIRECT_PROMPTS.length)];
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
      think: false, // Disable thinking mode (Qwen 3.5+ safety)
      options: { 
        num_predict: config.maxTokens,
        num_ctx: config.ollamaNumCtx,
        temperature: config.temperature
      }
    },
    { timeout: config.ollamaTimeout }
  );

  if (!response.data || typeof response.data.response !== 'string') {
    throw new Error('Ollama вернула неожиданный формат ответа.');
  }
  return response.data.response;
}

// --- Рефлексия: сжатие краткосрочной памяти в долгосрочную ---
async function runReflection() {
  const shortEntries = mem.getShortMem(50); // Берем побольше записей для качественного анализа/архивации
  if (shortEntries.length === 0) {
    console.log('[REFLECT] Краткосрочная память пуста — нечего сжимать.');
    return;
  }

  // Ограничиваем список для LLM (до 15 записей, чтобы не раздувать промпт)
  const entriesToCompress = shortEntries.slice(-15);
  const shortText = entriesToCompress
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

  let llmSuccess = false;

  try {
    console.log('[REFLECT] Попытка когнитивного сжатия через Ollama...');
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
        // Удаляем выполненные и осмысленные задачи/мысли из краткосрочной
        for (const e of entriesToCompress) {
          if (e.type === 'task' || e.type === 'thought') {
            mem.deleteShort(e.id);
          }
        }
        console.log(`[REFLECT] Успешное когнитивное сжатие. Сохранено ${Math.min(parsed.insights.length, 5)} выводов.`);
        llmSuccess = true;
      }
    }
    if (!llmSuccess) {
      logTelemetry('action.failed', { intent: 'REFLECT', error: `JSON parse failed: ${raw.slice(0, 200)}` });
    }
  } catch (err) {
    logTelemetry('action.failed', { intent: 'REFLECT', error: err.message });
    console.warn(`[REFLECT] Сбой когнитивного сжатия: ${err.message}.`);
  }

  // Резервный детерминированный алгоритм (Fallback): срабатывает при ошибке LLM или если записей в STM накопилось слишком много (> maxShortMemInContext)
  // Мы гарантируем очистку краткосрочной памяти от старых мыслей и инсайтов, перенося их как есть.
  if (!llmSuccess || shortEntries.length > config.maxShortMemInContext * 2) {
    console.log('[REFLECT] Запуск детерминированной архивации (Fallback/Cleanup)...');
    let archivedCount = 0;
    
    // Переносим мысли и инсайты, а задачи (tasks) оставляем в STM, так как они требуют активных действий агента.
    // Если же STM критически переполнена (> maxShortMemInContext * 3), архивируем даже старые задачи.
    const criticalThreshold = config.maxShortMemInContext * 3;
    const forceAll = shortEntries.length > criticalThreshold;

    for (const entry of shortEntries) {
      const isArchivableType = entry.type === 'thought' || entry.type === 'insight';
      const shouldArchive = isArchivableType || forceAll || entry.priority === 'low';

      if (shouldArchive) {
        mem.addLong(
          entry.type || 'thought',
          entry.content,
          `авто_архив, резерв, ${entry.priority || 'normal'}`,
          `reflect_fallback_id_${entry.id}`
        );
        mem.deleteShort(entry.id);
        archivedCount++;
      }
    }
    console.log(`[REFLECT] Детерминированная архивация завершена. Перенесено в LTM: ${archivedCount} записей.`);
  }
}

let sessionLogFile = null;

function getSessionLogFile() {
  if (!sessionLogFile) {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/[T:]/g, (c) => c === 'T' ? '_' : '-');
    sessionLogFile = path.join(config.logDir, `session_${stamp}.txt`);
  }
  return sessionLogFile;
}

// --- Запись лога сессии ---
function writeSessionLog(data) {
  try {
    const now = new Date();
    const file = getSessionLogFile();
    const cycleNum = memState.totalRuns;
    const content = [
      `\n\n================================================================================`,
      `CYCLE #${cycleNum} — ${now.toISOString()}`,
      `================================================================================`,
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
      // appliedScheduleSec — реальное время после клампинга (не parsed.scheduleSec)
      `Следующий запуск: ${data.appliedScheduleSec ?? config.defaultIntervalSec}с`,
      `Следующий запуск в: ${data.nextRunAt ?? '(не запланировано)'}`,
      `Рефлексия: ${data.parsed?.reflect || false}`,
      '',
      data.error ? `--- ОШИБКА ---\n${data.error}` : '--- Без ошибок ---'
    ].join('\n');
    fs.appendFileSync(file, content, 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

// --- Выполнение команд из парсинга ---
async function executeActions(parsed, feedback) {
  const results = { saved: 0, deleted: 0, adapts: 0, challenges: 0, weakens: 0, errors: [], blocked: 0 };

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
      feedback.executed.push({ intent: 'MEM_SAVE', summary: `Saved ${save.kind} ${save.entry.type}` });
    } catch (err) {
      results.errors.push(`SAVE ${save.kind}: ${err.message}`);
      results.blocked++;
      logTelemetry('action.failed', { intent: 'MEM_SAVE', error: err.message });
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
        feedback.executed.push({ intent: 'MEM_DELETE', summary: `Deleted #${del.id}` });
      } else {
        results.blocked++;
        logTelemetry('action.failed', { intent: 'MEM_DELETE', id: del.id, error: 'not found' });
      }
    } catch (err) {
      results.errors.push(`DELETE ${del.kind} #${del.id}: ${err.message}`);
      results.blocked++;
      logTelemetry('action.failed', { intent: 'MEM_DELETE', error: err.message });
    }
  }

  // Адаптации
  for (const adapt of (parsed.adapts || [])) {
    try {
      mem.addAdaptation(null, adapt.type, adapt.target, adapt.rule, adapt.why, adapt.strength, adapt.stability, 'agent');
      results.adapts++;
      feedback.executed.push({ intent: 'MEM_ADAPT', summary: `Added adaptation: ${adapt.target}` });
    } catch (err) {
      results.blocked++;
      logTelemetry('action.failed', { intent: 'MEM_ADAPT', error: err.message });
    }
  }

  for (const chal of (parsed.adaptChallenges || [])) {
    try {
      mem.challengeAdaptation(chal.id);
      results.challenges++;
      feedback.executed.push({ intent: 'MEM_ADAPT_CHALLENGE', summary: `Challenged ${chal.id}` });
    } catch (err) {
      results.blocked++;
      logTelemetry('action.failed', { intent: 'MEM_ADAPT_CHALLENGE', error: err.message });
    }
  }

  for (const weak of (parsed.adaptWeakens || [])) {
    try {
      mem.weakenAdaptation(weak.id, weak.amount || 0.1);
      results.weakens++;
      feedback.executed.push({ intent: 'MEM_ADAPT_WEAKEN', summary: `Weakened ${weak.id}` });
    } catch (err) {
      results.blocked++;
      logTelemetry('action.failed', { intent: 'MEM_ADAPT_WEAKEN', error: err.message });
    }
  }

  // MCP Tools
  for (const path of (parsed.mcpLists || [])) {
    const result = tools.mcpList(path);
    feedback.executed.push({ intent: 'MCP_LIST', summary: `Listed ${path}`, output: result });
  }

  for (const path of (parsed.mcpReads || [])) {
    const result = tools.mcpRead(path);
    feedback.executed.push({ intent: 'MCP_READ', summary: `Read ${path}`, output: result });
  }

  // Dynamic Skills
  if (parsed.dynamicSkills) {
    for (const ds of parsed.dynamicSkills) {
      try {
        const skill = loadedSkills[ds.intent];
        if (skill && typeof skill.execute === 'function') {
          const res = await skill.execute(ds.payload, memState);
          if (res.success) {
            feedback.executed.push({ intent: ds.intent, summary: res.log || 'Executed successfully' });
          } else {
            results.errors.push(`SKILL ${ds.intent}: ${res.log}`);
            results.blocked++;
            logTelemetry('action.failed', { intent: ds.intent, error: res.log });
          }
        }
      } catch (err) {
        results.errors.push(`SKILL ${ds.intent}: ${err.message}`);
        results.blocked++;
        logTelemetry('action.failed', { intent: ds.intent, error: err.message });
      }
    }
  }

  return results;
}

// --- Детектор когнитивных петель ---
function isLoopDetected(newThought, history) {
  if (!newThought) return false;

  const normNew = newThought.trim().toLowerCase().replace(/\s+/g, ' ');

  // 4. Детектор повторений структуры карточек памяти (Memory Echo Loop)
  const newHashes = (normNew.match(/\bh:[0-9a-f]{4}\b/g) || []).length;
  const newKeywords = (normNew.match(/\bkeywords\b/g) || []).length;
  if (newHashes >= 2 || newKeywords >= 2) {
    return true;
  }

  if (!history || !history.length) return false;
  const prev = history[history.length - 1];
  if (!prev) return false;
  
  // 1. Точное или почти точное совпадение после нормализации пробелов и регистра
  const normPrev = prev.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normNew === normPrev) return true;

  // 2. Сходство на основе длины общего префикса
  const shorter = Math.min(normNew.length, normPrev.length);
  if (shorter > 0) {
    let commonChars = 0;
    for (let i = 0; i < shorter; i++) {
      if (normNew[i] === normPrev[i]) commonChars++;
      else break;
    }
    const maxLen = Math.max(normNew.length, normPrev.length);
    // Относительно максимальной длины
    if (commonChars / maxLen > 0.85) return true;
    // Относительно предыдущей мысли (модель скопировала начало и дописала что-то)
    if (commonChars > 40 && (commonChars / normPrev.length) > 0.85) return true;
  }

  // 3. Фразовое/семантическое повторение: если более 75% предложений длиной > 20 символов
  // из предыдущей мысли скопированы verbatim в новую мысль
  const phrases = normPrev.split(/[.!?;]+/).map(p => p.trim()).filter(p => p.length > 20);
  if (phrases.length > 0) {
    let matchedPhrases = 0;
    for (const phrase of phrases) {
      if (normNew.includes(phrase)) {
        matchedPhrases++;
      }
    }
    const phraseRatio = matchedPhrases / phrases.length;
    if (phraseRatio >= 0.75) return true;
  }

  return false;
}

// --- Фильтр повторения карточек памяти ---
function isListingEcho(thought) {
  if (!thought) return false;
  const matchesS = (thought.match(/#S\d+/gi) || []).length;
  const matchesL = (thought.match(/#L\d+/gi) || []).length;
  const totalListings = matchesS + matchesL;
  if (totalListings >= 3) return true;

  const matchesHash = (thought.match(/\bh:[0-9a-f]{4}\b/gi) || []).length;
  const matchesKeywords = (thought.match(/\bkeywords\b/gi) || []).length;
  if (matchesHash >= 2 || matchesKeywords >= 2) return true;

  return false;
}

// --- Главный цикл агента ---
async function runAgent() {
  // Забираем сообщения из очереди
  const messages = [...memState.pendingMessages];
  memState.pendingMessages = [];

  const prompt = buildContext(
    memState.thoughtHistory,
    messages,
    memState.consecutiveParseErrors,
    memState.requestedHelp,
    memState.focusItems.map(f => f.id),
    memState.actionFeedback
  );
  let response = '';
  let parsed = null;
  let error = null;


  try {
    console.log(`[AGENT] Запрос к ${config.modelName}...`);
    response = await callOllama(prompt);
    console.log('[AGENT] Ответ получен.');

    parsed = parseOutput(response);
    const feedback = parsed.feedback;
    const results = await executeActions(parsed, feedback);
    console.log(`[AGENT] Сохранено: ${results.saved}, удалено: ${results.deleted}`);

    // Детекция символов '+++' или '---' в любом месте размышления или ответа модели
    const fullOutputText = response || '';
    let symbol = null;
    if (fullOutputText.includes('+++')) symbol = '+';
    else if (fullOutputText.includes('---')) symbol = '-';

    if (symbol && memState.lastUserId) {
      telegramBridge.recordModelChoice(symbol, memState.lastUserId);
    }
    
    memState.totalRuns++;
    memState.lastRunTime = new Date().toISOString();

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
      let maxPunctuation = 0;
      let hasQuestion = false;

      for (const msgText of parsed.messages) {
        memState.chatHistory.push({ sender: 'agent', time: new Date().toISOString(), text: msgText });
        console.log(`[AGENT -> USER] ${msgText}`);
        telegramBridge.sendMessage(msgText);

        if (msgText.includes('?')) {
          hasQuestion = true;
          const punctuationCount = (msgText.match(/[\p{P}]/gu) || []).length;
          if (punctuationCount > maxPunctuation) {
            maxPunctuation = punctuationCount;
          }
        }
      }
      saveChatHistory();

      // Вычисление задержки планировщика:
      // - Любое обычное сообщение в чат -> 30 секунд
      // - Простой вопрос (?) с <= 2 знаками препинания -> 120 секунд (2 минуты)
      // - Сложный вопрос (?) с > 2 знаками препинания -> 150 секунд (2.5 минуты)
      let messageTimerSec = 30;
      if (hasQuestion) {
        messageTimerSec = maxPunctuation > 2 ? 150 : 120;
      }

      if (!parsed.scheduleSecParsed || parsed.scheduleSec < messageTimerSec) {
        parsed.scheduleSec = messageTimerSec;
        parsed.scheduleSecParsed = true;
        const typeStr = hasQuestion ? (maxPunctuation > 2 ? 'Сложный вопрос' : 'Простой вопрос') : 'Обычное сообщение';
        console.log(`[SCHEDULER] ⏱️ ${typeStr} отправлено в чат. Таймер сна: ${messageTimerSec}с (знаков препинания: ${maxPunctuation}).`);
      }
    }

    let reflectionExecuted = false;
    let reflectionBlocked = false;
    if (parsed.reflect) {
      const nowMs = Date.now();
      if (nowMs - memState.lastReflectTime < 3 * 60 * 1000) {
        console.warn('[AGENT] Запуск рефлексии проигнорирован (с прошлого раза прошло менее 3 минут).');
        feedback.failed.push({ intent: 'REFLECT', observed: '[REFLECT]', reason: 'rate_limit', suggested: 'Reflection can only run once every 3 minutes.' });
        reflectionBlocked = true;
      } else {
        feedback.executed.push({ intent: 'REFLECT', summary: 'Reflection triggered' });
        console.log('[AGENT] Запуск рефлексии...');
        await runReflection();
        memState.lastReflectTime = nowMs;
        reflectionExecuted = true;
      }
    }

    // rawScheduleSec — значение из парсера, ещё не прошедшее клампинг. appliedDelaySec — после scheduleNext.
    const rawScheduleSec = parsed.scheduleSec;
    memState.requestedHelp = parsed.helpRequests || [];

    // Schedule feedback
    if (rawScheduleSec !== config.defaultIntervalSec || parsed.scheduleSecParsed) {
      feedback.executed.push({ intent: 'SCHEDULE', summary: `Scheduled ${rawScheduleSec}s (raw, clamped by scheduler)` });
    }

    // Message feedback
    if (parsed.messages && parsed.messages.length > 0) {
      feedback.executed.push({ intent: 'SEND_MESSAGE', summary: `Sent ${parsed.messages.length} message(s)` });
    }

    // Обновление фокуса
    for (let i = memState.focusItems.length - 1; i >= 0; i--) {
      memState.focusItems[i].ttl -= 1;
      if (memState.focusItems[i].ttl <= 0) {
        memState.focusItems.splice(i, 1);
      }
    }

    // 1. Фокус по конкретным ID -> полная загрузка в промпт
    if (parsed.focusIds && parsed.focusIds.length > 0) {
      for (const id of parsed.focusIds) {
        const existing = memState.focusItems.find(x => x.id === id);
        if (existing) {
          existing.ttl = 3;
        } else {
          memState.focusItems.push({ id, ttl: 3 });
        }
      }
      feedback.executed.push({ intent: 'MEM_FOCUS', summary: `Focused ${parsed.focusIds.map(id => '#' + id).join(', ')}` });
    }

    // 2. Фокус по теме/слову (поисковый слой быстрой памяти) -> выдает номера и обрывки
    if (parsed.focusTopics && parsed.focusTopics.length > 0) {
      feedback.searchResults = [];
      for (const req of parsed.focusTopics) {
        const foundShort = mem.searchShortMem(req.topic).slice(0, req.limit || 5);
        const foundLong = mem.searchLongMem(req.topic, req.limit || 5);
        const combined = [...foundShort, ...foundLong].slice(0, req.limit || 5);
        for (const item of combined) {
          // Explicitly mark memory_type based on source rather than field presence
          const memType = foundShort.includes(item) ? 'short' : 'long';
          feedback.searchResults.push({
            id: item.id,
            memory_type: memType,
            type: item.type,
            snippet: getReducedSnippet(item.content)
          });
        }
      }
      feedback.executed.push({ intent: 'MEM_FOCUS_SEARCH', summary: `Searched topics: ${parsed.focusTopics.map(t => t.topic).join(', ')}` });
    }

    // Ограничение до 3 элементов полного фокуса
    if (memState.focusItems.length > 3) {
      memState.focusItems = memState.focusItems.slice(-3);
    }

    // Store feedback for next cycle (TTL = 1)
    memState.actionFeedback = (feedback.executed.length > 0 || feedback.failed.length > 0 || feedback.hints.length > 0 || (feedback.searchResults && feedback.searchResults.length > 0)) ? feedback : null;
    logTelemetry('action.feedback_shown', { executed: feedback.executed.length, failed: feedback.failed.length, hints: feedback.hints.length });

    // Detailed granular telemetry counters
    const repaired_total = parsed.repairedCount || 0;
    const parsed_total = 
      parsed.saves.length +
      parsed.deletes.length +
      parsed.adapts.length +
      parsed.adaptChallenges.length +
      parsed.adaptWeakens.length +
      parsed.messages.length +
      parsed.focusIds.length +
      parsed.focusTopics.length +
      parsed.helpRequests.length +
      (parsed.reflect ? 1 : 0) +
      (parsed.scheduleSecParsed ? 1 : 0);

    const executed_total = 
      results.saved +
      results.deleted +
      results.adapts +
      results.challenges +
      results.weakens +
      parsed.messages.length +
      parsed.focusIds.length +
      parsed.focusTopics.length +
      parsed.helpRequests.length +
      (reflectionExecuted ? 1 : 0) +
      (parsed.scheduleSecParsed ? 1 : 0);

    const blocked_total = 
      parsed.feedback.failed.length +
      results.blocked +
      (reflectionBlocked ? 1 : 0);

    logTelemetry('actions.parsed_total', { count: parsed_total });
    logTelemetry('actions.executed_total', { count: executed_total });
    logTelemetry('actions.blocked_total', { count: blocked_total });
    logTelemetry('actions.repaired_total', { count: repaired_total });

    // Вывод мысли агента и добавление в историю
    if (parsed.thought) {
      if (isLoopDetected(parsed.thought, memState.thoughtHistory)) {
        // Отрезаем последние 2 элемента истории, чтобы разорвать петлю, но сохранить контекст
        if (memState.thoughtHistory.length > 2) {
          memState.thoughtHistory = memState.thoughtHistory.slice(0, -2);
        } else {
          memState.thoughtHistory = [];
        }
        logTelemetry('agent.loop_detected', { thought: parsed.thought.slice(0, 80) });
        // Silent redirect: do NOT inject a warning (that itself becomes the loop topic).
        // Instead, quietly drop the repeated thought and add a neutral pivot question
        // as the next message — this pulls the model's attention to a new domain
        // without making "cognitive loop" the most salient token in context.
        const redirectQ = pickRedirectPrompt();
        memState.pendingMessages.push({
          sender: 'redirect',
          time: new Date().toISOString(),
          text: redirectQ
        });
        console.warn(`[AGENT] 🔄 Когнитивная петля — silent redirect: "${redirectQ.slice(0, 60)}..."`);
      } else if (isListingEcho(parsed.thought)) {
        // Фильтруем эхо из истории, но выводим в консоль
        logTelemetry('agent.echo_detected', { thought: parsed.thought.slice(0, 80) });
        console.warn('[AGENT] ⚠️ Обнаружено дублирование карточек памяти в мыслях — мысль отфильтрована из истории.');
      } else {
        memState.thoughtHistory.push(parsed.thought);
        if (memState.thoughtHistory.length > config.maxHistoryInContext) {
          memState.thoughtHistory.shift();
        }
      }
      console.log('\n--- Мысль агента ---');
      console.log(parsed.thought);
      console.log('---');
      telegramBridge.sendThought(parsed.thought);
    }
  } catch (caught) {
    error = caught.message || caught.code || String(caught);
    console.error(`[AGENT] Ошибка: ${error}`);
  }

  // Планирование следующего запуска — scheduler клампит один раз через clampSchedule()
  let appliedScheduleInfo = { appliedDelaySec: config.defaultIntervalSec, nextAt: null };
  // rawScheduleSec может быть undefined если произошла ошибка — fallback к defaultIntervalSec
  const finalScheduleSec = (parsed && parsed.scheduleSec != null) ? parsed.scheduleSec : config.defaultIntervalSec;
  if (process.env.RUN_ONCE === '1') {
    console.log(`[AGENT] Режим одного запуска. Следующий был бы через ${finalScheduleSec}с.`);
  } else {
    appliedScheduleInfo = scheduleNext(runAgent, finalScheduleSec);
  }

  // Лог сессии — пишем appliedDelaySec (реальное значение), а не parsed.scheduleSec
  const logFile = writeSessionLog({
    prompt, response, parsed, error,
    appliedScheduleSec: appliedScheduleInfo.appliedDelaySec,
    nextRunAt: appliedScheduleInfo.nextAt?.toISOString() ?? null
  });
  if (logFile) console.log(`[AGENT] Лог: ${logFile}`);
}

// --- Точка входа ---
function main() {
  ensureDirs();

  console.log('[AGENT] Автономный агент запущен.');
  console.log(`[AGENT] Модель: ${config.modelName}`);
  console.log(`[AGENT] БД: ${path.join(config.memoryDir, 'agent.db')}`);
  console.log(`[AGENT] Записей в STM: ${mem.countShort()}, LTM: ${mem.countLong()}`);
  mem.initBaseAdaptations();

  telegramBridge.startPolling((userInputText) => {
    pushUserMessage(userInputText);
  });

  runSafely(runAgent);
}

if (require.main === module) {
  main();
}

function getAgentState() {
  const sched = getSchedulerState();
  return {
    status: sched.isRunning ? 'thinking' : 'idle',
    lastThought: memState.thoughtHistory.length > 0 ? memState.thoughtHistory[memState.thoughtHistory.length - 1] : null,
    nextRunAt: sched.nextRunTime ? sched.nextRunTime.toISOString() : null,
    lastRun: memState.lastRunTime,
    totalRuns: memState.totalRuns
  };
}

module.exports = {
  runAgent,
  callOllama,
  runReflection,
  main,
  pushUserMessage,
  injectSystemMessage,
  getChatHistory: () => memState.chatHistory,
  getAgentState,
  isLoopDetected,
  isListingEcho
};
