/**
 * Тесты настроек и подготовки бота к запуску на своём компьютере.
 *
 * Проверяем то, что легко сломать и трудно заметить: разбор файла .env и
 * аккуратные отказы, когда токена или адреса ещё нет.
 *
 * Запуск: node tests/env.test.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../tools/env.js";
import { setupBot } from "../tools/setup-bot.js";

let passed = 0, failed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}

console.log("DebtFree — тесты настроек\n");

/** Создаёт временную папку с файлом .env и убирает за собой. */
function withEnvFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debtfree-env-"));
  const keys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "PUBLIC_URL", "PORT", "DATA_DIR", "DF_TEST_KEY"];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  try {
    if (content !== null) fs.writeFileSync(path.join(dir, ".env"), content, "utf8");
    return fn(dir);
  } finally {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* не критично */ }
  }
}

console.log("1. Файл .env");
{
  withEnvFile([
    "# комментарий",
    "",
    "TELEGRAM_BOT_TOKEN=123456:AAHfake",
    "TELEGRAM_BOT_USERNAME=my_debtfree_bot",
    "PORT=8080",
    'PUBLIC_URL="https://example.com/"',
    "  DF_TEST_KEY = со пробелами  "
  ].join("\n"), function (dir) {
    const info = loadEnv(dir);
    eq("файл найден", info.loaded, true);
    eq("токен прочитан", process.env.TELEGRAM_BOT_TOKEN, "123456:AAHfake");
    eq("имя бота прочитано", process.env.TELEGRAM_BOT_USERNAME, "my_debtfree_bot");
    eq("порт прочитан", process.env.PORT, "8080");
    eq("кавычки сняты", process.env.PUBLIC_URL, "https://example.com/");
    eq("пробелы вокруг значения убраны", process.env.DF_TEST_KEY, "со пробелами");
    ok("список прочитанных ключей есть", Array.isArray(info.keys) && info.keys.length >= 5);
  });

  withEnvFile(null, function (dir) {
    const info = loadEnv(dir);
    eq("без файла — не падает", info.loaded, false);
  });

  withEnvFile("мусор без равно\n=без ключа\nTELEGRAM_BOT_TOKEN=ok", function (dir) {
    loadEnv(dir);
    eq("битые строки пропускаются", process.env.TELEGRAM_BOT_TOKEN, "ok");
  });

  /* Значения из окружения важнее файла: так удобно для systemd и CI */
  withEnvFile("TELEGRAM_BOT_TOKEN=из-файла", function (dir) {
    process.env.TELEGRAM_BOT_TOKEN = "из-окружения";
    loadEnv(dir);
    eq("окружение имеет приоритет", process.env.TELEGRAM_BOT_TOKEN, "из-окружения");
  });

  withEnvFile("TELEGRAM_BOT_TOKEN='одинарные кавычки'", function (dir) {
    loadEnv(dir);
    eq("одинарные кавычки тоже снимаются", process.env.TELEGRAM_BOT_TOKEN, "одинарные кавычки");
  });
}

console.log("\n2. Настройка бота: аккуратные отказы");
{
  const res1 = await setupBot({ token: "", url: "https://example.com" });
  eq("без токена — понятная причина", res1.error, "no_token");
  ok("и сообщения об ошибке наружу не летит", !res1.message);

  const res2 = await setupBot({ token: "123:ABC", url: "" });
  eq("без адреса — понятная причина", res2.error, "no_url");

  const res3 = await setupBot({ token: "123:ABC", url: "https://example.com" });
  eq("фиктивный токен не проходит", res3.ok, false);
  eq("причина — токен отвергнут", res3.error, "token_rejected");
  ok("сообщение Telegram передано как есть", typeof res3.message === "string" && res3.message.length > 0, res3.message);

  /* Проверка live-поведения: Telegram либо недоступен, либо отвергает фиктивный токен.
     В обоих случаях функция обязана вернуть понятный отказ, а не выбросить исключение. */
  const live = await setupBot({ token: "123456:FAKE_TOKEN_FOR_TEST", url: "https://example.com" });
  ok("фиктивный токен не проходит", live.ok === false, JSON.stringify(live));
  ok("причина названа", live.error === "token_rejected" || live.error === "network", live.error);
  if (live.error === "token_rejected") {
    ok("сообщение Telegram передано", typeof live.message === "string" && live.message.length > 0, live.message);
  }
}

console.log("\n3. Разбор настроек туннеля");
{
  const { parseTunnelArgs, providerCommand, urlFromText, PROVIDERS } = await import("../tools/tunnel-config.js");

  const dflt = parseTunnelArgs([], {});
  eq("провайдер по умолчанию", dflt.provider, "localtunnel");
  eq("порт по умолчанию", dflt.port, 8080);
  eq("таймаут по умолчанию", dflt.timeoutMs, 60000);

  eq("порт из окружения", parseTunnelArgs([], { PORT: "3000" }).port, 3000);
  eq("порт из аргумента важнее окружения", parseTunnelArgs(["--port=9000"], { PORT: "3000" }).port, 9000);
  eq("форма через пробел тоже работает", parseTunnelArgs(["--port", "9100"], {}).port, 9100);
  eq("мусор в порту заменяется на 8080", parseTunnelArgs(["--port=abc"], {}).port, 8080);
  eq("слишком большой порт отбрасывается", parseTunnelArgs(["--port=99999"], {}).port, 8080);
  eq("провайдер в нижнем регистре", parseTunnelArgs(["--provider=CloudFlared"], {}).provider, "cloudflared");
  eq("флаг --no-setup читается", parseTunnelArgs(["--no-setup"], {}).skipSetup, true);
  eq("слишком маленький таймаут поднимается до 5 секунд", parseTunnelArgs(["--timeout=100"], {}).timeoutMs, 5000);

  const lt = providerCommand("localtunnel", 8080);
  ok("localtunnel запускается на нужном порту", lt.cmd === "npx" && lt.args.includes("8080"));
  const cf = providerCommand("cloudflared", 8080);
  ok("cloudflared получает адрес сервера", /localhost:8080/.test(cf.args.join(" ")));
  const ng = providerCommand("ngrok", 8080);
  eq("ngrok получает порт", ng.args[ng.args.length - 1], "8080");
  const bad = providerCommand("чепуха", 8080);
  eq("неизвестный провайдер — ошибка с перечнем", bad.error, "unknown_provider");
  ok("в перечне все доступные", PROVIDERS.every((p) => bad.available.includes(p)));

  eq("адрес localtunnel распознаётся",
    urlFromText("your url is: https://fast-cat-42.loca.lt"), "https://fast-cat-42.loca.lt");
  eq("http заменяется на https",
    urlFromText("http://fast-cat-42.loca.lt"), "https://fast-cat-42.loca.lt");
  eq("адрес cloudflared распознаётся",
    urlFromText("|  https://quiet-river-1234.trycloudflare.com  |"), "https://quiet-river-1234.trycloudflare.com");
  eq("адрес ngrok распознаётся",
    urlFromText("Forwarding  https://ab12-34-56.ngrok-free.app -> http://localhost:8080"),
    "https://ab12-34-56.ngrok-free.app");
  eq("в обычном тексте адреса нет", urlFromText("просто сообщение без ссылки"), null);
  eq("ссылка на чужой домен не подходит", urlFromText("https://example.com"), null);
  eq("пустой вывод не ломает разбор", urlFromText(""), null);
}

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
