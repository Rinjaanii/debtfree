/**
 * Тесты веб-сессий.
 *
 * На сессиях держится вход в браузере, поэтому проверяем именно свойства
 * безопасности: код одноразовый, без подтверждения из Telegram сессии нет,
 * чужой/поддельный токен не работает, срок истекает.
 *
 * Запуск: node tests/session.test.js
 */

import {
  SessionStore, newLoginCode, parseCookies, sessionCookie, clearCookie, COOKIE
} from "../src/auth.js";

let passed = 0, failed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}

console.log("DebtFree — тесты веб-сессий\n");

console.log("1. Коды подтверждения");
{
  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(newLoginCode());
  eq("коды уникальны", codes.size, 500);
  ok("длина кода 8 символов", newLoginCode().length === 8);
  ok("без похожих символов (нет O, 0, I, 1, S, 5, B, 8)", !/[O0I1S5B8]/.test([...codes].join("")));

  const store = new SessionStore();
  const code = store.startLogin();
  ok("код создан", typeof code === "string" && code.length === 8);

  eq("до подтверждения сессии нет", store.redeemLogin(code), null);
  ok("чужой код не подтверждается", store.confirmLogin("НЕТТАКОГО", "5") === false);
  ok("подтверждение известного кода проходит", store.confirmLogin(code.toLowerCase(), "42") === true);

  const session = store.redeemLogin(code);
  ok("после подтверждения выдаётся сессия", !!session && typeof session.token === "string");
  eq("сессия принадлежит подтвердившему", session.userId, "42");
  ok("токен длинный и случайный", session.token.length >= 32);

  eq("код одноразовый", store.redeemLogin(code), null);
  eq("сессия узнаёт пользователя", store.resolve(session.token), "42");
}

console.log("\n2. Сроки");
{
  const store = new SessionStore();
  const code = store.startLogin();
  const entry = store.codes.get(code);
  ok("у кода есть время создания", typeof entry.createdAt === "number");

  /* Просроченный код: сдвигаем время создания в прошлое */
  entry.createdAt = Date.now() - COOKIE.loginTtlMs - 1000;
  ok("просроченный код не подтверждается", store.confirmLogin(code, "7") === false);

  const fresh = store.startLogin();
  store.confirmLogin(fresh, "7");
  const session = store.redeemLogin(fresh);
  ok("сессия создана", !!session);

  /* Просроченная сессия */
  store.sessions.get(session.token).createdAt = Date.now() - COOKIE.sessionTtlMs - 1000;
  eq("просроченная сессия не действует", store.resolve(session.token), null);
  eq("просроченная сессия удаляется из памяти", store.sessions.size, 0);
}

console.log("\n3. Выход и подделки");
{
  const store = new SessionStore();
  const code = store.startLogin();
  store.confirmLogin(code, "11");
  const session = store.redeemLogin(code);

  eq("до выхода сессия работает", store.resolve(session.token), "11");
  store.logout(session.token);
  eq("после выхода не работает", store.resolve(session.token), null);

  eq("пустой токен", store.resolve(null), null);
  eq("несуществующий токен", store.resolve("подделка"), null);
  eq("случайная строка", store.resolve("a".repeat(48)), null);
  store.logout("нет-такого"); // не должно падать
  ok("выход по неизвестному токену не ломает хранилище", true);
}

console.log("\n4. Несколько пользователей одновременно");
{
  const store = new SessionStore();
  const sessions = {};
  ["101", "202", "303"].forEach(function (userId) {
    const code = store.startLogin();
    store.confirmLogin(code, userId);
    sessions[userId] = store.redeemLogin(code);
  });

  eq("первый видит себя", store.resolve(sessions["101"].token), "101");
  eq("второй видит себя", store.resolve(sessions["202"].token), "202");
  eq("третий видит себя", store.resolve(sessions["303"].token), "303");

  store.logout(sessions["202"].token);
  eq("выход второго не влияет на первого", store.resolve(sessions["101"].token), "101");
  eq("и на третьего", store.resolve(sessions["303"].token), "303");
  eq("у второго доступа нет", store.resolve(sessions["202"].token), null);

  const stats = store.stats();
  eq("в статистике две живые сессии", stats.sessions, 2);
}

console.log("\n5. Куки");
{
  const parsed = parseCookies("a=1; df_session=abc123; b=2");
  eq("нужная кука найдена", parsed[COOKIE.name], "abc123");
  eq("остальные тоже", parsed.a, "1");
  eq("пустой заголовок", Object.keys(parseCookies("")).length, 0);
  eq("заголовка нет", Object.keys(parseCookies(undefined)).length, 0);

  const cookie = sessionCookie("token123", true);
  ok("в куке есть HttpOnly", cookie.includes("HttpOnly"));
  ok("в куке есть SameSite", cookie.includes("SameSite=Lax"));
  ok("Secure только по HTTPS", cookie.includes("Secure") && !sessionCookie("t", false).includes("Secure"));
  ok("путь — весь сайт", cookie.includes("Path=/"));
  ok("срок жизни — месяц", cookie.includes("Max-Age=" + Math.floor(COOKIE.sessionTtlMs / 1000)));

  const cleared = clearCookie(false);
  ok("удаление куки обнуляет срок", cleared.includes("Max-Age=0"));
}

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
