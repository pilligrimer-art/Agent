const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function pathEnv(name, fallback) {
  const raw = process.env[name] || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

const config = {
  rootDir,
  ollamaHost:           process.env.OLLAMA_HOST || 'http://localhost:11434',
  modelName:            process.env.MODEL_NAME  || 'gemma3:4b',
  defaultIntervalSec:   intEnv('DEFAULT_INTERVAL_SEC', 10),
  
  // 60% Рабочий контекст: последние мысли
  maxHistoryInContext:  intEnv('MAX_HISTORY_IN_CONTEXT', 1),
  
  // 30% Краткосрочная память: выжимки (до 1 абзаца)
  maxShortMemInContext: intEnv('MAX_SHORT_MEM_IN_CONTEXT', 5),
  
  // 10% Долгосрочная память: экзистенциальное (1-2 предложения)
  maxLongMemInContext:  intEnv('MAX_LONG_MEM_IN_CONTEXT', 20),
  
  maxTokens:            intEnv('MAX_TOKENS', 1024),
  logDir:               pathEnv('LOG_DIR', './logs'),
  memoryDir:            pathEnv('MEMORY_DIR', './memory')
};

module.exports = config;
