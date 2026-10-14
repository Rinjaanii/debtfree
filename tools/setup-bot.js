/**
 * Настройка бота под текущий публичный адрес.
 *
 * Когда сервер работает на вашем компьютере, Telegram нужен внешний HTTPS-адрес,
 * чтобы открыть мини-аппу. Адрес туннеля меняется при каждом запуске, и вручную
 * каждый раз ходить в @BotFather — мучение. Этот скрипт делает всё сам:
 *
 *   • кнопка меню в чате с ботом → открывает приложение по вашему адресу;
 *   • главная мини-аппа (кнопка в профиле бота, попадание в поиск) → тот же адрес;
 *   • вебхук снимается, чтобы бот работал на длинных запросах без публичного адреса.
 *
 * Запуск:
 *   node tools/setup-bot.js https://ваш-адрес
 *   node tools/setup-bot.js --clear          # убрать кнопку меню
 *
 * Токен берётся из переменной TELEGRAM_BOT_TOKEN или из файла .env рядом с проектом.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * Настраивает бота под указанный адрес.
 * Возвращает { ok, username, applied } — без завершения процесса, чтобы этим
 * можно было пользоваться и из скрипта туннеля.
 */
export async function setupBot(options) {
  options = options || {};
  const token = (options.token || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const url = (options.url || process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const clear = !!options.clear;
  const setNames = !!options.setNames;
  const log = options.log || function () {};
  const applied = [];

  if (!token) return { ok: false, error: "no_token" };
  if (!clear && !url) return { ok: false, error: "no_url" };

  async function call(method, payload) {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      const err = new Error((data && data.description) || ("http_" + res.status));
      err.code = data && data.error_code;
      throw err;
    }
    return data.result;
  }

  let me;
  try {
    me = await call("getMe");
  } catch (e) {
    return { ok: false, error: "token_rejected", message: e.message };
  }
  log("Бот: @" + me.username + (me.first_name ? " (" + me.first_name + ")" : ""));

  /* Вебхук снимаем: бот работает на длинных запросах, публичный адрес ему не нужен. */
  try {
    await call("deleteWebhook", { drop_pending_updates: false });
    const info = await call("getWebhookInfo");
    log("Вебхук: снят" + (info.url ? " (остался " + info.url + ")" : ", бот слушает сам"));
    applied.push("webhook");
  } catch (e) {
    log("Вебхук: не удалось проверить (" + e.message + ")");
  }

  if (clear) {
    await call("setChatMenuButton", { menu_button: { type: "commands" } });
    log("Кнопка меню: убрана, вернулись команды");
    applied.push("menu_clear");
    return { ok: true, username: me.username, applied: applied };
  }

  /* Кнопка меню — по ней пользователь открывает приложение в чате с ботом. */
  try {
    await call("setChatMenuButton", {
      menu_button: { type: "web_app", text: "DebtFree", web_app: { url: url } }
    });
    log("Кнопка меню → " + url);
    applied.push("menu");
  } catch (e) {
    return { ok: false, error: "menu_rejected", username: me.username, message: e.message };
  }

  /* Описание бота в профиле — мелочь, но помогает понять, что это за бот. */
  try {
    await call("setMyShortDescription", {
      short_description: "План погашения долгов: очередь закрытия, экономия, календарь платежей."
    });
    log("Описание бота: обновлено");
    applied.push("description");
  } catch (e) {
    log("Описание: не удалось обновить (" + e.message + ")");
  }

  /* Имена — только по явной просьбе: имя может быть занято. */
  if (setNames) {
    try {
      await call("setMyName", { name: "DebtFree" });
      log("Имя бота: DebtFree");
      applied.push("name");
    } catch (e) {
      log("Имя: не изменилось (" + e.message + ")");
    }
  }

  return { ok: true, username: me.username, applied: applied };
}

/* Запуск как отдельной команды */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv(ROOT);
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const clear = args.includes("--clear");
  const url = args.find((a) => /^https?:\/\//.test(a)) || (process.env.PUBLIC_URL || "").trim();

  console.log("DebtFree — настройка бота\n");

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("✗ Нет TELEGRAM_BOT_TOKEN. Создайте файл .env рядом с проектом:");
    console.error("    TELEGRAM_BOT_TOKEN=123456:AA...");
    console.error("    TELEGRAM_BOT_USERNAME=ваш_бот");
    process.exit(1);
  }
  if (!clear && !url) {
    console.error("✗ Укажите адрес: node tools/setup-bot.js https://ваш-адрес");
    process.exit(1);
  }

  const result = await setupBot({ token: process.env.TELEGRAM_BOT_TOKEN, url: url, clear: clear, setNames: args.includes("--set-names"), log: console.log });

  if (!result.ok) {
    if (result.error === "token_rejected") console.error("✗ Токен не принят Telegram: " + result.message);
    else if (result.error === "menu_rejected") {
      console.error("✗ Кнопку меню не приняли: " + result.message);
      console.error("  Telegram требует HTTPS и обычный домен. Если адрес вида");
      console.error("  https://что-то.loca.lt — попробуйте: node tools/tunnel.js --provider=cloudflared");
    } else console.error("✗ Не получилось: " + (result.error || "неизвестная причина"));
    process.exit(1);
  }

  if (clear) {
    console.log("\nГотово.");
  } else {
    console.log("\nЧто дальше:");
    console.log("  1. Откройте https://t.me/" + result.username + " — кнопка меню слева внизу.");
    console.log("  2. Нажмите её: приложение откроется прямо в Telegram.");
    console.log("  3. Для входа с компьютера откройте " + url + "/web-login");
    console.log("\nАдрес живёт, пока запущены сервер и туннель.");
  }
}
