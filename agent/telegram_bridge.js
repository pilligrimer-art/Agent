const https = require('https');
const config = require('./config');

class TelegramBridge {
  constructor() {
    this.token = config.telegramBotToken;
    this.chatId = config.telegramChatId;
    this.questionQuota = 0;
    this.botMessageIds = new Set();
    this.pendingUserReplies = new Map(); // msgId -> { text, user, replyToBotMsgId }
    this.reactionCounts = new Map(); // msgId -> count
    this.userRateLimitMap = new Map(); // userId -> lastTimestamp (1 token per 2 mins per user)
    this.onUserInputCallback = null;
    this.pollingOffset = 0;
    this.isPolling = false;
  }

  isConfigured() {
    return Boolean(this.token && this.token.trim());
  }

  async makeApiRequest(method, payload = {}) {
    if (!this.isConfigured()) return null;

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = https.request(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 35000
        },
        (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed);
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telegram API request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async sendThought(thoughtText) {
    if (!this.isConfigured() || !thoughtText) return;

    if (thoughtText.includes('?')) {
      this.questionQuota += 1;
      console.log(`[TELEGRAM] Вопрос обнаружен в мысли. Шлюз ответов открыт (квота: ${this.questionQuota}).`);
    }

    const cleanThought = this.escapeHtml(thoughtText);
    const htmlMessage = `<blockquote>${cleanThought}</blockquote>`;

    await this.dispatchMessage(htmlMessage, 'HTML');
  }

  async sendMessage(msgText) {
    if (!this.isConfigured() || !msgText) return;

    if (msgText.includes('?')) {
      this.questionQuota += 1;
      console.log(`[TELEGRAM] Вопрос обнаружен в сообщении. Шлюз ответов открыт (квота: ${this.questionQuota}).`);
    }

    const cleanText = this.escapeHtml(msgText);
    await this.dispatchMessage(cleanText, 'HTML');
  }

  async dispatchMessage(formattedText, parseMode = 'HTML') {
    try {
      const payload = {
        chat_id: this.chatId || undefined,
        text: formattedText,
        parse_mode: parseMode
      };

      // If chatId is not set in config, payload.chat_id might be missing; api returns error if missing
      const res = await this.makeApiRequest('sendMessage', payload);
      if (res && res.ok && res.result) {
        this.botMessageIds.add(res.result.message_id);
        if (!this.chatId) {
          this.chatId = String(res.result.chat.id);
          console.log(`[TELEGRAM] Авто-определение Chat ID: ${this.chatId}`);
        }
      } else if (res && !res.ok) {
        console.warn(`[TELEGRAM] Ошибка отправки сообщения: ${res.description}`);
      }
    } catch (err) {
      console.error(`[TELEGRAM] Ошибка при отправке сообщения: ${err.message}`);
    }
  }

  async startPolling(onApprovedUserInput) {
    if (!this.isConfigured()) {
      console.log('[TELEGRAM] TELEGRAM_BOT_TOKEN не задан в .env. Трансляция и шлюз отключены.');
      return;
    }

    this.onUserInputCallback = onApprovedUserInput;
    this.isPolling = true;

    // Обрабатываем самый свежий апдейт при запуске сервера
    try {
      const latest = await this.makeApiRequest('getUpdates', { offset: -1, timeout: 5 });
      if (latest && latest.ok && Array.isArray(latest.result) && latest.result.length > 0) {
        for (const update of latest.result) {
          this.pollingOffset = update.update_id + 1;
          this.handleUpdate(update);
        }
        console.log(`[TELEGRAM] Инициализирован offset: ${this.pollingOffset}`);
      }
    } catch (_) {}

    console.log(`[TELEGRAM] Запуск Лонг-поллинга (offset: ${this.pollingOffset})...`);
    this.pollLoop();
  }

  async pollLoop() {
    while (this.isPolling) {
      try {
        const updates = await this.makeApiRequest('getUpdates', {
          offset: this.pollingOffset,
          timeout: 20
        });

        if (updates && updates.ok && Array.isArray(updates.result)) {
          for (const update of updates.result) {
            this.pollingOffset = update.update_id + 1;
            this.handleUpdate(update);
          }
        }
      } catch (err) {
        // Log & sleep slightly on error
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  handleUpdate(update) {
    const msg = update.message || update.edited_message || update.channel_post;
    const chat = (msg && msg.chat) || (update.my_chat_member && update.my_chat_member.chat) || (update.chat_member && update.chat_member.chat);

    if (!this.chatId && chat) {
      this.chatId = String(chat.id);
      console.log(`[TELEGRAM] ✅ Авто-определение Chat ID: ${this.chatId}`);
    }

    // 1. Новое сообщение от пользователя (игнорируем собственные сообщения бота)
    if (msg && msg.from && !msg.from.is_bot) {
      const text = msg.text || '';
      const replyTo = msg.reply_to_message;
      const user = msg.from.username || msg.from.first_name || 'User';
      const userId = msg.from.id;
      const nowMs = Date.now();
      const lastUserTime = this.userRateLimitMap.get(userId) || 0;
      const TWO_MINUTES_MS = 2 * 60 * 1000;

      if (replyTo) {
        this.pendingUserReplies.set(msg.message_id, {
          text,
          user,
          replyToMsgId: replyTo.message_id,
          chatId: msg.chat.id
        });
      }

      const isReplyToBot = replyTo && replyTo.from && (replyTo.from.id === msg.from.id || replyTo.from.is_bot);
      const isReplyToQuestion = isReplyToBot && replyTo.text && replyTo.text.includes('?');
      const isUserTokenAvailable = (nowMs - lastUserTime) >= TWO_MINUTES_MS;

      // Шлюз 1: Персональный 2-минутный токен пользователя
      if (isUserTokenAvailable && text.trim()) {
        this.userRateLimitMap.set(userId, nowMs);
        console.log(`[TELEGRAM GATE] 🎟️ Персональный 2-мин токен пользователя @${user} использован: "${text}"`);
        if (this.onUserInputCallback) {
          this.onUserInputCallback(`[Telegram @${user}]: ${text}`);
        }
        return;
      }

      // Шлюз 2: Проверка Вопросительной Квоты ИЛИ прямого ответа на сообщение с вопросом '?'
      if ((this.questionQuota > 0 || isReplyToQuestion) && text.trim()) {
        if (this.questionQuota > 0) this.questionQuota -= 1;
        console.log(`[TELEGRAM GATE] ❓ Ответ пропущен по квоте вопроса от @${user}: "${text}"`);
        if (this.onUserInputCallback) {
          this.onUserInputCallback(`[Telegram @${user}]: ${text}`);
        }
        return;
      }

      // Шлюз 3: Ожидание 3+ реакций (отработка в processReactionGate)
    }

    // 2. Реакция на сообщение (message_reaction или message_reaction_count)
    if (update.message_reaction) {
      const mr = update.message_reaction;
      const msgId = mr.message_id;
      const newReactionsCount = (mr.new_reaction || []).length;
      
      this.processReactionGate(msgId, newReactionsCount);
    }

    if (update.message_reaction_count) {
      const mrc = update.message_reaction_count;
      const msgId = mrc.message_id;
      const totalCount = (mrc.reactions || []).reduce((acc, r) => acc + (r.total_count || 0), 0);

      this.processReactionGate(msgId, totalCount);
    }
  }

  processReactionGate(msgId, count) {
    this.reactionCounts.set(msgId, count);

    // Проверяем: если реплика пользователя соберет >= 3 реакций
    if (count >= 3 && this.pendingUserReplies.has(msgId)) {
      const reply = this.pendingUserReplies.get(msgId);
      console.log(`[TELEGRAM GATE] Сообщение @${reply.user} набрало ${count} реакций! Пропуск в контекст агента: "${reply.text}"`);
      this.pendingUserReplies.delete(msgId);
      if (this.onUserInputCallback) {
        this.onUserInputCallback(`[Telegram @${reply.user} (3+ reactions)]: ${reply.text}`);
      }
    }
  }
}

module.exports = new TelegramBridge();
