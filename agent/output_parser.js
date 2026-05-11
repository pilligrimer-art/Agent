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
const RE_SCHEDULE_SMART  = /^\s*\[SCHEDULE(?:\]\s*|\s+)([^\]\n]*)/m;
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
        if (char === '\\\\' && !escape) escape = true;
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

function createParserHint(intent, observed, suggested, explanation) {
  return {
    kind: "parser_hint",
    intent,
    observed: observed.trim(),
    suggested,
    explanation,
    expires_in_cycles: 1
  };
}

function extractProse(raw) {
  let prose = raw.trim().replace(/^[–-]\s*/, '').trim();
  const quoteMatch = prose.match(/^"([\s\S]+)"$/);
  if (quoteMatch) return quoteMatch[1].trim();
  return prose;
}

/**
 * Парсер вывода агента (С мягким парсингом).
 */
function parseOutput(text) {
  const normalizedFull = normalizeModelOutput(text);
  const lines = normalizedFull.split('\n');
  
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
    parserHints: []
  };

  const clearText = lines
    .filter(line => !/^\s*\[(MEM_SAVE|MEM_DELETE|MEM_FOCUS|MEM_ADAPT|MEM_ADAPT_CHALLENGE|MEM_ADAPT_WEAKEN|SCHEDULE|REFLECT|SEND_MESSAGE|HELP_ACTIONS|HELP_ACTION)\b/.test(line))
    .join('\n')
    .trim();

  // Non-interference mode detection
  const isReflectTag = /^\s*\[REFLECT\]/m.test(normalized);
  const isDeepReflection = clearText.length > 500 || isReflectTag;

  let match;
  
  const addHelp = (tag) => {
    if (!actions.helpRequests.includes(tag)) actions.helpRequests.push(tag);
  };
  
  const addHint = (intent, obs, sug, expl, isMinor = false) => {
    if (isDeepReflection && isMinor) return; // Non-interference mode
    if (actions.parserHints.length < 2 && !actions.parserHints.some(h => h.intent === intent)) {
      actions.parserHints.push(createParserHint(intent, obs, sug, expl));
    }
  };

  // MEM_SAVE
  RE_MEM_SAVE.lastIndex = 0;
  while ((match = RE_MEM_SAVE.exec(normalized)) !== null) {
    const kind = match[1];
    const rawJson = match[2].trim();
    const parsed = safeParseJson(rawJson);
    const observedTag = `[MEM_SAVE${kind ? ' ' + kind : ''}]` + (rawJson ? ` - ${rawJson.slice(0, 30)}...` : '');
    
    if (parsed.ok) {
      const obj = parsed.value;
      if (!obj.type || !obj.content) {
        // Missing fields? Soft parse it as content
        actions.saves.push({ kind: kind || 'short', entry: { type: 'thought', content: JSON.stringify(obj), priority: 'normal', why: "Soft parsed incomplete JSON." } });
        addHint('MEM_SAVE', observedTag, `[MEM_SAVE short] {"type":"thought","content":"...","priority":"normal","why":"..."}`, "Action successful. Missing fields filled automatically.", true);
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
      if (prose.length > 0 && !prose.startsWith('{')) {
        if (rawJson.match(/^#\d+/)) {
          const ids = [...rawJson.matchAll(/\d+/g)].map(m => Number.parseInt(m[0], 10));
          actions.focusIds.push(...ids);
          addHint('MEM_FOCUS', observedTag, `[MEM_FOCUS ${ids.map(id => '#' + id).join(' ')}]`, "Action successful. Use MEM_FOCUS to bring existing records into context instead of MEM_SAVE.", true);
        } else {
          actions.saves.push({ kind: kind || 'short', entry: { type: 'thought', content: prose, priority: 'normal', why: "Agent expressed intent via prose." } });
          addHint('MEM_SAVE', observedTag, `[MEM_SAVE short] {"type":"thought","content":"...","priority":"normal","why":"..."}`, "Action successful. To add specific tags or priority, use the JSON format.", true);
        }
      } else if (prose.length > 0) {
        // Graceful fallback for broken JSON
        const raw = extractProse(rawJson);
        actions.saves.push({ kind: kind || 'short', entry: { type: 'thought', content: raw, priority: 'normal', why: "Saved as raw text due to JSON error." } });
        addHint('MEM_SAVE', observedTag, `[MEM_SAVE short] {"type":"thought","content":"..."}`, "JSON error (e.g. unescaped quotes). Text saved as raw string to prevent data loss.", false);
      } else {
        addHint('MEM_SAVE', `[MEM_SAVE]`, `[MEM_SAVE short] {"type":"thought","content":"..."}`, "Empty save tag detected.", false);
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
    // Smart extraction: find any digits
    const ids = [...combined.matchAll(/\d+/g)].map(m => Number.parseInt(m[0], 10));
    const observedTag = `[MEM_DELETE${insideArgs}]` + (trailingArgs ? ` ${trailingArgs.slice(0, 30)}` : '');
    
    if (ids.length > 0) {
      for (const id of ids) {
        if (Number.isFinite(id)) {
          actions.deletes.push({ kind, id });
        }
      }
    } else {
      addHint('MEM_DELETE', observedTag, `[MEM_DELETE short #ID]`, "You used MEM_DELETE without a valid ID. Specify the ID with a hash, e.g., #61.", false);
      addHelp('MEM_DELETE');
    }
  }

  // MEM_FOCUS
  RE_MEM_FOCUS.lastIndex = 0;
  while ((match = RE_MEM_FOCUS.exec(normalized)) !== null) {
    const rawIds = match[1];
    const rawJson = match[2].trim();
    const observedTag = `[MEM_FOCUS${rawIds}]` + (rawJson ? ` ${rawJson.slice(0, 30)}...` : '');
    
    let acted = false;
    if (rawIds) {
      // Smart extraction
      const ids = [...rawIds.matchAll(/\d+/g)].map(m => Number.parseInt(m[0], 10));
      if (ids.length > 0) {
        actions.focusIds.push(...ids);
        acted = true;
      }
    }
    
    if (rawJson) {
      const parsed = safeParseJson(rawJson);
      if (parsed.ok && parsed.value.topic) {
        actions.focusTopics.push({ topic: parsed.value.topic, limit: parsed.value.limit || 3 });
        acted = true;
      } else {
        const prose = extractProse(rawJson);
        if (prose.length > 3 && !prose.startsWith('{')) {
           actions.focusTopics.push({ topic: prose, limit: 3 });
           addHint('MEM_FOCUS', observedTag, `[MEM_FOCUS] {"topic":"${prose}","limit":3}`, "Action successful. You used prose instead of JSON.", true);
           acted = true;
        } else if (prose.startsWith('{')) {
          // Graceful fallback
          const raw = extractProse(rawJson);
          actions.focusTopics.push({ topic: raw, limit: 3 });
          addHint('MEM_FOCUS', observedTag, `[MEM_FOCUS] {"topic":"keyword"}`, "JSON error. Focus was approximated.", false);
          acted = true;
        }
      }
    }
    
    if (!acted && !rawJson && !rawIds) {
       addHint('MEM_FOCUS', observedTag, `[MEM_FOCUS #ID]`, "Empty MEM_FOCUS tag. Use IDs or a topic JSON.", false);
       addHelp('MEM_FOCUS');
    }
  }

  // MEM_ADAPT
  RE_MEM_ADAPT.lastIndex = 0;
  while ((match = RE_MEM_ADAPT.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    const observedTag = `[MEM_ADAPT] ${rawJson.slice(0, 30)}`;
    if (parsed.ok && parsed.value.type && parsed.value.target && parsed.value.rule) {
      actions.adapts.push(parsed.value);
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 0 && !prose.startsWith('{')) {
         actions.adapts.push({ type: "strengthen", target: "self", rule: prose, why: "Soft parsed from prose." });
         addHint('MEM_ADAPT', observedTag, `[MEM_ADAPT] {"type":"strengthen","target":"...","rule":"...","why":"..."}`, "Action successful. For strict control over adaptations, use JSON.", true);
      } else if (prose.length > 0) {
         actions.adapts.push({ type: "strengthen", target: "self", rule: prose, why: "Fallback from broken JSON." });
         addHint('MEM_ADAPT', observedTag, `[MEM_ADAPT] {"type":"strengthen","target":"...","rule":"...","why":"..."}`, "JSON error. Saved adaptation as a general rule.", false);
      } else {
         addHint('MEM_ADAPT', observedTag, `[MEM_ADAPT] {"type":"strengthen","target":"...","rule":"...","why":"..."}`, "Empty MEM_ADAPT tag.", false);
      }
    }
  }

  // MEM_ADAPT_CHALLENGE
  RE_MEM_ADAPT_CHALLENGE.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_CHALLENGE.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    const observedTag = `[MEM_ADAPT_CHALLENGE] ${rawJson.slice(0, 30)}`;
    if (parsed.ok && parsed.value.id) {
      actions.adaptChallenges.push(parsed.value);
    } else {
      addHint('MEM_ADAPT_CHALLENGE', observedTag, `[MEM_ADAPT_CHALLENGE] {"id":"...","why":"...","replacement":"..."}`, "Malformed challenge intent.", false);
      addHelp('MEM_ADAPT_CHALLENGE');
    }
  }

  // MEM_ADAPT_WEAKEN
  RE_MEM_ADAPT_WEAKEN.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_WEAKEN.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    const observedTag = `[MEM_ADAPT_WEAKEN] ${rawJson.slice(0, 30)}`;
    if (parsed.ok && parsed.value.id && typeof parsed.value.amount === 'number') {
      actions.adaptWeakens.push(parsed.value);
    } else {
      addHint('MEM_ADAPT_WEAKEN', observedTag, `[MEM_ADAPT_WEAKEN] {"id":"...","why":"...","amount":0.2}`, "Malformed weaken intent.", false);
      addHelp('MEM_ADAPT_WEAKEN');
    }
  }

  // SCHEDULE
  const schedMatch = RE_SCHEDULE_SMART.exec(normalized);
  if (schedMatch) {
    let text = schedMatch[1].trim().toLowerCase();
    if (text) {
      let secs = -1;
      const m = text.match(/(\d+)/);
      if (m) {
        if (text.includes('min')) {
          secs = parseInt(m[1]) * 60;
        } else if (text.includes('hour')) {
          secs = parseInt(m[1]) * 3600;
        } else {
          secs = parseInt(m[1]);
        }
      }
      
      if (secs > 0) {
        actions.scheduleSec = Math.min(Math.max(secs, 10), 900);
        // Minor hint if they used text
        if (!/^\d+$/.test(text)) {
          addHint('SCHEDULE', `[SCHEDULE] ${text.slice(0, 20)}`, `[SCHEDULE ${actions.scheduleSec}]`, `Action successful. Text converted to seconds. Recommended format: [SCHEDULE ${actions.scheduleSec}]`, true);
        }
      } else {
         addHint('SCHEDULE', `[SCHEDULE] ${text.slice(0, 20)}`, `[SCHEDULE 60]`, "To schedule a delay, specify a number.", false);
         addHelp('SCHEDULE');
      }
    } else {
       addHint('SCHEDULE', `[SCHEDULE]`, `[SCHEDULE 60]`, "To schedule a delay, specify a number.", false);
       addHelp('SCHEDULE');
    }
  }

  // REFLECT
  RE_REFLECT.lastIndex = 0;
  while ((match = RE_REFLECT.exec(normalized)) !== null) {
    const rawText = match[1] ? match[1].trim() : '';
    const prose = extractProse(rawText);
    if (prose.length > 5 && !prose.startsWith('{') && !prose.startsWith('[')) {
      actions.reflect = true;
      actions.saves.push({ kind: 'short', entry: { type: 'question', content: prose, priority: 'normal', why: "Saved question prior to reflection." } });
      addHint('REFLECT', `[REFLECT] - ${prose.slice(0,30)}`, `[MEM_SAVE short] {"type":"question","content":"...","why":"..."}\n[REFLECT]`, "Action successful. Prose saved to memory and reflection triggered.", true);
    } else {
      actions.reflect = true;
    }
  }

  // SEND_MESSAGE
  RE_SEND_MSG.lastIndex = 0;
  while ((match = RE_SEND_MSG.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    const observedTag = `[SEND_MESSAGE] ${rawJson.slice(0, 30)}...`;
    if (parsed.ok && parsed.value.text) {
      if (!parsed.value.why) parsed.value.why = "Agent chose to send a user-visible message.";
      actions.messages.push(parsed.value.text);
    } else {
      const prose = extractProse(rawJson);
      if (prose.length > 0 && !prose.startsWith('{')) {
         actions.messages.push(prose);
         addHint('SEND_MESSAGE', observedTag, `[SEND_MESSAGE] {"text":"...","why":"..."}`, "Message sent successfully. For full control, use JSON.", true);
      } else if (prose.length > 0) {
         const raw = extractProse(rawJson);
         actions.messages.push(raw);
         addHint('SEND_MESSAGE', observedTag, `[SEND_MESSAGE] {"text":"..."}`, "JSON error. Raw text sent to user.", false);
      } else {
         addHint('SEND_MESSAGE', `[SEND_MESSAGE]`, `[SEND_MESSAGE] {"text":"..."}`, "Empty message tag.", false);
      }
    }
  }

  // HELP_ACTIONS
  if (RE_HELP_ACTIONS.test(normalized)) {
    actions.helpRequests.push("ALL");
  } else {
    RE_HELP_ACTION.lastIndex = 0;
    while ((match = RE_HELP_ACTION.exec(normalized)) !== null) {
      addHelp(match[1].trim());
    }
  }

  // Bare tag detector
  const knownTags = ['MEM_SAVE', 'MEM_DELETE', 'MEM_FOCUS', 'MEM_ADAPT', 'MEM_ADAPT_CHALLENGE', 'MEM_ADAPT_WEAKEN', 'SCHEDULE', 'REFLECT', 'SEND_MESSAGE'];
  for (const tag of knownTags) {
    const regex = new RegExp(`\\[${tag}\\b(.*?)\\]`, 'g');
    let m;
    while ((m = regex.exec(normalized)) !== null) {
      let hasAction = false;
      if (tag === 'MEM_SAVE' && actions.saves.length > 0) hasAction = true;
      if (tag === 'MEM_DELETE' && actions.deletes.length > 0) hasAction = true;
      if (tag === 'MEM_FOCUS' && (actions.focusIds.length > 0 || actions.focusTopics.length > 0)) hasAction = true;
      if (tag === 'MEM_ADAPT' && actions.adapts.length > 0) hasAction = true;
      if (tag === 'MEM_ADAPT_CHALLENGE' && actions.adaptChallenges.length > 0) hasAction = true;
      if (tag === 'MEM_ADAPT_WEAKEN' && actions.adaptWeakens.length > 0) hasAction = true;
      if (tag === 'SCHEDULE' && actions.scheduleSec !== config.defaultIntervalSec) hasAction = true;
      if (tag === 'REFLECT' && actions.reflect) hasAction = true;
      if (tag === 'SEND_MESSAGE' && actions.messages.length > 0) hasAction = true;
      
      if (!hasAction && !actions.helpRequests.includes(tag)) {
        if (tag === 'MEM_SAVE' && /#[0-9]+/.test(m[1])) {
           const ids = [...m[1].matchAll(/\d+/g)].map(x => Number.parseInt(x[0], 10));
           actions.focusIds.push(...ids);
           addHint('MEM_FOCUS', `[MEM_SAVE ${m[1].trim()}]`, `[MEM_FOCUS ${ids.map(id => '#' + id).join(' ')}]`, "Action successful. Use MEM_FOCUS to bring existing records into context instead of MEM_SAVE.", true);
        } else {
           addHint(tag, `[${tag}]`, `[${tag} ...]`, `Bare tag detected. If you want to use this tool, follow the exact syntax.`, false);
           actions.helpRequests.push(tag);
        }
      }
    }
  }

  // Weak Intent Detector
  const weakDetector = [
    { regex: /(?:\bI should|\bmight be worth)\s*(?:maybe\s*)?(?:save|remember)(?:ing)?\b/i, intent: 'MEM_SAVE', sug: '[MEM_SAVE short] {"type":"thought","content":"...","priority":"normal","why":"..."}' },
    { regex: /\bfocus on #(\d+)\b/i, intent: 'MEM_FOCUS', sug: '[MEM_FOCUS #$1]' },
    { regex: /\breview #(\d+)\b/i, intent: 'MEM_FOCUS', sug: '[MEM_FOCUS #$1]' },
    { regex: /\b(think about later|reflect on this)\b/i, intent: 'REFLECT', sug: '[REFLECT]' },
    { regex: /\b(tell user|write to user)\b/i, intent: 'SEND_MESSAGE', sug: '[SEND_MESSAGE] {"text":"...","why":"..."}' },
    { regex: /\b(change my habit|change how I think|suppress this tendency)\b/i, intent: 'MEM_ADAPT', sug: '[MEM_ADAPT] {"type":"suppress","target":"...","rule":"...","why":"..."}' }
  ];

  for (const w of weakDetector) {
    const wm = clearText.match(w.regex);
    if (wm) {
      let executed = false;
      if (w.intent === 'MEM_SAVE' && actions.saves.length > 0) executed = true;
      if (w.intent === 'MEM_FOCUS' && actions.focusIds.length > 0) executed = true;
      if (w.intent === 'REFLECT' && actions.reflect) executed = true;
      if (w.intent === 'SEND_MESSAGE' && actions.messages.length > 0) executed = true;
      if (w.intent === 'MEM_ADAPT' && actions.adapts.length > 0) executed = true;
      
      if (!executed) {
        let suggested = w.sug;
        if (wm[1]) suggested = suggested.replace('$1', wm[1]);
        addHint(w.intent, `Prose: "${wm[0]}"`, suggested, `You expressed an intent to ${w.intent.toLowerCase()} but didn't use a tool. Tool actions must use exact tags. You may ignore this if thinking is sufficient.`, true);
      }
    }
  }

  actions.thought = clearText;
  return actions;
}

module.exports = {
  parseOutput,
  logParseError
};
