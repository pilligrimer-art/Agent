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
};

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
    re: /\[(MEM_SAVE|MEM_FOCUS|SCHEDULE|SEND_MESSAGE|REFLECT|MEM_ADAPT|MEM_DELETE)\s*(short|long)?\]\s*:\s*([^\n\[]{1,400})/gi,
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
    parseErrorCount: 0,
    repairedCount: 0,
    scheduleSecParsed: false,
    dynamicSkills: [],
    feedback: {
      executed: [],
      failed: [],
      hints: []
    }
  };

  const addHelp = (tag) => {
    if (!actions.helpRequests.includes(tag)) actions.helpRequests.push(tag);
  };

  const addFailed = (intent, observed, reason, suggested) => {
    actions.feedback.failed.push({ intent, observed: observed.trim(), reason, suggested });
    logTelemetry('parser.malformed_intent', { intent, observed: observed.trim().slice(0, 60), reason });
  };

  const addToolHint = (intent, observed, suggested, explanation) => {
    actions.feedback.hints.push({ intent, observed: observed.trim(), suggested, explanation });
    logTelemetry('parser.hint_created', { intent });
  };

  const commandRanges = [];
  const coreTags = ['MEM_SAVE','MEM_DELETE','MEM_FOCUS','MEM_ADAPT_CHALLENGE','MEM_ADAPT_WEAKEN','MEM_ADAPT','SCHEDULE','REFLECT','SEND_MESSAGE','HELP_ACTION','HELP_ACTIONS'];
  const allTags = Array.from(new Set([...coreTags, ...dynamicTags]));
  const RE_ANY_TAG = new RegExp(`\\[(${allTags.join('|')})\\b([^\\]]*)\\]`, 'gi');

  let match;
  while ((match = RE_ANY_TAG.exec(normalized)) !== null) {
    const startIdx = match.index;
    const tagLen = match[0].length;
    const closingBracketIndex = startIdx + tagLen;

    const intent = match[1].toUpperCase();
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
      const kind = (bracketParams.includes('long') || proseFollowing.includes('long')) ? 'long' : 'short';
      
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
          const cleanedTopic = cleanProseText(combinedArgs);
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
