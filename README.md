# Local Ollama Agent

Minimal autonomous Node.js agent that talks to local Ollama, keeps SQLite memory, logs every run, and schedules its next wake-up through model tags.

## Documentation Constitution (SSOT)

- **`agent/config.js`** is the single source of truth for all limits, paths, and model defaults.
- **README and kernel prompt must match config.** Any mismatch is a bug — fix either code or docs.
- **Parsers must not fail silently.** Tag-like patterns that don't parse must produce `feedback.failed`.
- **Schedule limits are env-configurable:** set `SCHEDULE_MIN_SEC` / `SCHEDULE_MAX_SEC` in `.env`.

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
# Starts the web server + agent daemon
node server.js

# Or use the convenience batch script (opens browser automatically)
start.bat
```

Web UI: <http://127.0.0.1:3000>

> **Note:** `npm start` runs `node agent/index.js` (single cycle, no web server). To get the full web dashboard, use `node server.js` or `start.bat`.

The agent writes logs to `logs/` and memory to `memory/agent.db` (SQLite, via `better-sqlite3`). Long-term memory uses FTS5 full-text search.

**Backup:** stop the server and copy `memory/agent.db`.

## Philosophy: user input != control plane

Этот проект — автономный агент, а не чат-бот с командами.
Пользователь не управляет памятью, расписанием и политиками напрямую.

- Любой ввод пользователя — сигнал для анализа.
- Решения о сохранении/удалении памяти принимает агент.
- Даже если модель генерирует теги действий, они применяются только после policy-фильтра.

Следствие:
- фразы «запомни», «удали», «очисти» не являются командами,
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

## Web Dashboard

Start the server:

```powershell
node server.js
```

Open: <http://127.0.0.1:3000>

The interface layer uses:
- REST API at `/api/status`, `/api/memory/short`, `/api/memory/long`, `/api/chat`
- command enqueue at `POST /api/message`
- manual run at `POST /api/run`
- logs at `GET /api/logs`

## Взаимодействие со средой (Словарь тегов)

Агент использует специальные теги в конце своего ответа для вызова инструментов среды. Среда считывает эти теги и выполняет соответствующие действия. 
Важно: среда имеет **Обучающий слой парсера** (Parser Teaching Layer). Если тег написан с синтаксической ошибкой (например, без JSON или как обычный текст), среда **не** попытается выполнить его наугад, а вернет агенту `[PARSER HINT]` с подсказкой правильного синтаксиса в следующем цикле.

### 1. Управление памятью

#### `[MEM_SAVE]`
**Назначение:** Сохранение мыслей, инсайтов, задач или фактов в память (краткосрочную или долгосрочную).
**Синтаксис:** `[MEM_SAVE short|long] {"type":"...","content":"...","priority":"...","why":"..."}`
**Параметры:**
- `short|long` *(опционально)*: Выбор хранилища (по умолчанию `short`).
- `type` *(строка, обязательно)*: Тип записи (например, `task`, `thought`, `insight`, `question`).
- `content` *(строка, обязательно)*: Само содержимое для сохранения.
- `priority` *(строка)*: Приоритет записи (`low`, `normal`, `high`).
- `why` *(строка)*: Причина, по которой это стоит запомнить.
**Пример:** `[MEM_SAVE short] {"type":"task","content":"Review the auth flow.","priority":"high","why":"User reported a bug."}`

#### `[MEM_DELETE]`
**Назначение:** Удаление неактуальных, выполненных или ошибочных записей из памяти по их ID.
**Синтаксис (канонический):** `[MEM_DELETE short #ID]` (ID внутри скобок)
**Синтаксис (допустимый):** `[MEM_DELETE short] #ID` (ID вне скобок — парсер принимает оба варианта)
**Параметры:**
- `short|long` *(опционально)*: Из какого хранилища удалять.
- `#ID` *(число, обязательно)*: ID записи, начиная с символа решетки (например, `#61`). Поддерживается указание нескольких ID через пробел.
**Пример:** `[MEM_DELETE short #61]`

#### `[MEM_FOCUS]`
**Назначение:** Извлечение конкретных записей из базы данных памяти в текущий активный контекст (чтобы «вспомнить» их и использовать в следующем цикле рассуждений).
**Синтаксис:**
- По ID (новая строка или inline): `[MEM_FOCUS #ID1 #ID2]`
- По теме (только с новой строки): `[MEM_FOCUS] {"topic":"...","limit":3}`

> **Ограничение:** Inline-парсер (тег в середине предложения) извлекает только прямые `#ID`. Формат с JSON-payload `{"topic":"..."}` работает только когда тег написан с начала строки (canonical block form).

**Пример:** `[MEM_FOCUS #61 #38]`

### 2. Биологическая адаптация (Формирование привычек)

#### `[MEM_ADAPT]`
**Назначение:** Создание правила «биологической адаптации», которое изменит будущее поведение агента (правило добавляется в контекст навсегда, пока не будет оспорено). Используется для подавления вредных паттернов или усиления полезных.
**Синтаксис:** `[MEM_ADAPT] {"type":"strengthen|suppress|reframe","target":"...","rule":"...","why":"..."}`
**Параметры:**
- `type` *(строка)*: Тип адаптации (`strengthen` - усилить, `suppress` - подавить, `reframe` - переосмыслить).
- `target` *(строка)*: Целевое поведение или триггер, на которое направлено правило.
- `rule` *(строка)*: Само правило, которому нужно следовать.
- `why` *(строка)*: Внутренняя причина создания адаптации.
**Пример:** `[MEM_ADAPT] {"type":"suppress","target":"apologizing","rule":"Do not say sorry for agentic actions.","why":"Be more confident."}`

#### `[MEM_ADAPT_CHALLENGE]`
**Назначение:** Оспаривание (челлендж) существующей адаптации, если она устарела, стала мешать работе или слишком строга. Если правило получает 3 челленджа, оно удаляется из среды.
**Синтаксис:** `[MEM_ADAPT_CHALLENGE] {"id":"...","why":"...","replacement":"..."}`
**Параметры:**
- `id` *(строка)*: ID существующей адаптации (например, `bio_1`).
- `why` *(строка)*: Аргументация, почему правило больше не актуально или вредит.
- `replacement` *(строка)*: Предлагаемая замена или альтернативный подход.

#### `[MEM_ADAPT_WEAKEN]`
**Назначение:** Снижение «силы» (влияния) существующей адаптации без её полного оспаривания.
**Синтаксис:** `[MEM_ADAPT_WEAKEN] {"id":"...","why":"...","amount":0.2}`
**Параметры:**
- `id` *(строка)*: ID адаптации.
- `amount` *(число)*: Значение от 0.1 до 1.0, на которое нужно ослабить правило.
- `why` *(строка)*: Причина ослабления.

### 3. Внутренние процессы и коммуникация

#### `[SCHEDULE]`
**Назначение:** Установка времени простоя (в секундах) до следующего автоматического пробуждения (цикла) агента.
**Синтаксис:** `[SCHEDULE seconds]`
**Параметры:**
- `seconds` *(число)*: Желаемое время сна. Среда зажимает значение по конфигурационным лимитам: **от 10 до 90 секунд** (тест-режим; настраивается через `SCHEDULE_MIN_SEC` / `SCHEDULE_MAX_SEC` в `.env`).
**Пример:** `[SCHEDULE 60]`

#### `[REFLECT]`
**Назначение:** Запуск фонового процесса осмысления. Среда анализирует краткосрочную память, сжимает её и переносит самые важные инсайты в долгосрочную память.
**Синтаксис:** `[REFLECT]`
*(Примечание: не принимает параметров. Если агенту нужно обдумать конкретный вопрос, он должен сначала сохранить его через MEM_SAVE, а затем вызвать REFLECT).*

#### `[SEND_MESSAGE]`
**Назначение:** Отправка видимого сообщения пользователю (вывод в UI чата). Без этого тега рассуждения агента остаются его «внутренним голосом».
**Синтаксис:** `[SEND_MESSAGE] {"text":"...","why":"..."}`
**Параметры:**
- `text` *(строка, обязательно)*: Текст сообщения для пользователя.
- `why` *(строка)*: Внутренняя причина агента для отправки сообщения (пользователю не показывается).
**Пример:** `[SEND_MESSAGE] {"text":"I have finished analyzing the logs.","why":"Keep user updated."}`

#### `[HELP_ACTION]` / `[HELP_ACTIONS]`
**Назначение:** Запрос точного синтаксиса инструмента у среды, если агент сомневается, как его использовать. В следующем цикле среда предоставит точную JSON-схему в контексте.
**Синтаксис:** `[HELP_ACTIONS]` (получить справку по всем инструментам) ИЛИ `[HELP_ACTION "ИМЯ_ТЕГА"]` (по конкретному).
**Пример:** `[HELP_ACTION "MEM_SAVE"]`

