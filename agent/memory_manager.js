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

module.exports = {
  addShort,
  addLong,
  deleteShort,
  deleteLong,
  getShortMem,
  getLongMem,
  searchLongMem,
  clearExpired,
  countShort,
  countLong
};
