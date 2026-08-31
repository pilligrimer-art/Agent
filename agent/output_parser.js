const fs = require('fs');
const path = require('path');
const config = require('./config');

const skillsDir = path.join(__dirname, '..', 'skills');
let dynamicTags = [];
try {
  if (fs.existsSync(skillsDir)) {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const skill = require(path.join(skillsDir, file));
      if (skill.tag) dynamicTags.push(skill.tag);
    }
  }
} catch (e) { console.error('Failed to load dynamic tags:', e); }

const PARSE_ERRORS_LOG = path.join(config.logDir, 'parse_errors.log');

function logTelemetry(event, meta = {}) {
  try {
    const dir = path.dirname(PARSE_ERRORS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${event}] ${JSON.stringify(meta)}\n`;
    fs.appendFileSync(PARSE_ERRORS_LOG, line, 'utf8');
    console.log(`[PARSER] ${event}: ${meta.intent || ''} ${meta.reason || ''}`);
  } catch (_) {}
}

function normalizeModelOutput(text) {
  if (!text) return '';
  return text
    // Strip <think>...</think> blocks (Qwen 3.5 thinking mode safety net)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B`]/g, "'")
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function lenientJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Empty payload' };
  
  // 1. First attempt: standard JSON parse
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (_) {}

  // 2. Second attempt: bracket-balanced substring extraction
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
        } catch (_) {}
      }
    }
  }

  // 3. Third attempt: Sanitize common JSON errors (trailing commas, unclosed brackets)
  let candidate = start >= 0 ? raw.substring(start) : raw;
  candidate = candidate.trim()
    .replace(/,\s*([\}\]])/g, '$1') // Trailing comma fix
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"') // Typographic quotes
    .replace(/[\u2018\u2019]/g, "'");

  // Auto-close open braces if truncated
  let openCount = (candidate.match(/\{/g) || []).length;
  let closeCount = (candidate.match(/\}/g) || []).length;
  if (openCount > closeCount) {
    candidate += '}'.repeat(openCount - closeCount);
  }

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (_) {}

  // 4. Fourth attempt: Heuristic field extraction (fixes unescaped quotes in content/text/rule)
  const result = {};
  let fieldsFound = 0;

  // Extract content
  const contentMatch = candidate.match(/"content"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"\w+"\s*:|\s*\})/i);
  if (contentMatch) {
    result.content = contentMatch[1].trim();
    fieldsFound++;
  }

  // Extract text (for SEND_MESSAGE)
  const textMatch = candidate.match(/"text"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"\w+"\s*:|\s*\})/i);
  if (textMatch) {
    result.text = textMatch[1].trim();
    fieldsFound++;
  }

  // Extract type
  const typeMatch = candidate.match(/"type"\s*:\s*"([^"]+)"/i);
  if (typeMatch) {
    result.type = typeMatch[1].trim();
    fieldsFound++;
  }

  // Extract priority
  const priorityMatch = candidate.match(/"priority"\s*:\s*"([^"]+)"/i);
  if (priorityMatch) {
    result.priority = priorityMatch[1].trim();
    fieldsFound++;
  }

  // Extract why
  const whyMatch = candidate.match(/"why"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"\w+"\s*:|\s*\})/i);
  if (whyMatch) {
    result.why = whyMatch[1].trim();
    fieldsFound++;
  }

  // Extract rule & target (for adaptations)
  const ruleMatch = candidate.match(/"rule"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"\w+"\s*:|\s*\})/i);
  if (ruleMatch) {
    result.rule = ruleMatch[1].trim();
    fieldsFound++;
  }
  const targetMatch = candidate.match(/"target"\s*:\s*"([^"]+)"/i);
  if (targetMatch) {
    result.target = targetMatch[1].trim();
    fieldsFound++;
  }

  // Extract topic & limit (for focus)
  const topicMatch = candidate.match(/"topic"\s*:\s*"([^"]+)"/i);
  if (topicMatch) {
    result.topic = topicMatch[1].trim();
    fieldsFound++;
  }
  const limitMatch = candidate.match(/"limit"\s*:\s*(\d+)/i);
  if (limitMatch) {
    result.limit = parseInt(limitMatch[1], 10);
    fieldsFound++;
  }

  // Extract id & amount (for adapt challenge/weaken)
  const idMatch = candidate.match(/"id"\s*:\s*"([^"]+)"/i);
  if (idMatch) {
    result.id = idMatch[1].trim();
    fieldsFound++;
  }
  const amountMatch = candidate.match(/"amount"\s*:\s*([\d\.]+)/i);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1]);
    fieldsFound++;
  }
  const replacementMatch = candidate.match(/"replacement"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"\w+"\s*:|\s*\})/i);
  if (replacementMatch) {
    result.replacement = replacementMatch[1].trim();
    fieldsFound++;
  }

  // Extract tags
  const tagsMatch = candidate.match(/"tags"\s*:\s*(\[[^\]]*\]|"[^"]*")/i);
  if (tagsMatch) {
    try {
      result.tags = JSON.parse(tagsMatch[1]);
    } catch (_) {
      result.tags = tagsMatch[1].replace(/[\[\]"]/g, '').split(',').map(s => s.trim());
    }
    fieldsFound++;
  }

  if (fieldsFound > 0 && (result.content || result.text || result.topic || result.rule || result.id || result.target)) {
    return { ok: true, value: result, repaired: true };
  }

  return { ok: false, error: 'Malformed JSON payload' };
}

// Backward compatibility alias
const safeParseJson = lenientJsonParse;

function extractFollowingContent(afterText) {
  afterText = afterText.trim();
  if (afterText.startsWith('{')) {
    let openBraces = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < afterText.length; i++) {
      const char = afterText[i];
      if (!escape && char === '"') inString = !inString;
      if (!inString) {
        if (char === '{') openBraces++;
        if (char === '}') openBraces--;
      }
      if (char === '\\' && !escape) escape = true;
      else escape = false;
      if (openBraces === 0) {
        return afterText.substring(0, i + 1);
      }
    }
  }

  if (afterText.startsWith('"')) {
    let escape = false;
    for (let i = 1; i < afterText.length; i++) {
      const char = afterText[i];
      if (char === '"' && !escape) {
        return afterText.substring(0, i + 1);
      }
      if (char === '\\' && !escape) escape = true;
      else escape = false;
    }
  }

  const upToDotMatch = afterText.match(/^([^.\[\n]*)/);
  return upToDotMatch ? upToDotMatch[1] : '';
}

function cleanProseText(t) {
  let cleaned = t.trim();
  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
  // Remove leading dashes/colons/tags
  cleaned = cleaned.replace(/^[–\-:\s]+/, '').trim();
  return cleaned;
}

function extractPaths(argsString) {
  const paths = [];
  const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match;
  while ((match = regex.exec(argsString)) !== null) {
    const p = match[1] || match[2] || match[3];
    if (p) {
      // Remove trailing brackets or commas that might have stuck to unquoted paths
      paths.push(p.replace(/^[\[\]\,]+|[\[\]\,]+$/g, '').trim());
    }
  }
  return paths.filter(p => p.length > 0);
}

const SUGGESTED = {
  MEM_SAVE: '[MEM_SAVE short] {"type":"thought","content":"...","priority":"normal","why":"..."}',
  MEM_SAVE_LONG: '[MEM_SAVE long] {"type":"insight","content":"...","tags":["topic"],"why":"..."}',
  MEM_DELETE: '[MEM_DELETE short #ID]',
  MEM_FOCUS: '[MEM_FOCUS #ID1 #ID2]',
  MEM_FOCUS_TOPIC: '[MEM_FOCUS] {"topic":"...","limit":3}',
  MEM_ADAPT: '[MEM_ADAPT] {"type":"suppress","target":"...","rule":"...","why":"..."}',
  MEM_ADAPT_CHALLENGE: '[MEM_ADAPT_CHALLENGE] {"id":"...","why":"...","replacement":"..."}',
  MEM_ADAPT_WEAKEN: '[MEM_ADAPT_WEAKEN] {"id":"...","why":"...","amount":0.2}',
  SCHEDULE: '[SCHEDULE 60]',
  REFLECT: '[REFLECT]',
  SEND_MESSAGE: '[SEND_MESSAGE] {"text":"...","why":"..."}',
  THINK_LEVEL: '[THINK_LEVEL "high"]',
  USER_PROFILE: '[USER_PROFILE "@username"] {"preferences":"...","notes":"..."}',
};

// ── Карта мультиязычных и семантических алиасов ──────────────────────────────
const TAG_ALIASES = {
  // User Profiles (Mem0 Layer)
  'USER_PROFILE': 'USER_PROFILE',
  'USER_NOTE': 'USER_PROFILE',
  'USER_UPDATE': 'USER_PROFILE',
  'PROFILE_USER': 'USER_PROFILE',
  'SET_USER': 'USER_PROFILE',
  'ПРОФИЛЬ': 'USER_PROFILE',

  // Messages / Communication
  'SEND_MESSAGE': 'SEND_MESSAGE',
  'MESSAGE': 'SEND_MESSAGE',
  'MSG': 'SEND_MESSAGE',
  'REPLY': 'SEND_MESSAGE',
  'NOTIFY': 'SEND_MESSAGE',

  'SAY': 'SEND_MESSAGE',
  'CHAT': 'SEND_MESSAGE',
  'TELL': 'SEND_MESSAGE',
  'SPEAK': 'SEND_MESSAGE',
  'TALK': 'SEND_MESSAGE',
  'OUT': 'SEND_MESSAGE',
  'OUTPUT': 'SEND_MESSAGE',
  'SEND': 'SEND_MESSAGE',
  'POST': 'SEND_MESSAGE',
  'WRITE': 'SEND_MESSAGE',
  'RESPOND': 'SEND_MESSAGE',
  'ANSWER': 'SEND_MESSAGE',
  'DISPATCH': 'SEND_MESSAGE',
  'EMIT': 'SEND_MESSAGE',
  'BROADCAST': 'SEND_MESSAGE',
  'TRANSMIT': 'SEND_MESSAGE',
  'USER_MSG': 'SEND_MESSAGE',
  'SEND_MSG': 'SEND_MESSAGE',
  'REPLY_USER': 'SEND_MESSAGE',
  'TG_SEND': 'SEND_MESSAGE',
  'TELEGRAM_SEND': 'SEND_MESSAGE',
  'ОТВЕТИТЬ': 'SEND_MESSAGE',
  'СООБЩЕНИЕ': 'SEND_MESSAGE',
  'СКАЗАТЬ': 'SEND_MESSAGE',
  'НАПИСАТЬ': 'SEND_MESSAGE',
  'ОТПРАВИТЬ': 'SEND_MESSAGE',

  // Memory Save
  'MEM_SAVE': 'MEM_SAVE',
  'SAVE': 'MEM_SAVE',
  'REMEMBER': 'MEM_SAVE',
  'NOTE': 'MEM_SAVE',
  'RECORD': 'MEM_SAVE',
  'STORE': 'MEM_SAVE',
  'KEEP': 'MEM_SAVE',
  'MEMORIZE': 'MEM_SAVE',
  'LOG': 'MEM_SAVE',
  'WRITE_MEM': 'MEM_SAVE',
  'PUT_MEM': 'MEM_SAVE',
  'INSERT_MEM': 'MEM_SAVE',
  'INSIGHT': 'MEM_SAVE',
  'KNOWLEDGE': 'MEM_SAVE',
  'FACT': 'MEM_SAVE',
  'TASK': 'MEM_SAVE',
  'SAVE_MEM': 'MEM_SAVE',
  'MEM_STORE': 'MEM_SAVE',
  'MEM_ADD': 'MEM_SAVE',
  'ADD_MEM': 'MEM_SAVE',
  'SET_MEM': 'MEM_SAVE',
  'SHORT_MEM': 'MEM_SAVE',
  'LONG_MEM': 'MEM_SAVE',
  'ARCHIVE': 'MEM_SAVE',
  'СОХРАНИТЬ': 'MEM_SAVE',
  'ЗАПОМНИТЬ': 'MEM_SAVE',
  'ЗАМЕТКА': 'MEM_SAVE',
  'ПАМЯТЬ': 'MEM_SAVE',
  'ЗАПИСАТЬ': 'MEM_SAVE',
  'ИНСАЙТ': 'MEM_SAVE',

  // Memory Focus & Search
  'MEM_FOCUS': 'MEM_FOCUS',
  'FOCUS': 'MEM_FOCUS',
  'SEARCH': 'MEM_FOCUS',
  'FIND': 'MEM_FOCUS',
  'RECALL': 'MEM_FOCUS',
  'LOOKUP': 'MEM_FOCUS',
  'QUERY': 'MEM_FOCUS',
  'RETRIEVE': 'MEM_FOCUS',
  'FETCH': 'MEM_FOCUS',
  'LOCATE': 'MEM_FOCUS',
  'SCAN_MEM': 'MEM_FOCUS',
  'INSPECT': 'MEM_FOCUS',
  'EXPLORE': 'MEM_FOCUS',
  'DISCOVER': 'MEM_FOCUS',
  'MEM_SEARCH': 'MEM_FOCUS',
  'SEARCH_MEM': 'MEM_FOCUS',
  'FOCUS_MEM': 'MEM_FOCUS',
  'GET_MEM': 'MEM_FOCUS',
  'FIND_MEM': 'MEM_FOCUS',
  'НАЙТИ': 'MEM_FOCUS',
  'ПОИСК': 'MEM_FOCUS',
  'ВСПОМНИТЬ': 'MEM_FOCUS',
  'ФОКУС': 'MEM_FOCUS',

  // Memory Delete
  'MEM_DELETE': 'MEM_DELETE',
  'DELETE': 'MEM_DELETE',
  'REMOVE': 'MEM_DELETE',
  'FORGET': 'MEM_DELETE',
  'ERASE': 'MEM_DELETE',
  'DROP': 'MEM_DELETE',
  'CLEAR_MEM': 'MEM_DELETE',
  'PURGE': 'MEM_DELETE',
  'DISCARD': 'MEM_DELETE',
  'UNSET': 'MEM_DELETE',
  'DEL_MEM': 'MEM_DELETE',
  'MEM_DEL': 'MEM_DELETE',
  'DELETE_MEM': 'MEM_DELETE',
  'REMOVE_MEM': 'MEM_DELETE',
  'УДАЛИТЬ': 'MEM_DELETE',
  'СТЕРЕТЬ': 'MEM_DELETE',
  'ЗАБЫТЬ': 'MEM_DELETE',

  // Scheduling & Sleep
  'SCHEDULE': 'SCHEDULE',
  'SLEEP': 'SCHEDULE',
  'WAIT': 'SCHEDULE',
  'DELAY': 'SCHEDULE',
  'PAUSE': 'SCHEDULE',
  'REST': 'SCHEDULE',
  'IDLE': 'SCHEDULE',
  'SNOOZE': 'SCHEDULE',
  'DEFER': 'SCHEDULE',
  'HOLD': 'SCHEDULE',
  'TIMER': 'SCHEDULE',
  'WAKE_IN': 'SCHEDULE',
  'NEXT_RUN': 'SCHEDULE',
  'SET_TIMER': 'SCHEDULE',
  'SLEEP_FOR': 'SCHEDULE',
  'WAIT_SEC': 'SCHEDULE',
  'ПАУЗА': 'SCHEDULE',
  'СОН': 'SCHEDULE',
  'ЖДАТЬ': 'SCHEDULE',
  'ТАЙМЕР': 'SCHEDULE',
  'ОТЛОЖИТЬ': 'SCHEDULE',

  // Thinking Effort / CoT depth
  'THINK_LEVEL': 'THINK_LEVEL',
  'THINK_BUDGET': 'THINK_LEVEL',
  'REASONING_EFFORT': 'THINK_LEVEL',
  'THINK': 'THINK_LEVEL',
  'EFFORT': 'THINK_LEVEL',
  'REASONING': 'THINK_LEVEL',
  'BUDGET': 'THINK_LEVEL',
  'COT_LEVEL': 'THINK_LEVEL',
  'THINK_DEPTH': 'THINK_LEVEL',
  'DEPTH': 'THINK_LEVEL',
  'REASON_EFFORT': 'THINK_LEVEL',
  'COMPUTE': 'THINK_LEVEL',
  'MODE': 'THINK_LEVEL',
  'THINKING': 'THINK_LEVEL',
  'REASONING_LEVEL': 'THINK_LEVEL',
  'COT': 'THINK_LEVEL',
  'РЕЖИМ_МЫСЛЕЙ': 'THINK_LEVEL',
  'ДУМАТЬ': 'THINK_LEVEL',
  'ГЛУБИНА': 'THINK_LEVEL',

  // Reflection
  'REFLECT': 'REFLECT',
  'COMPRESS': 'REFLECT',
  'SYNTHESIZE': 'REFLECT',
  'CONSOLIDATE': 'REFLECT',
  'REVIEW': 'REFLECT',
  'CONTEMPLATE': 'REFLECT',
  'SELF_EVALUATE': 'REFLECT',
  'PONDER': 'REFLECT',
  'MEDITATE': 'REFLECT',
  'INTROSPECT': 'REFLECT',
  'РЕФЛЕКСИЯ': 'REFLECT',
  'АНАЛИЗ': 'REFLECT',
  'ОСМЫСЛИТЬ': 'REFLECT',

  // Adaptations
  'MEM_ADAPT': 'MEM_ADAPT',
  'ADAPT': 'MEM_ADAPT',
  'RULE': 'MEM_ADAPT',
  'BEHAVIOR': 'MEM_ADAPT',
  'HEURISTIC': 'MEM_ADAPT',
  'POLICY': 'MEM_ADAPT',
  'NEW_RULE': 'MEM_ADAPT',
  'SET_RULE': 'MEM_ADAPT',
  'ADAPTATION': 'MEM_ADAPT',
  'АДАПТАЦИЯ': 'MEM_ADAPT',
  'MEM_ADAPT_CHALLENGE': 'MEM_ADAPT_CHALLENGE',
  'CHALLENGE': 'MEM_ADAPT_CHALLENGE',
  'REVISE_RULE': 'MEM_ADAPT_CHALLENGE',
  'UPDATE_RULE': 'MEM_ADAPT_CHALLENGE',
  'RETHINK_RULE': 'MEM_ADAPT_CHALLENGE',
  'MODIFY_RULE': 'MEM_ADAPT_CHALLENGE',
  'ПЕРЕСМОТР': 'MEM_ADAPT_CHALLENGE',
  'MEM_ADAPT_WEAKEN': 'MEM_ADAPT_WEAKEN',
  'WEAKEN': 'MEM_ADAPT_WEAKEN',
  'UNLEARN': 'MEM_ADAPT_WEAKEN',
  'DECAY_RULE': 'MEM_ADAPT_WEAKEN',
  'REDUCE_RULE': 'MEM_ADAPT_WEAKEN',
  'FADE_RULE': 'MEM_ADAPT_WEAKEN',
  'ОСЛАБИТЬ': 'MEM_ADAPT_WEAKEN',

  // Curiosity & Self-Questions
  'SELF_QUESTION': 'SELF_QUESTION',
  'QUESTION': 'SELF_QUESTION',
  'ASK_SELF': 'SELF_QUESTION',
  'WONDER': 'SELF_QUESTION',
  'INQUIRE': 'SELF_QUESTION',
  'CURIOSITY': 'SELF_QUESTION',
  'TOPIC_SCORE': 'TOPIC_SCORE',
  'SCORE_TOPIC': 'TOPIC_SCORE',
  'INTEREST': 'TOPIC_SCORE',
  'RATE_TOPIC': 'TOPIC_SCORE',
  'TOPIC_RATING': 'TOPIC_SCORE',

  // Help
  'HELP_ACTION': 'HELP_ACTION',
  'HELP_ACTIONS': 'HELP_ACTIONS',
  'HELP': 'HELP_ACTIONS',
  'SYNTAX': 'HELP_ACTIONS',
  'TOOL_INFO': 'HELP_ACTIONS',
  'MAN': 'HELP_ACTIONS',
  'DOCS': 'HELP_ACTIONS',
  'ALL_TOOLS': 'HELP_ACTIONS',
  'TOOLS': 'HELP_ACTIONS',
  'ПОМОЩЬ': 'HELP_ACTIONS',

  // MCP
  'MCP_LIST': 'MCP_LIST',
  'LS': 'MCP_LIST',
  'DIR': 'MCP_LIST',
  'LIST_FILES': 'MCP_LIST',
  'LIST_DIR': 'MCP_LIST',
  'MCP_READ': 'MCP_READ',
  'CAT': 'MCP_READ',
  'READ': 'MCP_READ',
  'VIEW_FILE': 'MCP_READ',
  'GET_FILE': 'MCP_READ',
  'READ_FILE': 'MCP_READ'
};


// ── Генератор хирургических точечных подсказок (Surgical Diff Hints) ──────────
function makeSurgicalHint(intent, observed, reason) {
  const cleanObserved = (observed || '').trim().replace(/\s+/g, ' ');
  let exactFix = SUGGESTED[intent] || `[${intent}]`;

  if (intent === 'MEM_SAVE') {
    const textSnippet = cleanProseText(cleanObserved.replace(/\[?(MEM_SAVE|SAVE|СОХРАНИТЬ|ЗАПОМНИТЬ|NOTE)\s*(short|long)?\]?:?/iu, ''));
    if (textSnippet && textSnippet.length > 2) {
      exactFix = `[MEM_SAVE short] {"type":"thought","content":"${textSnippet.slice(0, 50).replace(/"/g, "'")}"}`;
    }
  } else if (intent === 'SEND_MESSAGE') {
    const textSnippet = cleanProseText(cleanObserved.replace(/\[?(SEND_MESSAGE|MESSAGE|СООБЩЕНИЕ|ОТВЕТИТЬ|REPLY)\b\]?:?/iu, ''));
    if (textSnippet && textSnippet.length > 2) {
      exactFix = `[SEND_MESSAGE] {"text":"${textSnippet.slice(0, 50).replace(/"/g, "'")}"}`;
    }
  } else if (intent === 'SCHEDULE') {
    const num = (cleanObserved.match(/\d+/) || [])[0] || '60';
    exactFix = `[SCHEDULE ${num}]`;
  } else if (intent === 'THINK_LEVEL') {
    const lvl = (cleanObserved.match(/high|medium|light|low|глубоко|быстро|средне/i) || [])[0] || 'high';
    const normLvl = (lvl === 'low' || lvl === 'быстро') ? 'light' : (lvl === 'глубоко' ? 'high' : 'medium');
    exactFix = `[THINK_LEVEL "${normLvl}"]`;
  } else if (intent === 'MEM_FOCUS') {
    const id = (cleanObserved.match(/#([SL]?\d+)/i) || [])[0] || '#S1';
    exactFix = `[MEM_FOCUS ${id}]`;
  }

  return {
    intent,
    observed: cleanObserved.slice(0, 80),
    reason: reason || 'Invalid format',
    exactFix
  };
}



// ========== HALLUCINATION PATTERNS TABLE ==========
// Each entry: { re, group, intent, autofix, extract }
//   re      — regex to detect the hallucinated pattern (run on `normalized`)
//   group   — label for telemetry
//   intent  — canonical tag name (key in SUGGESTED)
//   autofix — if true and extract() returns non-null → execute the action silently
//   extract — fn(match, normalized) → { kind, payload } or null
//             payload shapes per intent:
//               MEM_SAVE  → { kind:'short'|'long', entry:{type,content,priority,why} }
//               MEM_FOCUS → { ids:[], topics:[] }
//               SCHEDULE  → { sec: Number }
//               REFLECT   → {}
//               SEND_MESSAGE → { text: String }
const HALLUCINATION_PATTERNS = [

  // ── GROUP A: pseudo-wrappers [ACTION] / [TOOL] / [COMMAND] etc. ────────────
  {
    re: /\[(ACTION|TOOL|COMMAND|USE|INVOKE|CALL|TAG|EXECUTE|RUN|DO|APPLY)\]\s*:?\s*(MEM_SAVE|MEM_FOCUS|MEM_DELETE|SCHEDULE|REFLECT|SEND_MESSAGE|MEM_ADAPT)\b([^\n\[]*)/gi,
    group: 'A_pseudo_wrapper',
    // intent determined dynamically from capture group
    autofix: true,
    extract(match) {
      const tagName = match[2].toUpperCase();
      const rest    = (match[3] || '').trim();
      if (tagName === 'REFLECT') return { kind: 'REFLECT' };
      if (tagName === 'SCHEDULE') {
        const n = parseInt((rest.match(/\d+/) || [])[0], 10);
        if (n > 0) return { kind: 'SCHEDULE', sec: n };
        return null; // no number → hint
      }
      if (tagName === 'MEM_FOCUS') {
        const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase()
          .replace(/^(\d+)$/, 'S$1'));
        if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
        const topic = rest.replace(/#/g,'').trim();
        if (topic.length > 2) return { kind: 'MEM_FOCUS_TOPIC', topic };
        return null;
      }
      if (tagName === 'MEM_SAVE') {
        // try JSON first
        const jStart = rest.indexOf('{');
        if (jStart >= 0) {
          const p = safeParseJson(rest.substring(jStart));
          if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind: 'short', entry: p.value };
        }
        const clean = cleanProseText(rest);
        if (clean.length > 5) return { kind: 'MEM_SAVE', memKind: 'short', entry: { type:'thought', content: clean, priority:'normal', why:'Auto-repaired from pseudo-wrapper.' } };
        return null;
      }
      if (tagName === 'SEND_MESSAGE') {
        const txt = cleanProseText(rest);
        if (txt.length > 2) return { kind: 'SEND_MESSAGE', text: txt };
        return null;
      }
      if (tagName === 'MCP_LIST' || tagName === 'MCP_READ') {
        const paths = extractPaths(rest);
        if (paths.length > 0) return { kind: tagName, paths };
        return null;
      }
      return null;
    },
    intentFor: (match) => match[2].toUpperCase()
  },

  // ── Dialect Entry 1: **Action:** MESSAGE "..." / SEND "..." / SEND_MESSAGE "..."
  {
    re: /\*\*Action:\*\*\s+(MESSAGE|SEND|SEND_MESSAGE)\s+["']([^"']+)["']/gi,
    group: 'A_pseudo_wrapper',
    autofix: true,
    extract(match) {
      const text = match[2].trim();
      if (text.length > 0) return { kind: 'SEND_MESSAGE', text };
      return null;
    },
    intentFor: () => 'SEND_MESSAGE'
  },

  // ── Dialect Entry 2: **Action:** MEM_SAVE {...}
  {
    re: /\*\*Action:\*\*\s+MEM_SAVE\b([^\n]*)/gi,
    group: 'A_pseudo_wrapper',
    autofix: true,
    extract(match) {
      const rest = (match[1] || '').trim();
      const jStart = rest.indexOf('{');
      if (jStart >= 0) {
        const p = safeParseJson(rest.substring(jStart));
        if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind: 'short', entry: p.value };
      }
      const clean = cleanProseText(rest);
      if (clean.length > 5) {
        return {
          kind: 'MEM_SAVE',
          memKind: 'short',
          entry: { type: 'thought', content: clean, priority: 'normal', why: 'Auto-repaired from dialect.' }
        };
      }
      return null;
    },
    intentFor: () => 'MEM_SAVE'
  },

  // ── Dialect Entry 3: **Action:** MEM_FOCUS #ID or topic
  {
    re: /\*\*Action:\*\*\s+MEM_FOCUS\s+([^\n]+)/gi,
    group: 'A_pseudo_wrapper',
    autofix: true,
    extract(match) {
      const rest = (match[1] || '').trim();
      const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
      if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
      const topic = rest.replace(/#/g, '').replace(/[\[\]]/g, '').trim();
      if (topic.length > 2) return { kind: 'MEM_FOCUS_TOPIC', topic };
      return null;
    },
    intentFor: () => 'MEM_FOCUS'
  },

  // ── GROUP B: colon-separator  [MEM_SAVE]: {...} ─────────────────────────
  {
    re: /\[(MEM_SAVE|MEM_FOCUS|SCHEDULE|SEND_MESSAGE|REFLECT|MEM_ADAPT|MEM_DELETE|MCP_LIST|MCP_READ)\s*(short|long)?\]\s*:\s*([^\n\[]{1,400})/gi,
    group: 'B_colon_sep',
    autofix: true,
    extract(match) {
      const tagName = match[1].toUpperCase();
      const subKind = (match[2] || '').toLowerCase();
      const rest    = (match[3] || '').trim();
      if (tagName === 'SCHEDULE') {
        const n = parseInt((rest.match(/\d+/) || [])[0], 10);
        if (n > 0) return { kind: 'SCHEDULE', sec: n };
        return null;
      }
      if (tagName === 'REFLECT') return { kind: 'REFLECT' };
      if (tagName === 'MEM_FOCUS') {
        const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
        if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
        return null;
      }
      if (tagName === 'MEM_SAVE') {
        const memKind = subKind === 'long' ? 'long' : 'short';
        const jStart = rest.indexOf('{');
        if (jStart >= 0) {
          const p = safeParseJson(rest.substring(jStart));
          if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind, entry: p.value };
        }
        const clean = cleanProseText(rest);
        if (clean.length > 5) return { kind: 'MEM_SAVE', memKind, entry: { type:'thought', content: clean, priority:'normal', why:'Auto-repaired from colon-separator.' } };
        return null;
      }
      if (tagName === 'SEND_MESSAGE') {
        const txt = cleanProseText(rest);
        if (txt.length > 2) return { kind: 'SEND_MESSAGE', text: txt };
        return null;
      }
      if (tagName === 'MCP_LIST' || tagName === 'MCP_READ') {
        const paths = extractPaths(rest);
        if (paths.length > 0) return { kind: tagName, paths };
        return null;
      }
      return null;
    },
    intentFor: (match) => match[1].toUpperCase()
  },

  // ── GROUP C: arrow/equals wrapping  [MEM_SAVE → {...}]  MEM_SAVE -> {...} ─
  {
    re: /\[?(MEM_SAVE|MEM_FOCUS|SCHEDULE|SEND_MESSAGE|REFLECT)\s*(?:→|->|=>|=)\s*([^\n\]]{1,300})\]?/gi,
    group: 'C_arrow_eq',
    autofix: true,
    extract(match) {
      const tagName = match[1].toUpperCase();
      const rest    = (match[2] || '').trim();
      if (tagName === 'SCHEDULE') {
        const n = parseInt((rest.match(/\d+/) || [])[0], 10);
        if (n > 0) return { kind: 'SCHEDULE', sec: n };
        return null;
      }
      if (tagName === 'REFLECT') return { kind: 'REFLECT' };
      if (tagName === 'MEM_FOCUS') {
        const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
        if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
        return null;
      }
      if (tagName === 'MEM_SAVE') {
        const jStart = rest.indexOf('{');
        if (jStart >= 0) {
          const p = safeParseJson(rest.substring(jStart));
          if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind:'short', entry: p.value };
        }
        const clean = cleanProseText(rest);
        if (clean.length > 5) return { kind: 'MEM_SAVE', memKind:'short', entry:{ type:'thought', content:clean, priority:'normal', why:'Auto-repaired from arrow/eq.' } };
        return null;
      }
      if (tagName === 'SEND_MESSAGE') {
        const txt = cleanProseText(rest);
        if (txt.length > 2) return { kind: 'SEND_MESSAGE', text: txt };
        return null;
      }
      return null;
    },
    intentFor: (match) => match[1].toUpperCase()
  },

  // ── GROUP D: empty tag then content on next line ─────────────────────────
  {
    re: /\[(MEM_SAVE|MEM_FOCUS|SCHEDULE|SEND_MESSAGE|REFLECT|MEM_ADAPT)\]\s*\n([^\n\[]{1,300})/gi,
    group: 'D_next_line',
    autofix: true,
    extract(match) {
      const tagName = match[1].toUpperCase();
      const rest    = (match[2] || '').trim();
      if (tagName === 'SCHEDULE') {
        const n = parseInt((rest.match(/\d+/) || [])[0], 10);
        if (n > 0) return { kind: 'SCHEDULE', sec: n };
        return null;
      }
      if (tagName === 'REFLECT') return { kind: 'REFLECT' };
      if (tagName === 'MEM_FOCUS') {
        const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
        if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
        return null;
      }
      if (tagName === 'MEM_SAVE') {
        const jStart = rest.indexOf('{');
        if (jStart >= 0) {
          const p = safeParseJson(rest.substring(jStart));
          if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind:'short', entry: p.value };
        }
        return null; // ambiguous next-line prose → hint
      }
      if (tagName === 'SEND_MESSAGE') {
        const txt = cleanProseText(rest);
        if (txt.length > 2) return { kind: 'SEND_MESSAGE', text: txt };
        return null;
      }
      return null;
    },
    intentFor: (match) => match[1].toUpperCase()
  },

  // ── GROUP E: markdown wrappers  `[TAG] ...`  **[TAG]** ...  > [TAG] ... ──
  {
    re: /(?:`+|\*{1,2}|>\s*)\[?(MEM_SAVE|MEM_FOCUS|SCHEDULE|SEND_MESSAGE|REFLECT|MEM_ADAPT|MEM_DELETE)\s*(short|long)?\]?(?:`*|\*{0,2})\s*([^`\n\[\]]{0,300})/gi,
    group: 'E_markdown',
    autofix: true,
    extract(match) {
      const tagName = match[1].toUpperCase();
      const subKind = (match[2] || '').toLowerCase();
      const rest    = (match[3] || '').trim();
      if (tagName === 'SCHEDULE') {
        const n = parseInt((rest.match(/\d+/) || [])[0], 10);
        if (n > 0) return { kind: 'SCHEDULE', sec: n };
        return null;
      }
      if (tagName === 'REFLECT') return { kind: 'REFLECT' };
      if (tagName === 'MEM_FOCUS') {
        const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
        if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
        return null;
      }
      if (tagName === 'MEM_SAVE') {
        const memKind = subKind === 'long' ? 'long' : 'short';
        const jStart = rest.indexOf('{');
        if (jStart >= 0) {
          const p = safeParseJson(rest.substring(jStart));
          if (p.ok && p.value.content) return { kind: 'MEM_SAVE', memKind, entry: p.value };
        }
        return null;
      }
      if (tagName === 'SEND_MESSAGE') {
        const txt = cleanProseText(rest);
        if (txt.length > 2) return { kind: 'SEND_MESSAGE', text: txt };
        return null;
      }
      return null;
    },
    intentFor: (match) => match[1].toUpperCase()
  },

  // ── GROUP F: unknown/synonym wrappers → always hint ─────────────────────
  { re: /\[(MEMORY_SAVE|SAVE_MEMORY|REMEMBER|NOTE|STORE|MEMORIZE)\b[^\]]*\]/gi, group:'F_synonym', autofix:false, intentFor:() => 'MEM_SAVE' },
  { re: /\[(SEND|MESSAGE|MSG|NOTIFY|REPLY)\b[^\]]*\]/gi,                        group:'F_synonym', autofix:false, intentFor:() => 'SEND_MESSAGE' },
  { re: /\[(WAIT|SLEEP|DELAY|PAUSE|TIMER)\b[^\]]*\]/gi,                         group:'F_synonym', autofix:false, intentFor:() => 'SCHEDULE' },
  { re: /\[(THINK_ABOUT|MEDITATE|SUMMARIZE|COMPRESS|ARCHIVE)\b[^\]]*\]/gi,      group:'F_synonym', autofix:false, intentFor:() => 'REFLECT' },
  { re: /\[(ADAPT|BEHAVIOR|HABIT|SELF_MODIFY)\b[^\]]*\]/gi,                     group:'F_synonym', autofix:false, intentFor:() => 'MEM_ADAPT' },
  { re: /\[(FOCUS)\s+([^\]]+)\]/gi, group:'F_synonym', autofix:true,
    extract(match) {
      const rest = (match[2] || '').trim();
      const ids = [...rest.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase().replace(/^(\d+)$/, 'S$1'));
      if (ids.length > 0) return { kind: 'MEM_FOCUS', ids };
      const topic = cleanProseText(rest);
      if (topic.length > 2) return { kind: 'MEM_FOCUS_TOPIC', topic };
      return null;
    },
    intentFor: () => 'MEM_FOCUS'
  },
  { re: /\[(DELETE|FORGET|REMOVE)\s+[^\]]+\]/gi,  group:'F_synonym', autofix:false, intentFor:() => 'MEM_DELETE' },
];

// ── Helper: apply one resolved extraction to actions ─────────────────────────
function _applyExtraction(resolved, actions, addToolHint, logTelemetry, SUGGESTED, patternGroup, rawMatch) {
  const { kind } = resolved;
  if (kind === 'REFLECT') {
    if (!actions.reflect) {
      actions.reflect = true;
      actions.feedback.executed.push({ intent:'REFLECT', summary:`[parser: understood as REFLECT]` });
      logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind, raw: rawMatch.slice(0,60) });
    }
    return true;
  }
  if (kind === 'SCHEDULE') {
    actions.scheduleSec = resolved.sec;
    actions.scheduleSecParsed = true;
    actions.feedback.executed.push({ intent:'SCHEDULE', summary:`[parser: understood as SCHEDULE ${resolved.sec}s]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind, sec: resolved.sec, raw: rawMatch.slice(0,60) });
    return true;
  }
  if (kind === 'MEM_FOCUS') {
    for (const id of resolved.ids) {
      if (!actions.focusIds.includes(id)) actions.focusIds.push(id);
    }
    actions.feedback.executed.push({ intent:'MEM_FOCUS', summary:`[parser: understood as MEM_FOCUS ${resolved.ids.join(',')}]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind, ids: resolved.ids, raw: rawMatch.slice(0,60) });
    return true;
  }
  if (kind === 'MEM_FOCUS_TOPIC') {
    if (!actions.focusTopics.some(t => t.topic.toLowerCase() === resolved.topic.toLowerCase())) {
      actions.focusTopics.push({ topic: resolved.topic, limit: 3 });
    }
    actions.feedback.executed.push({ intent:'MEM_FOCUS', summary:`[parser: understood as MEM_FOCUS topic "${resolved.topic}"]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind:'MEM_FOCUS_TOPIC', topic: resolved.topic, raw: rawMatch.slice(0,60) });
    return true;
  }
  if (kind === 'MEM_SAVE') {
    const entry = resolved.entry || {};
    if (!entry.type) entry.type = 'thought';
    if (!entry.why) entry.why = 'Auto-repaired from dialect ('+patternGroup+')';
    if (Array.isArray(entry.tags)) entry.tags = entry.tags.join(', ');
    actions.saves.push({ kind: resolved.memKind || 'short', entry });
    actions.feedback.executed.push({ intent:'MEM_SAVE', summary:`[parser: understood as MEM_SAVE ${resolved.memKind||'short'}]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind:'MEM_SAVE', memKind: resolved.memKind, raw: rawMatch.slice(0,60) });
    return true;
  }
  if (kind === 'SEND_MESSAGE') {
    actions.messages.push(resolved.text);
    actions.feedback.executed.push({ intent:'SEND_MESSAGE', summary:`[parser: understood as SEND_MESSAGE]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind:'SEND_MESSAGE', raw: rawMatch.slice(0,60) });
    return true;
  }
  if (kind === 'THINK_LEVEL') {
    actions.thinkLevel = resolved.level;
    actions.feedback.executed.push({ intent:'THINK_LEVEL', summary:`[parser: understood as THINK_LEVEL ${resolved.level.toUpperCase()}]` });
    logTelemetry('parser.hallucination_repaired', { group: patternGroup, kind:'THINK_LEVEL', raw: rawMatch.slice(0,60) });
    return true;
  }
  return false;
}


// ── Main hallucination-scan function (runs on `normalized`, AFTER main pass) ─
function processHallucinationPatterns(normalized, actions, addToolHint, logTelemetry, SUGGESTED) {
  const MAX_HALLUCINATIONS_PER_CYCLE = 3;
  let caught = 0;

  // collect already-covered ranges from commandRanges to avoid double-firing
  // (we cannot reach commandRanges here, so we use a local set of raw matches)
  const alreadyCovered = new Set();

  for (const pat of HALLUCINATION_PATTERNS) {
    if (caught >= MAX_HALLUCINATIONS_PER_CYCLE) break;
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(normalized)) !== null) {
      if (caught >= MAX_HALLUCINATIONS_PER_CYCLE) break;
      const rawMatch = m[0];
      // Skip if this exact span was already processed by another pattern
      const spanKey = `${m.index}:${m.index + rawMatch.length}`;
      if (alreadyCovered.has(spanKey)) continue;
      alreadyCovered.add(spanKey);

      const intent = pat.intentFor(m);
      const sugKey = {
        'MEM_SAVE': 'MEM_SAVE', 'MEM_FOCUS': 'MEM_FOCUS', 'MEM_DELETE': 'MEM_DELETE',
        'SCHEDULE': 'SCHEDULE', 'REFLECT': 'REFLECT', 'SEND_MESSAGE': 'SEND_MESSAGE',
        'MEM_ADAPT': 'MEM_ADAPT', 'MEM_ADAPT_CHALLENGE': 'MEM_ADAPT_CHALLENGE'
      }[intent] || 'MEM_SAVE';
      const suggested = SUGGESTED[sugKey] || `[${intent}]`;

      let repaired = false;
      if (pat.autofix && typeof pat.extract === 'function') {
        try {
          const resolved = pat.extract(m);
          if (resolved) {
            repaired = _applyExtraction(resolved, actions, addToolHint, logTelemetry, SUGGESTED, pat.group, rawMatch);
            if (repaired) {
              actions.repairedCount = (actions.repairedCount || 0) + 1;
            }
          }
        } catch (err) {
          // extraction error → fall through to hint
          logTelemetry('parser.hallucination_extract_error', { group: pat.group, err: err.message });
        }
      }

      if (!repaired) {
        // Inject a one-time, precise instruction for the next cycle
        const explanation = `Your tag looked like \"${rawMatch.slice(0,60).replace(/\n/g,' ')}\" but the parser could not execute it.`
          + ` Use the exact syntax:\n  ${suggested}`;
        addToolHint(intent, rawMatch.slice(0,60), suggested, explanation);
        logTelemetry('parser.hallucination_hint', { group: pat.group, intent, raw: rawMatch.slice(0,60) });
      }

      caught++;
    }
  }
}

function parseOutput(text) {
  const normalizedFull = normalizeModelOutput(text);
  const normalized = normalizedFull;

  const actions = {
    saves: [],
    deletes: [],
    adapts: [],
    adaptChallenges: [],
    adaptWeakens: [],
    focusIds: [],
    focusTopics: [],
    scheduleSec: config.defaultIntervalSec,
    scheduleSecParsed: false,
    reflect: false,
    messages: [],
    userProfiles: [],
    helpRequests: [],
    mcpLists: [],
    mcpReads: [],
    dynamicSkills: [],
    thought: '',
    selfQuestion: null,
    topicScore: null,
    resolveTopic: null,
    thinkLevel: null,
    repairedCount: 0,
    parseErrorCount: 0,

    feedback: {
      executed: [],
      failed: [],
      blocked: [],
      hints: []
    }
  };


  const addHelp = (tag) => {
    if (!actions.helpRequests.includes(tag)) actions.helpRequests.push(tag);
  };

  const addFailed = (intent, observed, reason, suggested) => {
    const hint = makeSurgicalHint(intent, observed, reason);
    actions.feedback.failed.push({
      intent,
      observed: hint.observed,
      reason: hint.reason,
      exactFix: hint.exactFix,
      suggested: suggested || hint.exactFix
    });
    logTelemetry('parser.malformed_intent', { intent, observed: hint.observed, reason });
  };

  const addToolHint = (intent, observed, suggested, explanation) => {
    actions.feedback.hints.push({ intent, observed: observed.trim(), suggested, explanation });
    logTelemetry('parser.hint_created', { intent });
  };

  const commandRanges = [];
  const coreTags = ['MEM_SAVE','MEM_DELETE','MEM_FOCUS','MEM_ADAPT_CHALLENGE','MEM_ADAPT_WEAKEN','MEM_ADAPT','SCHEDULE','REFLECT','SEND_MESSAGE','HELP_ACTION','HELP_ACTIONS','MCP_LIST','MCP_READ','THINK_LEVEL','THINK_BUDGET','REASONING_EFFORT','USER_PROFILE'];
  const allAliases = Object.keys(TAG_ALIASES);
  const allTags = Array.from(new Set([...coreTags, ...allAliases, ...dynamicTags]));
  const RE_ANY_TAG = new RegExp(`\\[(${allTags.join('|')})(?=[\\s\\]:]|$)([^\\]]*)\\]`, 'giu');



  let match;
  while ((match = RE_ANY_TAG.exec(normalized)) !== null) {
    const startIdx = match.index;
    const tagLen = match[0].length;
    const closingBracketIndex = startIdx + tagLen;

    const rawIntent = match[1].toUpperCase();
    const intent = TAG_ALIASES[rawIntent] || rawIntent;
    if (rawIntent !== intent) {
      logTelemetry('parser.alias_resolved', { from: rawIntent, to: intent });
    }
    const bracketParams = match[2] ? match[2].trim() : '';

    const afterTextRaw = normalized.substring(closingBracketIndex);
    const proseFollowing = extractFollowingContent(afterTextRaw).trim();

    // Guard: indexOf returns -1 if proseFollowing is empty string or not found
    const proseOffset = proseFollowing.length > 0 ? afterTextRaw.indexOf(proseFollowing) : 0;
    const endIdx = closingBracketIndex + Math.max(proseOffset, 0) + proseFollowing.length;
    commandRanges.push({ start: startIdx, end: endIdx });

    const combinedArgs = (bracketParams + " " + proseFollowing).trim();
    const observed = `${match[0]} ${proseFollowing.slice(0, 50)}`;

    if (intent === 'MEM_SAVE') {
      const isLong = /\b(long|инсайт|архив|опыт|insight|archive)\b/i.test(bracketParams + ' ' + proseFollowing);
      const kind = isLong ? 'long' : 'short';

      
      let parsed = { ok: false };
      const startBrace = combinedArgs.indexOf('{');
      if (startBrace >= 0) {
        parsed = safeParseJson(combinedArgs.substring(startBrace));
      }

      const hasIdMistake = /#\d+/.test(combinedArgs) && !parsed.ok;
      
      if (hasIdMistake) {
        const idNum = (combinedArgs.match(/#(\d+)/) || [])[1];
        addFailed(
          'MEM_SAVE',
          observed,
          'id_not_valid_for_save',
          `[MEM_SAVE #ID] is not valid syntax.\nTo SAVE new data use: ${SUGGESTED.MEM_SAVE}\nTo FOCUS existing record: [MEM_FOCUS #${idNum}]`
        );
        addHelp('MEM_SAVE');
      } else if (parsed.ok) {
        const obj = parsed.value;
        if (!obj.type || !obj.content) {
          addFailed('MEM_SAVE', observed, 'missing_required_fields', SUGGESTED.MEM_SAVE);
          addHelp('MEM_SAVE');
          actions.parseErrorCount++;
        } else {
          if (Array.isArray(obj.tags)) {
            obj.tags = obj.tags.join(', ');
          } else if (typeof obj.tags === 'string') {
            obj.tags = obj.tags.split(',').map(s => s.trim()).join(', ');
          }
          if (!obj.why) {
            obj.why = "Agent expressed stable save intent.";
          }
          actions.saves.push({ kind, entry: obj });
          logTelemetry('parser.valid_action', { intent: 'MEM_SAVE', kind });
        }
      } else {
        const cleanedContent = cleanProseText(combinedArgs.replace(/\b(short|long)\b/gi, ''));
        if (cleanedContent.length > 0) {
          const obj = {
            type: kind === 'long' ? 'insight' : 'thought',
            content: cleanedContent,
            priority: 'normal',
            why: 'Automatically parsed from prose/inline tag.'
          };
          actions.saves.push({ kind, entry: obj });
          logTelemetry('parser.valid_action', { intent: 'MEM_SAVE', kind, autoWrapped: true });
        } else {
          addFailed('MEM_SAVE', observed, 'empty_tag', SUGGESTED.MEM_SAVE);
          addHelp('MEM_SAVE');
        }
      }
    }

    else if (intent === 'MEM_DELETE') {
      const parsedIds = [...combinedArgs.matchAll(/#?([SL]?\d+)\b/gi)].map(m => {
        const raw = m[1].toUpperCase();
        const itemKind = raw.startsWith('L') ? 'long' : (raw.startsWith('S') ? 'short' : undefined);
        const itemId = Number.parseInt(raw.replace(/[SL]/g, ''), 10);
        return { kind: itemKind, id: itemId };
      });
      const kind = combinedArgs.includes('long') ? 'long' : (combinedArgs.includes('short') ? 'short' : undefined);
      if (parsedIds.length > 0) {
        for (const item of parsedIds) {
          actions.deletes.push({ kind: item.kind || kind, id: item.id });
          logTelemetry('parser.valid_action', { intent: 'MEM_DELETE', id: item.id });
        }
      } else {
        addFailed('MEM_DELETE', observed, 'no_valid_id', SUGGESTED.MEM_DELETE);
        addHelp('MEM_DELETE');
      }
    }

    else if (intent === 'MEM_FOCUS') {
      let acted = false;
      
      let parsed = { ok: false };
      const startBrace = combinedArgs.indexOf('{');
      if (startBrace >= 0) {
        parsed = safeParseJson(combinedArgs.substring(startBrace));
      }

      if (parsed.ok && parsed.value.topic) {
        actions.focusTopics.push({ topic: parsed.value.topic, limit: parsed.value.limit || 3 });
        acted = true;
        logTelemetry('parser.valid_action', { intent: 'MEM_FOCUS', topic: parsed.value.topic });
      } else {
        const parsedIds = [...combinedArgs.matchAll(/#?([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase());
        if (parsedIds.length > 0) {
          const formattedIds = parsedIds.map(raw => {
            if (/^\d+$/.test(raw)) return 'S' + raw;
            return raw;
          });
          actions.focusIds.push(...formattedIds);
          acted = true;
          logTelemetry('parser.valid_action', { intent: 'MEM_FOCUS', ids: formattedIds });
        } else {
          const cleanedTopic = cleanProseText(combinedArgs.replace(/^[#\s]+/, ''));
          if (cleanedTopic.length > 0) {
            actions.focusTopics.push({ topic: cleanedTopic, limit: 3 });
            acted = true;
            logTelemetry('parser.valid_action', { intent: 'MEM_FOCUS', topic: cleanedTopic, autoTopic: true });
            addToolHint('MEM_FOCUS', observed, SUGGESTED.MEM_FOCUS,
              `Focused on topic "${cleanedTopic}". If you meant to focus on specific memory record IDs, use: [MEM_FOCUS #ID]`);
          }

        }
      }

      if (!acted) {
        addFailed('MEM_FOCUS', observed, 'empty_tag', SUGGESTED.MEM_FOCUS);
        addHelp('MEM_FOCUS');
      }
    }

    else if (intent === 'MEM_ADAPT') {
      const parsed = safeParseJson(combinedArgs);
      if (parsed.ok && parsed.value.type && parsed.value.target && parsed.value.rule) {
        actions.adapts.push(parsed.value);
        logTelemetry('parser.valid_action', { intent: 'MEM_ADAPT' });
      } else {
        addFailed('MEM_ADAPT', observed, 'malformed_tag', SUGGESTED.MEM_ADAPT);
        addHelp('MEM_ADAPT');
      }
    }

    else if (intent === 'MEM_ADAPT_CHALLENGE') {
      const parsed = safeParseJson(combinedArgs);
      if (parsed.ok && parsed.value.id) {
        actions.adaptChallenges.push(parsed.value);
        logTelemetry('parser.valid_action', { intent: 'MEM_ADAPT_CHALLENGE' });
      } else {
        addFailed('MEM_ADAPT_CHALLENGE', observed, 'malformed_tag', SUGGESTED.MEM_ADAPT_CHALLENGE);
        addHelp('MEM_ADAPT_CHALLENGE');
      }
    }

    else if (intent === 'MEM_ADAPT_WEAKEN') {
      const parsed = safeParseJson(combinedArgs);
      if (parsed.ok && parsed.value.id && typeof parsed.value.amount === 'number') {
        actions.adaptWeakens.push(parsed.value);
        logTelemetry('parser.valid_action', { intent: 'MEM_ADAPT_WEAKEN' });
      } else {
        addFailed('MEM_ADAPT_WEAKEN', observed, 'malformed_tag', SUGGESTED.MEM_ADAPT_WEAKEN);
        addHelp('MEM_ADAPT_WEAKEN');
      }
    }

    else if (intent === 'SCHEDULE') {
      const nums = [...combinedArgs.matchAll(/\d+/g)].map(m => Number.parseInt(m[0], 10));
      if (nums.length > 0) {
        // Do NOT clamp here — clamping is exclusively the scheduler's responsibility (SSOT: clampSchedule)
        actions.scheduleSec = nums[0];
        actions.scheduleSecParsed = true;
        logTelemetry('parser.valid_action', { intent: 'SCHEDULE', seconds: actions.scheduleSec });
      } else {
        addFailed('SCHEDULE', observed, 'malformed_tag', SUGGESTED.SCHEDULE);
        addHelp('SCHEDULE');
      }
    }

    else if (intent === 'REFLECT') {
      actions.reflect = true;
      logTelemetry('parser.valid_action', { intent: 'REFLECT' });
    }

    else if (intent === 'SEND_MESSAGE') {
      let msgText = '';
      const startBrace = combinedArgs.indexOf('{');
      if (startBrace >= 0) {
        const parsed = safeParseJson(combinedArgs.substring(startBrace));
        if (parsed.ok && parsed.value.text) {
          msgText = parsed.value.text;
        }
      }
      
      if (!msgText) {
        msgText = cleanProseText(combinedArgs);
      }

      if (msgText) {
        actions.messages.push(msgText);
        logTelemetry('parser.valid_action', { intent: 'SEND_MESSAGE' });
      } else {
        addFailed('SEND_MESSAGE', observed, 'empty_tag', SUGGESTED.SEND_MESSAGE);
        addHelp('SEND_MESSAGE');
      }
    }
    
    else if (intent === 'MCP_LIST') {
      const paths = extractPaths(combinedArgs);
      if (paths.length > 0) {
        actions.mcpLists.push(...paths);
        paths.forEach(p => logTelemetry('parser.valid_action', { intent: 'MCP_LIST', path: p }));
      } else {
        addFailed('MCP_LIST', observed, 'missing_path', '[MCP_LIST "directory_path"]');
      }
    }

    else if (intent === 'MCP_READ') {
      const paths = extractPaths(combinedArgs);
      if (paths.length > 0) {
        actions.mcpReads.push(...paths);
        paths.forEach(p => logTelemetry('parser.valid_action', { intent: 'MCP_READ', path: p }));
      } else {
        addFailed('MCP_READ', observed, 'missing_path', '[MCP_READ "file_name.txt"]');
      }
    }

    else if (intent === 'HELP_ACTIONS') {
      actions.helpRequests.push("ALL");
      logTelemetry('parser.help_requested', { scope: 'ALL' });
    }

    else if (intent === 'HELP_ACTION') {
      const wordMatch = combinedArgs.match(/"([^"]+)"|'([^']+)'|(\b\w+\b)/);
      const actionName = wordMatch ? (wordMatch[1] || wordMatch[2] || wordMatch[3]) : '';
      if (actionName) {
        addHelp(actionName.trim().toUpperCase());
        logTelemetry('parser.help_requested', { scope: actionName.trim().toUpperCase() });
      }
    }

    else if (intent === 'THINK_LEVEL') {
      const match = combinedArgs.match(/(high|medium|light|low|глубоко|высокий|быстро|низкий|средне|средний)/i);
      if (match) {
        let rawLvl = match[1].toLowerCase();
        let lvl = 'medium';
        if (['high', 'глубоко', 'высокий'].includes(rawLvl)) lvl = 'high';
        else if (['light', 'low', 'быстро', 'низкий'].includes(rawLvl)) lvl = 'light';
        else lvl = 'medium';

        actions.thinkLevel = lvl;
        actions.feedback.executed.push({ intent: 'THINK_LEVEL', summary: `Reasoning effort set to ${lvl.toUpperCase()}` });
        logTelemetry('parser.valid_action', { intent: 'THINK_LEVEL', level: lvl });
      } else {
        addFailed('THINK_LEVEL', observed, 'invalid_level', SUGGESTED.THINK_LEVEL);
        addHelp('THINK_LEVEL');
      }
    }

    
    else if (intent === 'USER_PROFILE') {
      const userMatch = combinedArgs.match(/@([a-zA-Z0-9_]{3,})/);
      const username = userMatch ? userMatch[1] : null;

      let parsed = { ok: false };
      const startBrace = combinedArgs.indexOf('{');
      if (startBrace >= 0) {
        parsed = lenientJsonParse(combinedArgs.substring(startBrace));
      }

      if (username && parsed.ok) {
        actions.userProfiles.push({
          username,
          preferences: parsed.value.preferences || '',
          notes: parsed.value.notes || parsed.value.content || ''
        });
        actions.feedback.executed.push({ intent: 'USER_PROFILE', summary: `Updated dossier for @${username}` });
        logTelemetry('parser.valid_action', { intent: 'USER_PROFILE', username });
      } else {
        addFailed('USER_PROFILE', observed, 'missing_username_or_json', SUGGESTED.USER_PROFILE);
        addHelp('USER_PROFILE');
      }
    }

    else {


      if (dynamicTags.includes(intent)) {
        const startBrace = combinedArgs.indexOf('{');
        let payload = {};
        let parseOk = false;
        if (startBrace >= 0) {
          const parsed = safeParseJson(combinedArgs.substring(startBrace));
          if (parsed.ok) {
            payload = parsed.value;
            parseOk = true;
          }
        }
        if (parseOk) {
          actions.dynamicSkills.push({ intent, payload });
          logTelemetry('parser.valid_action', { intent });
        } else {
          addFailed(intent, observed, 'Invalid JSON payload', `[${intent}] {"key": "value"}`);
          actions.parseErrorCount++;
        }
      }
    }
  }

  commandRanges.sort((a, b) => b.start - a.start);
  let clearText = normalized;
  for (const range of commandRanges) {
    clearText = clearText.substring(0, range.start) + clearText.substring(range.end);
  }
  clearText = clearText.replace(/\s+/g, ' ').trim();

  // Extract SELF_QUESTION, TOPIC_SCORE, and RESOLVE_TOPIC
  actions.selfQuestion = null;
  actions.topicScore = null;
  actions.resolveTopic = null;

  const scoreMatch = normalized.match(/\[?(?:TOPIC_SCORE|SCORE_TOPIC|RATE_TOPIC|INTEREST|TOPIC_RATING)[:\s]+(\d+)/i) || 
                     normalized.match(/(?:topic\s*score|interest\s*score|topic\s*rating)[:\s]+(\d+)/i);
  if (scoreMatch) {
    actions.topicScore = Math.min(10, Math.max(1, parseInt(scoreMatch[1], 10)));
  }

  const qMatch = normalized.match(/\[(?:SELF_QUESTION|QUESTION|ASK_SELF|WONDER|INQUIRE|CURIOSITY)\s+(["'])(.*?)\1\]/i) || 
                 normalized.match(/\[(?:SELF_QUESTION|QUESTION|ASK_SELF|WONDER|INQUIRE|CURIOSITY)\]\s*(["'])(.*?)\1/i) ||
                 normalized.match(/(?:SELF_QUESTION|QUESTION|ASK_SELF|WONDER):\s*(["']?)([^"\n\r\[]+)\1/i);
  if (qMatch) {
    actions.selfQuestion = (qMatch[2] || qMatch[1]).trim();
  }

  const resolveMatch = normalized.match(/\[(?:RESOLVE_TOPIC|TOPIC_DONE|RESOLVE|CLOSE_TOPIC)\s*(?:(["'])(.*?)\1|([^\]]*))\]/i);
  if (resolveMatch) {
    actions.resolveTopic = (resolveMatch[2] || resolveMatch[3] || 'Topic resolved').trim();
  }



  // ========== HALLUCINATION PATTERN DETECTOR ==========
  // Runs on `normalized` (original text before tag-stripping) so it sees everything
  // that the main RE_ANY_TAG pass already handled, but only fires on spans NOT already
  // captured (pattern logic skips already-processed ranges via alreadyCovered set).
  // Limit: max 3 hallucinations per cycle to avoid prompt spam.
  processHallucinationPatterns(normalized, actions, addToolHint, logTelemetry, SUGGESTED);

  // ========== HASHTAG PARSING & PROSE DETECTORS ==========
  // 1. Numeric hashtags (#123 or #S123 or #L123) in reasoning -> auto-focus by ID
  const numericHashtags = [...clearText.matchAll(/#([SL]?\d+)\b/gi)].map(m => m[1].toUpperCase());
  for (const raw of numericHashtags) {
    const formatted = /^\d+$/.test(raw) ? 'S' + raw : raw;
    if (!actions.focusIds.includes(formatted)) {
      actions.focusIds.push(formatted);
    }
  }

  // 2. Conceptual hashtags (#topic) in reasoning -> auto-search by keyword
  const conceptualHashtags = [...clearText.matchAll(/#([a-zA-Zа-яА-ЯёЁ_]{2,})\b/g)].map(m => m[1]);
  for (const topic of conceptualHashtags) {
    if (['MEM_SAVE', 'MEM_FOCUS', 'MEM_DELETE', 'MEM_ADAPT', 'SCHEDULE', 'REFLECT', 'SEND_MESSAGE'].includes(topic.toUpperCase())) {
      continue;
    }
    const topicLower = topic.toLowerCase();
    if (!actions.focusTopics.some(t => t.topic.toLowerCase() === topicLower)) {
      actions.focusTopics.push({ topic: topic, limit: 5 });
    }
  }

  // 3. Prose "focus" or "focused" detection -> auto-inject syntax hint
  const hasFocusWords = /\b(focus|focused)\b/i.test(clearText);
  if (hasFocusWords && actions.focusIds.length === 0 && actions.focusTopics.length === 0) {
    actions.feedback.hints.push({
      intent: 'MEM_FOCUS',
      observed: 'Word "focus" in prose',
      suggested: '[MEM_FOCUS #ID] (focus ID) or [MEM_FOCUS topic] (search)',
      explanation: 'You mentioned "focus" or "focused" in your thoughts. You can use hashtags like #83 to focus a memory by ID, or #topic to search all memory.'
    });
  }

  // ========== Weak Intent Detector (TOOL HINT) ==========
  const weakDetector = [
    { regex: /(?:\bI should|\bmight be worth)\s*(?:maybe\s*)?(?:save|remember)(?:ing)?\b/i, intent: 'MEM_SAVE', sug: SUGGESTED.MEM_SAVE },
    { regex: /\bfocus on #(\d+)\b/i, intent: 'MEM_FOCUS', sug: '[MEM_FOCUS #$1]' },
    { regex: /\breview #(\d+)\b/i, intent: 'MEM_FOCUS', sug: '[MEM_FOCUS #$1]' },
    { regex: /\b(think about later|reflect on this)\b/i, intent: 'REFLECT', sug: SUGGESTED.REFLECT },
    { regex: /\b(tell user|write to user|message the user)\b/i, intent: 'SEND_MESSAGE', sug: SUGGESTED.SEND_MESSAGE },
    { regex: /\b(change my habit|change how I think|suppress this tendency|I want to adapt|I should adapt)\b/i, intent: 'MEM_ADAPT', sug: SUGGESTED.MEM_ADAPT },
    { regex: /\b(I want to schedule|I need to schedule)\b/i, intent: 'SCHEDULE', sug: SUGGESTED.SCHEDULE }
  ];

  const hasAnyAction = actions.saves.length > 0 || actions.deletes.length > 0 ||
    actions.adapts.length > 0 || actions.messages.length > 0 ||
    actions.focusIds.length > 0 || actions.focusTopics.length > 0 ||
    actions.reflect || actions.scheduleSec !== config.defaultIntervalSec ||
    actions.feedback.failed.length > 0;

  if (!hasAnyAction) {
    for (const w of weakDetector) {
      const wm = clearText.match(w.regex);
      if (wm) {
        let suggested = w.sug;
        if (wm[1]) suggested = suggested.replace('$1', wm[1]);
        addToolHint(w.intent, `Prose: "${wm[0]}"`, suggested,
          `You seemed to consider using ${w.intent} but no explicit action was attempted.`);
        break; // Only one tool hint per cycle
      }
    }
  }

  // ========== NO-SILENT MEM TAGS INVARIANT ==========
  const parsedMemCount = actions.saves.length + actions.deletes.length +
    actions.adapts.length + actions.adaptChallenges.length + actions.adaptWeakens.length +
    actions.focusIds.length + actions.focusTopics.length;
  const hasMemTagInText = /\[MEM_/.test(normalized);
  if (hasMemTagInText && parsedMemCount === 0 && actions.feedback.failed.length === 0) {
    const firstTagMatch = normalized.match(/\[MEM_[^\]]{0,40}\]/) || [];
    const observed = firstTagMatch[0] || '[MEM_???]';
    addFailed(
      'MEM_?',
      observed,
      'tag_not_parsed',
      'Detected MEM tags but none were parsed. Use canonical syntax:\n' +
      `${SUGGESTED.MEM_SAVE}\n${SUGGESTED.MEM_FOCUS}\n${SUGGESTED.MEM_DELETE}`
    );
    addHelp('MEM_SAVE');
    logTelemetry('parser.silent_mem_detected', { observed: observed.slice(0, 60) });
  }

  // Очистка мыслей от галлюцинированных секций промпта
  const promptSections = [
    /\[ACTION FEEDBACK\][\s\S]*/i,
    /\[TOOL HINT\][\s\S]*/i,
    /\[CURRENT TIME\][\s\S]*/i,
    /\[WORKING CONTEXT\][\s\S]*/i,
    /\[SHORT_MEM\][\s\S]*/i,
    /\[LONG_MEM\][\s\S]*/i,
    /\[BIOLOGICAL ADAPTATIONS\][\s\S]*/i,
    /\[MESSAGES FROM USER\][\s\S]*/i
  ];
  for (const rx of promptSections) {
    clearText = clearText.replace(rx, '');
  }
  clearText = clearText.replace(/\s+/g, ' ').trim();

  actions.thought = clearText;
  return actions;
}

module.exports = {
  parseOutput,
  logTelemetry
};
