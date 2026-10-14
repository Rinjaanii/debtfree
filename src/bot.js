/**
 * DebtFree — бот в Telegram.
 *
 * Зачем он нужен сервису:
 *   • подтверждает вход в веб-версию: вы открываете бота, нажимаете кнопку,
 *     и браузер получает доступ. Пароля нигде нет;
 *   • позже будет присылать напоминания о платежах (заготовка — handlers.remind).
 *
 * Работает на длинных запросах (long polling), без внешних библиотек и без
 * необходимости в публичном адресе для вебхука.
 */

const API = "https://api.telegram.org/bot";

/** Кнопка «Открыть DebtFree» — только если публичный адрес известен. */
function openAppKeyboard() {
  const url = (process.env.PUBLIC_URL || "").trim();
  if (!/^https:\/\//i.test(url)) return undefined;
  return { inline_keyboard: [[{ text: "Открыть DebtFree", web_app: { url: url } }]] };
}

/** Кнопки и текст приветствия. */
function welcome(name) {
  const hello = name ? "Здравствуйте, " + name + "!" : "Здравствуйте!";
  return hello + "\n\n" +
    "DebtFree — план погашения долгов: в каком порядке закрывать, когда вы освободитесь " +
    "и сколько процентов сэкономите.\n\n" +
    (openAppKeyboard()
      ? "Откройте приложение кнопкой ниже 👇"
      : "Приложение открывается кнопкой меню слева внизу.");
}

/**
 * @param {{token:string, sessions:object, onUser:function, displayName:function}} opts
 * @returns {{stop:function}|null}
 */
export function startBot(opts) {
  const token = (opts && opts.token) || "";
  if (!token) return null;

  const sessions = opts.sessions;
  const base = API + token;
  let stopped = false;
  let offset = 0;
  let me = null;

  async function call(method, payload) {
    const res = await fetch(base + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      const description = (data && data.description) || ("http_" + res.status);
      const error = new Error(description);
      error.code = data && data.error_code;
      throw error;
    }
    return data.result;
  }

  /** Подтверждение входа: код приходит из ссылки t.me/<бот>?start=<код>. */
  async function handleStart(message, payload) {
    const chatId = message.chat.id;
    const userId = message.from && message.from.id;
    const name = [message.from && message.from.first_name, message.from && message.from.last_name]
      .filter(Boolean).join(" ");

    if (opts.onUser && message.from) opts.onUser(message.from);

    if (payload && sessions) {
      const confirmed = sessions.confirmLogin(payload, userId);
      if (confirmed) {
        await call("sendMessage", {
          chat_id: chatId,
          text: "✅ Вход в DebtFree подтверждён.\n\nВернитесь в браузер — там уже открыт ваш план.",
          reply_markup: openAppKeyboard()
        });
        return;
      }
      if (/^[A-Z0-9]{6,12}$/.test(payload)) {
        await call("sendMessage", {
          chat_id: chatId,
          text: "Код не найден или уже истёк — запросите новый на странице входа в браузере."
        });
        return;
      }
    }

    await call("sendMessage", { chat_id: chatId, text: welcome(name), reply_markup: openAppKeyboard() });
  }

  async function handleMessage(message) {
    if (!message || !message.text) return;
    const text = message.text.trim();
    const match = /^\/start(?:\s+(\S+))?/.exec(text);
    if (match) return handleStart(message, match[1] || null);

    if (/^\/code(?:\s+(\S+))?/.test(text)) {
      const code = /^\/code\s+(\S+)/.exec(text);
      if (!code) {
        return call("sendMessage", { chat_id: message.chat.id, text: "Пришлите код командой: /code ВАШКОД" });
      }
      const userId = message.from && message.from.id;
      if (opts.onUser && message.from) opts.onUser(message.from);
      const ok = sessions && sessions.confirmLogin(code[1], userId);
      return call("sendMessage", {
        chat_id: message.chat.id,
        text: ok ? "✅ Вход подтверждён. Вернитесь в браузер." : "Код не найден или истёк."
      });
    }

    if (text === "/help") {
      return call("sendMessage", {
        chat_id: message.chat.id,
        text: "DebtFree — план погашения долгов.\n\n" +
              "• Приложение открывается кнопкой меню.\n" +
              "• Вход в браузере подтверждается здесь: приходит код или кнопка.\n" +
              "• Данные видны только вам: доступ проверяется подписью Telegram."
      });
    }

    return call("sendMessage", {
      chat_id: message.chat.id,
      text: "Откройте приложение кнопкой меню — там весь план. Команда /help подскажет остальное."
    });
  }

  async function loop() {
    while (!stopped) {
      try {
        const updates = await call("getUpdates", {
          offset: offset,
          timeout: 30,
          allowed_updates: ["message"]
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            handleMessage(update.message).catch(function (e) {
              console.warn("[bot] не удалось ответить: " + e.message);
            });
          }
        }
      } catch (e) {
        if (stopped) break;
        console.warn("[bot] " + e.message + " — повтор через 5 секунд");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  (async function boot() {
    try {
      me = await call("getMe");
      console.log("[bot] подключён: @" + me.username + (me.first_name ? " (" + me.first_name + ")" : ""));
      if (!process.env.TELEGRAM_BOT_USERNAME) {
        console.log("[bot] подсказка: задайте TELEGRAM_BOT_USERNAME=" + me.username + " для входа в браузере одной кнопкой");
      }
      loop();
    } catch (e) {
      console.error("[bot] не удалось подключиться («" + e.message + "»). " +
        "Сервис работает, но вход в браузере и напоминания недоступны.");
    }
  })();

  return {
    stop() { stopped = true; },
    get username() { return me && me.username; }
  };
}
