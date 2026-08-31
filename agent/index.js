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
const { evaluateOutboundSemanticDelta } = require('./fatigue_engine');

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
  lastRunTime: null,
  lastReplyLanguageMismatch: false, // true if last agent reply was wrong language vs last user msg
  lastShownLtmId: null, // anti-repetition for scent-of-memory
  curiosity: {
    activeTopic: null,
    topicScore: 5,
    lowScoreStreak: 0,
    questionHistory: []
  },
  // Tracks consecutive cycles with no meaningful action (saves/deletes/msgs/questions/reflects).
  // Used by the adaptive backoff scheduler: idle cycles exponentially increase sleep duration.
  idleStreak: 0,
  // Normalized texts of the last 50 agent messages sent to the user.
  // Used for silent deduplication without injecting toxic [MALFORMED_INTENT] into context.
  sentMessageHashes: [],
  // Dynamic Chain of Thought (Thinking Effort): light | medium | high
  currentThinkLevel: config.defaultThinkLevel || 'medium',
  nextScheduledThinkLevel: null
};

function pushUserMessage(text, userId = null, meta = {}) {
  if (userId) {
    memState.lastUserId = userId;
  }
  const usernameMatch = text.match(/^\[Telegram @([^\]:\s]+)\]/);
  const username = meta.username || (usernameMatch ? usernameMatch[1] : (userId ? `user_${userId}` : 'user'));
  const msg = {
    sender: 'user',
    time: new Date().toISOString(),
    text,
    userId,
    username,
    messageId: meta.messageId || null,
    replyToText: meta.replyToText || null,
    isReplyToBot: meta.isReplyToBot || false,
    answered: false
  };
  memState.pendingMessages.push(msg);
  memState.chatHistory.push(msg);
  saveChatHistory();
  mem.touchUserSeen(username, userId);
  console.log(`[USER] Новое сообщение от @${username}${meta.replyToText ? ' (в ответ на вопрос бота)' : ''}: ${text.length > 40 ? text.substring(0, 40) + '...' : text}`);

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

// --- Запрос к Ollama с динамическим бюджетом токенов (thinkLevel) ---
async function callOllama(prompt, thinkLevel = 'medium') {
  const url = `${config.ollamaHost.replace(/\/$/, '')}/api/generate`;
  
  // Динамический расчёт бюджета токенов на основе уровня рассуждения (Thinking Budget)
  const budgetMap = {
    light: config.thinkBudgetLight || 384,
    medium: config.thinkBudgetMedium || 1024,
    high: config.thinkBudgetHigh || 2048
  };
  const numPredict = budgetMap[thinkLevel] || config.maxTokens || 1024;

  const response = await axios.post(
    url,
    {
      model: config.modelName,
      prompt,
      stream: false,
      options: {
        num_predict: numPredict,
        num_ctx: config.ollamaNumCtx,
        temperature: config.temperature,
        // Repetition control: penalises token reuse in the last repeat_last_n tokens.
        // Complements the semantic loop detector which works at the sentence level.
        repeat_penalty: config.repeatPenalty,
        repeat_last_n: config.repeatLastN,
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

  // User Profiles (Mem0 Layer)
  for (const up of (parsed.userProfiles || [])) {
    try {
      mem.upsertUserProfile(up.username, up);
      results.userProfiles = (results.userProfiles || 0) + 1;
      feedback.executed.push({ intent: 'USER_PROFILE', summary: `Updated dossier for @${up.username}` });
    } catch (err) {
      results.blocked++;
      logTelemetry('action.failed', { intent: 'USER_PROFILE', error: err.message });
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

// --- Детектор когнитивных петель (мультипериодный кольцевой буфер) ---
//
// СОХРАНЕНО из исходной версии:
//   - Memory Echo Loop детектор (h:xxxx / keywords)
//   - Jaccard similarity (порог 0.75 → теперь задаётся через config.loopSimilarityThreshold)
//   - Prefix/suffix word match (порог 0.8)
//
// ДОБАВЛЕНО:
//   - normalizeForLoop(): нормализует типографские апострофы/кавычки → ASCII.
//     Это устраняет главный механизм осцилляции ±1 символ (умный апостроф ' vs ASCII ').
//   - Цикл по периодам p=1..4 вместо сравнения только с T-1.
//     Обнаруживает петли вида A→B→A (период 2) и A→B→C→A (период 3).

function normalizeForLoop(text) {
  if (!text) return '';
  return text
    // Типографские апострофы и одиночные кавычки → ASCII '
    .replace(/[\u2018\u2019\u201A\u201B\u0060]/g, "'")
    // Типографские двойные кавычки → ASCII "
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    // Нулевые пробелы и BOM
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function _jaccardSimilarity(norm1, norm2) {
  const getWords = (str) => new Set(str.split(/\s+/).filter(w => w.length > 2));
  const words1 = getWords(norm1);
  const words2 = getWords(norm2);
  let intersection = 0;
  for (const w of words1) { if (words2.has(w)) intersection++; }
  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function _prefixSuffixMatch(norm1, norm2, threshold = 0.8) {
  const a = norm1.split(/\s+/);
  const b = norm2.split(/\s+/);
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter <= 5) return false;

  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
  if (prefix / longer > threshold) return true;

  let suffix = 0;
  while (suffix < shorter && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return suffix / longer > threshold;
}

function isLoopDetected(newThought, history) {
  if (!newThought) return false;

  const normNew = normalizeForLoop(newThought);

  // [СОХРАНЕНО] Детектор повторений структуры карточек памяти (Memory Echo Loop)
  const newHashes = (normNew.match(/\bh:[0-9a-f]{4}\b/g) || []).length;
  const newKeywords = (normNew.match(/\bkeywords\b/g) || []).length;
  if (newHashes >= 2 || newKeywords >= 2) return true;

  if (!history || !history.length) return false;

  // [НОВОЕ] Мультипериодная проверка: период 1, 2, 3, 4
  // Позволяет обнаруживать A→B→A (период 2) и A→B→C→A (период 3),
  // которые исходный детектор пропускал (сравнивал только A с B, видел разницу).
  const maxPeriod = Math.min(config.loopRingBufferSize || 4, history.length);
  const threshold = config.loopSimilarityThreshold || 0.78;

  for (let period = 1; period <= maxPeriod; period++) {
    const pastIdx = history.length - period;
    const past = history[pastIdx];
    if (!past) continue;

    const normPast = normalizeForLoop(past);

    // Точное совпадение (после нормализации типографии и регистра)
    if (normNew === normPast) return true;

    // [СОХРАНЕНО] Jaccard similarity
    if (_jaccardSimilarity(normNew, normPast) > threshold) return true;

    // [СОХРАНЕНО] Общий префикс или суффикс по словам
    if (_prefixSuffixMatch(normNew, normPast)) return true;
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

  // Определение уровня рассуждений (Thinking Effort / Dynamic CoT) для текущего цикла
  let effectiveThinkLevel = 'medium';
  const hasDirectUserMessage = messages.some(m => m.sender === 'user');

  if (hasDirectUserMessage) {
    effectiveThinkLevel = 'high'; // Всегда глубокий анализ при новом сообщении от пользователя
  } else if (memState.nextScheduledThinkLevel) {
    effectiveThinkLevel = memState.nextScheduledThinkLevel;
    memState.nextScheduledThinkLevel = null; // Сбрасываем после применения
  } else if (memState.idleStreak >= 2) {
    effectiveThinkLevel = 'light'; // Экономия токенов при холостом ходе
  } else {
    effectiveThinkLevel = config.defaultThinkLevel || 'medium';
  }
  memState.currentThinkLevel = effectiveThinkLevel;

  const { prompt, lastShownLtmId: newLastShownLtmId, triageInfo, fatigueState } = buildContext(
    memState.thoughtHistory,
    messages,
    memState.consecutiveParseErrors,
    memState.requestedHelp,
    memState.focusItems.map(f => f.id),
    memState.actionFeedback,
    memState.curiosity,
    memState.chatHistory,
    memState.lastShownLtmId,
    effectiveThinkLevel
  );
  if (newLastShownLtmId !== null) memState.lastShownLtmId = newLastShownLtmId;

  if (fatigueState && fatigueState.state === 'EXHAUSTED') {
    if (memState.curiosity && memState.curiosity.activeTopic) {
      console.log(`[FATIGUE] 🥱 Семантическое насыщение (Fatigue: ${Math.round(fatigueState.fatigue * 100)}%). Сброс застрявшей темы: "${memState.curiosity.activeTopic.slice(0, 50)}..."`);
      memState.curiosity.activeTopic = null;
      memState.curiosity.topicScore = 0;
    }
  }

  let response = '';
  let parsed = null;
  let error = null;
  let results = null;
  let feedback = { executed: [], failed: [], blocked: [], hints: [] };
  let actualSentCount = 0;
  let blockedReasons = [];
  let reflectionExecuted = false;

  try {
    console.log(`[AGENT] Запрос к ${config.modelName} (Think Level: ${effectiveThinkLevel.toUpperCase()})...`);
    response = await callOllama(prompt, effectiveThinkLevel);
    console.log('[AGENT] Ответ получен.');


    parsed = parseOutput(response);
    feedback = parsed.feedback;
    results = await executeActions(parsed, feedback);
    console.log(`[AGENT] Сохранено: ${results.saved}, удалено: ${results.deleted}`);


    // Учёт запланированного агентом уровня мышления на следующий цикл
    if (parsed.thinkLevel) {
      memState.nextScheduledThinkLevel = parsed.thinkLevel;
      console.log(`[AGENT] 🧠 Запланирован уровень рассуждения на следующий цикл: ${parsed.thinkLevel.toUpperCase()}`);
    }

    // Детекция символов '+++' или '---' в любом месте размышления или ответа модели
    const fullOutputText = response || '';
    let symbol = null;
    if (fullOutputText.includes('+++')) symbol = '+';
    else if (fullOutputText.includes('---')) symbol = '-';


    if (symbol && memState.lastUserId) {
      telegramBridge.recordModelChoice(symbol, memState.lastUserId);
    }

    // Обработка разрешения и закрытия исследовательской темы
    if (parsed.resolveTopic) {
      console.log(`[CURIOSITY] 🏁 Тема завершена: "${parsed.resolveTopic}"`);
      if (!feedback.executed) feedback.executed = [];
      feedback.executed.push({ intent: 'RESOLVE_TOPIC', summary: `Resolved: ${parsed.resolveTopic.slice(0, 60)}` });
      
      if (memState.curiosity.activeTopic) {
        mem.addLong(
          'fact',
          `[Research Conclusion]: "${memState.curiosity.activeTopic}" -> ${parsed.resolveTopic}`,
          '#research,#conclusion,#synthesis',
          'cognitive_resolution'
        );
      }

      memState.curiosity.activeTopic = null;
      memState.curiosity.topicScore = 0;
      memState.curiosity.inquiryStep = 1;
    }

    // Обработка автономного самовопроса и оценки темы
    if (parsed.selfQuestion) {
      if (isLoopDetected(parsed.selfQuestion, memState.curiosity.questionHistory)) {
        console.warn(`[CURIOSITY] 🔄 Дубликат самовопроса отклонен: "${parsed.selfQuestion.slice(0, 50)}..."`);
        parsed.topicScore = null; // Prevent score update on duplicate
        injectSystemMessage(`[MALFORMED_INTENT "duplicate_self_question"] You repeated the exact same question. Advance to the next phase of your research or choose a fresh topic.`);
      } else {
        memState.curiosity.activeTopic = parsed.selfQuestion;
        memState.curiosity.inquiryStep = 1;
        memState.curiosity.maxInquirySteps = 4;
        memState.curiosity.lowScoreStreak = 0;
        memState.curiosity.questionHistory.push(parsed.selfQuestion);
        if (memState.curiosity.questionHistory.length > 5) {
          memState.curiosity.questionHistory.shift();
        }
        console.log(`[CURIOSITY] 💡 Новая исследовательская тема (Шаг 1/4): "${parsed.selfQuestion}"`);
      }
    } else if (memState.curiosity.activeTopic && !parsed.resolveTopic) {
      // Продвижение по шагам исследования (1 -> 2 -> 3 -> 4)
      memState.curiosity.inquiryStep = (memState.curiosity.inquiryStep || 1) + 1;
      console.log(`[CURIOSITY] 🔬 Продвижение исследования "${memState.curiosity.activeTopic.slice(0, 35)}..." (Шаг ${memState.curiosity.inquiryStep}/4)`);
      if (memState.curiosity.inquiryStep > 4) {
        console.log(`[CURIOSITY] 🏁 Тема исследована в течение 4 шагов. Авто-завершение и освобождение фокуса.`);
        memState.curiosity.activeTopic = null;
        memState.curiosity.inquiryStep = 1;
      }
    }

    if (parsed.topicScore !== null) {
      memState.curiosity.topicScore = parsed.topicScore;
      console.log(`[CURIOSITY] 📊 Оценка интереса к теме: ${parsed.topicScore}/10`);
      
      if (parsed.topicScore <= 3) {
        memState.curiosity.lowScoreStreak += 1;
        console.log(`[CURIOSITY] 📉 Низкий интерес (${parsed.topicScore}/10). Серия низкого интереса: ${memState.curiosity.lowScoreStreak}/5`);
        if (memState.curiosity.lowScoreStreak >= 5) {
          console.log(`[CURIOSITY] 🔄 Интерес угас 5 циклов подряд (<=3/10). Сброс текущей темы для генерации новой!`);
          memState.curiosity.activeTopic = null;
          memState.curiosity.lowScoreStreak = 0;
          memState.curiosity.inquiryStep = 1;
        }
      } else {
        memState.curiosity.lowScoreStreak = 0;
      }
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

      const recentAgentMsgs = memState.chatHistory
        .filter(m => m.sender === 'agent')
        .slice(-3)
        .map(m => m.text);

      // For duplicate detection we also use the persistent cross-cycle buffer (sentMessageHashes).
      // This catches duplicates that slip through if the chat history window is short.
      const dedupHistory = [
        ...recentAgentMsgs,
        ...memState.sentMessageHashes.slice(-20)
      ];

      let hasUnansweredUser = false;
      let lastUserIdx = -1;
      let lastAgentIdx = -1;
      let lastUserMsgText = '';
      for (let i = memState.chatHistory.length - 1; i >= 0; i--) {
        if (lastUserIdx === -1 && memState.chatHistory[i].sender === 'user') {
          lastUserIdx = i;
          lastUserMsgText = memState.chatHistory[i].text;
        }
        if (lastAgentIdx === -1 && memState.chatHistory[i].sender === 'agent') lastAgentIdx = i;
      }
      if (lastUserIdx > lastAgentIdx) {
        hasUnansweredUser = true;
      }

      const TAG_LEAK_PATTERN = /\[(SELF_QUESTION|SEND_MESSAGE|MEM_SAVE|MEM_FOCUS|TOPIC_SCORE|REFLECT|SCHEDULE)\b/i;

      for (const msgText of parsed.messages) {
        // Guard 0: tag leaked into message text
        if (TAG_LEAK_PATTERN.test(msgText)) {
          console.warn(`[AGENT] ⛔ Тег в сообщении заблокирован: tag_leaked_into_message`);
          injectSystemMessage(`[MALFORMED_INTENT "tag_leaked_into_message"] Your SEND_MESSAGE argument contains a raw tool tag (e.g. [SELF_QUESTION ...]). Send plain text only — no brackets, no tags.`);
          blockedReasons.push('tag_leaked_into_message');
          continue;
        }

        // Guard 1: duplicate send — SILENT suppression (no MALFORMED_INTENT injected).
        // Rationale: injecting "[MALFORMED_INTENT duplicate_send_message] You are repeating..."
        // puts the words "repeating", "same", "message" at high salience in context — exactly
        // the tokens that prime the next generation toward... the same message.
        // Instead we silently drop it and record a blocked entry in actionFeedback so the
        // agent sees "blocked: duplicate_send_message" in the next [ACTION FEEDBACK] block,
        // which is neutral and informative without polluting the attention window.
        if (isLoopDetected(msgText, dedupHistory)) {
          console.warn(`[AGENT] 🔇 Дубликат сообщения тихо подавлен: "${msgText.slice(0, 60)}..."`);
          blockedReasons.push('duplicate_send_message');
          // Записать в feedback следующего цикла нейтрально (агент увидит в [ACTION FEEDBACK])
          if (results) {
            if (!results.blockedSends) results.blockedSends = [];
            results.blockedSends.push({ reason: 'duplicate_send_message', preview: msgText.slice(0, 60) });
          }
          continue;
        }

        // Guard 1.5: Outbound Semantic Delta & Intent Diversity Guard
        // Если в этом цикле не поступило нового сообщения от пользователя, проверяем смысловую новизну:
        // Агент может свободно отправлять сообщения, если они несут РАЗНУЮ смысловую нагрузку (новые вопросы, факты, темы),
        // но перефразирование одного и того же совета (семантическое эхо) тихо подавляется.
        if (messages.length === 0) {
          const recentAgentMsgs = memState.chatHistory
            .filter(m => m.sender === 'agent')
            .slice(-4)
            .map(m => m.text);

          const delta = evaluateOutboundSemanticDelta(msgText, recentAgentMsgs);
          if (!delta.isNovel) {
            console.warn(`[AGENT] 🔇 Семантическое эхо предотвращено (${Math.round(delta.overlap * 100)}% совпадения): "${msgText.slice(0, 60)}..."`);
            blockedReasons.push('semantic_echo');
            if (results) {
              if (!results.blockedSends) results.blockedSends = [];
              results.blockedSends.push({ reason: 'semantic_echo', preview: msgText.slice(0, 60), overlap: delta.overlap });
            }
            continue;
          }
        }

        // Guard 2: language mismatch

        if (hasUnansweredUser) {
          const cyrillicMatchUser = lastUserMsgText.match(/[\u0400-\u04FF]/g);
          const cyrillicRatioUser = cyrillicMatchUser ? cyrillicMatchUser.length / lastUserMsgText.length : 0;
          const cyrillicMatchAgent = msgText.match(/[\u0400-\u04FF]/g);
          const cyrillicRatioAgent = cyrillicMatchAgent ? cyrillicMatchAgent.length / msgText.length : 0;

          if (cyrillicRatioUser > 0.35 && cyrillicRatioAgent < 0.05) {
            console.warn(`[AGENT] ⛔ Языковой барьер: ответ заблокирован (ожидалась кириллица).`);
            injectSystemMessage(`[MALFORMED_INTENT "irrelevant_language"] The user spoke in Russian (Cyrillic). You MUST reply in Russian. Do NOT use English for [SEND_MESSAGE].`);
            blockedReasons.push('irrelevant_language');
            memState.lastReplyLanguageMismatch = true;
            continue;
          } else if (cyrillicRatioUser < 0.05 && cyrillicRatioAgent > 0.25) {
            console.warn(`[AGENT] ⛔ Языковой барьер: ответ заблокирован (ожидался английский).`);
            injectSystemMessage(`[MALFORMED_INTENT "irrelevant_language"] The user spoke in English. You MUST reply in English. Do NOT use Russian for [SEND_MESSAGE].`);
            blockedReasons.push('irrelevant_language');
            memState.lastReplyLanguageMismatch = true;
            continue;
          } else {
            memState.lastReplyLanguageMismatch = false;
          }
        }

        // All guards passed — actually send
        memState.chatHistory.push({ sender: 'agent', time: new Date().toISOString(), text: msgText });
        console.log(`[AGENT -> USER] ${msgText}`);
        telegramBridge.sendMessage(msgText);
        actualSentCount++;
        memState.lastReplyLanguageMismatch = false; // successful send clears mismatch flag

        // Target user resolution: check if reply mentions @username or reply addresses pending inquiry
        const targetUserMatch = msgText.match(/@([a-zA-Z0-9_]{3,})/);
        if (targetUserMatch) {
          const targetUsername = targetUserMatch[1].toLowerCase();
          for (let i = memState.chatHistory.length - 1; i >= 0; i--) {
            const m = memState.chatHistory[i];
            if (m.sender === 'user' && !m.answered && (m.username?.toLowerCase() === targetUsername || m.text?.toLowerCase().includes(`@${targetUsername}`))) {
              m.answered = true;
              if (m.userId) memState.lastUserId = m.userId;
              break;
            }
          }
        } else {
          // Mark latest unanswered user message as answered
          for (let i = memState.chatHistory.length - 1; i >= 0; i--) {
            const m = memState.chatHistory[i];
            if (m.sender === 'user' && !m.answered) {
              m.answered = true;
              if (m.userId) memState.lastUserId = m.userId;
              break;
            }
          }
        }

        // Register in persistent dedup buffer (keep last 50 messages)
        memState.sentMessageHashes.push(normalizeForLoop(msgText));
        if (memState.sentMessageHashes.length > 50) memState.sentMessageHashes.shift();

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
    } else {
      // ПРОВЕРКА НА ИГНОРИРОВАНИЕ ПОЛЬЗОВАТЕЛЯ
      let hasUnansweredUser = false;
      let lastUserIdx = -1;
      let lastAgentIdx = -1;
      for (let i = memState.chatHistory.length - 1; i >= 0; i--) {
        if (lastUserIdx === -1 && memState.chatHistory[i].sender === 'user') lastUserIdx = i;
        if (lastAgentIdx === -1 && memState.chatHistory[i].sender === 'agent') lastAgentIdx = i;
      }
      if (lastUserIdx > lastAgentIdx) {
        hasUnansweredUser = true;
      }

      // Persistent language mismatch: also force reply if last reply was wrong language
      const needsCorrectReply = hasUnansweredUser || memState.lastReplyLanguageMismatch;

      if (needsCorrectReply) {
        // Exception: do not force reply for very short acknowledgements ("ок", "👍", etc.)
        const lastUserMsg = memState.chatHistory.slice().reverse().find(m => m.sender === 'user');
        const isShortAck = lastUserMsg && lastUserMsg.text.trim().split(/\s+/).length < 5 && !lastUserMsg.text.includes('?');

        if (!isShortAck) {
          injectSystemMessage(`[MALFORMED_INTENT "missing_reply"] You must reply to the user using [SEND_MESSAGE]. Do not ignore the user.`);
          results.errors.push('Ignored user message');
        }
      }
    }

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

    // Message feedback — report actual sent vs intended
    if (parsed.messages && parsed.messages.length > 0) {
      if (actualSentCount > 0) {
        if (!feedback.executed) feedback.executed = [];
        feedback.executed.push({ intent: 'SEND_MESSAGE', summary: `Sent ${actualSentCount} of ${parsed.messages.length} message(s)` });
      } else {
        const reasons = blockedReasons.length > 0 ? blockedReasons.join(', ') : 'unknown guard';
        if (!feedback.blocked) feedback.blocked = [];
        feedback.blocked.push({ intent: 'SEND_MESSAGE', summary: `Blocked ${parsed.messages.length} message(s): ${reasons}` });
      }
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

  // ── Адаптивный backoff при холостом ходе ──────────────────────────────────────
  // Холостой цикл = цикл без сохранений/удалений памяти, без отправки сообщений,
  // без рефлексий, без своих вопросов. Каждый такой цикл удваивает паузу до maxSleep.
  // Устраняет паттерн «10 секунд бесконечно» (35 серий, до 18 подряд — из аудита).
  const hadAction = Boolean(
    (results && results.saved > 0) ||
    (results && results.deleted > 0) ||
    (results && results.adapts > 0) ||
    actualSentCount > 0 ||
    (parsed && parsed.selfQuestion) ||
    reflectionExecuted
  );

  if (hadAction) {
    if (memState.idleStreak > 0) {
      console.log(`[SCHEDULER] ✅ Действие выполнено. Сброс idle streak (было ${memState.idleStreak}).`);
    }
    memState.idleStreak = 0;
  } else {
    memState.idleStreak++;
  }

  // Планирование следующего запуска — scheduler клампит один раз через clampSchedule()
  let appliedScheduleInfo = { appliedDelaySec: config.defaultIntervalSec, nextAt: null };

  // Приоритет 1: агент явно поставил [SCHEDULE N]
  let finalScheduleSec = (parsed && parsed.scheduleSecParsed && parsed.scheduleSec != null)
    ? parsed.scheduleSec
    : null;

  // Приоритет 2: адаптивный backoff при холостом ходе (агент не ставил SCHEDULE)
  if (finalScheduleSec == null && memState.idleStreak > 0) {
    const base = config.idleBackoffBaseSec || 15;
    const cap  = config.idleBackoffMaxSec  || 600;
    finalScheduleSec = Math.min(cap, base * Math.pow(2, memState.idleStreak - 1));
    console.log(`[SCHEDULER] 💤 Холостой цикл #${memState.idleStreak}. Адаптивный сон: ${finalScheduleSec}с`);
    logTelemetry('agent.idle_backoff', { streak: memState.idleStreak, sleep: finalScheduleSec });
  }

  // Приоритет 3: дефолтный интервал
  if (finalScheduleSec == null) {
    finalScheduleSec = config.defaultIntervalSec;
  }

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

  telegramBridge.startPolling((userInputText, userId) => {
    pushUserMessage(userInputText, userId);
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
