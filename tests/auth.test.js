/**
 * Тесты авторизации через Telegram.
 *
 * Проверяют ровно то, от чего зависит приватность: подделанные или просроченные
 * данные не должны пускать в сервис, а подлинные — должны.
 *
 * Один из примеров взят из официальной документации Bot API (WebAppInitData),
 * чтобы проверка алгоритма не зависела от нашего же кода.
 *
 * Запуск: node tests/auth.test.js
 */

import crypto from "node:crypto";
import { verifyInitData, initDataFromHeaders, shortUser } from "../src/auth.js";

let passed = 0, failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}

/** Собирает подписанный initData так же, как это делает Telegram. */
function sign(params, botToken) {
  const pairs = Object.keys(params)
    .filter((k) => k !== "hash")
    .map((k) => k + "=" + params[k])
    .sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  return new URLSearchParams(Object.assign({}, params, { hash: hash })).toString();
}

console.log("DebtFree — тесты авторизации\n");

const TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";
const NOW = 1733584787000; // фиксируем время, чтобы тесты не зависели от часов

console.log("1. Официальный пример из документации Bot API");
{
  const initData =
    "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";
  const res = verifyInitData(initData, TOKEN, { now: 1662771648000 + 60000 });
  ok("подпись из документации принимается", res.ok === true, res.error);
  eq("id пользователя разобран верно", res.user && res.user.id, 279058397);
  eq("имя разобрано", res.user && res.user.first_name, "Vladislav");
  eq("premium-статус разобран", res.user && res.user.is_premium, true);
}

console.log("\n2. Наши собственные подписанные данные");
{
  const params = {
    query_id: "AAA",
    user: JSON.stringify({ id: 42, first_name: "Андрей", username: "andrey", language_code: "ru" }),
    auth_date: "1733584787",
    start_param: "ref_1"
  };
  const initData = sign(params, TOKEN);

  const good = verifyInitData(initData, TOKEN, { now: NOW });
  ok("корректная подпись принимается", good.ok === true, good.error);
  eq("id", good.user.id, 42);
  eq("start_param доходит до сервера", good.startParam, "ref_1");

  const wrongToken = verifyInitData(initData, TOKEN + "X", { now: NOW });
  ok("чужой токен не проходит", wrongToken.ok === false && wrongToken.error === "hash_invalid", wrongToken.error);

  const tampered = initData.replace(/%22id%22%3A42/, "%22id%22%3A43");
  const hacked = verifyInitData(tampered, TOKEN, { now: NOW });
  ok("подмена id ломает подпись", hacked.ok === false, hacked.error);

  const noHash = new URLSearchParams(initData);
  noHash.delete("hash");
  ok("без hash не проходит", verifyInitData(noHash.toString(), TOKEN, { now: NOW }).ok === false);
}

console.log("\n3. Срок жизни данных");
{
  const params = { user: JSON.stringify({ id: 7, first_name: "Тест" }), auth_date: "1733584787" };
  const initData = sign(params, TOKEN);

  ok("свежие данные (1 минута) принимаются", verifyInitData(initData, TOKEN, { now: NOW + 60 * 1000 }).ok === true);
  ok("данные суточной давности ещё принимаются",
    verifyInitData(initData, TOKEN, { now: NOW + 23 * 3600 * 1000 }).ok === true);

  const old = verifyInitData(initData, TOKEN, { now: NOW + 25 * 3600 * 1000 });
  ok("старше суток — отказ", old.ok === false && old.error === "auth_date_expired", old.error);

  const future = verifyInitData(initData, TOKEN, { now: NOW - 3600 * 1000 });
  ok("дата из будущего — отказ", future.ok === false && future.error === "auth_date_in_future", future.error);

  const custom = verifyInitData(initData, TOKEN, { now: NOW + 10 * 60 * 1000, maxAgeSeconds: 300 });
  ok("свой лимит свежести соблюдается", custom.ok === false && custom.error === "auth_date_expired", custom.error);
}

console.log("\n4. Некорректные входные данные");
{
  const cases = [
    ["пустая строка", "", "initData_missing"],
    ["null", null, "initData_missing"],
    ["без пользователя", "auth_date=1733584787", "hash_missing"],
    ["мусор без hash", "не-параметры", "hash_missing"]
  ];
  cases.forEach(function (c) {
    const res = verifyInitData(c[1], TOKEN, { now: NOW });
    ok("отказ: " + c[0], res.ok === false && res.error === c[2], res.error);
  });

  const signedNoUser = sign({ auth_date: "1733584787" }, TOKEN);
  const res = verifyInitData(signedNoUser, TOKEN, { now: NOW });
  ok("отказ: подпись верна, но пользователя нет", res.ok === false && res.error === "user_missing", res.error);

  ok("без токена бота — отказ", verifyInitData(sign({ user: "{}" }, TOKEN), "", { now: NOW }).ok === false);
}

console.log("\n5. Разбор заголовка Authorization");
{
  eq("обычный заголовок", initDataFromHeaders({ authorization: "tma auth_date=1&hash=abc" }), "auth_date=1&hash=abc");
  eq("регистр схемы не важен", initDataFromHeaders({ Authorization: "TMA x=1" }), "x=1");
  eq("чужой заголовок не принимается", initDataFromHeaders({ authorization: "Bearer token" }), null);
  eq("пусто", initDataFromHeaders({}), null);
  eq("заголовка нет", initDataFromHeaders(undefined), null);
  eq("пробелы внутри данных не теряются", initDataFromHeaders({ authorization: "tma a=1&b=two words" }), "a=1&b=two words");
}

console.log("\n6. Служебные функции");
{
  eq("имя пользователя для логов", shortUser({ id: 42, first_name: "Андрей", last_name: "П." }), "#42 (Андрей П.)");
  eq("имя без фамилии", shortUser({ id: 42, first_name: "Андрей" }), "#42 (Андрей)");
  eq("пустой пользователь", shortUser(null), "?");
}

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
