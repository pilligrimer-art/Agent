const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbPath = path.join(config.memoryDir, 'agent.db');

// Создать директорию если не существует
const fs = require('fs');
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

// --- Настройки производительности ---
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

// --- Создание таблиц ---

db.exec(`
  CREATE TABLE IF NOT EXISTS short_mem (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    content   TEXT NOT NULL,
    priority  TEXT DEFAULT 'normal',
    created   TEXT DEFAULT (datetime('now')),
    expires   TEXT DEFAULT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS long_mem (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    content   TEXT NOT NULL,
    tags      TEXT DEFAULT '',
    created   TEXT DEFAULT (datetime('now')),
    source    TEXT DEFAULT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS adaptations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    target          TEXT NOT NULL,
    rule            TEXT NOT NULL,
    why             TEXT,
    strength        REAL DEFAULT 1.0,
    stability       REAL DEFAULT 1.0,
    challenge_count INTEGER DEFAULT 0,
    revision_count  INTEGER DEFAULT 0,
    created_by      TEXT DEFAULT 'environment',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
`);

// --- FTS5 виртуальная таблица для полнотекстового поиска ---

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS long_mem_fts
    USING fts5(content, tags, content='long_mem', content_rowid='id');
`);

// --- Триггеры синхронизации FTS5 ---

const triggers = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('long_mem_ai','long_mem_ad')"
).all();
const existingTriggers = new Set(triggers.map(t => t.name));

if (!existingTriggers.has('long_mem_ai')) {
  db.exec(`
    CREATE TRIGGER long_mem_ai AFTER INSERT ON long_mem BEGIN
      INSERT INTO long_mem_fts(rowid, content, tags)
        VALUES (new.id, new.content, new.tags);
    END;
  `);
}

if (!existingTriggers.has('long_mem_ad')) {
  db.exec(`
    CREATE TRIGGER long_mem_ad AFTER DELETE ON long_mem BEGIN
      INSERT INTO long_mem_fts(long_mem_fts, rowid, content, tags)
        VALUES('delete', old.id, old.content, old.tags);
    END;
  `);
}

// Корректное закрытие БД при завершении процесса
process.on('exit', () => {
  try { db.close(); } catch (_) { /* уже закрыта */ }
});

module.exports = db;
