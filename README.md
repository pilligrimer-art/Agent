# Local Ollama Agent

Minimal autonomous Node.js agent that talks to local Ollama, keeps JSON memory, logs every run, and schedules its next wake-up through model tags.

## Requirements

- Node.js and npm
- Ollama running at `http://localhost:11434`
- Installed model from `.env`, default: `gemma3:4b`

## Install

```powershell
npm install
```

## Run

```powershell
npm start
```

The agent writes logs to `logs/` and memory to `memory/short_mem.json` and `memory/long_mem.json`.

## Philosophy: user input != control plane

Этот проект — автономный агент, а не чат-бот с командами.
Пользователь не управляет памятью, расписанием и политиками напрямую.

- Любой ввод пользователя — сигнал для анализа.
- Решения о сохранении/удалении памяти принимает агент.
- Даже если модель генерирует теги действий, они применяются только после policy-фильтра.

Следствие:
- фразы "запомни", "удали", "очисти" не являются командами,
- агент может сделать это по собственной инициативе, если сочтёт полезным.

For a single verification run without leaving the scheduler active:

```powershell
$env:RUN_ONCE='1'; node agent/index.js
```

## CLI Input

Pass a message as arguments to run the controller pipeline once:

```powershell
node agent/index.js "Продумай архитектуру Telegram-бота для этого агента"
```

Pipeline:

```text
user input -> analysis -> mode -> response -> policy-filtered actions
```

The user never controls memory tags directly. The analyzer chooses whether memory writes, reflection, or scheduling are allowed.

## Daemon And Web Dashboard

Run the long-lived daemon:

```powershell
node agent/index.js --daemon
```

Run the web dashboard:

```powershell
node agent/index.js --web 3000
```

Open:

```text
http://127.0.0.1:3000
```

The interface layer uses:
- `runtime/commands.jsonl` for incoming commands
- `telemetry/events.jsonl` for JSONL events
- Server-Sent Events at `/api/events`
- command enqueue endpoint at `POST /api/command`

## Supported Tags

The model controls only memory and scheduling:

```text
[MEM_SAVE short] {"type":"task","content":"...","priority":"normal","why":"Useful because ..."}
[MEM_SAVE long] {"type":"insight","content":"...","tags":["topic"],"why":"Useful because ..."}
[MEM_DELETE short m_2026_05_08_0001 duplicate]
[MEM_PLAN] [{"op":"PIN","kind":"short","id":"m_2026_05_08_0001","params":{"pin_reason":"Long-term goal"},"why":"Stable goal likely needed later"}]
[NOTIFY_AFTER] {"after_ms":30000,"text":"Reminder text","why":"User-visible follow-up is useful"}
[SCHEDULE 3600]
[REFLECT]
```

The parser reads tags only from the last 30 lines, clamps schedule to `.env` limits, ignores invalid JSON, and limits memory edits per run.
Supported plan ops are `ADD`, `UPDATE`, `PROMOTE`, `DELETE`, `PIN`, and `UNPIN`. There is no separate non-removable memory state.
`NOTIFY_AFTER` is daemon-only and capped by `MAX_DELAY_MS` (default 60000).
