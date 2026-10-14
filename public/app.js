/**
 * DebtFree — единый клиент.
 *
 * Один и тот же интерфейс работает в трёх режимах, и данные в них одни и те же:
 *
 *   1. Telegram Mini App — Telegram отдаёт подписанные данные, сервер проверяет подпись;
 *   2. браузер с входом — одноразовый код подтверждается в Telegram, дальше сессия;
 *   3. автономно — если сервера нет (обычный HTML-файл), всё считается и хранится
 *      прямо в браузере, с экспортом и импортом в файл.
 *
 * Расчёт в любом режиме делает одно и то же ядро.
 */

import * as nodeCalc from "/src/calc.js";

/* Ядро: в обычном файле оно подставлено как window.DFCalc, на сервере — как модуль. */
const calc = (typeof window !== "undefined" && window.DFCalc) ? window.DFCalc : nodeCalc;

const {
  fmtMoney, fmtPct, durationText, monthLabel, plural, num,
  validateDebts, compareStrategies, budgetGrid, whatIf, normalizeDebt, PALETTE
} = calc;

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const IN_TELEGRAM = !!(tg && tg.initData);
const STANDALONE = typeof window !== "undefined" && !!window.DF_STANDALONE;

const state = {
  authMethod: null,     // "telegram" | "web" | "dev" | "local"
  online: false,
  user: null,
  summary: null,
  profile: { budget: 0, strategy: "avalanche", extra: 0, extraMonth: 3, growth: 0 },
  debts: [],
  tab: "plan",
  editingId: null,
  login: { code: null, deepLink: null, timer: null }
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ локальное хранилище (автономный режим) */

const LS_KEY = "debtfree-local-v1";

function localSave() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      profile: state.profile,
      debts: state.debts
    }));
  } catch (e) { /* приватный режим — просто не сохраняем */ }
}

function localLoad() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.debts)) return false;
    state.debts = data.debts.map((d, i) => Object.assign(normalizeDebt(d, i), { id: d.id || ("loc" + i) }));
    state.profile = Object.assign(state.profile, data.profile || {});
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ сеть */

/**
 * Запрос к серверу.
 * Если сервер недоступен (открыт обычный файл), включаем автономный режим:
 * интерфейс продолжает работать, данные остаются в браузере.
 */
async function api(path, options) {
  options = options || {};
  if (STANDALONE && !state.online) throw offlineError();

  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (IN_TELEGRAM) headers["Authorization"] = "tma " + tg.initData;

  let res;
  try {
    res = await fetch("/api/" + path, {
      method: options.method || "GET",
      headers: headers,
      credentials: "same-origin",
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (e) {
    goOffline();
    throw offlineError();
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  if (!res.ok) {
    const err = new Error((data && data.error) || ("http_" + res.status));
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function offlineError() {
  const e = new Error("offline");
  e.offline = true;
  return e;
}

/** Переходим в автономный режим: считаем сами, храним в браузере. */
function goOffline() {
  if (state.authMethod === "local") return;
  state.online = false;
  state.authMethod = "local";
  state.user = { name: "Локальные данные", local: true };
  if (!state.debts.length) localLoad();
  rebuildSummary();
  renderHeader();
  renderAccount();
  $("offline-note").hidden = false;
}

/* ------------------------------------------------------------------ расчёт */

function rebuildSummary() {
  const debts = state.debts.map((d, i) => Object.assign({}, d, { color: PALETTE[i % PALETTE.length] }));
  const budget = num(state.profile.budget, 0);
  const strategy = state.profile.strategy === "snowball" ? "snowball" : "avalanche";
  const extras = [];
  if (num(state.profile.extra, 0) > 0) {
    extras.push({ month: Math.max(0, Math.round(num(state.profile.extraMonth, 3)) - 1), amount: num(state.profile.extra, 0) });
  }
  const opts = { extras: extras, growth: num(state.profile.growth, 0) };
  const comparison = compareStrategies(debts, budget, opts);
  const chosen = strategy === "snowball" ? comparison.snowball : comparison.avalanche;

  state.summary = {
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
  return state.summary;
}

/* ------------------------------------------------------------------ загрузка */

async function boot() {
  if (STANDALONE) {
    /* В обычном файле сервера нет: пробуем только если он есть рядом. */
    try {
      const info = await api("auth");
      state.online = true;
      state.authMethod = info.authenticated ? (info.authenticated && info.method) : null;
      if (!info.authenticated) { goOffline(); return; }
    } catch (e) {
      goOffline();
      return;
    }
  }

  try {
    const info = await api("auth");
    state.authMethod = info.authenticated ? info.method : null;
    state.online = true;
    if (!info.authenticated) {
      renderLogin(info);
      return;
    }
    await refresh();
  } catch (e) {
    if (e.offline) return;
    throw e;
  }
}

async function refresh() {
  const me = await api("me");
  state.online = true;
  state.authMethod = me.authMethod || state.authMethod || "web";
  state.user = me.user;
  state.profile = me.plan;
  state.debts = me.debts || [];
  state.summary = null;
  try {
    const res = await api("plan");
    state.summary = res.data;
  } catch (e) {
    rebuildSummary();
  }
  finishRender();
}

function finishRender() {
  renderHeader();
  renderAccount();
  renderPlan();
  renderDebts();
  $("loading").hidden = true;
  $("panel-" + state.tab).hidden = false;
  if (!state.debts.length) switchTab("debts");
}

const saveProfile = debounce(async function (patch) {
  if (state.authMethod === "local") {
    rebuildSummary();
    localSave();
    renderPlan();
    return;
  }
  try {
    const res = await api("profile", { method: "POST", body: patch });
    state.profile = res.plan;
    const plan = await api("plan");
    state.summary = plan.data;
    renderPlan();
  } catch (e) {
    if (!e.offline) toast("Не удалось сохранить: " + e.message);
  }
}, 500);

/* ------------------------------------------------------------------ помощники */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function toast(message, ms) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), ms || 2600);
}

function haptic(type) {
  if (!tg || !tg.HapticFeedback) return;
  try {
    if (type === "success") tg.HapticFeedback.notificationOccurred("success");
    else if (type === "error") tg.HapticFeedback.notificationOccurred("error");
    else tg.HapticFeedback.impactOccurred("light");
  } catch (e) { /* не критично */ }
}

function groupDigits(v) {
  const s = String(v == null ? "" : v).replace(/\s|\u00A0/g, "").replace(",", ".");
  if (s === "") return "";
  const neg = s.startsWith("-");
  const parts = s.replace("-", "").split(".");
  const int = parts[0].replace(/\D/g, "");
  const frac = parts.length > 1 ? parts[1].replace(/\D/g, "").slice(0, 2) : null;
  let out = "", i = 0;
  for (i = int.length; i > 3; i -= 3) out = " " + int.slice(i - 3, i) + out;
  out = int.slice(0, i) + out;
  return (neg ? "−" : "") + out + (frac !== null && frac !== "" ? "," + frac : "");
}

function parseMoney(v) {
  const s = String(v == null ? "" : v).replace(/\s|\u00A0/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(self, args), ms);
  };
}

/* ------------------------------------------------------------------ шапка и аккаунт */

function renderHeader() {
  const dot = $("status-dot");
  const who = $("who-text");
  const note = $("mode-note");

  if (state.authMethod === "telegram") {
    dot.className = "dot live";
    who.textContent = state.user ? state.user.name : "…";
    note.textContent = "Telegram";
  } else if (state.authMethod === "web") {
    dot.className = "dot live";
    who.textContent = state.user ? state.user.name : "…";
    note.textContent = "браузер";
  } else if (state.authMethod === "dev") {
    dot.className = "dot dev";
    who.textContent = (state.user ? state.user.name : "Разработчик") + " (тест)";
    note.textContent = "режим разработки";
  } else {
    dot.className = "dot dev";
    who.textContent = "Автономный режим";
    note.textContent = "данные в браузере";
  }
}

function renderAccount() {
  const box = $("account-box");
  box.innerHTML = "";

  if (state.authMethod === "local") {
    box.appendChild(el("p", "hint",
      "Сервер недоступен, поэтому план считается и хранится прямо в этом браузере. " +
      "Чтобы данные стали доступны с телефона и в Telegram, откройте сервис по адресу сервера."));
    const exportBtn = el("button", null, "Скачать данные (JSON)");
    exportBtn.addEventListener("click", exportLocal);
    box.appendChild(exportBtn);
    const importBtn = el("button", null, "Загрузить из файла");
    importBtn.addEventListener("click", () => $("file-input").click());
    box.appendChild(importBtn);
    addStandaloneLink(box);
    return;
  }

  const p = el("p", "hint");
  if (state.authMethod === "telegram") {
    p.textContent = "Вы вошли через Telegram: " + (state.user ? state.user.name : "") +
      ". Те же данные откроются в браузере, если войти там по коду.";
  } else {
    p.textContent = "Вы вошли в браузере: " + (state.user ? state.user.name : "") +
      ". Те же данные видны в Telegram — это один аккаунт.";
  }
  box.appendChild(p);

  if (!state.user || !state.user.local) {
    const out = el("button", "ghost danger", "Выйти");
    out.addEventListener("click", async function () {
      if (!confirm("Выйти из аккаунта? Данные останутся на сервере.")) return;
      try {
        await api("auth/logout", { method: "POST", body: {} });
      } catch (e) { /* выходим в любом случае */ }
      location.reload();
    });
    box.appendChild(out);
  }
  addStandaloneLink(box);
}

/** Ссылка на автономный файл: пригодится, если нужен вариант без сервера. */
function addStandaloneLink(box) {
  const wrap = el("div");
  wrap.style.marginTop = "14px";
  const p = el("p", "hint", "Нужен вариант без интернета и сервера? Скачайте один HTML-файл: он считает так же и хранит данные в браузере.");
  const a = el("a");
  a.href = "/debtfree.html";
  a.setAttribute("download", "debtfree.html");
  a.appendChild(el("button", null, "Скачать файл debtfree.html"));
  wrap.appendChild(p);
  wrap.appendChild(a);
  box.appendChild(wrap);
}

/* ------------------------------------------------------------------ вход в браузере */

function renderLogin(info) {
  $("loading").hidden = true;
  $("panel-plan").hidden = true;
  $("panel-debts").hidden = true;
  $("panel-settings").hidden = false;
  $("tabs").hidden = true;

  const box = $("account-box");
  box.innerHTML = "";

  const title = el("p", "hint", "Войдите, чтобы видеть свои долги здесь и в Telegram. Пароль не нужен: подтверждение придёт в Telegram.");
  box.appendChild(title);

  const btn = el("button", "primary", "Войти через Telegram");
  box.appendChild(btn);

  const status = el("div", "hint");
  status.style.marginTop = "12px";
  box.appendChild(status);

  const codeBox = el("div");
  codeBox.style.display = "none";
  box.appendChild(codeBox);

  btn.addEventListener("click", async function () {
    btn.disabled = true;
    status.textContent = "Создаём код…";
    try {
      const start = await api("auth/login/start", { method: "POST", body: {} });
      state.login.code = start.code;
      status.textContent = "Откройте Telegram и подтвердите вход:";
      codeBox.style.display = "block";
      codeBox.innerHTML = "";

      if (start.deepLink) {
        const link = el("a");
        link.href = start.deepLink;
        link.target = "_blank";
        link.rel = "noopener";
        const openBtn = el("button", "primary", "Открыть Telegram");
        link.appendChild(openBtn);
        codeBox.appendChild(link);
      }

      const code = el("div", "code");
      code.textContent = start.code;
      codeBox.appendChild(code);

      const hint = el("div", "hint");
      hint.innerHTML = "Если кнопка не сработала, отправьте боту команду <b>/start " + start.code + "</b>. " +
        "Код действует " + Math.round((start.expiresInSeconds || 600) / 60) + " минут.";
      codeBox.appendChild(hint);

      const wait = el("div", "hint");
      wait.textContent = "Ждём подтверждения…";
      codeBox.appendChild(wait);

      let attempts = 0;
      clearInterval(state.login.timer);
      state.login.timer = setInterval(async function () {
        attempts++;
        if (attempts > 120) {
          clearInterval(state.login.timer);
          wait.textContent = "Код истёк — нажмите «Войти через Telegram» ещё раз.";
          btn.disabled = false;
          return;
        }
        try {
          const check = await api("auth/login/check", { method: "POST", body: { code: state.login.code } });
          if (check.confirmed) {
            clearInterval(state.login.timer);
            wait.textContent = "Готово! Загружаем данные…";
            await refresh();
          }
        } catch (e) { /* сеть моргнула — продолжаем ждать */ }
      }, 1500);
    } catch (e) {
      status.textContent = "Не получилось создать код: " + e.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ план */

function renderPlan() {
  const data = state.summary;
  if (!data) return;

  const plan = data.plan;
  const debts = state.debts;

  const verdict = $("verdict");
  verdict.innerHTML = "";

  if (!debts.length) {
    const box = el("div", "box info");
    box.textContent = "Добавьте первый долг — и DebtFree посчитает, когда вы освободитесь и сколько сэкономите на процентах.";
    verdict.appendChild(box);
  } else if (plan.unreachable) {
    const box = el("div", "box bad");
    box.innerHTML = "<b>При таком бюджете долг не закрывается.</b> Проценты съедают почти весь платёж. " +
      "Нужно направлять минимум " + fmtMoney(plan.minSum + plan.startTotal * 0.01) + " в месяц.";
    verdict.appendChild(box);
  } else {
    const free = Math.max(0, data.budget - plan.minSum);
    const box = el("div", "box " + (free < Math.max(3000, data.budget * 0.12) ? "warn" : "good"));
    let html = "<b>Свобода от долгов в " + plan.freeMonthLabel + "</b> — через " + durationText(plan.period) + ".";
    if (data.savings && data.savings.interest > 1) {
      html += " Против «платить только минимум» вы экономите <b>" + fmtMoney(data.savings.interest) + "</b> процентов";
      if (data.savings.months > 0) html += " и <b>" + durationText(data.savings.months) + "</b>";
      html += ".";
    }
    if (free < Math.max(3000, data.budget * 0.12)) {
      html += " На досрочное погашение остаётся всего " + fmtMoney(free) + " в месяц — попробуйте добавить к бюджету.";
    }
    box.innerHTML = html;
    verdict.appendChild(box);
  }

  data.validation.problems.slice(0, 3).forEach(function (p) {
    verdict.appendChild(el("div", "box " + (p.level === "error" ? "bad" : "warn"), p.text));
  });

  const kpis = $("kpis");
  kpis.innerHTML = "";
  if (debts.length && !plan.unreachable) {
    const kpi = (title, value, desc, cls) => {
      const c = el("div", "kpi " + (cls || ""));
      c.appendChild(el("div", "t", title));
      c.appendChild(el("div", "v", value));
      if (desc) c.appendChild(el("div", "d", desc));
      return c;
    };
    const parts = plan.freeMonthLabel.split(" ");
    kpis.appendChild(kpi("Свобода от долгов", parts[0] + " " + parts[1], "через " + durationText(plan.period), "hero"));
    kpis.appendChild(kpi("Мой долг", fmtMoney(plan.startTotal), debts.length + " " + plural(debts.length, "долг", "долга", "долгов")));
    kpis.appendChild(kpi("Плачу в месяц", fmtMoney(Math.max(data.budget, plan.minSum)), "минимум " + fmtMoney(plan.minSum)));
    kpis.appendChild(kpi("Проценты", fmtMoney(plan.totalInterest),
      plan.startTotal > 0 ? fmtPct(plan.totalInterest / plan.startTotal * 100, 0) + " к долгу" : "", "warn"));
    kpis.appendChild(kpi("Экономия", data.savings && data.savings.interest != null ? fmtMoney(data.savings.interest) : "—",
      data.minimumOnly.unreachable ? "минимум не закрывает долг" : "против оплаты только минимума", "good"));
  }

  const budgetInput = $("budget");
  if (document.activeElement !== budgetInput) budgetInput.value = groupDigits(Math.round(data.budget));
  const extraInput = $("extra");
  if (document.activeElement !== extraInput) extraInput.value = groupDigits(Math.round(num(state.profile.extra, 0)));
  const emInput = $("extra-month");
  if (document.activeElement !== emInput) emInput.value = String(num(state.profile.extraMonth, 3));
  $("strategy").value = state.profile.strategy || "avalanche";

  const free = Math.max(0, data.budget - plan.minSum);
  $("budget-hint").textContent = debts.length
    ? "Обязательные платежи: " + fmtMoney(plan.minSum) + ". Свободно на досрочку: " + fmtMoney(free) + " в месяц."
    : "Впишите, сколько готовы платить по долгам каждый месяц.";

  renderChart(plan);
  renderOrder(plan);
  renderWhatIf(data.whatIf);
}

/* ------------------------------------------------------------------ график */

function shortMoney(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(".", ",") + " млн";
  if (a >= 1e3) return Math.round(v / 1e3) + " тыс.";
  return String(Math.round(v));
}

function renderChart(plan) {
  const svg = $("chart");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  const months = plan.months;
  const legend = $("legend");
  legend.innerHTML = "";
  if (!months.length) return;

  const step = Math.max(1, Math.ceil(months.length / 40));
  const points = [];
  for (let i = 0; i < months.length; i += step) points.push(months[i]);
  if (points[points.length - 1] !== months[months.length - 1]) points.push(months[months.length - 1]);

  const W = 340, H = 180, padL = 42, padR = 8, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxY = plan.startTotal * 1.05 || 1;
  const X = (i) => padL + (points.length <= 1 ? iw : i * iw / (points.length - 1));
  const Y = (v) => padT + ih - (v / maxY) * ih;

  for (let g = 0; g <= 3; g++) {
    const val = maxY * g / 3, y = Y(val);
    svg.appendChild(mk("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: "rgba(125,135,155,.25)", "stroke-width": 1 }));
    const label = mk("text", { x: padL - 6, y: y + 4, "text-anchor": "end", "font-size": 9, fill: "currentColor", opacity: .55 });
    label.textContent = shortMoney(val);
    svg.appendChild(label);
  }

  let dArea = "", dLine = "";
  points.forEach(function (m, i) {
    const x = X(i).toFixed(1), y = Y(m.totalBalance).toFixed(1);
    dArea += (i === 0 ? "M" : "L") + x + " " + y + " ";
    dLine += (i === 0 ? "M" : "L") + x + " " + y + " ";
  });
  dArea += "L" + X(points.length - 1).toFixed(1) + " " + Y(0).toFixed(1) + " L" + X(0).toFixed(1) + " " + Y(0).toFixed(1) + " Z";
  svg.appendChild(mk("path", { d: dArea, fill: "rgba(79,70,229,.15)" }));
  svg.appendChild(mk("path", { d: dLine, fill: "none", stroke: "#4f46e5", "stroke-width": 2.2, "stroke-linejoin": "round" }));

  const labelEvery = Math.max(1, Math.ceil(points.length / 4));
  points.forEach(function (m, i) {
    if (i % labelEvery !== 0 && i !== points.length - 1) return;
    const t = mk("text", { x: X(i), y: H - 6, "text-anchor": "middle", "font-size": 9, fill: "currentColor", opacity: .55 });
    t.textContent = m.labelShort;
    svg.appendChild(t);
  });

  const last = points[points.length - 1];
  svg.appendChild(mk("circle", { cx: X(points.length - 1), cy: Y(last.totalBalance), r: 3, fill: "#0f9d6e" }));

  const item = (color, text) => {
    const s = el("span");
    const i = el("i"); i.style.background = color;
    s.appendChild(i);
    s.appendChild(document.createTextNode(text));
    return s;
  };
  legend.appendChild(item("#4f46e5", "остаток долга"));
  legend.appendChild(item("#0f9d6e", "свобода: " + plan.freeMonthLabel));
}

/* ------------------------------------------------------------------ очередь */

function renderOrder(plan) {
  const box = $("order");
  box.innerHTML = "";
  if (!plan.items.length) {
    box.appendChild(el("div", "hint", "Пока нет долгов для расчёта."));
    return;
  }

  const ordered = plan.items.slice().sort((a, b) => (a.paidMonth || 9999) - (b.paidMonth || 9999));
  ordered.forEach(function (it, i) {
    const row = el("div", "step");
    row.appendChild(el("div", "num", String(i + 1)));

    const body = el("div", "body");
    body.appendChild(el("div", "ttl", it.name));
    body.appendChild(el("div", "meta", fmtMoney(it.start) + " · " + fmtPct(it.rate, 1) + " · минимум " + fmtMoney(it.minPay) + "/мес"));
    body.appendChild(el("div", "why", it.paidMonth
      ? "закроется в " + monthLabel(it.paidMonth - 1, true) + " (" + it.paidMonth + "-й месяц), проценты " + fmtMoney(it.totalInterest)
      : "не закрывается при текущем бюджете"));

    if (i === 0) {
      body.appendChild(el("div", "why", plan.ordering === "snowball"
        ? "Цель номер один: самый маленький долг — быстрая победа."
        : "Цель номер один: самая высокая ставка — каждый рубль экономит больше всего."));
    }
    row.appendChild(body);

    if (it.paidMonth) row.appendChild(el("div", "paid" + (it.paidMonth <= 3 ? " soon" : ""), monthLabel(it.paidMonth - 1, false)));
    box.appendChild(row);
  });
}

function renderWhatIf(rows) {
  const tb = $("whatif").querySelector("tbody");
  tb.innerHTML = "";
  if (!rows || !rows.length || !state.summary) return;
  const current = state.summary.budget;
  rows.forEach(function (r) {
    const tr = el("tr");
    if (Math.abs(r.budget - current) < 1) tr.className = "me";
    tr.appendChild(el("td", null, fmtMoney(r.budget) + (Math.abs(r.budget - current) < 1 ? " — сейчас" : "")));
    tr.appendChild(el("td", "n", r.unreachable ? "не закрыть" : durationText(r.period)));
    tr.appendChild(el("td", "n", r.savedInterest != null && r.savedInterest > 0 ? "−" + fmtMoney(r.savedInterest) : "—"));
    tb.appendChild(tr);
  });
}

/* ------------------------------------------------------------------ долги */

function renderDebts() {
  const list = $("debts-list");
  list.innerHTML = "";

  if (!state.debts.length) {
    const empty = el("div", "hint");
    empty.style.padding = "16px";
    empty.textContent = "Долгов пока нет. Нажмите «Добавить»: название, остаток, ставка и минимальный платёж.";
    list.appendChild(empty);
  }

  state.debts.forEach(function (d, i) {
    const row = el("button", "debt-row");
    row.type = "button";
    const mark = el("span", "mark");
    mark.style.background = PALETTE[i % PALETTE.length];
    const main = el("div", "main");
    main.appendChild(el("div", "nm", d.name));
    main.appendChild(el("div", "sub", fmtPct(d.rate, 1) + " · минимум " + fmtMoney(d.minPay) + "/мес" +
      (d.term ? " · срок " + d.term + " мес." : "")));
    row.appendChild(mark);
    row.appendChild(main);
    row.appendChild(el("div", "sum", fmtMoney(d.amount)));
    row.addEventListener("click", () => openSheet(d));
    list.appendChild(row);
  });

  const alerts = $("debt-alerts");
  alerts.innerHTML = "";
  if (state.summary && state.summary.validation.problems.length) {
    state.summary.validation.problems.slice(0, 4).forEach(function (p) {
      alerts.appendChild(el("div", "box " + (p.level === "error" ? "bad" : "warn"), p.text));
    });
  }
}

/* ------------------------------------------------------------------ редактор */

function openSheet(debt) {
  state.editingId = debt ? debt.id : null;
  $("sheet-title").textContent = debt ? "Изменить долг" : "Новый долг";
  $("f-name").value = debt ? debt.name : "";
  $("f-amount").value = debt ? groupDigits(String(Math.round(debt.amount))) : "";
  $("f-rate").value = debt ? String(debt.rate).replace(".", ",") : "";
  $("f-min").value = debt ? groupDigits(String(Math.round(debt.minPay))) : "";
  $("f-term").value = debt && debt.term ? String(debt.term) : "";
  $("f-day").value = debt ? String(debt.dueDay || 1) : "10";
  $("sheet-delete").hidden = !debt;
  $("sheet-hint").textContent = debt
    ? "Ставку и минимальный платёж смотрите в приложении банка или в договоре."
    : "Если не знаете ставку — поставьте 0, план всё равно посчитается.";
  $("sheet").hidden = false;
  setTimeout(() => $("f-name").focus(), 50);
}

function closeSheet() {
  $("sheet").hidden = true;
  state.editingId = null;
}

async function saveSheet() {
  const debt = {
    id: state.editingId,
    name: $("f-name").value.trim() || "Долг",
    amount: parseMoney($("f-amount").value),
    rate: parseMoney($("f-rate").value),
    minPay: parseMoney($("f-min").value),
    term: parseInt($("f-term").value, 10) || 0,
    dueDay: Math.min(31, Math.max(1, parseInt($("f-day").value, 10) || 1))
  };

  if (debt.amount <= 0) { toast("Укажите остаток долга"); return; }
  if (debt.minPay <= 0) { toast("Укажите минимальный платёж"); return; }

  const list = state.debts.slice();
  if (state.editingId) {
    const idx = list.findIndex((d) => d.id === state.editingId);
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], debt);
  } else {
    list.push(debt);
  }

  const wasEditing = !!state.editingId;
  const btn = $("sheet-save");
  btn.disabled = true;
  try {
    if (state.authMethod === "local") {
      state.debts = list.map((d, i) => Object.assign(normalizeDebt(d, i), { id: d.id || ("loc" + i) }));
      rebuildSummary();
      localSave();
    } else {
      const res = await api("debts", { method: "POST", body: { debts: list } });
      state.debts = res.debts;
      const plan = await api("plan");
      state.summary = plan.data;
    }
    closeSheet();
    haptic("success");
    renderPlan();
    renderDebts();
    toast(wasEditing ? "Сохранено" : "Долг добавлен");
  } catch (e) {
    haptic("error");
    toast(e.offline ? "Сервер недоступен — данные сохранены в браузере" : "Ошибка сохранения: " + e.message);
    if (e.offline) {
      state.debts = list.map((d, i) => Object.assign(normalizeDebt(d, i), { id: d.id || ("loc" + i) }));
      rebuildSummary();
      localSave();
      closeSheet();
      renderPlan();
      renderDebts();
    }
  } finally {
    btn.disabled = false;
  }
}

async function deleteDebt() {
  if (!state.editingId) return;
  if (!confirm("Удалить этот долг?")) return;
  const list = state.debts.filter((d) => d.id !== state.editingId);
  try {
    if (state.authMethod === "local") {
      state.debts = list;
      rebuildSummary();
      localSave();
    } else {
      const res = await api("debts", { method: "POST", body: { debts: list } });
      state.debts = res.debts;
      const plan = await api("plan");
      state.summary = plan.data;
    }
    closeSheet();
    renderPlan();
    renderDebts();
    toast("Долг удалён");
  } catch (e) {
    toast("Не удалось удалить: " + e.message);
  }
}

/* ------------------------------------------------------------------ экспорт и импорт */

function download(content, filename) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportLocal() {
  download(JSON.stringify({
    app: "debtfree",
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    debts: state.debts
  }, null, 2), "debtfree-my-data.json");
  toast("Файл с вашими данными сохранён");
}

function importLocal(file) {
  const reader = new FileReader();
  reader.onload = function () {
    let data = null;
    try { data = JSON.parse(String(reader.result)); }
    catch (e) { toast("Не удалось прочитать файл"); return; }
    const incoming = Array.isArray(data) ? data : (data && data.debts);
    if (!Array.isArray(incoming) || !incoming.length) { toast("В файле нет долгов"); return; }
    state.debts = incoming.map((d, i) => Object.assign(normalizeDebt(d, i), { id: d.id || ("loc" + i) }));
    if (data.profile) state.profile = Object.assign(state.profile, data.profile);
    else if (data.budget !== undefined) state.profile.budget = num(data.budget, 0);
    rebuildSummary();
    localSave();
    renderHeader();
    renderPlan();
    renderDebts();
    toast("Загружено долгов: " + state.debts.length);
  };
  reader.onerror = function () { toast("Ошибка чтения файла"); };
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ табы */

function switchTab(tab) {
  state.tab = tab;
  ["plan", "debts", "settings"].forEach(function (t) {
    $("panel-" + t).hidden = t !== tab;
  });
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  haptic("light");
}

/* ------------------------------------------------------------------ события */

function bind() {
  $("tabs").addEventListener("click", function (ev) {
    const b = ev.target.closest("button");
    if (b) switchTab(b.dataset.tab);
  });

  $("budget").addEventListener("input", function () {
    const v = parseMoney(this.value);
    state.profile.budget = v;
    if (state.authMethod === "local") { rebuildSummary(); renderPlan(); localSave(); }
    else saveProfile({ budget: v });
  });
  $("budget").addEventListener("blur", function () {
    this.value = groupDigits(Math.round(parseMoney(this.value)));
  });

  $("strategy").addEventListener("change", function () {
    state.profile.strategy = this.value;
    if (state.authMethod === "local") { rebuildSummary(); renderPlan(); localSave(); }
    else saveProfile({ strategy: this.value });
  });

  $("extra").addEventListener("input", function () {
    state.profile.extra = parseMoney(this.value);
    if (state.authMethod === "local") { rebuildSummary(); renderPlan(); localSave(); }
    else saveProfile({ extra: state.profile.extra });
  });
  $("extra").addEventListener("blur", function () {
    this.value = groupDigits(Math.round(parseMoney(this.value)));
  });

  $("extra-month").addEventListener("input", function () {
    state.profile.extraMonth = Math.max(1, Math.min(600, parseInt(this.value, 10) || 1));
    if (state.authMethod === "local") { rebuildSummary(); renderPlan(); localSave(); }
    else saveProfile({ extraMonth: state.profile.extraMonth });
  });

  $("btn-add-debt").addEventListener("click", function () { openSheet(null); });
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", function (ev) { if (ev.target === this) closeSheet(); });
  $("sheet-save").addEventListener("click", saveSheet);
  $("sheet-delete").addEventListener("click", deleteDebt);

  $("btn-export").addEventListener("click", function () {
    if (state.authMethod === "local") return exportLocal();
    download(JSON.stringify({
      app: "debtfree",
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      debts: state.debts
    }, null, 2), "debtfree-my-data.json");
    toast("Файл с вашими данными сохранён");
  });

  $("btn-wipe").addEventListener("click", async function () {
    if (!confirm("Удалить все ваши долги и настройки? Это необратимо.")) return;
    if (state.authMethod === "local") {
      state.debts = [];
      state.profile = { budget: 0, strategy: "avalanche", extra: 0, extraMonth: 3, growth: 0 };
      rebuildSummary();
      localSave();
      renderPlan();
      renderDebts();
      toast("Данные удалены");
      return;
    }
    try {
      await api("data", { method: "DELETE" });
      await refresh();
      renderDebts();
      toast("Данные удалены");
    } catch (e) {
      toast("Не удалось удалить данные");
    }
  });

  /* скрытый выбор файла создаём сами: он нужен и в автономном режиме */
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "file-input";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", function () {
    if (this.files && this.files[0]) importLocal(this.files[0]);
    this.value = "";
  });
}

/* ------------------------------------------------------------------ старт */

async function start() {
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      if (tg.setHeaderColor) tg.setHeaderColor("bg_color");
      if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color");
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      if (tg.onEvent) {
        tg.onEvent("themeChanged", function () {
          if (state.summary) renderChart(state.summary.plan);
        });
      }
    } catch (e) { /* старые версии Telegram */ }
  }

  bind();
  renderHeader();
  $("about-version").textContent = "Версия 0.3 · " + (STANDALONE ? "файл без сервера" : "сервис DebtFree");

  try {
    await boot();
    if (state.authMethod && state.authMethod !== "local") finishRender();
  } catch (e) {
    if (e.status === 401) {
      renderLogin({ botUsername: null });
    } else {
      $("loading").textContent = "Не удалось загрузить данные: " + e.message;
    }
  }
}

start();
