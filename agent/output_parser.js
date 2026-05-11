const fs = require('fs');
const path = require('path');
const config = require('./config');

const PARSE_ERRORS_LOG = path.join(config.logDir, 'parse_errors.log');

// --- Регулярные выражения для тегов ---

const RE_MEM_SAVE  = /^\s*\[MEM_SAVE\s+(short|long)\]\s*(.+)$/gm;
const RE_MEM_DEL   = /^\s*\[MEM_DELETE\s+(short|long)\s+(\d+)\]\s*$/gm;
const RE_SCHEDULE  = /^\s*\[SCHEDULE\s+(\d+)\]\s*$/m;
const RE_REFLECT   = /^\s*\[REFLECT\]\s*$/m;
const RE_SEND_MSG  = /^\s*\[SEND_MESSAGE\]\s*(.+)$/gm;

/**
 * Безопасный парсинг JSON с fallback.
 * Если JSON невалиден — возвращает { type: 'thought', content: raw }.
 */
function parseSavePayload(raw) {
  const trimmed = String(raw).trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    logParseError('MEM_SAVE', `Invalid JSON: ${trimmed}`);
    return { type: 'error', content: 'SYSTEM WARNING: Previous cycle generated invalid JSON for memory saving. I must output strictly valid JSON inside technical tags.' };
  }
}

/**
 * Запись ошибки парсинга в лог (тихо, без прерывания).
 */
function logParseError(tag, message) {
  try {
    const dir = path.dirname(PARSE_ERRORS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    fs.appendFileSync(PARSE_ERRORS_LOG, line, 'utf8');
  } catch (_) {
    // Если не можем писать в лог — игнорируем, не прерываем работу
  }
}

/**
 * Основной парсер ответа модели.
 * Ищет теги только в последних 40 строках.
 */
function parseOutput(output) {
  const raw = String(output || '');
  const lines = raw.split(/\r?\n/);

  // Берём только последние 40 строк для поиска тегов
  const tailStart = Math.max(0, lines.length - 40);
  const tail = lines.slice(tailStart).join('\n');

  const saves = [];
  const deletes = [];
  const messages = [];
  let scheduleSec = config.defaultIntervalSec;
  let reflect = false;

  // --- Парсинг MEM_SAVE ---
  let match;
  RE_MEM_SAVE.lastIndex = 0;
  while ((match = RE_MEM_SAVE.exec(tail)) !== null) {
    const kind = match[1]; // 'short' или 'long'
    const payload = parseSavePayload(match[2]);
    saves.push({ kind, entry: payload });
  }

  // --- Парсинг MEM_DELETE ---
  RE_MEM_DEL.lastIndex = 0;
  while ((match = RE_MEM_DEL.exec(tail)) !== null) {
    const kind = match[1];
    const id = Number.parseInt(match[2], 10);
    if (Number.isFinite(id)) {
      deletes.push({ kind, id });
    } else {
      logParseError('MEM_DELETE', `Invalid ID: ${match[2]}`);
    }
  }

  // --- Парсинг SCHEDULE ---
  const schedMatch = RE_SCHEDULE.exec(tail);
  if (schedMatch) {
    const seconds = Number.parseInt(schedMatch[1], 10);
    if (Number.isFinite(seconds) && seconds >= 10) {
      scheduleSec = seconds;
    } else {
      logParseError('SCHEDULE', `Invalid value: ${schedMatch[1]}, using default`);
    }
  } else {
    logParseError('SCHEDULE', 'Tag not found, using default interval');
  }

  // --- Парсинг REFLECT ---
  reflect = RE_REFLECT.test(tail);

  // --- Парсинг SEND_MESSAGE ---
  RE_SEND_MSG.lastIndex = 0;
  while ((match = RE_SEND_MSG.exec(tail)) !== null) {
    messages.push(match[1].trim());
  }

  // --- Извлечение «мысли» (текст без тегов) ---
  const thought = lines
    .filter(line => !/^\s*\[(MEM_SAVE|MEM_DELETE|SCHEDULE|REFLECT|SEND_MESSAGE)\b/.test(line))
    .join('\n')
    .trim();

  return {
    thought,
    saves,
    deletes,
    messages,
    scheduleSec,
    reflect
  };
}

module.exports = {
  parseOutput,
  parseSavePayload,
  logParseError
};
