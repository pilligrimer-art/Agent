const config = require('./config');

let timer = null;
let isRunning = false;

/**
 * Очистить текущий запланированный запуск.
 */
function clearScheduledRun() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Запланировать следующий запуск агента.
 * @param {Function} runAgent — функция главного цикла
 * @param {number} seconds — задержка в секундах (кламируется в [60, maxInterval])
 */
function scheduleNext(runAgent, seconds) {
  clearScheduledRun();

  const delaySec = Math.min(
    86400, // максимум 24 часа
    Math.max(60, Number(seconds) || config.defaultIntervalSec)
  );

  const nextAt = new Date(Date.now() + delaySec * 1000);

  timer = setTimeout(() => {
    runSafely(runAgent);
  }, delaySec * 1000);

  console.log(`[SCHEDULER] Следующий запуск: ${nextAt.toLocaleString()} (через ${delaySec}с)`);
  return { delaySec, nextAt };
}

/**
 * Безопасный запуск с защитой от перекрытия.
 * Если предыдущий цикл ещё выполняется — пропускаем.
 */
async function runSafely(runAgent) {
  if (isRunning) {
    console.warn('[SCHEDULER] Предыдущий цикл ещё активен — пропуск.');
    return;
  }
  isRunning = true;
  try {
    await runAgent();
  } catch (err) {
    console.error(`[SCHEDULER] Ошибка цикла: ${err.message}`);
    // При ошибке — перезапланировать по умолчанию
    scheduleNext(runAgent, config.defaultIntervalSec);
  } finally {
    isRunning = false;
  }
}

module.exports = {
  scheduleNext,
  runSafely,
  clearScheduledRun
};
