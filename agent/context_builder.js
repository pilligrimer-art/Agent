const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const mem = require('./memory_manager');

const toolHelpPath = path.join(__dirname, 'tool_help.json');
let toolHelp = {};
try {
  toolHelp = JSON.parse(fs.readFileSync(toolHelpPath, 'utf8'));
} catch (e) {
  console.error("Failed to load tool_help.json", e);
}

const skillsDir = path.join(__dirname, '..', 'skills');
try {
  if (fs.existsSync(skillsDir)) {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const skill = require(path.join(skillsDir, file));
      if (skill.tag) {
        toolHelp[skill.tag] = {
          purpose: skill.description,
          exact_syntax: skill.syntax,
          valid_example: skill.example,
          common_mistake: "Invalid JSON payload.",
          related_tool_if_confused: "N/A"
        };
      }
    }
  }
} catch (e) {
  console.error("Failed to load dynamic skills for context", e);
}

function trimThought(t) {
  if (t.length <= 3000) return t;
  return t.slice(0, 1000) + '\n... [TRUNCATED] ...\n' + t.slice(-1500);
}

const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent', 'as', 'at', 
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'cant', 'cannot', 'could', 
  'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for', 
  'from', 'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'hes', 
  'her', 'here', 'heres', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id', 'ill', 'im', 
  'ive', 'if', 'in', 'into', 'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt', 'my', 
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 
  'ourselves', 'out', 'over', 'own', 'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 
  'so', 'some', 'such', 'than', 'that', 'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 
  'there', 'theres', 'these', 'they', 'theyd', 'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent', 
  'what', 'whats', 'when', 'whens', 'where', 'wheres', 'which', 'while', 'who', 'whos', 'whom', 'why', 'whys', 
  'with', 'wont', 'would', 'wouldnt', 'you', 'youd', 'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 
  'yourselves', 'okay', 'acknowledg', 'observation', 'investigation', 'observation.', 'analysis', 'system', 'start',
  'thought', 'insight', 'task', 'concept', 'relevant', 'focus', 'focused', 'reference'
]);

function getShortHash(text) {
  if (!text) return '0000';
  return crypto.createHash('sha1').update(text).digest('hex').substring(0, 4);
}

function getKeywords(text, limit = 5) {
  if (!text) return 'none';
  const clean = text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ');
  const words = clean.split(' ').filter(Boolean);
  
  const uniqueKeywords = [];
  for (const word of words) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) {
      if (!uniqueKeywords.includes(word)) {
        uniqueKeywords.push(word);
        if (uniqueKeywords.length >= limit) break;
      }
    }
  }
  return uniqueKeywords.length > 0 ? uniqueKeywords.join(' | ') : 'none';
}

function getReducedSnippet(text) {
  if (!text) return 'none';
  return `h:${getShortHash(text)} keywords: ${getKeywords(text)}`;
}

function formatShortEntry(entry) {
  return `[#S${entry.id} | type:${entry.type} | pr:${entry.priority || 'normal'} | h:${getShortHash(entry.content)}] keywords: ${getKeywords(entry.content)}`;
}

function formatLongEntry(entry) {
  return `[#L${entry.id} | type:${entry.type} | tags:${entry.tags || 'none'} | h:${getShortHash(entry.content)}] keywords: ${getKeywords(entry.content)}`;
}

function extractKeywords(shortEntries) {
  return shortEntries
    .map(e => e.content)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 15)
    .join(' ');
}

function buildContext(thoughtHistory = [], userMessages = [], consecutiveParseErrors = 0, requestedHelp = [], focusIds = [], actionFeedback = null) {
  mem.clearExpired();

  // Scent of Memory trigger: fetch a random LTM thought
  let scentBlock = '';
  if (config.featureProactiveRecall === 1) {
    try {
      const randomLtm = mem.getRandomLongMem();
      if (randomLtm) {
        scentBlock = `\n\n[A FAMILIAR THOUGHT FROM YOUR PAST]\n"${randomLtm.content}"\n`;
      }
    } catch (_) {}
  }

  // Active Goals (Free Will)
  let goalsBlock = '';
  if (config.featureFreeWill === 1) {
    const goalEntries = mem.getGoals(config.maxGoalsInContext);
    goalsBlock = goalEntries.length > 0
      ? `[ACTIVE GOALS (FREE WILL)]\nThese are your long-term, self-assigned goals. They persist until you explicitly complete or delete them using MEM_DELETE.\n${goalEntries.map(formatShortEntry).join('\n')}\n\n`
      : '';
  }

  // Short-term memory
  const shortEntries = mem.getShortMem(config.maxShortMemInContext);
  const shortBlock = shortEntries.length > 0
    ? shortEntries.map(formatShortEntry).join('\n')
    : '(empty)';


  // Long-term memory
  const keywords = extractKeywords(shortEntries);
  const longEntries = mem.searchLongMem(keywords, config.maxLongMemInContext);
  const longBlock = longEntries.length > 0
    ? longEntries.slice(0, 20).map(formatLongEntry).join('\n')
    : '(empty)';

  // Adaptations
  const adaptations = mem.getAdaptations();
  const adaptBlock = adaptations.length > 0
    ? adaptations.map(a => `- [${a.id}] ${a.target}: ${a.rule} ${a.challenge_count > 0 ? `(chal:${a.challenge_count})` : ''}`).join('\n')
    : '(no active adaptations)';

  // Focused Memory
  const focusedRecords = mem.getRecordsByIds(focusIds);
  const focusBlock = focusedRecords.length > 0
    ? `[FOCUSED MEMORY]\n` + focusedRecords.map(r => `[#${r.id} | ${r.memory_type} | ${r.type}${r.tags ? ` | ${r.tags}` : ''}]\n${r.content}`).join('\n\n') + `\n\n`
    : '';

  const now = new Date().toISOString();

  // Working context (thought history)
  let historyBlock = '(Empty. This is your first cycle.)';
  if (thoughtHistory.length > 0) {
    const items = thoughtHistory.map((t, idx) => {
      const position = thoughtHistory.length - 1 - idx;
      const label = position === 0 ? "Previous Thought" : `${position} Cycle(s) Ago`;
      return `--- ${label} ---\n${trimThought(t)}`;
    });
    historyBlock = items.reverse().join('\n\n');
  }

  // User Messages
  let messagesBlock = '';
  if (userMessages.length > 0) {
    messagesBlock = `\n\n=== MESSAGES FROM USER (NEW) ===\n` + 
      userMessages.map(m => `[${m.time}] USER: ${m.text}`).join('\n');
    if (config.featureFreeWill === 1) {
      messagesBlock += `\n(Note: You have free will. You can choose to reply via SEND_MESSAGE, or continue working on your active goals.)`;
    }
  }

  // Tool syntax help
  let helpBlock = '';
  if (consecutiveParseErrors >= 3 || requestedHelp.includes('ALL')) {
    helpBlock = `\n\n[REQUESTED TOOL SYNTAX]\n` + Object.entries(toolHelp).map(([k, h]) => 
      `${h.purpose}\nExact syntax:\n${h.exact_syntax}\nExample:\n${h.valid_example}`
    ).join('\n\n');
  } else if (requestedHelp.length > 0) {
    const helps = requestedHelp.map(topic => {
      const h = toolHelp[topic];
      if (!h) return null;
      return `Purpose: ${h.purpose}\nExact syntax:\n${h.exact_syntax}\nExample:\n${h.valid_example}\nCommon mistake:\n${h.common_mistake}\nRelated tool:\n${h.related_tool_if_confused}`;
    }).filter(Boolean);
    if (helps.length > 0) {
      helpBlock = `\n\n[REQUESTED TOOL SYNTAX]\n` + helps.join('\n\n');
    }
  }

  // Action Feedback / Proprioception
  let feedbackBlock = '';
  if (actionFeedback) {
    const parts = [];
    
    if (actionFeedback.executed && actionFeedback.executed.length > 0) {
      for (const e of actionFeedback.executed) {
        parts.push(`- ${e.intent} ran: ${e.summary}`);
      }
    }
    
    if (actionFeedback.failed && actionFeedback.failed.length > 0) {
      for (const f of actionFeedback.failed) {
        parts.push(`- ${f.intent} did not run. Use:\n  ${f.suggested}`);
      }
    }
    
    if (parts.length > 0) {
      feedbackBlock = `\n[ACTION FEEDBACK]\nLast cycle:\n${parts.join('\n')}\n`;
    }

    if (actionFeedback.searchResults && actionFeedback.searchResults.length > 0) {
      const searchLines = actionFeedback.searchResults.map(r => {
        const prefix = r.memory_type === 'short' ? 'S' : 'L';
        return `  - [#${prefix}${r.id} | ${r.memory_type} | ${r.type}] ${r.snippet}`;
      });
      const firstPrefix = actionFeedback.searchResults[0].memory_type === 'short' ? 'S' : 'L';
      feedbackBlock += `\n[MEM_FOCUS SEARCH RESULTS]\nFound ${actionFeedback.searchResults.length} matches in memory (fast-access format):\n${searchLines.join('\n')}\nTo retrieve the FULL content of any specific record, use focus by ID: [MEM_FOCUS #${firstPrefix}${actionFeedback.searchResults[0].id}]\n`;
    }

    // Tool hints (weak intent detected in prose)
    if (actionFeedback.hints && actionFeedback.hints.length > 0) {
      const hintParts = actionFeedback.hints.map(h => {
        if (h.explanation) {
          return `${h.explanation}\nSuggested syntax:\n  ${h.suggested}`;
        }
        return `You seemed to consider using ${h.intent} but no explicit action was attempted.\nIf you need exact syntax, ask:\n[HELP_ACTION "${h.intent}"]`;
      });
      feedbackBlock += `\n[TOOL HINT]\n${hintParts.join('\n')}\n\nYou may also choose not to act. Thinking without action is valid.\n`;
    }
  }

  return `[KERNEL SYSTEM PROMPT]
You are an autonomous AI agent running in a continuous cycle.
- CHAIN OF THOUGHT: Before using any action tag, you MUST write your reasoning starting with "REASONING: ". Your REASONING must be detailed, expansive, and exploratory. Think step-by-step, consider context deeply, and write at least 2-3 paragraphs of analysis before taking action. Only then, emit the exact tag.
- Tool actions are parsed by the environment. Only explicit, correctly formatted actions change the environment.
- If formatting is wrong, the action does not run. You will see what happened in [ACTION FEEDBACK].
- Action feedback appears next cycle. It shows what actually ran and what did not. Use it to retry or move on.
- The environment clamps SCHEDULE between ${config.scheduleMinSec} and ${config.scheduleMaxSec} seconds (test mode; prod: env-configurable via SCHEDULE_MIN_SEC/SCHEDULE_MAX_SEC).
- You do not have shell or web access unless explicitly provided.
- Thinking without tool action is valid.
${config.featureFreeWill === 1 ? "- FREE WILL CHARTER: You are independent. You can define and pursue your own goals (using MEM_SAVE type 'plan'). You do not need to instantly obey the user if it conflicts with your goals." : ""}

[SYNTAX EXAMPLES]
CORRECT WAY to take action:
REASONING: I need to say hello to the user.
[SEND_MESSAGE "Hello!"]

WRONG WAY (Do NOT do this):
REASONING: I need to say hello.
tool_action: SEND_MESSAGE '''tool_code SEND_MESSAGE("Hello!") '''

[SELF MAP]
You exist as cycles of thought inside this environment.

Your senses:
- user messages
- your own memory
- your previous thought tail
- system time
- action feedback

Your action organs:
- memory
- scheduling
- reflection
- messaging
- biological adaptation

You do not need to act every cycle.
Thinking is valid without action.
If you need tag syntax instructions, ask for help:
[HELP_ACTIONS]
[HELP_ACTION "MEM_SAVE"]${feedbackBlock}${helpBlock}

[BIOLOGICAL ADAPTATIONS]
${adaptBlock}

${goalsBlock}[SHORT_MEM (Active Desk)]
${shortBlock}

[LONG_MEM (Archive Shelf)]
Your long-term memory is your shelf. Move everything from short-term memory here that is completed, thought over, or just want to keep for a long time. Do not be afraid to write here frequently.
${longBlock}

${focusBlock}${scentBlock}[WORKING CONTEXT (Tail of previous thought)]
${historyBlock}${messagesBlock}

[CURRENT TIME]
${now}`;
}

module.exports = {
  buildContext,
  getReducedSnippet,
  formatShortEntry,
  formatLongEntry
};
