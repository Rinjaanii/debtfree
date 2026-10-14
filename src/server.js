/**
 * DebtFree — сервер.
 *
 * Один сервис, два входа — данные одни и те же:
 *   • Telegram Mini App: клиент присылает подписанный initData, сервер проверяет подпись;
 *   • обычный браузер: одноразовый код, подтверждение в Telegram, сессионная кука.
 *
 * В обоих случаях сервер знает только одно — идентификатор пользователя Telegram,
 * и работает исключительно с его данными.
 *
 * Запуск:  TELEGRAM_BOT_TOKEN=123:ABC npm start
 * Без токена — режим разработки: подпись не проверяется, удобно отлаживать.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  verifyInitData, initDataFromHeaders, shortUser,
  SessionStore, sessionTokenFromHeaders, sessionCookie, clearCookie, COOKIE
} from "./auth.js";
import { startBot } from "./bot.js";
import { buildIfNeeded } from "../tools/build.js";
import { loadEnv } from "../tools/env.js";
import { compareStrategies, whatIf, budgetGrid, validateDebts, normalizeDebt, r2, num } from "./calc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/* Настройки можно хранить в файле debtfree/.env: токен, имя бота, порт, адрес.
   Значения из окружения имеют приоритет — удобно для systemd и CI. */
const envInfo = loadEnv(ROOT);
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
/* Режим разработки включается либо отсутствием токена, либо флагом --dev:
   так можно посмотреть интерфейс локально, не трогая .env с настоящим токеном. */
const FORCE_DEV = process.argv.includes("--dev");
const DEV_MODE = FORCE_DEV || !BOT_TOKEN;
const MAX_BODY = 512 * 1024;

const sessions = new SessionStore();

/* ------------------------------------------------------------------ хранилище */

const emptyStore = { users: {}, debts: {}, plans: {} };
let store = structuredClone(emptyStore);
let saveTimer = null;

async function loadStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const raw = await fsp.readFile(STORE_FILE, "utf8");
    store = Object.assign(structuredClone(emptyStore), JSON.parse(raw));
    console.log("[store] пользователей: " + Object.keys(store.users).length +
                ", с долгами: " + Object.keys(store.debts).filter((id) => (store.debts[id] || []).length).length);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[store] не удалось прочитать " + STORE_FILE + ": " + e.message);
  }
}

/** Сохраняем с небольшой задержкой: при вводе записи идут пачками. */
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(async function () {
    saveTimer = null;
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = STORE_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
      await fsp.rename(tmp, STORE_FILE);
    } catch (e) {
      console.error("[store] ошибка записи: " + e.message);
    }
  }, 300);
}

/* ------------------------------------------------------------------ пользователи */

function newId(prefix) { return (prefix || "id") + crypto.randomBytes(6).toString("hex"); }

function defaultPlan() {
  return { budget: 0, strategy: "avalanche", extra: 0, extraMonth: 3, growth: 0, updatedAt: new Date().toISOString() };
}

function ensureUser(tgUser) {
  const id = String(tgUser.id);
  const existing = store.users[id];
  if (!existing) {
    store.users[id] = {
      id: id,
      username: tgUser.username || null,
      firstName: tgUser.first_name || tgUser.firstName || null,
      lastName: tgUser.last_name || tgUser.lastName || null,
      languageCode: tgUser.language_code || null,
      createdAt: new Date().toISOString()
    };
    store.debts[id] = [];
    store.plans[id] = defaultPlan();
    saveStore();
    console.log("[user] новый: " + shortUser(tgUser));
  } else {
    let changed = false;
    const next = {
      username: tgUser.username || null,
      firstName: tgUser.first_name || tgUser.firstName || null,
      lastName: tgUser.last_name || tgUser.lastName || null
    };
    if (existing.username !== next.username) { existing.username = next.username; changed = true; }
    if (existing.firstName !== next.firstName) { existing.firstName = next.firstName; changed = true; }
    if (existing.lastName !== next.lastName) { existing.lastName = next.lastName; changed = true; }
    if (changed) saveStore();
  }
  return store.users[id];
}

function displayName(userId) {
  const u = store.users[userId];
  if (!u) return "Пользователь";
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || (u.username ? "@" + u.username : "Пользователь");
}

/** Долги пользователя. Чужие сюда попасть не могут: ключ — проверенный user.id. */
function debtsOf(userId) {
  return (store.debts[userId] || []).map(function (d, i) {
    return Object.assign(normalizeDebt(d, i), { id: d.id });
  });
}

function planOf(userId) {
  return store.plans[userId] || defaultPlan();
}

function optsOf(plan) {
  const extras = [];
  if (num(plan.extra, 0) > 0) {
    extras.push({ month: Math.max(0, Math.round(num(plan.extraMonth, 3)) - 1), amount: num(plan.extra, 0) });
  }
  return { extras: extras, growth: num(plan.growth, 0) };
}

/** Сводка для интерфейса: вердикт, экономия, календарь, «а если платить больше». */
function buildSummary(debts, plan) {
  const budget = num(plan.budget, 0);
  const strategy = plan.strategy === "snowball" ? "snowball" : "avalanche";
  const opts = optsOf(plan);
  const comparison = compareStrategies(debts, budget, opts);
  const chosen = strategy === "snowball" ? comparison.snowball : comparison.avalanche;

  return {
    strategy: strategy,
    budget: budget,
    validation: validateDebts(debts, budget),
    plan: chosen,
    minimumOnly: comparison.minimumOnly,
    avalanche: comparison.avalanche,
    snowball: comparison.snowball,
    savings: strategy === "snowball" ? comparison.savings.snowball : comparison.savings.avalanche,
    avalancheVsSnowball: comparison.savings.avalancheVsSnowball,
    whatIf: whatIf(debts, budgetGrid(budget > 0 ? budget : Math.max(comparison.avalanche.minSum, 10000)), opts)
  };
}

/* ------------------------------------------------------------------ ответы */

function send(res, status, payload, headers) {
  const isText = typeof payload === "string";
  const body = isText ? payload : JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }, headers || {}));
  res.end(body);
}
function fail(res, status, error, extra) {
  send(res, status, Object.assign({ ok: false, error: error }, extra || {}));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}

/** Куку помечаем Secure, если запрос пришёл по HTTPS (важно за обратным прокси). */
function isSecureRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return !!(req.socket && req.socket.encrypted);
}

/* ------------------------------------------------------------------ маршруты */

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/?/, "");

  if (route === "health") {
    const stats = sessions.stats();
    return send(res, 200, {
      ok: true,
      mode: DEV_MODE ? "dev" : "telegram",
      botConfigured: !!BOT_USERNAME,
      users: Object.keys(store.users).length,
      sessions: stats.sessions
    });
  }

  /* --- авторизация: кто именно делает запрос --- */
  const auth = authenticate(req);

  if (route === "auth") {
    return send(res, 200, {
      ok: true,
      mode: DEV_MODE ? "dev" : "telegram",
      authenticated: !!auth.ok,
      method: auth.ok ? auth.method : null,
      botUsername: BOT_USERNAME || null,
      publicUrl: PUBLIC_URL || null,
      /* Вход в браузере возможен только в боевом режиме: в режиме разработки
         и так пускает тестовый пользователь. */
      webLogin: !DEV_MODE,
      standaloneFile: "/debtfree.html",
      loginTtlMinutes: Math.round(COOKIE.loginTtlMs / 60000),
      user: auth.ok ? { id: auth.user.id, name: displayName(auth.user.id) } : null
    });
  }

  if (route === "auth/login/start" && req.method === "POST") {
    const code = sessions.startLogin();
    const botUsername = BOT_USERNAME || null;
    return send(res, 200, {
      ok: true,
      code: code,
      botUsername: botUsername,
      deepLink: botUsername ? ("https://t.me/" + botUsername + "?start=" + code) : null,
      expiresInSeconds: Math.round(COOKIE.loginTtlMs / 1000)
    });
  }

  /* Тестовый хук: заменяет приход подтверждения из бота.
     Включается только переменной окружения — в боевом режиме его не существует. */
  if (route === "auth/login/confirm" && req.method === "POST" && process.env.DEBT_TESTS === "1") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return fail(res, 400, e.message); }
    const ok = sessions.confirmLogin(body.code, body.userId);
    return send(res, 200, { ok: ok, confirmed: ok });
  }

  if (route === "auth/login/check" && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return fail(res, 400, e.message); }
    const redeemed = sessions.redeemLogin(body.code);
    if (!redeemed) return send(res, 200, { ok: true, confirmed: false });

    // Пользователь должен существовать: сессия выдаётся только на известный аккаунт.
    if (!store.users[redeemed.userId]) {
      sessions.logout(redeemed.token);
      return send(res, 200, { ok: true, confirmed: false, error: "user_unknown" });
    }
    const secure = isSecureRequest(req);
    return send(res, 200, {
      ok: true,
      confirmed: true,
      user: { id: redeemed.userId, name: displayName(redeemed.userId) }
    }, { "Set-Cookie": sessionCookie(redeemed.token, secure) });
  }

  if (route === "auth/logout" && req.method === "POST") {
    const token = sessionTokenFromHeaders(req.headers);
    sessions.logout(token);
    return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie(isSecureRequest(req)) });
  }

  /* --- всё остальное требует авторизации --- */
  if (!auth.ok) {
    return fail(res, 401, auth.reason || "auth_required", {
      reason: auth.reason || "auth_required",
      hint: "Откройте сервис в Telegram или войдите в браузере по коду"
    });
  }

  const userId = auth.user.id;
  ensureUser(auth.user);

  if (route === "me") {
    return send(res, 200, {
      ok: true,
      authMethod: auth.method,
      /* Идентификатор всегда строка: у Telegram он числовой, в хранилище — строковый,
         и клиенту не должно быть дела до этой разницы. */
      user: { id: String(userId), name: displayName(userId), username: store.users[userId].username },
      plan: planOf(userId),
      debts: debtsOf(userId)
    });
  }

  if (route === "plan") {
    return send(res, 200, { ok: true, data: buildSummary(debtsOf(userId), planOf(userId)) });
  }

  if (route === "debts" && req.method !== "GET") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return fail(res, 400, e.message); }
    if (!Array.isArray(body.debts)) return fail(res, 400, "debts_must_be_array");
    if (body.debts.length > 200) return fail(res, 400, "too_many_debts");

    store.debts[userId] = body.debts.map(function (d, i) {
      const norm = normalizeDebt(d, i);
      norm.id = d.id && /^[a-zA-Z0-9_-]{4,32}$/.test(String(d.id)) ? String(d.id) : newId("dbt");
      return norm;
    });
    saveStore();
    return send(res, 200, { ok: true, debts: store.debts[userId] });
  }

  if (route === "profile" && req.method !== "GET") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return fail(res, 400, e.message); }
    const p = planOf(userId);
    if (body.budget !== undefined) p.budget = Math.max(0, r2(num(body.budget, p.budget)));
    if (body.strategy !== undefined) p.strategy = body.strategy === "snowball" ? "snowball" : "avalanche";
    if (body.extra !== undefined) p.extra = Math.max(0, r2(num(body.extra, 0)));
    if (body.extraMonth !== undefined) p.extraMonth = Math.max(1, Math.min(600, Math.round(num(body.extraMonth, 3))));
    if (body.growth !== undefined) p.growth = Math.max(0, Math.min(100, num(body.growth, 0)));
    p.updatedAt = new Date().toISOString();
    store.plans[userId] = p;
    saveStore();
    return send(res, 200, { ok: true, plan: p });
  }

  /** Полное удаление своих данных. */
  if (route === "data" && req.method === "DELETE") {
    store.debts[userId] = [];
    store.plans[userId] = defaultPlan();
    saveStore();
    console.log("[user] удалил свои данные: " + userId);
    return send(res, 200, { ok: true });
  }

  return fail(res, 404, "unknown_route", { route: route });
}

/**
 * Определяет пользователя по запросу.
 * Порядок: подпись Telegram (мини-аппа) → сессионная кука (веб-версия) → режим разработки.
 * Возвращает { ok, method, user } либо { ok: false, reason } — причину отказа
 * показываем клиенту, чтобы ему не пришлось гадать.
 */
function authenticate(req) {
  if (DEV_MODE) {
    const devId = (req.headers["x-dev-user"] && String(req.headers["x-dev-user"])) || "1";
    return { ok: true, method: "dev", user: { id: Number(devId), first_name: "Разработчик", username: "dev" } };
  }

  const initData = initDataFromHeaders(req.headers);
  if (initData) {
    const result = verifyInitData(initData, BOT_TOKEN);
    if (result.ok) return { ok: true, method: "telegram", user: result.user };
    console.warn("[auth] отказ по подписи: " + result.error);
    return { ok: false, reason: result.error };
  }

  const token = sessionTokenFromHeaders(req.headers);
  if (token) {
    const userId = sessions.resolve(token);
    if (userId) return { ok: true, method: "web", user: { id: Number(userId), first_name: displayName(userId) } };
    return { ok: false, reason: "session_invalid" };
  }

  return { ok: false, reason: "auth_required" };
}

/* ------------------------------------------------------------------ страница входа */

/**
 * Страница входа в браузере.
 * Показываем подсказку, если адрес ещё не подключён: иначе непонятно, почему
 * после подтверждения в Telegram браузер остаётся на экране входа.
 */
function loginPage() {
  const warning = PUBLIC_URL ? "" : `
  <p class="warn">
    На сервере не задан публичный адрес (<b>PUBLIC_URL</b>), поэтому Telegram не сможет
    вернуть вас на эту страницу. Запустите <b>node tools/tunnel.js</b> — он получит адрес
    и подставит его и в бота, и сюда.
  </p>`;
  return LOGIN_PAGE.replace("<!--DF_WARNING-->", warning);
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход в DebtFree</title>
<style>
  body { margin:0; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#eef1f7; color:#111a2e; display:flex; align-items:center; justify-content:center;
         min-height:100vh; padding:20px; }
  .card { background:#fff; border-radius:16px; padding:28px; max-width:420px; width:100%;
          box-shadow:0 10px 30px -18px rgba(17,26,46,.35); text-align:center; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#6b7994; font-size:14px; margin:0 0 18px; }
  button { width:100%; border:0; border-radius:12px; padding:14px; font-size:16px;
           background:#4f46e5; color:#fff; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; }
  .code { font-family:ui-monospace,Consolas,monospace; font-size:26px; letter-spacing:.18em;
          background:#f4f6fb; border-radius:12px; padding:14px; margin:16px 0; font-weight:600; }
  .muted { font-size:13px; color:#6b7994; }
  a { color:#4f46e5; }
  .ok { color:#0f9d6e; font-weight:600; }
  .err { color:#9b1c1c; }
  .warn { background:#fdf1dd; border:1px solid #f3d9a8; color:#8a5a06; border-radius:11px;
          padding:11px 13px; font-size:13px; text-align:left; }
  ol { text-align:left; color:#3d4a63; font-size:14px; padding-left:20px; }
  li { margin:6px 0; }
</style>
</head>
<body>
<div class="card" id="card">
  <h1>Вход в DebtFree</h1>
  <p>Подтвердите вход в Telegram — пароль не нужен.</p>
  <!--DF_WARNING-->
  <button id="go">Создать код входа</button>
</div>
<script>
  var card = document.getElementById("card");
  var go = document.getElementById("go");

  function show(html) { card.innerHTML = html; }

  async function start() {
    go.disabled = true;
    var res = await fetch("/api/auth/login/start", { method: "POST" });
    var data = await res.json();
    if (!data.ok) { show("<h1>Не получилось</h1><p>Попробуйте ещё раз.</p>"); return; }

    var html = "<h1>Подтвердите вход</h1>";
    if (data.deepLink) {
      html += "<ol>" +
        "<li>Откройте бота в Telegram по кнопке ниже.</li>" +
        "<li>Нажмите «Подтвердить вход» — бот ответит сразу.</li>" +
        "<li>Вернитесь на эту страницу: вход произойдёт автоматически.</li>" +
        "</ol>" +
        "<p><a href='" + data.deepLink + "' id='link'><button>Открыть Telegram</button></a></p>" +
        "<div class='code'>" + data.code + "</div>" +
        "<p class='muted'>Если кнопка не сработала, отправьте боту этот код командой <b>/start " + data.code + "</b></p>";
    } else {
      html += "<p>Настройте <b>TELEGRAM_BOT_USERNAME</b> на сервере, чтобы входить одной кнопкой. " +
              "Пока можно подтвердить код командой боту:</p>" +
              "<div class='code'>/start " + data.code + "</div>";
    }
    html += "<p class='muted' id='status'>Ждём подтверждения…</p>";
    show(html);

    var attempts = 0;
    var timer = setInterval(async function () {
      attempts++;
      if (attempts > 120) { clearInterval(timer); document.getElementById("status").textContent = "Код истёк, обновите страницу."; return; }
      try {
        var r = await fetch("/api/auth/login/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: data.code })
        });
        var j = await r.json();
        if (j.confirmed) {
          clearInterval(timer);
          document.getElementById("status").innerHTML = "<span class='ok'>Готово! Открываем…</span>";
          location.href = "/app";
        }
      } catch (e) { /* сеть моргнула — просто ждём дальше */ }
    }, 1500);
  }

  go.addEventListener("click", start);
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ статика */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

/** Проверяет, что запрошенный путь не выходит за пределы папки. */
function isInside(childPath, parentDir) {
  const rel = path.relative(parentDir, childPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Страницы, которые отдаются как интерфейс приложения. */
const APP_PAGES = ["/", "/app", "/app/", "/index.html"];

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (APP_PAGES.indexOf(rel) >= 0) rel = "/app.html";
  if (rel === "/web-login") return send(res, 200, loginPage(), { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });

  const filePath = path.resolve(PUBLIC_DIR, "." + path.posix.normalize("/" + rel));
  if (!isInside(filePath, PUBLIC_DIR)) return send(res, 403, "forbidden");

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return serveStatic(req, res, { pathname: path.posix.join(rel, "index.html") });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    // Неизвестный путь возвращаем как интерфейс только если это «страница»
    // без расширения. Файл с расширением, которого нет, честно даёт 404.
    if (!path.extname(rel)) {
      try {
        const html = await fsp.readFile(path.join(PUBLIC_DIR, "app.html"));
        return send(res, 200, html.toString("utf8"), { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      } catch (e2) { /* отдадим 404 ниже */ }
    }
    send(res, 404, "not_found");
  }
}

/** Модули, которые разрешено отдавать клиенту: список явный, серверный код — нет. */
const SHARED_MODULES = ["calc.js"];

async function serveSharedSource(res, url) {
  const name = url.pathname.replace(/^\/src\//, "");
  if (SHARED_MODULES.indexOf(name) < 0) return send(res, 404, "not_found");
  const filePath = path.join(__dirname, name);
  if (!isInside(filePath, __dirname)) return send(res, 404, "not_found");
  try {
    const code = await fsp.readFile(filePath, "utf8");
    send(res, 200, code, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
  } catch (e) {
    send(res, 404, "not_found");
  }
}

/* ------------------------------------------------------------------ запуск */

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  /* Приводим путь к каноническому виду ДО маршрутизации: попытки выйти за пределы
     разрешённых папок не совпадут ни с одним маршрутом и получат 404. */
  url.pathname = path.posix.normalize(decodeURIComponent(url.pathname));
  if (!url.pathname.startsWith("/")) url.pathname = "/" + url.pathname;
  if (url.pathname.includes("\0")) return send(res, 400, "bad_path");

  if (req.method === "OPTIONS") {
    return send(res, 204, "", { "Allow": "GET,POST,DELETE,OPTIONS" });
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch(function (e) {
      console.error("[api] " + (e && e.stack || e));
      if (!res.headersSent) fail(res, 500, "internal_error");
    });
    return;
  }
  if (url.pathname.startsWith("/src/")) {
    serveSharedSource(res, url).catch(function () { send(res, 500, "internal_error"); });
    return;
  }
  serveStatic(req, res, url).catch(function () { send(res, 500, "internal_error"); });
});

await loadStore();

/* Если шаблон интерфейса или ядро новее сборки — собираем на месте:
   так «забыл пересобрать» не превращается в непонятную ошибку в браузере. */
try {
  buildIfNeeded((msg) => console.log("[build] " + msg));
} catch (e) {
  console.error("[build] не удалось собрать страницы: " + e.message);
}

/* Бот нужен для подтверждения веб-входа и позже — для напоминаний.
   В режиме разработки (--dev) его не запускаем: иначе он начал бы опрашивать
   Telegram параллельно с боевой версией, и они отбирали бы обновления друг у друга. */
const bot = startBot({
  token: DEV_MODE ? "" : BOT_TOKEN,
  sessions: sessions,
  async onUser(user) { ensureUser(user); },
  displayName: displayName
});

server.listen(PORT, HOST, function () {
  const mode = DEV_MODE
    ? ("РЕЖИМ РАЗРАБОТКИ" + (FORCE_DEV ? " (включён флагом --dev)" : " (токен не задан)"))
    : "боевой режим (проверка подписи Telegram)";
  console.log("DebtFree: http://localhost:" + PORT + "  — " + mode);
  if (envInfo.loaded) console.log("  настройки: .env (" + (envInfo.keys || []).join(", ") + ")");

  if (DEV_MODE) {
    console.log("\nДля быстрого просмотра откройте в браузере: http://localhost:" + PORT);
    console.log("Вы войдёте автоматически как тестовый пользователь «Разработчик».");
    console.log("\nЧтобы запустить по-настоящему (мини-аппа в Telegram), укажите в .env:");
    console.log("  TELEGRAM_BOT_TOKEN=...      токен от @BotFather");
    console.log("  TELEGRAM_BOT_USERNAME=...   имя бота без @");
    console.log("  PUBLIC_URL=https://...      домен (или туннель)");
    console.log("и запустите без флага --dev.");
  } else {
    console.log("Бот: @" + (BOT_USERNAME || "без имени (задайте TELEGRAM_BOT_USERNAME)"));
    if (PUBLIC_URL) {
      console.log("Публичный адрес: " + PUBLIC_URL);
      console.log("  мини-аппа: " + PUBLIC_URL + "/app    вход в браузере: " + PUBLIC_URL + "/web-login");
    } else {
      console.log("\nПубличного адреса нет: мини-аппа из Telegram не откроется, пока его не будет.");
      console.log("Это и есть случай для VPS с доменом (см. DEPLOY.md).");
    }
  }
});

process.on("SIGINT", function () {
  console.log("\nОстановлено.");
  if (bot) bot.stop();
  process.exit(0);
});
