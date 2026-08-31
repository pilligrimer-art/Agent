---
name: kimi_assistant
description: Kimi Model Integration (kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k3) via console CLI (ask.bat / python cli.py). Use this skill when executing complex analytical, deep reasoning, code architecture, or file-intensive tasks requiring Kimi models.
---

# Kimi Model CLI Assistant Skill

This skill enables using Kimi models (`kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k3`) via interactive console for complex, analytical, and reasoning-heavy tasks.

## Execution Path & Commands

Console CLI location: `C:\Users\Nich\Desktop\Claw`

Run in console / PowerShell:
```powershell
cd C:\Users\Nich\Desktop\Claw
.\ask.bat
# or
python cli.py
```

Interactive console capabilities:
- Full tool support (PowerShell, file system, web search, GitHub, Moonshot Files API).
- Real-time token balance and usage display.

## In-Console Commands

- `/model [code|fast|k3]` — Change active model on the fly:
  - `code` -> `kimi-k2.7-code`
  - `fast` -> `kimi-k2.7-code-highspeed`
  - `k3`   -> `kimi-k3`
- `/effort [low|high|max]` — Change reasoning depth level (`low`, `high`, `max`).
- `/new` — Start a new dialogue session (clear context).
- `exit` — Close and exit the console.

## Workflows & Best Practices

1. **Complex Analytical & Code Tasks**: Launch CLI, set `/model code` or `/model k3`, and set `/effort high` or `/effort max`.
2. **Fast Refactoring & Quick Iterations**: Switch to `/model fast`.
3. **Fresh Context**: Execute `/new` before starting unrelated complex sub-tasks.
