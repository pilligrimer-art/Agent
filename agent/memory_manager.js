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
  WHERE type != 'error'
  ORDER BY
    CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
    created DESC
  LIMIT ?
`);

const stmtGetGoals = db.prepare(`
  SELECT * FROM short_mem
  WHERE type = 'plan'
  ORDER BY
    CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
    created DESC
  LIMIT ?
`);

const stmtGetLong = db.prepare(
  'SELECT * FROM long_mem ORDER BY created DESC LIMIT ?'
);

const decayLambda = (config.decayHalfLifeDays > 0) ? (0.69314718056 / config.decayHalfLifeDays) : 0;

const stmtSearchLong = db.prepare(`
  SELECT long_mem.* FROM long_mem
    JOIN long_mem_fts ON long_mem.id = long_mem_fts.rowid
    WHERE long_mem_fts MATCH ?
    ORDER BY rank + (
      COALESCE(long_mem.access_count, 0) 
      * ${config.decayPenaltyWeight} 
      * EXP(-${decayLambda} * (julianday('now') - julianday(COALESCE(long_mem.last_accessed, datetime('now')))))
      * (1 - COALESCE(long_mem.is_core, 0))
    ) ASC
    LIMIT ?
`);

const stmtUpdateAccess = db.prepare(`
  UPDATE long_mem 
  SET access_count = COALESCE(access_count, 0) 
      * EXP(-${decayLambda} * (julianday('now') - julianday(COALESCE(last_accessed, datetime('now'))))) 
      + 1, 
      last_accessed = datetime('now')
  WHERE id = ?
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

// --- User Profiles (Mem0 Layer) Prepared Statements ---
const stmtGetUserProfile = db.prepare('SELECT * FROM user_profiles WHERE username = ? COLLATE NOCASE');

const stmtUpsertUserProfile = db.prepare(`
  INSERT INTO user_profiles (username, user_id, preferences, notes, interaction_count, last_seen, updated_at)
  VALUES (@username, @user_id, @preferences, @notes, 1, datetime('now'), datetime('now'))
  ON CONFLICT(username) DO UPDATE SET
    user_id = COALESCE(@user_id, user_profiles.user_id),
    preferences = CASE WHEN @preferences != '' THEN @preferences ELSE user_profiles.preferences END,
    notes = CASE WHEN @notes != '' THEN @notes ELSE user_profiles.notes END,
    interaction_count = user_profiles.interaction_count + 1,
    last_seen = datetime('now'),
    updated_at = datetime('now')
`);

const stmtTouchUserSeen = db.prepare(`
  INSERT INTO user_profiles (username, user_id, interaction_count, last_seen, updated_at)
  VALUES (@username, @user_id, 1, datetime('now'), datetime('now'))
  ON CONFLICT(username) DO UPDATE SET
    user_id = COALESCE(@user_id, user_profiles.user_id),
    interaction_count = user_profiles.interaction_count + 1,
    last_seen = datetime('now'),
    updated_at = datetime('now')
`);

const stmtGetRecentUserProfiles = db.prepare('SELECT * FROM user_profiles ORDER BY last_seen DESC LIMIT ?');

// --- HippoRAG Light (Concept Graph) Prepared Statements ---
const stmtLinkConcepts = db.prepare(`
  INSERT INTO concept_links (concept_a, concept_b, weight, updated_at)
  VALUES (@concept_a, @concept_b, @weight, datetime('now'))
  ON CONFLICT(concept_a, concept_b) DO UPDATE SET
    weight = MIN(10.0, concept_links.weight + @weight),
    updated_at = datetime('now')
`);

const stmtGetNeighbors = db.prepare(`
  SELECT concept_b AS concept, weight FROM concept_links WHERE concept_a = ?
  UNION
  SELECT concept_a AS concept, weight FROM concept_links WHERE concept_b = ?
  ORDER BY weight DESC LIMIT ?
`);

// --- CRUD-функции (все синхронные) ---

/**
 * Добавить запись в краткосрочную память.
 * @returns {{ id: number }} вставленная запись
 */
function addShort(type, content, priority = 'normal', expires = null) {
  let resolvedType = type || 'thought';
  if (resolvedType === 'error') {
    resolvedType = 'thought';
  }
  const info = stmtAddShort.run({
    type:     resolvedType,
    content:  String(content).trim(),
    priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
    expires:  expires || null
  });
  return { id: info.lastInsertRowid, type: resolvedType, content: String(content).trim(), priority };
}

/**
 * Добавить запись в долгосрочную память.
 * Триггер long_mem_ai автоматически обновит FTS5 индекс.
 * Автоматически связывает концепты в HippoRAG графе.
 * @returns {{ id: number }} вставленная запись
 */
function addLong(type, content, tags = '', source = null) {
  const tagsStr = Array.isArray(tags) ? tags.join(',') : String(tags || '');
  const cleanContent = String(content).trim();
  const info = stmtAddLong.run({
    type:    type || 'insight',
    content: cleanContent,
    tags:    tagsStr,
    source:  source || null
  });

  // Автоматическое построение графа связей концептов
  recordMemoryConcepts(tagsStr, cleanContent);

  return { id: info.lastInsertRowid, type, content: cleanContent, tags: tagsStr };
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
 * Получить самопоставленные цели агента (STM-записи типа 'plan').
 * Цели НЕ авто-архивируются по циклам — агент сам закрывает их через MEM_DELETE.
 */
function getGoals(limit) {
  return stmtGetGoals.all(limit || config.maxGoalsInContext);
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
  const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !FTS5_RESERVED.has(w.toUpperCase()));
  if (!words.length) return getLongMem(limit);

  const ftsQuery = words.map(w => `"${w}"`).join(' OR ');

  try {
    const results = stmtSearchLong.all(ftsQuery, limit || config.maxLongMemInContext);
    if (results.length > 0) {
      for (const r of results) {
        stmtUpdateAccess.run(r.id);
      }
      return results;
    }
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
  const words = query.split(/\s+/).filter(w => w.length >= 3);
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
    const strId = String(id).toUpperCase();
    const isLong = strId.startsWith('L');
    const numId = Number(strId.replace(/[SL]/g, ''));
    if (!Number.isFinite(numId)) continue;
    
    if (isLong) {
      const rec = stmtGetLongById.get(numId);
      if (rec) {
        rec.memory_type = 'long';
        stmtUpdateAccess.run(numId);
        results.push(rec);
      }
    } else {
      const rec = stmtGetShortById.get(numId);
      if (rec) {
        rec.memory_type = 'short';
        results.push(rec);
      }
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
  archiveExpiredShortMem(config.maxStmCycles);
  return info.changes;
}

function archiveExpiredShortMem(maxCycles = 4) {
  // Ensure the 'cycles' column exists in short_mem
  try {
    db.exec('ALTER TABLE short_mem ADD COLUMN cycles INTEGER DEFAULT 0');
  } catch (_) {
    // Column already exists, safe to ignore
  }

  try {
    // Increment cycles for all entries in short_mem
    db.prepare("UPDATE short_mem SET cycles = cycles + 1 WHERE type != 'plan'").run();

    // Select and auto-archive entries that exceeded cycles limit
    const expired = db.prepare("SELECT * FROM short_mem WHERE cycles >= ? AND type != 'plan'").all(maxCycles);
    for (const entry of expired) {
      // Enforce LTM auto_archive quota: max 20 entries. Evict oldest first.
      const AUTO_ARCHIVE_LTM_QUOTA = 20;
      const autoArchiveCount = db.prepare("SELECT COUNT(*) as cnt FROM long_mem WHERE tags LIKE 'auto_archive%'").get();
      if (autoArchiveCount && autoArchiveCount.cnt >= AUTO_ARCHIVE_LTM_QUOTA) {
        const oldest = db.prepare("SELECT id FROM long_mem WHERE tags LIKE 'auto_archive%' ORDER BY created ASC LIMIT 1").get();
        if (oldest) {
          db.prepare('DELETE FROM long_mem WHERE id = ?').run(oldest.id);
          console.log(`[MEM] LTM auto_archive quota exceeded (${AUTO_ARCHIVE_LTM_QUOTA}). Evicted oldest entry #${oldest.id}.`);
        }
      }

      addLong(
        entry.type,
        entry.content,
        `auto_archive, cycle_limit_${maxCycles}, ${entry.priority || 'normal'}`,
        `auto_archive_stm_${entry.id}`
      );
      deleteShort(entry.id);
      console.log(`[MEM] Auto-archived STM #${entry.id} (${entry.type}) to LTM after ${entry.cycles} cycles.`);
    }
  } catch (err) {
    console.error('[MEM] Error in STM auto-archiving:', err.message);
  }
}

function getRandomLongMem(lastShownId = null) {
  try {
    // 40% chance to exclude auto_archive entries to reduce self-referential priming
    const excludeAutoArchive = Math.random() < 0.4;
    
    // Build base query excluding the last shown entry to prevent immediate repetition
    const excludeClause = lastShownId ? `AND id != '${lastShownId}'` : '';
    
    if (excludeAutoArchive) {
      const row = db.prepare(`SELECT * FROM long_mem WHERE tags NOT LIKE 'auto_archive%' ${excludeClause} ORDER BY RANDOM() LIMIT 1`).get();
      if (row) return row;
    }
    // Fallback: any entry except last shown
    const row = db.prepare(`SELECT * FROM long_mem WHERE 1=1 ${excludeClause} ORDER BY RANDOM() LIMIT 1`).get();
    return row || db.prepare('SELECT * FROM long_mem ORDER BY RANDOM() LIMIT 1').get();
  } catch (_) {
    return null;
  }
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

// --- Letta Block Abstraction Layer (Phase 2) ---

/**
 * Core Memory (In-context)
 * Maps short_mem and adaptations into Letta-style blocks
 */
function getCoreMemoryBlocks(limit = 50) {
  const shortMem = getShortMem(limit);
  const adaptations = getAdaptations();
  
  const active_tasks = shortMem.filter(e => ['task', 'plan', 'reminder'].includes(e.type));
  const working_context = shortMem.filter(e => ['thought', 'insight', 'question'].includes(e.type));
  const persona = adaptations.map(a => `Rule: ${a.rule} (Target: ${a.target}, Strength: ${a.strength})`);
  
  return {
    active_tasks,
    working_context,
    persona
  };
}

/**
 * Archival Memory (Out-of-context, searchable)
 * Wraps long_mem FTS5 search
 */
function getArchivalMemory(query, limit = 20) {
  if (query) {
    return searchLongMem(query, limit);
  }
  return getLongMem(limit);
}

/**
 * Recall Memory (Temporal/Event history)
 * Reads chat_history.json
 */
function getRecallMemory(limit = 50) {
  const fs = require('fs');
  const path = require('path');
  const chatFile = path.join(config.logDir, 'chat_history.json');
  try {
    if (fs.existsSync(chatFile)) {
      const data = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
      return Array.isArray(data) ? data.slice(-limit) : [];
    }
  } catch (err) {
    // Ignore read errors
  }
  return [];
}

// ── User Profiles (Mem0 Layer) Functions ─────────────────────────────────────

function getUserProfile(username) {
  if (!username) return null;
  const cleanUsername = username.replace(/^@/, '').trim();
  try {
    return stmtGetUserProfile.get(cleanUsername) || null;
  } catch (_) {
    return null;
  }
}

function upsertUserProfile(username, data = {}) {
  if (!username) return null;
  const cleanUsername = username.replace(/^@/, '').trim();
  try {
    stmtUpsertUserProfile.run({
      username: cleanUsername,
      user_id: data.user_id || data.userId || null,
      preferences: data.preferences || '',
      notes: data.notes || ''
    });
    return getUserProfile(cleanUsername);
  } catch (err) {
    console.error('[MEM] Error upserting user profile:', err.message);
    return null;
  }
}

function touchUserSeen(username, userId = null) {
  if (!username) return;
  const cleanUsername = username.replace(/^@/, '').trim();
  try {
    stmtTouchUserSeen.run({
      username: cleanUsername,
      user_id: userId || null
    });
  } catch (_) {}
}

function getRecentUserProfiles(limit = 10) {
  try {
    return stmtGetRecentUserProfiles.all(limit);
  } catch (_) {
    return [];
  }
}

// ── HippoRAG Light (Concept Graph) Functions ──────────────────────────────────

function linkConcepts(conceptA, conceptB, weight = 1.0) {
  if (!conceptA || !conceptB) return;
  const a = String(conceptA).trim().toLowerCase();
  const b = String(conceptB).trim().toLowerCase();
  if (a === b || a.length < 2 || b.length < 2) return;

  // Store in deterministic alphabetical order to avoid duplicate reverse links
  const [first, second] = a < b ? [a, b] : [b, a];
  try {
    stmtLinkConcepts.run({
      concept_a: first,
      concept_b: second,
      weight: parseFloat(weight) || 1.0
    });
  } catch (_) {}
}

function getAssociatedConcepts(concept, limit = 3) {
  if (!concept) return [];
  const c = String(concept).trim().toLowerCase();
  try {
    const rows = stmtGetNeighbors.all(c, c, limit);
    return rows.map(r => r.concept);
  } catch (_) {
    return [];
  }
}

function recordMemoryConcepts(tagsStr, contentStr) {
  const concepts = new Set();

  // Extract from tags
  if (tagsStr) {
    tagsStr.split(/[,\s]+/).forEach(t => {
      const clean = t.replace(/^[#\s]+|[#\s]+$/g, '').trim().toLowerCase();
      if (clean.length > 2) concepts.add(clean);
    });
  }

  // Extract hashtags from content
  const contentHashtags = (contentStr.match(/#([a-zA-Zа-яА-ЯёЁ_]{3,})/g) || []).map(h => h.slice(1).toLowerCase());
  contentHashtags.forEach(h => concepts.add(h));

  const conceptArr = Array.from(concepts);
  if (conceptArr.length >= 2) {
    for (let i = 0; i < conceptArr.length; i++) {
      for (let j = i + 1; j < conceptArr.length; j++) {
        linkConcepts(conceptArr[i], conceptArr[j], 1.0);
      }
    }
  }
}

module.exports = {
  addShort,
  addLong,
  deleteShort,
  deleteLong,
  getShortMem,
  getGoals,
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
  initBaseAdaptations,
  archiveExpiredShortMem,
  getRandomLongMem,
  getCoreMemoryBlocks,
  getArchivalMemory,
  getRecallMemory,
  // Mem0 User Profile Layer
  getUserProfile,
  upsertUserProfile,
  touchUserSeen,
  getRecentUserProfiles,
  // HippoRAG Light Concept Graph
  linkConcepts,
  getAssociatedConcepts,
  recordMemoryConcepts
};

