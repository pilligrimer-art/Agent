const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./agent/config');
require('./agent/db');
const mem = require('./agent/memory_manager');
const { buildContext } = require('./agent/context_builder');
const { parseOutput, logParseError } = require('./agent/output_parser');
const { scheduleNext, clearScheduledRun } = require('./agent/scheduler');
const { runAgent, callOllama, runReflection, pushUserMessage, getChatHistory } = require('./agent/index');

const app = express();
const PORT = process.env.WEB_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Состояние агента ---
const state = {
  status: 'idle',        // idle | thinking | reflecting
  lastRun: null,
  lastThought: null,
  lastError: null,
  nextRunAt: null,
  totalRuns: 0
};

// --- API ---

// Получить полное состояние
app.get('/api/status', (req, res) => {
  res.json({
    status: state.status,
    lastRun: state.lastRun,
    lastThought: state.lastThought,
    lastError: state.lastError,
    nextRunAt: state.nextRunAt,
    totalRuns: state.totalRuns,
    model: config.modelName,
    shortCount: mem.countShort(),
    longCount: mem.countLong()
  });
});

// Получить краткосрочную память
app.get('/api/memory/short', (req, res) => {
  res.json(mem.getShortMem(50));
});

// Получить долгосрочную память
app.get('/api/memory/long', (req, res) => {
  res.json(mem.getLongMem(50));
});

// Поиск в долгосрочной памяти
app.get('/api/memory/search', (req, res) => {
  const q = req.query.q || '';
  res.json(mem.searchLongMem(q, 20));
});

// Добавить запись вручную
app.post('/api/memory/add', (req, res) => {
  const { kind, type, content, priority, tags } = req.body;
  try {
    if (kind === 'short') {
      const entry = mem.addShort(type || 'task', content, priority || 'normal');
      res.json({ ok: true, entry });
    } else {
      const entry = mem.addLong(type || 'insight', content, tags || '', 'manual');
      res.json({ ok: true, entry });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Удалить запись
app.post('/api/memory/delete', (req, res) => {
  const { kind, id } = req.body;
  const deleted = kind === 'short' ? mem.deleteShort(id) : mem.deleteLong(id);
  res.json({ ok: deleted });
});

// Получить историю чата
app.get('/api/chat', (req, res) => {
  res.json(getChatHistory());
});

// Отправить сообщение агенту
app.post('/api/message', (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ ok: false, error: 'Empty message' });
  pushUserMessage(text);
  res.json({ ok: true });
});

// Запустить агента вручную
app.post('/api/run', async (req, res) => {
  if (state.status !== 'idle') {
    return res.json({ ok: false, error: 'Агент уже работает' });
  }
  state.status = 'thinking';
  res.json({ ok: true, message: 'Запуск...' });

  try {
    // В ручном запуске мы просто эмулируем вызов основного агента, 
    // но в реальности лучше вызывать runSafely(runAgent), 
    // чтобы работала общая логика с очередью.
    clearScheduledRun();
    const { runSafely } = require('./agent/scheduler');
    await runSafely(runAgent);
    
    state.lastThought = "Мысль сгенерирована, посмотрите логи или рабочий контекст.";
    state.lastError = null;
    state.lastRun = new Date().toISOString();
    state.totalRuns++;

  } catch (err) {
    state.lastError = err.message;
  } finally {
    state.status = 'idle';
  }
});

// Получить логи
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(config.logDir)) return res.json([]);
    const files = fs.readdirSync(config.logDir)
      .filter(f => f.endsWith('.txt'))
      .sort()
      .reverse()
      .slice(0, 20);
    const logs = files.map(f => ({
      name: f,
      content: fs.readFileSync(path.join(config.logDir, f), 'utf8').slice(0, 5000)
    }));
    res.json(logs);
  } catch (err) {
    res.json([]);
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`[WEB] Интерфейс: http://localhost:${PORT}`);
});
