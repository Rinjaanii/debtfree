/**
 * Публичный адрес для мини-аппы, когда сервер работает на вашем компьютере.
 *
 * Telegram открывает приложение по HTTPS-адресу и до «localhost» дотянуться не может,
 * поэтому нужен туннель: он выдаёт внешний адрес и передаёт запросы вашему серверу.
 * Бот при этом работает без туннеля — он сам опрашивает Telegram (длинные запросы),
 * публичный адрес нужен только приложению.
 *
 * Что делает скрипт:
 *   1. поднимает туннель к вашему порту (по умолчанию 8080);
 *   2. дожидается внешнего адреса;
 *   3. прописывает его в бота: кнопка меню в чате и главная мини-аппа.
 *
 * Запуск:
 *   node tools/tunnel.js                       # localtunnel, порт из .env или 8080
 *   node tools/tunnel.js --provider=cloudflared
 *   node tools/tunnel.js --provider=ngrok --port=8080
 *   node tools/tunnel.js --no-setup            # только адрес, без настройки бота
 *
 * Сервер должен быть уже запущен: npm start
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";
import { parseTunnelArgs, providerCommand, urlFromText, PROVIDERS } from "./tunnel-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv(ROOT);

const opts = parseTunnelArgs(process.argv.slice(2), process.env);
const PROVIDER = opts.provider;
const PORT = opts.port;
const SKIP_SETUP = opts.skipSetup;
const TIMEOUT_MS = opts.timeoutMs;

/** Команда для выбранного провайдера. */
function makeCommand() {
  return providerCommand(PROVIDER, PORT);
}

/** Команда для выбранного провайдера. */
function providerCommand() {
  if (PROVIDER === "localtunnel" || PROVIDER === "lt") {
    return { cmd: "npx", args: ["--yes", "localtunnel", "--port", String(PORT)], kind: "localtunnel" };
  }
  if (PROVIDER === "cloudflared") {
    return { cmd: "npx", args: ["--yes", "cloudflared", "tunnel", "--url", "http://localhost:" + PORT], kind: "cloudflared" };
  }
  if (PROVIDER === "ngrok") {
    return { cmd: "npx", args: ["--yes", "ngrok", "http", String(PORT)], kind: "ngrok" };
  }
  return null;
}

/** На Windows npx — это .cmd, и запускать его надо через оболочку. */
function spawnCommand(cmd, cmdArgs) {
  const isWindows = process.platform === "win32";
  if (isWindows && (cmd === "npx" || cmd === "npx.cmd")) {
    const quoted = cmdArgs.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", "npx " + quoted], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }
  return spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
}

const run = makeCommand();
if (run.error) {
  console.error("✗ Неизвестный провайдер: " + PROVIDER);
  console.error("  Доступны: " + PROVIDERS.join(", ") + " (по умолчанию localtunnel)");
  console.error("\nИли поднимите туннель сами и подставьте адрес:");
  console.error("  npx --yes localtunnel --port " + PORT);
  console.error("  node tools/setup-bot.js https://полученный-адрес");
  process.exit(1);
}

console.log("DebtFree — публичный адрес для приложения\n");
console.log("Провайдер: " + run.kind + ", порт: " + PORT);
console.log("Проверьте, что сервер уже запущен: npm start\n");

let child;
try {
  child = spawnCommand(run.cmd, run.args);
} catch (e) {
  console.error("✗ Не удалось запустить туннель: " + e.message);
  console.error("  Запустите вручную: npx --yes localtunnel --port " + PORT);
  console.error("  и затем: node tools/setup-bot.js https://полученный-адрес");
  process.exit(1);
}

let output = "";
let publicUrl = null;
let finished = false;

child.stdout.on("data", (d) => { output += d.toString(); });
child.stderr.on("data", (d) => { output += d.toString(); });
child.on("error", function (e) {
  console.error("✗ Туннель не запустился: " + e.message);
  console.error("  Похоже, нет доступа к npm или к сети. Запустите вручную:");
  console.error("    npx --yes localtunnel --port " + PORT);
  process.exit(1);
});

/** localtunnel показывает свой адрес в локальном API — это надёжнее разбора вывода. */
async function askLocaltunnelApi() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = await res.json();
    const t = (data.tunnels || [])[0];
    if (t && t.public_url) return t.public_url.replace(/^http:/, "https:");
  } catch (e) { /* API недоступен — читаем вывод */ }
  return null;
}

function urlFromOutput() {
  return urlFromText(output);
}

const started = Date.now();
const timer = setInterval(async function () {
  if (finished) return;

  if (run.kind === "localtunnel") {
    const fromApi = await askLocaltunnelApi();
    if (fromApi) publicUrl = fromApi;
  }
  if (!publicUrl) publicUrl = urlFromOutput();

  if (publicUrl) {
    finished = true;
    clearInterval(timer);
    await onReady(publicUrl);
    return;
  }

  if (Date.now() - started > TIMEOUT_MS) {
    finished = true;
    clearInterval(timer);
    console.error("\n✗ Не дождались публичного адреса за " + Math.round(TIMEOUT_MS / 1000) + " с.");
    if (output.trim()) console.error("\nЧто ответил туннель:\n" + output.trim().split("\n").slice(-6).join("\n"));
    console.error("\nПопробуйте другой провайдер:");
    console.error("  node tools/tunnel.js --provider=cloudflared");
    console.error("или запустите вручную и подставьте адрес:");
    console.error("  npx --yes localtunnel --port " + PORT);
    console.error("  node tools/setup-bot.js https://полученный-адрес");
    stop(1);
  }
}, 1500);

async function onReady(url) {
  console.log("✓ Публичный адрес: " + url + "\n");

  if (!SKIP_SETUP) {
    const { setupBot } = await import("./setup-bot.js");
    const result = await setupBot({
      token: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
      url: url,
      log: (msg) => console.log(msg)
    });

    if (!result.ok) {
      if (result.error === "no_token") {
        console.log("Токен бота не задан, поэтому кнопку меню пропускаем.");
        console.log("Добавьте в .env строку TELEGRAM_BOT_TOKEN=... и запустите этот скрипт снова.");
      } else if (result.error === "token_rejected") {
        console.log("✗ Telegram не принял токен: " + result.message);
      } else if (result.error === "menu_rejected") {
        console.log("✗ Кнопку меню не приняли: " + result.message);
        console.log("  Этот провайдер туннеля не подошёл. Попробуйте:");
        console.log("    node tools/tunnel.js --provider=cloudflared");
        console.log("  или вручную: node tools/setup-bot.js " + url);
      }
    } else {
      console.log("\nБот настроен: кнопка меню ведёт на " + url);
      console.log("Откройте https://t.me/" + result.username + " и нажмите кнопку меню.");
    }
  } else {
    console.log("Настройка бота пропущена (--no-setup).");
    console.log("Подставить адрес вручную: node tools/setup-bot.js " + url);
  }

  console.log("\n" + "─".repeat(58));
  console.log("Туннель работает. Не закрывайте это окно, пока пользуетесь приложением.");
  console.log("Вход с компьютера: " + url + "/web-login");
  console.log("Остановить: Ctrl+C");
  console.log("─".repeat(58));
}

function stop(code) {
  try { child.kill(); } catch (e) { /* уже остановлен */ }
  process.exit(code || 0);
}

process.on("SIGINT", function () {
  console.log("\nОстанавливаем туннель…");
  stop(0);
});
