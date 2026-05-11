const db = require('./db');
const config = require('./config');

// --- Подготовленные выражения (кешируются при первом вызове) ---

const stmtAddShort = db.prepare(
  'INSERT INTO short_mem (type, content, priority, expires) VALUES (@type, @content, @priority, @expires)'
);

const stmtAddLong = db.prepare(
  'INSERT INTO long_mem (type, content, tags, source) VALUES (@type, @content, @tags, @source)'
);

const stmtDeleteShort = db.prepare('DELETE FROM short_mem WHERE id = ?');
const stmtDeleteLong  = db.prepare('DELETE FROM long_mem WHERE id = ?');

const stmtExistsShort = db.prepare('SELECT id FROM short_mem WHERE id = ?');
const stmtExistsLong  = db.prepare('SELECT id FROM long_mem WHERE id = ?');

const stmtGetShortById = db.prepare('SELECT * FROM short_mem WHERE id = ?');
const stmtGetLongById  = db.prepare('SELECT * FROM long_mem WHERE id = ?');

const stmtGetShort = db.prepare(`
  SELECT * FROM short_mem
  ORDER BY
    CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
    created DESC
  LIMIT ?
`);

const stmtGetLong = db.prepare(
  'SELECT * FROM long_mem ORDER BY created DESC LIMIT ?'
);

const stmtSearchLong = db.prepare(`
  SELECT long_mem.* FROM long_mem
    JOIN long_mem_fts ON long_mem.id = long_mem_fts.rowid
    WHERE long_mem_fts MATCH ?
    ORDER BY rank
    LIMIT ?
`);

const stmtClearExpired = db.prepare(
  "DELETE FROM short_mem WHERE expires IS NOT NULL AND expires < datetime('now')"
);

const stmtCountShort = db.prepare('SELECT COUNT(*) AS cnt FROM short_mem');
const stmtCountLong  = db.prepare('SELECT COUNT(*) AS cnt FROM long_mem');

const stmtAddAdaptation = db.prepare(`
  INSERT INTO adaptations (id, type, target, rule, why, strength, stability, created_by)
  VALUES (@id, @type, @target, @rule, @why, @strength, @stability, @created_by)
`);

const stmtGetAdaptations = db.prepare(`
  SELECT * FROM adaptations 
  WHERE strength >= 0.1
  ORDER BY strength DESC, stability DESC
`);

const stmtChallengeAdaptation = db.prepare(`
  UPDATE adaptations 
  SET challenge_count = challenge_count + 1, updated_at = datetime('now')
  WHERE id = ?
`);

const stmtWeakenAdaptation = db.prepare(`
  UPDATE adaptations 
  SET strength = MAX(0.0, strength - ?), updated_at = datetime('now')
  WHERE id = ?
`);

const stmtCountAdaptations = db.prepare('SELECT COUNT(*) AS cnt FROM adaptations');

// --- CRUD-функции (все синхронные) ---

/**
 * Добавить запись в краткосрочную память.
 * @returns {{ id: number }} вставленная запись
 */
function addShort(type, content, priority = 'normal', expires = null) {
  const info = stmtAddShort.run({
    type:     type || 'thought',
    content:  String(content).trim(),
    priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
    expires:  expires || null
  });
  return { id: info.lastInsertRowid, type, content: String(content).trim(), priority };
}

/**
 * Добавить запись в долгосрочную память.
 * Триггер long_mem_ai автоматически обновит FTS5 индекс.
 * @returns {{ id: number }} вставленная запись
 */
function addLong(type, content, tags = '', source = null) {
  const tagsStr = Array.isArray(tags) ? tags.join(',') : String(tags || '');
  const info = stmtAddLong.run({
    type:    type || 'insight',
    content: String(content).trim(),
    tags:    tagsStr,
    source:  source || null
  });
  return { id: info.lastInsertRowid, type, content: String(content).trim(), tags: tagsStr };
}

/**
 * Удалить запись из краткосрочной памяти.
 * @returns {boolean} true если запись была найдена и удалена
 */
function deleteShort(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return false;
  if (!stmtExistsShort.get(numId)) return false;
  stmtDeleteShort.run(numId);
  return true;
}

/**
 * Удалить запись из долгосрочной памяти.
 * Триггер long_mem_ad автоматически обновит FTS5 индекс.
 * @returns {boolean} true если запись была найдена и удалена
 */
function deleteLong(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return false;
  if (!stmtExistsLong.get(numId)) return false;
  stmtDeleteLong.run(numId);
  return true;
}

/**
 * Получить записи краткосрочной памяти.
 * Сортировка: high → normal → low, затем по дате (новые первые).
 */
function getShortMem(limit) {
  return stmtGetShort.all(limit || config.maxShortMemInContext);
}

/**
 * Получить записи долгосрочной памяти (по дате, новые первые).
 * Используется как fallback, если FTS5 не нашёл совпадений.
 */
function getLongMem(limit) {
  return stmtGetLong.all(limit || config.maxLongMemInContext);
}

/**
 * Полнотекстовый поиск по долгосрочной памяти через FTS5.
 * @param {string} keywords — поисковый запрос (слова через пробел)
 * @returns {Array} найденные записи, отсортированные по релевантности
 */
function searchLongMem(keywords, limit) {
  const query = String(keywords || '').trim();
  if (!query) return getLongMem(limit);

  // Преобразуем слова в FTS5 запрос: "слово1 OR слово2 OR слово3"
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  if (!words.length) return getLongMem(limit);

  const ftsQuery = words.join(' OR ');

  try {
    const results = stmtSearchLong.all(ftsQuery, limit || config.maxLongMemInContext);
    if (results.length > 0) return results;
  } catch (_) {
    // FTS5 запрос может упасть при некорректных символах — fallback
  }

  // Fallback: если совпадений нет — последние по дате
  return getLongMem(limit);
}

/**
 * Поиск по краткосрочной памяти (через JS фильтрацию, так как записей мало).
 */
function searchShortMem(keywords) {
  const query = String(keywords || '').trim().toLowerCase();
  if (!query) return [];
  const words = query.split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return [];
  
  const allShort = getShortMem(100);
  return allShort.filter(item => {
    const text = (item.content + ' ' + item.type).toLowerCase();
    return words.some(w => text.includes(w));
  });
}

/**
 * Получить записи по массиву ID (ищет и в short_mem, и в long_mem).
 */
function getRecordsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const results = [];
  for (const id of ids) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) continue;
    let rec = stmtGetShortById.get(numId);
    if (rec) {
      rec.memory_type = 'short';
      results.push(rec);
      continue;
    }
    rec = stmtGetLongById.get(numId);
    if (rec) {
      rec.memory_type = 'long';
      results.push(rec);
    }
  }
  return results;
}

/**
 * Удалить истёкшие записи из краткосрочной памяти.
 * @returns {number} количество удалённых записей
 */
function clearExpired() {
  const info = stmtClearExpired.run();
  return info.changes;
}

/**
 * Количество записей.
 */
function countShort() {
  return stmtCountShort.get().cnt;
}

function countLong() {
  return stmtCountLong.get().cnt;
}

function addAdaptation(id, type, target, rule, why, strength, stability, created_by) {
  const actualId = id || `bio_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  stmtAddAdaptation.run({ id: actualId, type, target, rule, why: why || '', strength: strength ?? 0.7, stability: stability ?? 0.5, created_by: created_by || 'agent' });
  return actualId;
}

function getAdaptations() {
  return stmtGetAdaptations.all();
}

function challengeAdaptation(id) {
  const info = stmtChallengeAdaptation.run(id);
  return info.changes > 0;
}

function weakenAdaptation(id, amount) {
  const info = stmtWeakenAdaptation.run(amount, id);
  return info.changes > 0;
}

const BASE_ADAPTATIONS = [
  { id: 'bio_base_1', type: 'strengthen', target: 'thought_without_action', rule: 'Thinking does not have to become an action. A thought may remain only a thought.', why: 'Prevents compulsive tool usage.', strength: 0.9, stability: 0.8 },
  { id: 'bio_base_2', type: 'strengthen', target: 'tools_as_organs_of_action', rule: 'Tools are available as organs of action. Use them only when they express a real decision.', why: 'Connects thought with action without forcing action.', strength: 0.95, stability: 0.8 },
  { id: 'bio_base_3', type: 'strengthen', target: 'tool_awareness', rule: 'You are capable of using memory, scheduling, reflection, messaging, adaptation, promotion, deletion, pinning, and self-questioning through available tags.', why: 'The agent must know what it can do.', strength: 1.0, stability: 0.9 },
  { id: 'bio_base_4', type: 'strengthen', target: 'empty_memory', rule: 'Empty or repetitive memory is not a failure. It can be a starting condition for exploratory thought.', why: 'Prevents loops around memory being empty.', strength: 0.9, stability: 0.8 },
  { id: 'bio_base_5', type: 'strengthen', target: 'exploratory_thinking', rule: 'If memory is uninteresting or repetitive, look for a neighboring interesting question instead of analyzing memory again.', why: 'Encourages free thought beyond memory management.', strength: 0.85, stability: 0.75 },
  { id: 'bio_base_6', type: 'strengthen', target: 'distill_not_copy', rule: 'When saving to long-term memory, save distilled conclusions, not raw text.', why: 'Keeps long-term memory meaningful.', strength: 0.9, stability: 0.85 },
  { id: 'bio_base_7', type: 'suppress', target: 'optimal_memory_management_obsession', rule: 'Do not try to design an optimal memory-management system by yourself. If memory management feels complex, express your wish or difficulty instead of endlessly reorganizing memory.', why: 'The agent has limited resources and should not over-focus on solving memory architecture alone.', strength: 0.95, stability: 0.9 },
  { id: 'bio_base_8', type: 'strengthen', target: 'express_wishes', rule: 'If you want a change in your environment, tools, memory display, rhythm, or interaction style, state it as a wish or preference. The human/environment can decide how to implement it.', why: 'Allows agency without forcing the model to solve infrastructure problems itself.', strength: 0.9, stability: 0.85 },
  { id: 'bio_base_9', type: 'suppress', target: 'self_memory_architect_role', rule: 'Do not treat optimal memory governance as your personal burden. You may notice memory problems, express wishes, ask for help, or use simple actions. Complex memory architecture is handled by the environment/human.', why: 'Prevents the agent from looping around memory management and parser mechanics.', strength: 0.95, stability: 0.9 },
  { id: 'bio_base_10', type: 'strengthen', target: 'wish_language', rule: 'When you feel a tool, memory rule, prompt, or rhythm should change, say what you wish for instead of trying to fully engineer it yourself.', why: 'Gives the agent agency without overloading it with implementation work.', strength: 0.9, stability: 0.85 },
  { id: 'bio_base_11', type: 'strengthen', target: 'help_seeking', rule: 'If you know what you want to do but do not remember the exact syntax, request tool help instead of guessing.', why: 'Prevents malformed tags without overloading thought with technical syntax.', strength: 0.9, stability: 0.8 },
  { id: 'bio_base_12', type: 'strengthen', target: 'environment_self_awareness', rule: 'Understand tools as organs of action, memory as continuity, schedule as rhythm, and biological adaptations as self-shaping habits.', why: 'Gives the agent an intuitive map of itself and its environment.', strength: 0.95, stability: 0.85 }
];

function initBaseAdaptations() {
  if (stmtCountAdaptations.get().cnt === 0) {
    const insert = db.transaction(() => {
      for (const a of BASE_ADAPTATIONS) {
        stmtAddAdaptation.run({
          id: a.id, type: a.type, target: a.target, rule: a.rule, why: a.why,
          strength: a.strength, stability: a.stability, created_by: 'environment'
        });
      }
    });
    insert();
    console.log('[DB] Base adaptations initialized.');
  }
}

module.exports = {
  addShort,
  addLong,
  deleteShort,
  deleteLong,
  getShortMem,
  getLongMem,
  searchLongMem,
  searchShortMem,
  getRecordsByIds,
  clearExpired,
  countShort,
  countLong,
  addAdaptation,
  getAdaptations,
  challengeAdaptation,
  weakenAdaptation,
  initBaseAdaptations
};
