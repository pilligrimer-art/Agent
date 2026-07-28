---
name: environment-doctor
version: 1.0.0
author: OpenClaw
description: Проверка зависимостей, кодировок Windows, процессов и рабочего окружения.
triggers:
  - доктор среды
  - проверь окружение
  - зависимости
dependencies: []
tools:
  - run_command
---

# 🩺 Environment Doctor Skill

## Назначение
Проверка локальной среды исполнения, версий интерпретаторов и корректности кодировок Windows.

## Проверки (Checklist)
1. **Кодировка консоли:** Запусти `[Console]::OutputEncoding.EncodingName` (должна быть UTF-8).
2. **Зависимости Python/Node:**
   - Для Python: `python -m pip check`
   - Для Node.js: `npm doctor` или проверка `node_modules`
3. **Процессы и Порты:**
   - Запусти `netstat -ano | Select-String "LISTENING"` для проверки занятых портов.
   - Сформируй краткий статус окружения с рекомендациями по исправлению.
