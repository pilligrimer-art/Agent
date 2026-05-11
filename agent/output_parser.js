const fs = require('fs');
const path = require('path');
const config = require('./config');

const PARSE_ERRORS_LOG = path.join(config.logDir, 'parse_errors.log');

function logParseError(tag, message) {
  try {
    const dir = path.dirname(PARSE_ERRORS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    fs.appendFileSync(PARSE_ERRORS_LOG, line, 'utf8');
    console.log(`[PARSER] warning: ${message}`);
  } catch (_) {
    // ignore
  }
}

// Regex to capture technical tags. \s*[^\]]* allows trailing prose before the closing bracket.
const RE_MEM_SAVE  = /^\s*\[MEM_SAVE(?:\s+(short|long))?\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_DEL   = /^\s*\[MEM_DELETE([^\]]*)\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_FOCUS = /^\s*\[MEM_FOCUS([^\]]*)\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT = /^\s*\[MEM_ADAPT\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT_CHALLENGE = /^\s*\[MEM_ADAPT_CHALLENGE\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT_WEAKEN = /^\s*\[MEM_ADAPT_WEAKEN\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_SCHEDULE  = /^\s*\[SCHEDULE(?:\]\s*|\s+)(\d+)\]?/m;
const RE_REFLECT   = /^\s*\[REFLECT\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_SEND_MSG  = /^\s*\[SEND_MESSAGE\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_HELP_ACTIONS = /^\s*\[HELP_ACTIONS\]/m;
const RE_HELP_ACTION = /^\s*\[HELP_ACTION\s+"([^"]+)"\]/gm;

function normalizeModelOutput(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function safeParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    const start = raw.indexOf('{');
    if (start >= 0) {
      let openBraces = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < raw.length; i++) {
        const char = raw[i];
        if (!escape && char === '"') inString = !inString;
        if (!inString) {
          if (char === '{') openBraces++;
          if (char === '}') openBraces--;
        }
        if (char === '\\' && !escape) escape = true;
        else escape = false;
        
        if (openBraces === 0) {
          const extracted = raw.substring(start, i + 1);
          try {
            return { ok: true, value: JSON.parse(extracted) };
          } catch(e2) {
            break;
          }
        }
      }
    }
    return { ok: false, error: e.message };
  }
}

function fallbackSaveMalformedTag(tag, raw, thought) {
  return {
    type: "thought",
    content: `Malformed ${tag} was ignored. Related thought: ${thought.slice(0, 300)}...`,
    priority: "normal",
    why: "Model attempted an action but formatting failed; preserving semantic content."
  };
}

function extractProse(raw) {
  let prose = raw.trim().replace(/^[–-]\s*/, '').trim();
  const quoteMatch = prose.match(/^"([\s\S]+)"$/);
  if (quoteMatch) return quoteMatch[1].trim();
  return prose;
}

function determineProseType(prose) {
  const lower = prose.toLowerCase();
  if (lower.startsWith('initial assessment')) return 'insight';
  if (lower.startsWith('question:')) return 'question';
  if (lower.startsWith('consider')) return 'thought';
  if (lower.startsWith('need to') || lower.startsWith('i should') || lower.startsWith('must')) return 'task';
  return 'thought';
}

/**
 * Парсер вывода агента.
 * Вытаскивает все команды из конца (или любой части) текста.
 * Поддерживает множественные действия за один ответ.
 */
function parseOutput(text) {
  const normalizedFull = normalizeModelOutput(text);
  const lines = normalizedFull.split('\n');
  
  // Берём только последние 40 строк для поиска тегов
  const tailStart = Math.max(0, lines.length - 40);
  const tail = lines.slice(tailStart).join('\n');
  const normalized = tail; // already normalized by normalizeModelOutput

  const actions = {
    thought: '',
    saves: [],
    deletes: [],
    adapts: [],
    adaptChallenges: [],
    adaptWeakens: [],
    messages: [],
    helpRequests: [],
    focusIds: [],
    focusTopics: [],
    scheduleSec: config.defaultIntervalSec,
    reflect: false,
    parseErrorCount: 0
  };

  let match;
  
  // MEM_SAVE
  RE_MEM_SAVE.lastIndex = 0;
  while ((match = RE_MEM_SAVE.exec(normalized)) !== null) {
    const kind = match[1]; // might be undefined
    const rawJson = match[2].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok) {
      const obj = parsed.value;
      if (!obj.type || !obj.content) {
        logParseError('MEM_SAVE', `invalid_json_schema in MEM_SAVE, action ignored, thought preserved`);
        actions.parseErrorCount++;
        actions.saves.push({ kind: kind || 'short', entry: fallbackSaveMalformedTag('MEM_SAVE', rawJson, text) });
      } else {
        if (Array.isArray(obj.tags)) {
          obj.tags = obj.tags.join(', ');
        } else if (typeof obj.tags === 'string') {
          obj.tags = obj.tags.split(',').map(s => s.trim()).join(', ');
        }
        if (!obj.why) {
          obj.why = "Agent expressed stable save intent.";
        }
        actions.saves.push({ kind: kind || 'short', entry: obj });
      }
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 5 && !prose.startsWith('{')) {
        logParseError('MEM_SAVE', `semantic_fallback for prose payload`);
        const type = determineProseType(prose);
        actions.saves.push({ kind: kind || 'short', entry: { type, content: prose, priority: 'normal', why: "Agent expressed save intent with prose payload." } });
      } else {
        logParseError('MEM_SAVE', `invalid_json in MEM_SAVE`);
        if (prose.startsWith('{')) actions.parseErrorCount++;
        if (!actions.helpRequests.includes('MEM_SAVE')) actions.helpRequests.push('MEM_SAVE');
      }
    }
  }

  // MEM_DELETE
  RE_MEM_DEL.lastIndex = 0;
  while ((match = RE_MEM_DEL.exec(normalized)) !== null) {
    const insideArgs = match[1];
    const trailingArgs = match[2];
    let kind = undefined;
    if (insideArgs.includes('short')) kind = 'short';
    if (insideArgs.includes('long')) kind = 'long';
    
    const combined = insideArgs + " " + trailingArgs;
    const ids = [...combined.matchAll(/#?(\d+)/g)].map(m => Number.parseInt(m[1], 10));
    for (const id of ids) {
      if (Number.isFinite(id)) {
        actions.deletes.push({ kind, id });
      }
    }
  }

  // MEM_FOCUS
  RE_MEM_FOCUS.lastIndex = 0;
  while ((match = RE_MEM_FOCUS.exec(normalized)) !== null) {
    const rawIds = match[1];
    const rawJson = match[2].trim();
    
    if (rawIds) {
      const ids = [...rawIds.matchAll(/#(\d+)/g)].map(m => Number.parseInt(m[1], 10));
      if (ids.length > 0) {
        actions.focusIds.push(...ids);
      }
    }
    
    if (rawJson) {
      const parsed = safeParseJson(rawJson);
      if (parsed.ok && parsed.value.topic) {
        actions.focusTopics.push({ topic: parsed.value.topic, limit: parsed.value.limit || 3 });
      } else {
        const prose = extractProse(rawJson);
        if (prose.length > 3 && !prose.startsWith('{')) {
           actions.focusTopics.push({ topic: prose, limit: 3 });
           logParseError('MEM_FOCUS', `semantic_fallback for prose topic`);
        } else {
          if (prose.startsWith('{')) {
            logParseError('MEM_FOCUS', `invalid_json`);
            actions.parseErrorCount++;
          }
          if (!actions.helpRequests.includes('MEM_FOCUS')) actions.helpRequests.push('MEM_FOCUS');
        }
      }
    }
  }

  // MEM_ADAPT
  RE_MEM_ADAPT.lastIndex = 0;
  while ((match = RE_MEM_ADAPT.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.type && parsed.value.target && parsed.value.rule) {
      actions.adapts.push(parsed.value);
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 5 && !prose.startsWith('{')) {
        actions.saves.push({ kind: 'short', entry: { type: 'thought', content: `Attempted to adapt: ${prose}`, priority: 'normal', why: 'Agent expressed adaptation intent with prose payload.' } });
        logParseError('MEM_ADAPT', `semantic_fallback`);
      } else {
        logParseError('MEM_ADAPT', `invalid_json or schema`);
        if (prose.startsWith('{')) actions.parseErrorCount++;
      }
      if (!actions.helpRequests.includes('MEM_ADAPT')) actions.helpRequests.push('MEM_ADAPT');
    }
  }

  // MEM_ADAPT_CHALLENGE
  RE_MEM_ADAPT_CHALLENGE.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_CHALLENGE.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.id) {
      actions.adaptChallenges.push(parsed.value);
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 5 && !prose.startsWith('{')) {
        actions.saves.push({ kind: 'short', entry: { type: 'thought', content: `Attempted to challenge: ${prose}`, priority: 'normal', why: 'Agent expressed challenge intent with prose.' } });
      } else {
        if (prose.startsWith('{')) actions.parseErrorCount++;
      }
      if (!actions.helpRequests.includes('MEM_ADAPT_CHALLENGE')) actions.helpRequests.push('MEM_ADAPT_CHALLENGE');
    }
  }

  // MEM_ADAPT_WEAKEN
  RE_MEM_ADAPT_WEAKEN.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_WEAKEN.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.id && typeof parsed.value.amount === 'number') {
      actions.adaptWeakens.push(parsed.value);
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 5 && !prose.startsWith('{')) {
        actions.saves.push({ kind: 'short', entry: { type: 'thought', content: `Attempted to weaken: ${prose}`, priority: 'normal', why: 'Agent expressed weaken intent with prose.' } });
      } else {
        if (prose.startsWith('{')) actions.parseErrorCount++;
      }
      if (!actions.helpRequests.includes('MEM_ADAPT_WEAKEN')) actions.helpRequests.push('MEM_ADAPT_WEAKEN');
    }
  }

  // SCHEDULE
  const schedMatch = RE_SCHEDULE.exec(normalized);
  if (schedMatch) {
    let seconds = Number.parseInt(schedMatch[1], 10);
    if (Number.isFinite(seconds)) {
      actions.scheduleSec = Math.min(Math.max(seconds, 10), 900);
    }
  }

  // REFLECT
  RE_REFLECT.lastIndex = 0;
  while ((match = RE_REFLECT.exec(normalized)) !== null) {
    actions.reflect = true;
    const rawText = match[1] ? match[1].trim() : '';
    const prose = extractProse(rawText);
    if (prose.length > 5 && !prose.startsWith('{') && !prose.startsWith('[')) {
      actions.saves.push({ kind: 'short', entry: { type: 'reflection_request', content: prose, priority: 'normal', why: 'Agent triggered reflection with prose.' } });
      logParseError('REFLECT', `semantic_fallback for prose`);
    }
  }

  // SEND_MESSAGE
  RE_SEND_MSG.lastIndex = 0;
  while ((match = RE_SEND_MSG.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.text) {
      actions.messages.push(parsed.value.text);
    } else {
      // Fallback if not json
      if (!rawJson.startsWith('{')) {
         const prose = extractProse(rawJson);
         if (prose.length > 0) {
           actions.messages.push(prose);
         }
      } else {
         logParseError('SEND_MESSAGE', `invalid_json`);
         actions.parseErrorCount++;
      }
    }
  }

  // HELP_ACTIONS
  if (RE_HELP_ACTIONS.test(normalized)) {
    actions.helpRequests.push("ALL");
  } else {
    RE_HELP_ACTION.lastIndex = 0;
    while ((match = RE_HELP_ACTION.exec(normalized)) !== null) {
      actions.helpRequests.push(match[1].trim());
    }
  }

  // Bare tag -> help injection (Backup for missed tags)
  const expectedCounts = {
    'MEM_SAVE': actions.saves.length,
    'MEM_DELETE': actions.deletes.length,
    'MEM_ADAPT': actions.adapts.length,
    'MEM_ADAPT_CHALLENGE': actions.adaptChallenges.length,
    'MEM_ADAPT_WEAKEN': actions.adaptWeakens.length,
    'SEND_MESSAGE': actions.messages.length,
    'MEM_FOCUS': actions.focusIds.length + actions.focusTopics.length // approximate
  };

  for (const [tag, count] of Object.entries(expectedCounts)) {
    const rawCount = (normalized.match(new RegExp(`\\[${tag}(?=[\\s\\]])`, 'g')) || []).length;
    if (rawCount > count) {
      if (tag === 'MEM_SAVE' && /\[MEM_SAVE\s+#\d+/.test(normalized)) {
         logParseError('MEM_SAVE', 'Detected [MEM_SAVE #ID], probably intended MEM_FOCUS.');
         if (!actions.helpRequests.includes('MEM_FOCUS')) actions.helpRequests.push('MEM_FOCUS');
      } else {
         if (!actions.helpRequests.includes(tag)) {
           actions.helpRequests.push(tag);
         }
      }
    }
  }

  // Очищаем оригинальный текст от тегов
  actions.thought = lines
    .filter(line => !/^\s*\[(MEM_SAVE|MEM_DELETE|MEM_FOCUS|MEM_ADAPT|MEM_ADAPT_CHALLENGE|MEM_ADAPT_WEAKEN|SCHEDULE|REFLECT|SEND_MESSAGE|HELP_ACTIONS|HELP_ACTION)\b/.test(line))
    .join('\n')
    .trim();

  return actions;
}

module.exports = {
  parseOutput,
  logParseError
};
