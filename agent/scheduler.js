const config = require('./config');

let timer = null;
let isRunning = false;
let nextRunTime = null;
let hasPendingImmediateRun = false;

/**
 * Зажать значение интервала сна по конфигурационным лимитам.
 * SSOT: config.scheduleMinSec и config.scheduleMaxSec.
 * Экспортируется для юнит-тестирования.
 * @param {number|undefined} seconds
 * @returns {number} appliedDelaySec — реальное значение после клампинга
 */
function clampSchedule(seconds) {
  const s = Number(seconds);
  const raw = Number.isFinite(s) ? s : config.defaultIntervalSec;
  return Math.min(config.scheduleMaxSec, Math.max(config.scheduleMinSec, raw));
}

/**
 * Очистить текущий запланированный запуск.
 */
function clearScheduledRun() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    nextRunTime = null;
  }
}

/**
 * Запланировать следующий запуск агента.
 * @param {Function} runAgent — функция главного цикла
 * @param {number} seconds — желаемая задержка (будет зажата через clampSchedule)
 * @returns {{ appliedDelaySec: number, nextAt: Date }}
 */
function scheduleNext(runAgent, seconds) {
  clearScheduledRun();

  const appliedDelaySec = clampSchedule(seconds);
  const nextAt = new Date(Date.now() + appliedDelaySec * 1000);
  nextRunTime = nextAt;

  timer = setTimeout(() => {
    runSafely(runAgent);
  }, appliedDelaySec * 1000);

  console.log(`[SCHEDULER] Следующий запуск: ${nextAt.toLocaleString()} (через ${appliedDelaySec}с)`);
  return { appliedDelaySec, nextAt };
}

/**
 * Безопасный запуск с защитой от перекрытия.
 * Если предыдущий цикл ещё выполняется — пропускаем.
 */
async function runSafely(runAgent) {
  if (isRunning) {
    hasPendingImmediateRun = true;
    console.warn('[SCHEDULER] Предыдущий цикл ещё активен — запуск запланирован сразу по завершению.');
    return;
  }
  isRunning = true;
  try {
    await runAgent();
  } catch (err) {
    console.error(`[SCHEDULER] Ошибка цикла: ${err.message}`);
    scheduleNext(runAgent, config.defaultIntervalSec);
  } finally {
    isRunning = false;
    if (hasPendingImmediateRun) {
      hasPendingImmediateRun = false;
      console.log('[SCHEDULER] ⚡ Немедленный запуск отложенного сообщения пользователя...');
      clearScheduledRun();
      runSafely(runAgent);
    }
  }
}

module.exports = {
  clampSchedule,
  scheduleNext,
  runSafely,
  clearScheduledRun,
  getSchedulerState: () => ({ isRunning, nextRunTime })
};
