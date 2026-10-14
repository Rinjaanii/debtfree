/**
 * Тесты автономного файла debtfree.html.
 *
 * Файл открывают без сервера, поэтому проверяем именно это: он запускается,
 * считает план своим ядром и хранит данные в браузере.
 *
 * Запуск: node tests/standalone.test.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "..", "public", "debtfree.html");

let passed = 0, failed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}

console.log("DebtFree — тесты автономного файла\n");

if (!fs.existsSync(FILE)) {
  console.log("✗ Файл не найден: " + FILE);
  console.log("  Сначала соберите его: node tools/build-standalone.js");
  process.exit(1);
}
const html = fs.readFileSync(FILE, "utf8");

/* ------------------------------------------------------------------ 1. структура файла */

console.log("1. Структура файла");
{
  ok("ячейка браузера объявлена", html.startsWith("<!DOCTYPE html>"));
  ok("внешних скриптов нет, кроме SDK Telegram", !/<script[^>]+src="(?!https:\/\/telegram\.org)/.test(html));
  ok("стили внутри файла", html.includes("<style>") && !html.includes('href="./style.css"'));
  ok("плейсхолдеры сборки заменены", !html.includes("<!--DF_STYLES-->") && !html.includes("<!--DF_SCRIPT-->"));
  ok("модульный синтаксис убран", !/^\s*export\s/m.test(html) && !/^\s*import\s+\*\s+as/m.test(html));
  ok("ядро доступно как window.DFCalc", html.includes("window.DFCalc"));
  ok("режим автономности включён", html.includes("window.DF_STANDALONE = true"));
  ok("размер разумный", html.length > 40000 && html.length < 400000, Math.round(html.length / 1024) + " КБ");
  ok("есть пометка о сборке", /tools\/build\.js/.test(html));
}

/* ------------------------------------------------------------------ 2. запуск без сервера */

console.log("\n2. Запуск без сервера");
{
  const script = html.slice(html.indexOf("<script>", html.indexOf("window.DF_STANDALONE") - 2000) + 8, html.lastIndexOf("</script>"));

  const store = {};
  const errors = [];

  class ClassList {
    constructor() { this.set = new Set(); }
    add(...c) { c.forEach((x) => this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
  }
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {};
      this.style = {}; this.classList = new ClassList();
      this._text = ""; this._html = ""; this.listeners = {};
      this.value = ""; this.id = ""; this.hidden = false; this.type = ""; this.files = null;
    }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    insertBefore(c, r) { const i = r ? this.children.indexOf(r) : -1; if (i < 0) return this.appendChild(c); c.parentNode = this; this.children.splice(i, 0, c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener() {}
    querySelector(sel) { const w = sel.toUpperCase().replace(/[^A-Z]/g, ""); let hit = null; walk(this, (n) => { if (!hit && n !== this && n.tagName === w) hit = n; }); return hit; }
    querySelectorAll(sel) { const out = []; if (sel.startsWith(".")) { const c = sel.slice(1); walk(this, (n) => { if (n !== this && n.classList.contains(c)) out.push(n); }); return out; }
      const w = sel.toUpperCase().replace(/[^A-Z]/g, ""); walk(this, (n) => { if (n !== this && n.tagName === w) out.push(n); }); return out; }
    closest() { let n = this.parentNode; while (n) { if (n.tagName === "TR" || n.tagName === "BUTTON") return n; n = n.parentNode; } return null; }
    focus() {} click() { this.dispatch("click", { target: this, preventDefault() {} }); }
    dispatch(t, ev) { ev = ev || { target: this, preventDefault() {} }; let n = this; while (n) { (n.listeners[t] || []).forEach((f) => f.call(n, ev)); n = n.parentNode; } }
    getBoundingClientRect() { return { left: 0, top: 0, width: 340, height: 180 }; }
  }
  class TextNode extends El { constructor(t) { super("#text"); this._text = String(t); } }
  function walk(n, f) { f(n); n.children.forEach((c) => walk(c, f)); }
  function textOf(n) { let s = (n._html || "") + (n._text || ""); if (n.tagName === "INPUT" && n.value) s += n.value; n.children.forEach((c) => { s += textOf(c); }); return s; }

  /* минимальный DOM: парсим тот же HTML, но без скрипта */
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "path", "line", "rect", "circle", "text", "g", "option"]);
  const markup = html.slice(0, html.indexOf("<script>"));
  const root = new El("div");
  {
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)(\/?)>/g;
    let last = 0, m;
    while ((m = re.exec(markup))) {
      const tx = markup.slice(last, m.index);
      if (tx.trim()) stack[stack.length - 1].appendChild(new TextNode(tx));
      last = re.lastIndex;
      if (m[1]) { for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; } } continue; }
      if (!m[2]) continue;
      const e = new El(m[2]);
      const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
      let a;
      while ((a = ar.exec(m[3] || ""))) { if (a[1]) e.setAttribute(a[1], a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : "")); }
      stack[stack.length - 1].appendChild(e);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(e);
    }
  }
  const byId = {};
  walk(root, (n) => { if (n.id) byId[n.id] = n; });

  const globals = {
    window: null,
    document: {
      readyState: "complete",
      body: new El("body"),
      getElementById: (id) => byId[id] || null,
      createElement: (t) => new El(t),
      createElementNS: (ns, t) => new El(t),
      createTextNode: (t) => new TextNode(t),
      querySelector: (sel) => {
        if (sel.startsWith("#")) return byId[sel.slice(1)] || null;
        const w = sel.toUpperCase().replace(/[^A-Z]/g, "");
        let hit = null;
        walk(root, (n) => { if (!hit && n.tagName === w) hit = n; });
        return hit;
      },
      querySelectorAll: (sel) => {
        if (sel.startsWith(".")) {
          const c = sel.slice(1).split(" ")[0], found = [];
          walk(root, (n) => { if (n.classList.contains(c)) found.push(n); });
          const btns = [];
          found.forEach((f) => f.children.forEach((y) => { if (y.tagName === "BUTTON") btns.push(y); }));
          return btns;
        }
        return [];
      },
      addEventListener() {}
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    /* сервера нет: любой запрос должен падать, и клиент обязан это пережить */
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    Blob: function (parts) { this.parts = parts; },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    FileReader: class { readAsText() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => true,
    alert: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console
  };
  globals.window = globals;
  globals.window.Telegram = undefined;

  const names = Object.keys(globals);
  const prev = {};
  try {
    names.forEach((k) => {
      prev[k] = global[k];
      try { Object.defineProperty(global, k, { value: globals[k], writable: true, configurable: true }); }
      catch (e) { global[k] = globals[k]; }
    });

    try {
      new Function(script)();
    } catch (e) {
      errors.push(e);
    }

    /* ждём, пока отработают промисы загрузки */
    await new Promise((r) => setTimeout(r, 300));

    ok("скрипт выполнился без ошибок", errors.length === 0,
      errors.map((e) => e.message + " | " + (e.stack || "").split("\n")[1]).join(" ;; "));
    ok("ядро подставлено в window.DFCalc", !!globals.window.DFCalc);
    eq("в ядре есть simulate", typeof (globals.window.DFCalc || {}).simulate, "function");
    eq("в ядре есть compareStrategies", typeof (globals.window.DFCalc || {}).compareStrategies, "function");

    const dot = byId["status-dot"];
    ok("интерфейс отрисовал статус", !!dot && String(dot.className).includes("dot"));
    eq("подпись режима — автономный", textOf(byId["who-text"]).trim(), "Автономный режим");
    eq("в шапке про браузер", textOf(byId["mode-note"]).trim(), "данные в браузере");
    ok("панель настроек показана", byId["panel-settings"].hidden === false);
    ok("показана подсказка о работе без сервера", byId["offline-note"].hidden === false);
    ok("есть кнопки экспорта и импорта",
      textOf(byId["account-box"]).includes("Скачать данные") && textOf(byId["account-box"]).includes("Загрузить из файла"));
    ok("табов не видно (некуда переключаться)", !!byId["tabs"]);
  } finally {
    names.forEach((k) => {
      if (prev[k] === undefined) delete global[k];
      else Object.defineProperty(global, k, { value: prev[k], writable: true, configurable: true });
    });
  }
}

/* ------------------------------------------------------------------ 3. ядро внутри файла считает верно */

console.log("\n3. Расчёт ядром из файла");
{
  const script = html.slice(html.indexOf("<script>", html.indexOf("window.DF_STANDALONE") - 2000) + 8, html.lastIndexOf("</script>"));
  const start = script.indexOf("/*DF_CORE_START*/");
  const end = script.indexOf("/*DF_CORE_END*/");
  ok("в файле есть маркеры ядра", start >= 0 && end > start);

  const corePart = script.slice(start, end);
  const fakeWindow = {};
  const fakeGlobal = {
    window: fakeWindow,
    console
  };
  const names = Object.keys(fakeGlobal);
  const prev = {};
  try {
    names.forEach((k) => { prev[k] = global[k]; global[k] = fakeGlobal[k]; });
    new Function(corePart)();
    const C = fakeWindow.DFCalc;
    ok("ядро доступно", !!C);

    const DEMO = [
      { id: "d1", name: "Карта", amount: 350000, rate: 32, minPay: 18000, dueDay: 5 },
      { id: "d2", name: "Потреб", amount: 420000, rate: 19.5, minPay: 14500, dueDay: 12 },
      { id: "d3", name: "Авто", amount: 640000, rate: 14.2, minPay: 19500, dueDay: 20 },
      { id: "d4", name: "Рассрочка", amount: 78000, rate: 0, minPay: 6500, dueDay: 8 },
      { id: "d5", name: "Другу", amount: 50000, rate: 0, minPay: 5000, dueDay: 25 }
    ];
    const res = C.simulate(DEMO, 75000, "avalanche", { now: "2026-10-14T00:00:00Z" });
    eq("срок совпадает с серверным ядром", res.period, 25);
    eq("проценты совпадают", Math.round(res.totalInterest), 306996);
    ok("все долги получили дату закрытия", res.items.every((i) => !!i.paidMonth));
    ok("бухгалтерия сходится", res.months.every((m) => Math.abs(m.payment - m.interest - m.principal) < 0.02));
    eq("форматирование денег работает", C.fmtMoney(1538000), "1 538 000 ₽");
    eq("склонения работают", C.durationText(25), "2 года 1 мес.");
  } finally {
    names.forEach((k) => { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; });
  }
}

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
