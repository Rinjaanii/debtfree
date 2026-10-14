/**
 * Интеграционный тест: поднимает сервер в режиме разработки и работает с ним
 * по HTTP так же, как это делают мини-аппа и браузер.
 *
 * Проверяется главное для сервиса на несколько человек:
 *   • вход по подписи Telegram и вход по сессии браузера;
 *   • изоляция данных: пользователи не видят долгов друг друга;
 *   • в боевом режиме без подтверждения входа доступа нет;
 *   • раздача файлов: серверный код наружу не уходит.
 *
 * Запуск: node tests/server.test.js
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8123;
const BASE = "http://127.0.0.1:" + PORT;
const BOT_TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";

let passed = 0, failed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "debtfree-test-"));
const logFile = path.join(dataDir, "server.log");
console.log("DebtFree — интеграционные тесты сервера");
console.log("(временная папка данных: " + dataDir + ")\n");

/** Запускает сервер отдельным процессом; вывод пишем в файл. */
function startServer(env) {
  const out = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }, env || {}),
    stdio: ["ignore", out, out]
  });
  child.on("error", (e) => { console.error("не удалось запустить сервер: " + e.message); });
  return child;
}
function serverLog() {
  try { return fs.readFileSync(logFile, "utf8"); } catch (e) { return ""; }
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(BASE + "/api/health");
      if (res.ok) return true;
    } catch (e) { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function call(pathname, options) {
  options = options || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (options.user) headers["X-Dev-User"] = String(options.user);
  if (options.cookie) headers["Cookie"] = options.cookie;
  const res = await fetch(BASE + "/api/" + pathname, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data: data, headers: res.headers };
}

/** Собирает подписанный initData так же, как Telegram. */
function signInitData(params, token) {
  const pairs = Object.keys(params).map((k) => k + "=" + params[k]).sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  return new URLSearchParams(Object.assign({}, params, { hash })).toString();
}

const DEMO = [
  { id: "d1", name: "Кредитная карта", amount: 350000, rate: 32.0, minPay: 18000, term: 36, dueDay: 5 },
  { id: "d2", name: "Потребительский", amount: 420000, rate: 19.5, minPay: 14500, term: 48, dueDay: 12 },
  { id: "d3", name: "Автокредит", amount: 640000, rate: 14.2, minPay: 19500, term: 60, dueDay: 20 },
  { id: "d4", name: "Рассрочка", amount: 78000, rate: 0, minPay: 6500, term: 12, dueDay: 8 },
  { id: "d5", name: "Долг другу", amount: 50000, rate: 0, minPay: 5000, term: 10, dueDay: 25 }
];

let server = startServer({ TELEGRAM_BOT_TOKEN: "" });

try {
  const up = await waitForServer();
  if (!up) {
    console.log("Сервер не поднялся. Лог:\n" + serverLog());
    process.exit(1);
  }

  console.log("1. Служебные маршруты и раздача файлов");
  {
    const health = await call("health");
    eq("health отвечает", health.status, 200);
    eq("режим разработки", health.data.mode, "dev");
    ok("сервер сообщает о старте", /РЕЖИМ РАЗРАБОТКИ/.test(serverLog()));

    const pages = [
      ["/", "интерфейс приложения"],
      ["/app", "короткая ссылка /app"],
      ["/web-login", "страница входа в браузере"],
      ["/app.js", "клиент"],
      ["/src/calc.js", "общее ядро"],
      ["/debtfree.html", "автономный файл для скачивания"]
    ];
    for (const [url, label] of pages) {
      const res = await fetch(BASE + url);
      ok("отдаётся: " + label + " (" + url + ")", res.status === 200, "код " + res.status);
    }

    /* Стили встроены в страницу, отдельного файла быть не должно:
       если он вдруг отдаётся — значит страница осталась от старой сборки. */
    eq("отдельного style.css больше нет", (await fetch(BASE + "/style.css")).status, 404);

    const appPage = await (await fetch(BASE + "/app")).text();
    ok("стили встроены в страницу", appPage.includes("<style>") && appPage.includes("--tg-theme"));
    ok("клиент подключён модулем", appPage.includes('type="module"') && appPage.includes("./app.js"));

    const loginPage = await (await fetch(BASE + "/web-login")).text();
    ok("страница входа содержит кнопку", loginPage.includes("Создать код входа"));
    ok("страница входа не раскрывает серверный код", !loginPage.includes("BOT_TOKEN"));

    const missing = await fetch(BASE + "/missing.js");
    eq("нет файла с расширением — 404", missing.status, 404);
    const spa = await fetch(BASE + "/some/deep/path");
    eq("путь без расширения отдаёт интерфейс", spa.status, 200);

    for (const url of ["/src/server.js", "/src/auth.js", "/src/bot.js", "/src/../src/server.js", "/%2e%2e/src/auth.js"]) {
      const res = await fetch(BASE + url);
      const body = res.status === 200 ? await res.text() : "";
      const leaks = body.includes("BOT_TOKEN") || body.includes("verifyInitData") || body.includes("timingSafeEqual");
      ok("закрыт доступ к серверному коду: " + url, res.status === 404 && !leaks, "код " + res.status + (leaks ? ", УТЕЧКА" : ""));
    }
  }

  console.log("\n2. Первый вход и сохранение долгов");
  {
    const me = await call("me", { user: 111 });
    eq("вход выполнен", me.status, 200);
    eq("долгов нет", me.data.debts.length, 0);
    eq("бюджет по умолчанию 0", me.data.plan.budget, 0);
    eq("способ входа — разработка", me.data.authMethod, "dev");

    const saved = await call("debts", { user: 111, method: "POST", body: { debts: DEMO } });
    eq("долги сохранены", saved.status, 200);
    eq("их ровно 5", saved.data.debts.length, 5);
    ok("каждому выдан id", saved.data.debts.every((d) => typeof d.id === "string" && d.id.length > 4));

    const bad = await call("debts", { user: 111, method: "POST", body: { debts: "не массив" } });
    eq("неверный формат отклонён", bad.status, 400);
    const many = await call("debts", { user: 111, method: "POST", body: { debts: new Array(300).fill(DEMO[0]) } });
    eq("слишком много долгов отклонено", many.status, 400);
  }

  console.log("\n3. Расчёт плана");
  {
    const prof = await call("profile", { user: 111, method: "POST", body: { budget: 75000 } });
    eq("бюджет сохранён", prof.data.plan.budget, 75000);

    const planRes = await call("plan", { user: 111 });
    eq("план посчитан", planRes.status, 200);
    const plan = planRes.data.data;
    const p = plan.plan;
    eq("долг на старте верный", p.startTotal, 1538000);
    ok("срок положительный", p.period > 0 && p.period < 600, p.period + " мес.");
    ok("есть дата свободы", typeof p.freeMonthLabel === "string" && p.freeMonthLabel.length > 0);
    ok("экономия положительная", plan.savings.interest > 0, String(plan.savings.interest));
    ok("календарь помесячный присутствует", Array.isArray(p.months) && p.months.length === p.period);
    ok("сценарии «если больше» посчитаны", Array.isArray(plan.whatIf) && plan.whatIf.length >= 3);
    ok("в сценариях есть текущий бюджет", plan.whatIf.some((w) => w.budget === 75000));
    ok("бухгалтерия сходится", p.months.every((m) => Math.abs(m.payment - m.interest - m.principal) < 0.02));

    await call("profile", { user: 111, method: "POST", body: { strategy: "snowball" } });
    const plan2 = (await call("plan", { user: 111 })).data.data;
    eq("стратегия переключилась", plan2.strategy, "snowball");
    ok("снежный ком дороже или равен лавине", plan2.plan.totalInterest >= p.totalInterest - 1,
      "ком " + plan2.plan.totalInterest + " vs лавина " + p.totalInterest);
    await call("profile", { user: 111, method: "POST", body: { strategy: "avalanche" } });
  }

  console.log("\n4. Изоляция данных между пользователями");
  {
    const other = await call("me", { user: 222 });
    eq("второй пользователь вошёл", other.status, 200);
    eq("он не видит чужих долгов", other.data.debts.length, 0);
    eq("его план пустой", (await call("plan", { user: 222 })).data.data.plan.items.length, 0);

    await call("debts", { user: 222, method: "POST", body: { debts: [{ name: "Его долг", amount: 100000, rate: 10, minPay: 5000 }] } });
    const me = await call("me", { user: 111 });
    eq("первый не получил чужой долг", me.data.debts.length, 5);
    ok("и не потерял свои", me.data.debts.some((d) => d.name === "Кредитная карта"));

    const his = await call("me", { user: 222 });
    eq("второй видит только свой долг", his.data.debts.length, 1);
    eq("и именно свой", his.data.debts[0].name, "Его долг");

    await call("debts", { user: 333, method: "POST", body: { debts: [{ id: "d1", name: "Подмена", amount: 1, rate: 0, minPay: 1 }] } });
    eq("чужой id не даёт доступа", (await call("me", { user: 111 })).data.debts.length, 5);
  }

  console.log("\n5. Удаление своих данных");
  {
    const del = await call("data", { user: 222, method: "DELETE" });
    eq("удаление прошло", del.status, 200);
    const his = await call("me", { user: 222 });
    eq("его долги удалены", his.data.debts.length, 0);
    eq("настройки сброшены", his.data.plan.budget, 0);
    eq("данные другого не тронуты", (await call("me", { user: 111 })).data.debts.length, 5);
  }

  console.log("\n6. Вход в браузере: подготовка кода");
  {
    const info = await call("auth", { user: 111 });
    eq("в режиме разработки веб-вход не предлагается", info.data.webLogin, false);
    eq("но ссылка на автономный файл есть", info.data.standaloneFile, "/debtfree.html");

    const start = await call("auth/login/start", { method: "POST", body: {} });
    eq("код создаётся", start.status, 200);
    ok("код нужной длины и без похожих символов", /^[A-CDEF-HJ-NP-RT-Y3-9]{8}$/.test(start.data.code), start.data.code);
    eq("код действует 10 минут", start.data.expiresInSeconds, 600);
    eq("без имени бота ссылки нет", start.data.deepLink, null);

    const check = await call("auth/login/check", { method: "POST", body: { code: start.data.code } });
    eq("неподтверждённый код не даёт сессию", check.data.confirmed, false);
    ok("кука не выдана", !check.headers.get("set-cookie"));

    const bogus = await call("auth/login/check", { method: "POST", body: { code: "ZZZZZZZZ" } });
    eq("чужой код не даёт сессию", bogus.data.confirmed, false);

    const reuse = await call("auth/login/check", { method: "POST", body: { code: start.data.code } });
    eq("код нельзя использовать повторно", reuse.data.confirmed, false);

    const logout = await call("auth/logout", { method: "POST", body: {} });
    eq("выход отвечает", logout.status, 200);
  }

  console.log("\n7. Боевой режим: без подтверждения входа доступа нет");
  {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));

    const secure = startServer({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_BOT_USERNAME: "debtfree_test_bot" });

    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(BASE + "/api/health"); if (r.ok) { ready = true; break; } } catch (e) { /* ждём */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    ok("сервер поднялся в боевом режиме", ready && /боевой режим/.test(serverLog()),
      serverLog().trim().split("\n").slice(-1)[0]);

    const noAuth = await fetch(BASE + "/api/me");
    eq("без подписи и без куки — 401", noAuth.status, 401);

    const devHeader = await fetch(BASE + "/api/me", { headers: { "X-Dev-User": "111" } });
    eq("заголовок разработчика в боевом режиме не работает", devHeader.status, 401);

    const badSig = await fetch(BASE + "/api/me", { headers: { Authorization: "tma auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef" } });
    eq("поддельная подпись — 401", badSig.status, 401);

    const stale = "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";
    const expired = await fetch(BASE + "/api/me", { headers: { Authorization: "tma " + stale } });
    eq("просроченная подпись — 401", expired.status, 401);
    const expiredBody = await expired.json();
    eq("причина отказа передана клиенту", expiredBody.reason, "auth_date_expired");

    const fakeCookie = await fetch(BASE + "/api/me", { headers: { Cookie: "df_session=fake-token-123" } });
    eq("поддельная кука — 401", fakeCookie.status, 401);
    eq("причина — сессия неизвестна", (await fakeCookie.json()).reason, "session_invalid");

    const info = await call("auth", {});
    eq("веб-вход в боевом режиме доступен", info.data.webLogin, true);
    eq("имя бота передано клиенту", info.data.botUsername, "debtfree_test_bot");

    const start = await call("auth/login/start", { method: "POST", body: {} });
    ok("код создан", !!start.data.code);
    eq("есть ссылка на бота", start.data.deepLink, "https://t.me/debtfree_test_bot?start=" + start.data.code);
    eq("неподтверждённый код не даёт вход", (await call("auth/login/check", { method: "POST", body: { code: start.data.code } })).data.confirmed, false);

    /* Свежая корректная подпись Telegram должна пустить */
    const fresh = signInitData({
      user: JSON.stringify({ id: 999, first_name: "Свежий" }),
      auth_date: String(Math.floor(Date.now() / 1000))
    }, BOT_TOKEN);
    const authed = await fetch(BASE + "/api/me", { headers: { Authorization: "tma " + fresh } });
    eq("свежая подпись пускает", authed.status, 200);
    const body = await authed.json();
    eq("и открывает нужного пользователя", body.user.id, "999");
    eq("способ входа отмечен как Telegram", body.authMethod, "telegram");
    eq("у нового пользователя нет долгов", body.debts.length, 0);

    /* Копим данные под этим пользователем — потом проверим, что они достались
       веб-сессии того же человека и не достались чужой. */
    await fetch(BASE + "/api/debts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "tma " + fresh },
      body: JSON.stringify({ debts: DEMO })
    });

    secure.kill();
  }

  console.log("\n8. Сквозной вход в браузере: код → подтверждение → кука");
  {
    /* DEBT_TESTS=1 включает на сервере один тестовый маршрут — он заменяет собой
       приход подтверждения из бота. Ничего больше он не меняет. */
    const secure = startServer({
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: "debtfree_test_bot",
      DEBT_TESTS: "1"
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(BASE + "/api/health"); if (r.ok) { ready = true; break; } } catch (e) { /* ждём */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    ok("сервер поднялся", ready);

    /* Готовим данные владельца: он уже входил через Telegram раньше */
    const owner = signInitData({
      user: JSON.stringify({ id: 555, first_name: "Владелец" }),
      auth_date: String(Math.floor(Date.now() / 1000))
    }, BOT_TOKEN);
    await fetch(BASE + "/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "tma " + owner },
      body: JSON.stringify({ budget: 75000 })
    });
    await fetch(BASE + "/api/debts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "tma " + owner },
      body: JSON.stringify({ debts: DEMO })
    });

    const start = await call("auth/login/start", { method: "POST", body: {} });
    const code = start.data.code;
    ok("код получен", !!code);

    const notYet = await call("auth/login/check", { method: "POST", body: { code: code } });
    eq("до подтверждения входа нет", notYet.data.confirmed, false);
    ok("и куки тоже нет", !notYet.headers.get("set-cookie"));

    /* Подтверждение из Telegram */
    const confirmed = await call("auth/login/confirm", { method: "POST", body: { code: code, userId: 555 } });
    eq("подтверждение принято", confirmed.data.confirmed, true);

    /* Браузер забирает код и получает куку */
    const check = await call("auth/login/check", { method: "POST", body: { code: code } });
    eq("вход подтверждён", check.data.confirmed, true);
    eq("известен пользователь", check.data.user.id, "555");
    const setCookie = String(check.headers.get("set-cookie") || "");
    ok("выдана сессионная кука", /df_session=[a-f0-9]{32,}/.test(setCookie), setCookie.slice(0, 40));
    ok("кука защищена от скриптов", setCookie.includes("HttpOnly"));
    ok("кука не уходит на чужие сайты", setCookie.includes("SameSite"));

    const cookie = setCookie.split(";")[0];

    /* Теперь браузер работает со своими данными — теми же, что были в Telegram */
    const me = await call("me", { cookie: cookie });
    eq("сессия открывает доступ", me.status, 200);
    eq("способ входа — браузер", me.data.authMethod, "web");
    eq("видны те же долги", me.data.debts.length, 5);
    eq("тот же бюджет", me.data.plan.budget, 75000);

    const plan = await call("plan", { cookie: cookie });
    eq("план считается", plan.status, 200);
    eq("долг на старте тот же", plan.data.data.plan.startTotal, 1538000);

    /* Изменение из браузера должно быть видно в Telegram */
    await call("profile", { method: "POST", cookie: cookie, body: { budget: 90000 } });
    const inTelegram = await fetch(BASE + "/api/me", { headers: { Authorization: "tma " + owner } });
    const tgBody = await inTelegram.json();
    eq("правка из браузера видна в Telegram", tgBody.plan.budget, 90000);

    /* Код одноразовый: повторно им не войти */
    const again = await call("auth/login/check", { method: "POST", body: { code: code } });
    eq("повторно код не работает", again.data.confirmed, false);

    /* Чужой не получит доступ по этой куке */
    const other = await call("me", { user: 777, cookie: cookie });
    eq("кука главнее заголовка разработчика — это тот же пользователь", other.data.user.id, "555");

    /* Выход закрывает доступ */
    const logout = await call("auth/logout", { method: "POST", cookie: cookie, body: {} });
    eq("выход выполнен", logout.status, 200);
    const after = await call("me", { cookie: cookie });
    eq("после выхода доступа нет", after.status, 401);

    /* Но данные в Telegram на месте */
    const stillThere = await fetch(BASE + "/api/me", { headers: { Authorization: "tma " + owner } });
    eq("данные в Telegram не пострадали", stillThere.status, 200);

    secure.kill();
  }
} catch (e) {
  console.error("\nОшибка теста: " + (e && e.stack || e));
  failures.push("исключение: " + e.message);
  failed++;
} finally {
  try { server.kill(); } catch (e) { /* уже остановлен */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* не критично */ }
}

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
