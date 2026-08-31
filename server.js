const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./agent/config');
require('./agent/db');
const mem = require('./agent/memory_manager');
const { buildContext } = require('./agent/context_builder');
const { parseOutput, logTelemetry } = require('./agent/output_parser');
const { scheduleNext, clearScheduledRun } = require('./agent/scheduler');
const { runAgent, callOllama, runReflection, pushUserMessage, getChatHistory, getAgentState } = require('./agent/index');

const app = express();
const PORT = process.env.WEB_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// No local state needed anymore, we query getAgentState()

// --- API ---

// Получить полное состояние
app.get('/api/status', (req, res) => {
  const agentState = getAgentState();
  res.json({
    status: agentState.status,
    lastRun: agentState.lastRun,
    lastThought: agentState.lastThought,
    lastError: null, // Error is now just in logs
    nextRunAt: agentState.nextRunAt,
    totalRuns: agentState.totalRuns,
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
  if (typeof content !== 'string' || content.trim() === '' || content.length > 10000) {
    return res.status(400).json({ ok: false, error: 'Invalid input: content' });
  }
  if (!['thought', 'task', 'insight', 'question', 'plan', 'reminder', 'knowledge', 'reflection'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid input: type' });
  }
  if (priority && !['high', 'normal', 'low'].includes(priority)) {
    return res.status(400).json({ ok: false, error: 'Invalid input: priority' });
  }
  if (kind !== 'short' && kind !== 'long') {
    return res.status(400).json({ ok: false, error: 'Invalid input: kind' });
  }
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
  const agentState = getAgentState();
  if (agentState.status !== 'idle') {
    return res.json({ ok: false, error: 'Агент уже работает' });
  }
  
  res.json({ ok: true, message: 'Запуск...' });

  try {
    clearScheduledRun();
    const { runSafely } = require('./agent/scheduler');
    // We don't await this so the request returns immediately and the agent runs in background
    runSafely(runAgent);
  } catch (err) {
    console.error('Run failed:', err);
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
app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[WEB] Интерфейс: http://localhost:${PORT}`);
  
  // Автоматический старт агента
  console.log('[SYSTEM] Инициализация агента...');
  mem.initBaseAdaptations();
  
  const telegramBridge = require('./agent/telegram_bridge');
  telegramBridge.startPolling((userInputText, userId, meta) => {
    pushUserMessage(userInputText, userId, meta);
  });
  
  const { runSafely } = require('./agent/scheduler');
  await runSafely(runAgent);
});

