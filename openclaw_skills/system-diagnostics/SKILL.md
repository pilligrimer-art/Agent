---
name: system-diagnostics
version: 1.0.0
author: OpenClaw
description: Быстрая диагностика процессов, дисков и системных ресурсов Windows.
triggers:
  - диаг
  - статус сервера
  - healthcheck
dependencies: []
tools:
  - run_command
---

# 🖥️ System Diagnostics Skill

## Описание
Данный скилл предписывает агенту выполнять быструю и безопасную проверку ресурсов машины Windows при запросе диагностики.

## Инструкция для агента (Workflow)
1. Выполни PowerShell команду проверки ТОП-5 процессов по памяти:
   `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 ProcessId, ProcessName, @{N='RAM_MB';E={[math]::round($_.WorkingSet64/1MB,2)}}`
2. Выполни проверку свободного места на дисках:
   `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, @{N='Free_GB';E={[math]::round($_.FreeSpace/1GB,2)}}, @{N='Total_GB';E={[math]::round($_.Size/1GB,2)}}`
3. Сформируй результат в виде лаконичного отчёта с эмодзи.
