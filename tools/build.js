/**
 * Общая сборка DebtFree.
 *
 * Источник один — `templates/` и `src/calc.js`, а форм две:
 *   • сервис: `public/app.html` + `public/app.js` (вход через Telegram или по коду в браузере);
 *   • автономный файл `debtfree.html`: весь интерфейс и ядро в одном HTML, работает без сервера.
 *
 * Сервер вызывает это сам при старте, если исходники новее сборки, — поэтому
 * «забыл пересобрать» не бывает. Вручную: `node tools/build.js`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..");

const FILES = {
  template: path.join(ROOT, "templates", "app.html"),
  style: path.join(ROOT, "templates", "style.css"),
  client: path.join(ROOT, "public", "app.js"),
  core: path.join(ROOT, "src", "calc.js"),
  package: path.join(ROOT, "package.json"),
  outApp: path.join(ROOT, "public", "app.html"),
  outStandaloneRepo: path.join(REPO_ROOT, "debtfree.html"),
  outStandalonePublic: path.join(ROOT, "public", "debtfree.html")
};

function read(file) { return fs.readFileSync(file, "utf8"); }

function coreAsPlainScript(source) {
  const names = [];
  const body = source.replace(/^export\s+(function|const|let|var)\s+([A-Za-z0-9_$]+)/gm, function (m, kind, name) {
    names.push(name);
    return kind + " " + name;
  });
  if (/^export\s/m.test(body)) {
    throw new Error("В ядре остались конструкции export, которые сборка не умеет убирать");
  }
  const exportsObject = "  window.DFCalc = {\n" +
    names.map((n) => "    " + n + ": " + n).join(",\n") +
    "\n  };\n";
  return "(function () {\n\"use strict\";\n" + body + "\n" + exportsObject + "})();\n";
}

function clientWithoutImport(source) {
  const cleaned = source.replace(/^import\s+\*\s+as\s+nodeCalc\s+from\s+["'][^"']+["'];?\s*$/m, "");
  if (/^import\s/m.test(cleaned)) {
    throw new Error("В клиенте остались import-строки: автономный файл их не поддерживает");
  }
  return cleaned;
}

/** Собирает страницу сервиса: шаблон + встроенные стили + подключение клиента. */
export function buildServicePage() {
  const version = JSON.parse(read(FILES.package)).version;
  let html = read(FILES.template)
    .replace("<!--DF_STYLES-->", "<style>\n" + read(FILES.style) + "\n</style>")
    .replace("<!--DF_SCRIPT-->", '<script type="module" src="./app.js"></script>');

  html = html.replace("<title>DebtFree</title>",
    "<title>DebtFree — план погашения долгов</title>\n" +
    "<!-- Собрано из templates/app.html (версия " + version + "). Правьте шаблон: node debtfree/tools/build.js -->");

  fs.writeFileSync(FILES.outApp, html, "utf8");
  return { file: FILES.outApp, size: Buffer.byteLength(html, "utf8") };
}

/** Собирает автономный файл: интерфейс + ядро внутри одного HTML. */
export function buildStandalone() {
  const version = JSON.parse(read(FILES.package)).version;
  const core = coreAsPlainScript(read(FILES.core));
  const client = clientWithoutImport(read(FILES.client));

  const script = [
    "(function () {",
    "\"use strict\";",
    "window.DF_STANDALONE = true;",
    "",
    "/*DF_CORE_START*/",
    "/* ---- расчётное ядро (то же, что и на сервере) ---- */",
    core,
    "/*DF_CORE_END*/",
    "",
    "/*DF_UI_START*/",
    "/* ---- интерфейс ---- */",
    "(function () {",
    client,
    "})();",
    "/*DF_UI_END*/",
    "})();"
  ].join("\n");

  let html = read(FILES.template)
    .replace("<!--DF_STYLES-->", "<style>\n" + read(FILES.style) + "\n</style>")
    .replace("<!--DF_SCRIPT-->", "<script>\n" + script + "\n</script>");

  html = html.replace("<title>DebtFree</title>",
    "<title>DebtFree — план погашения долгов</title>\n" +
    "<meta name=\"description\" content=\"DebtFree: план погашения долгов — очередь закрытия, экономия на процентах, календарь платежей. Работает без сервера.\">\n" +
    "<!-- Собрано из debtfree/ версии " + version + ". Правьте исходники: node debtfree/tools/build.js -->");

  // То, что отдаётся сервером по адресу /debtfree.html — пишем всегда.
  fs.writeFileSync(FILES.outStandalonePublic, html, "utf8");

  // Копия в корень репозитория — удобство для локальной разработки. На VPS папка
  // на уровень выше может быть недоступна для записи, поэтому это «по возможности».
  try {
    fs.writeFileSync(FILES.outStandaloneRepo, html, "utf8");
  } catch (e) {
    /* не критично: серверу нужна только копия в public/ */
  }

  return { repo: FILES.outStandaloneRepo, public: FILES.outStandalonePublic, size: Buffer.byteLength(html, "utf8") };
}

/** Нужна ли пересборка: сравниваем время правки исходников и результата, который
 *  реально отдаётся сервером (public/), а не копии в корне репозитория. */
export function needsRebuild() {
  const sources = [FILES.template, FILES.style, FILES.client, FILES.core];
  const outputs = [FILES.outApp, FILES.outStandalonePublic];
  try {
    const newestSource = Math.max(...sources.map((f) => fs.statSync(f).mtimeMs));
    const oldestOutput = Math.min(...outputs.map((f) => fs.statSync(f).mtimeMs));
    return newestSource > oldestOutput;
  } catch (e) {
    return true; // чего-то нет — точно надо собрать
  }
}

/** Пересобирает при необходимости. Возвращает описание того, что сделано. */
export function buildIfNeeded(log) {
  if (!needsRebuild()) return { rebuilt: false };
  const app = buildServicePage();
  const standalone = buildStandalone();
  if (log) {
    log("сборка обновлена: public/app.html и debtfree.html (" +
      (standalone.size / 1024).toFixed(1) + " КБ)");
  }
  return { rebuilt: true, app: app, standalone: standalone };
}

/* Запуск как отдельной команды */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = buildServicePage();
  const standalone = buildStandalone();
  console.log("Собрано:");
  console.log("  " + path.relative(ROOT, app.file) + "  (" + (app.size / 1024).toFixed(1) + " КБ) — страница сервиса");
  console.log("  " + path.relative(REPO_ROOT, standalone.repo) + "  (" + (standalone.size / 1024).toFixed(1) + " КБ) — автономный файл");
  console.log("  " + path.relative(REPO_ROOT, standalone.public) + " — копия для скачивания с сервера");
}
