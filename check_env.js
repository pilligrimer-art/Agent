#!/usr/bin/env node
// check_env.js — запусти: node check_env.js

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const OK  = '✓';
const WARN = '~';
const ERR = '✗';

function run(cmd) {
  try { return execSync(cmd, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function check(label, value, ok, hint) {
  const icon = value ? (ok ? OK : WARN) : ERR;
  console.log(`  ${icon}  ${label}: ${value ?? 'не найдено'}${hint ? '  →  ' + hint : ''}`);
  return !!value;
}

console.log('\n══════════════════════════════════════');
console.log('  ДИАГНОСТИКА ОКРУЖЕНИЯ АГЕНТА');
console.log('══════════════════════════════════════\n');

// ── 1. БАЗОВЫЕ ИНСТРУМЕНТЫ ──────────────────
console.log('[ Базовые инструменты ]');
const nodeVer  = run('node --version');
const npmVer   = run('npm --version');
const pyVer    = run('python3 --version') || run('python --version');
const gitVer   = run('git --version');

check('Node.js',  nodeVer, nodeVer?.startsWith('v'), '');
check('npm',      npmVer, true, '');
check('Python',   pyVer,  !!pyVer, pyVer ? '' : 'нужен для Ollama CLI / утилит');
check('Git',      gitVer, true, '');

// ── 2. OLLAMA ───────────────────────────────
console.log('\n[ Ollama ]');
const ollamaVer  = run('ollama --version');
const ollamaPath = run('which ollama') || run('where ollama');

check('ollama binary',  ollamaVer,  !!ollamaVer,  ollamaVer ? '' : 'установи с https://ollama.com');
check('ollama в PATH',  ollamaPath, !!ollamaPath, '');

// Проверяем, запущен ли ollama serve
http.get('http://localhost:11434', (res) => {
  const running = res.statusCode < 500;
  console.log(`  ${running ? OK : ERR}  ollama server: ${running ? 'запущен (port 11434)' : 'НЕ запущен  →  выполни: ollama serve'}`);
}).on('error', () => {
  console.log(`  ${ERR}  ollama server: НЕ запущен  →  выполни: ollama serve`);
});

// Список скачанных моделей
const modelsRaw = run('ollama list');
if (modelsRaw && modelsRaw.includes('NAME')) {
  const lines = modelsRaw.split('\n').slice(1).filter(l => l.trim());
  if (lines.length) {
    console.log(`  ${OK}  модели (${lines.length}):`);
    lines.forEach(l => console.log(`       • ${l.split(/\s+/)[0]}`));
  } else {
    console.log(`  ${WARN}  модели: ни одной  →  ollama pull llama3.2 (3B, ~2GB) или llama3.1:8b`);
  }
} else {
  console.log(`  ${WARN}  список моделей: недоступен (ollama не запущен?)`);
}

// ── 3. NODE.JS ПАКЕТЫ ──────────────────────
console.log('\n[ Node.js пакеты ]');
const pkgs = {
  'node-cron':    'планировщик cron-задач (wake-up цикл агента)',
  'axios':        'HTTP-запросы к Ollama API',
  'fs-extra':     'расширенная работа с файлами памяти',
  'dotenv':       'переменные окружения / конфиг',
  'chalk':        'цветной вывод логов (опционально)',
};

const globalMods = run('npm list -g --depth=0 2>/dev/null') || '';
const localMods  = fs.existsSync('./node_modules') ? (run('npm list --depth=0 2>/dev/null') || '') : '';

for (const [pkg, desc] of Object.entries(pkgs)) {
  const installed = globalMods.includes(pkg) || localMods.includes(pkg)
    || !!run(`node -e "require('${pkg}')" 2>/dev/null`);
  console.log(`  ${installed ? OK : WARN}  ${pkg.padEnd(16)} ${installed ? 'установлен' : 'отсутствует'}  →  ${desc}`);
}

// ── 4. ДИСК И ПАМЯТЬ ────────────────────────
console.log('\n[ Ресурсы системы ]');
const platform = process.platform;

if (platform === 'linux' || platform === 'darwin') {
  const disk = run("df -h . | awk 'NR==2{print $4\" свободно из \"$2}'");
  const ram  = platform === 'linux'
    ? run("free -h | awk '/^Mem/{print $7\" свободно из \"$2}'")
    : run("vm_stat | awk '/Pages free/{free=$3} /Pages wired/{wire=$4} END{printf \"%.1fGB free\", (free+0)*4096/1073741824}'");
  check('Диск',    disk, true, '');
  check('RAM',     ram,  true, 'Llama 3.2 3B требует ~3-4GB RAM');
} else if (platform === 'win32') {
  const disk = run('powershell -c "(Get-PSDrive C).Free/1GB | ForEach-Object { \"{0:N1} GB free\" -f $_ }"');
  const ram  = run('powershell -c "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB | ForEach-Object { \"{0:N1} GB free\" -f $_ }"');
  check('Диск C:', disk, true, '');
  check('RAM',     ram,  true, 'Llama 3.2 3B требует ~3-4GB RAM');
}

// ── 5. СТРУКТУРА ПРОЕКТА ────────────────────
console.log('\n[ Структура проекта ]');
const files = {
  'package.json':       'npm-проект инициализирован',
  '.env':               'конфиг агента',
  'agent/':             'папка агента',
  'memory/short_mem.json': 'краткосрочная память',
  'memory/long_mem.json':  'долгосрочная память',
};
for (const [f, desc] of Object.entries(files)) {
  const exists = fs.existsSync(f);
  console.log(`  ${exists ? OK : '-'}  ${f.padEnd(28)} ${exists ? 'есть' : 'создадим'}  — ${desc}`);
}

// ── 6. ИТОГ И ПЛАН ──────────────────────────
setTimeout(() => {
  console.log('\n══════════════════════════════════════');
  console.log('  СЛЕДУЮЩИЕ ШАГИ');
  console.log('══════════════════════════════════════');

  const missing = [];
  if (!run('npm list --depth=0 2>/dev/null')?.includes('node-cron') &&
      !run('node -e "require(\'node-cron\')"'))  missing.push('node-cron axios fs-extra dotenv');

  if (missing.length) {
    console.log(`\n  1. Установить пакеты:`);
    console.log(`     npm init -y && npm install ${[...new Set(missing.join(' ').split(' '))].join(' ')}`);
  }

  if (!run('ollama list')?.includes('\n')) {
    console.log(`\n  2. Скачать модель (выбери по RAM):`);
    console.log(`     ollama pull llama3.2        # 3B, ~2GB — для слабого ПК`);
    console.log(`     ollama pull llama3.1:8b     # 8B, ~5GB — лучше качество`);
    console.log(`     ollama pull phi3:mini       # 3.8B, ~2.3GB — быстрая альтернатива`);
  }

  console.log(`\n  3. Убедиться что ollama работает:`);
  console.log(`     ollama serve   (в отдельном терминале)`);
  console.log(`     curl http://localhost:11434`);
  console.log('\n');
}, 300);
