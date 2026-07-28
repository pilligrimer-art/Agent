const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function pathEnv(name, fallback) {
  const raw = process.env[name] || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

const config = {
  rootDir,
  ollamaHost:           process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaNumCtx:         intEnv('OLLAMA_NUM_CTX', 8192),
  ollamaTimeout:        intEnv('OLLAMA_TIMEOUT_MS', 300000),
  temperature:          floatEnv('TEMPERATURE', 0.2),
  modelName:            process.env.MODEL_NAME  || 'gemma3:4b',
  featureProactiveRecall: intEnv('FEATURE_PROACTIVE_RECALL', 0),
  featureFreeWill:      intEnv('FEATURE_FREE_WILL', 1),
  decayPenaltyWeight:   floatEnv('DECAY_PENALTY_WEIGHT', 0.5),
  decayHalfLifeDays:    floatEnv('DECAY_HALF_LIFE_DAYS', 1.0),
  
  // 60% Рабочий контекст: краткосрочная память и цели
  maxGoalsInContext:      intEnv('MAX_GOALS_IN_CONTEXT', 5),
  // Schedule clamp bounds — env-driven SSOT for all schedule limits.
  // Test defaults: 10..90s. Prod: set SCHEDULE_MAX_SEC=900 (or 86400) in .env.
  scheduleMinSec:       intEnv('SCHEDULE_MIN_SEC', 5),
  scheduleMaxSec:       intEnv('SCHEDULE_MAX_SEC', 300),
  defaultIntervalSec:   intEnv('DEFAULT_INTERVAL_SEC', 10),
  // 60% Рабочий контекст: последние мысли
  maxHistoryInContext:  intEnv('MAX_HISTORY_IN_CONTEXT', 1),
  
  // STM Cycle limit before auto-archiving
  maxStmCycles:         intEnv('MAX_STM_CYCLES', 4),
  
  // 30% Краткосрочная память: выжимки (до 1 абзаца)
  maxShortMemInContext: intEnv('MAX_SHORT_MEM_IN_CONTEXT', 5),
  
  // 10% Долгосрочная память: экзистенциальное (1-2 предложения)
  maxLongMemInContext:  intEnv('MAX_LONG_MEM_IN_CONTEXT', 20),
  
  maxTokens:            intEnv('MAX_TOKENS', 1024),
  logDir:               pathEnv('LOG_DIR', './logs'),
  memoryDir:            pathEnv('MEMORY_DIR', './memory')
};

module.exports = config;
