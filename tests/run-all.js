/**
 * Запускает все тесты по очереди и подводит общий итог.
 *
 * Запуск: npm test
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "debtfree-tests-"));
const SUITES = [
  { file: "calc.test.js", title: "Расчётное ядро" },
  { file: "auth.test.js", title: "Подпись Telegram" },
  { file: "session.test.js", title: "Веб-сессии" },
  { file: "env.test.js", title: "Настройки и туннель" },
  { file: "standalone.test.js", title: "Автономный файл" },
  { file: "server.test.js", title: "Сервер, API и изоляция данных" }
];

/**
 * Запускает тест отдельным процессом.
 * Вывод пишем в файл, а не в канал: так работает и там, где каналы между
 * процессами запрещены. Читаем файл после завершения процесса.
 */
function run(file) {
  return new Promise(function (resolve) {
    const logFile = path.join(LOG_DIR, file + ".log");
    let fd = null;
    try {
      fd = fs.openSync(logFile, "w");
    } catch (e) {
      return resolve({ code: 1, out: "не удалось создать файл лога: " + e.message });
    }
    const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ["ignore", fd, fd] });
    child.on("close", function (code) {
      try { fs.closeSync(fd); } catch (e) { /* уже закрыт */ }
      let out = "";
      try { out = fs.readFileSync(logFile, "utf8"); } catch (e) { out = ""; }
      resolve({ code: code, out: out });
    });
    child.on("error", function (e) {
      try { fs.closeSync(fd); } catch (e2) { /* уже закрыт */ }
      resolve({ code: 1, out: "не удалось запустить: " + e.message });
    });
  });
}

let failedSuites = 0;
const summary = [];

for (const suite of SUITES) {
  console.log("\n" + "═".repeat(58));
  console.log("▶ " + suite.title + "  (" + suite.file + ")");
  console.log("═".repeat(58));
  const res = await run(suite.file);
  process.stdout.write(res.out.replace(/\s+$/, "") + "\n");

  const passed = (res.out.match(/Пройдено: (\d+)/) || [])[1];
  const failed = (res.out.match(/провалено: (\d+)/) || [])[1];
  summary.push({ title: suite.title, passed: passed || "?", failed: failed || "?", code: res.code });
  if (res.code !== 0) failedSuites++;
}

try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (e) { /* не критично */ }

console.log("\n" + "═".repeat(58));
console.log("ИТОГ");
console.log("═".repeat(58));
summary.forEach(function (s) {
  const mark = s.code === 0 ? "✓" : "✗";
  console.log("  " + mark + " " + s.title.padEnd(34) + " пройдено " + s.passed + ", провалено " + s.failed);
});

const totalPassed = summary.reduce((acc, s) => acc + (parseInt(s.passed, 10) || 0), 0);
const totalFailed = summary.reduce((acc, s) => acc + (parseInt(s.failed, 10) || 0), 0);
console.log("\n  Всего: " + totalPassed + " пройдено, " + totalFailed + " провалено");

if (failedSuites) {
  console.log("\n✗ Есть проваленные проверки.");
  process.exit(1);
}
console.log("\n✓ Все тесты пройдены.");
