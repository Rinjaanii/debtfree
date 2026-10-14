/**
 * DebtFree — расчётное ядро.
 *
 * Чистый JavaScript: ни DOM, ни сети, ни Node-специфики.
 * Один и тот же файл используется браузером (мини-аппа) и сервером (Node),
 * поэтому цифры в интерфейсе и в ответах API не могут разойтись.
 *
 * Модель: ежемесячное начисление процентов по каждому долгу
 * (остаток × ставка / 12), обязательные минимальные платежи по всем долгам,
 * весь остаток бюджета — в один долг по очереди («лавина» или «снежный ком»),
 * после закрытия его платёж переходит на следующий.
 */

export const MAX_MONTHS = 600;

export const PALETTE = [
  "#4f46e5", "#0ea5e9", "#0f9d6e", "#f59e0b", "#e11d48",
  "#8b5cf6", "#14b8a6", "#f97316", "#84cc16", "#6366f1"
];

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/* ------------------------------------------------------------------ утилиты */

export function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
export function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
export function num(x, dflt) { const n = parseFloat(x); return isFinite(n) ? n : dflt; }

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export function fmtMoney(x) {
  if (!isFinite(x)) return "—";
  const neg = x < 0;
  let s = String(Math.round(Math.abs(x))), out = "";
  while (s.length > 3) { out = " " + s.slice(-3) + out; s = s.slice(0, -3); }
  return (neg ? "−" : "") + s + out + " \u20BD";
}

export function fmtPct(x, d) {
  const p = Math.pow(10, d == null ? 1 : d);
  return (Math.round((Number(x) || 0) * p) / p).toFixed(d == null ? 1 : d).replace(".", ",") + "%";
}

export function durationText(m) {
  if (!isFinite(m) || m <= 0) return "—";
  const y = Math.floor(m / 12), mo = m % 12;
  if (y === 0) return m + " " + plural(m, "месяц", "месяца", "месяцев");
  if (mo === 0) return y + " " + plural(y, "год", "года", "лет");
  return y + " " + plural(y, "год", "года", "лет") + " " + mo + " мес.";
}

/** Подпись месяца относительно сегодняшнего. now — для тестов. */
export function monthLabel(offset, withYear, now) {
  const base = now ? new Date(now) : new Date();
  const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  return MONTHS_SHORT[d.getMonth()] + (withYear ? (" " + d.getFullYear()) : "");
}
export function monthLabelFull(offset, now) {
  const base = now ? new Date(now) : new Date();
  const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  return MONTHS_FULL[d.getMonth()] + " " + d.getFullYear();
}
export function yearOf(offset, now) {
  const base = now ? new Date(now) : new Date();
  const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  return d.getFullYear();
}

/* ---------------------------------------------------------------- валидация */

export function validateDebts(debts, budget) {
  const problems = [];
  let sumDebt = 0, sumMin = 0, wsum = 0, rateBase = 0;
  (debts || []).forEach(function (d) {
    if (d.amount > 0) {
      sumDebt += d.amount;
      wsum += d.amount * clamp(d.rate, 0, 300);
      rateBase += d.amount;
    }
    if (d.amount > 0 && d.minPay > 0) sumMin += d.minPay;

    if (d.amount > 0 && d.minPay <= 0) {
      problems.push({ level: "error", text: "«" + d.name + "»: не указан минимальный платёж — долг не будет обслуживаться." });
    }
    const mrate = clamp(d.rate, 0, 300) / 100 / 12;
    if (d.amount > 0 && d.minPay > 0 && mrate > 0 && d.minPay < d.amount * mrate + d.amount * 0.005) {
      problems.push({
        level: "warn",
        text: "«" + d.name + "»: платёж " + fmtMoney(d.minPay) + " почти не уменьшает долг (проценты ≈ " +
              fmtMoney(d.amount * mrate) + "/мес)."
      });
    }
  });
  if (sumMin > budget + 0.5) {
    problems.push({
      level: "error",
      text: "Минимальные платежи (" + fmtMoney(sumMin) + ") больше бюджета (" + fmtMoney(budget) + ")."
    });
  }
  return { problems, sumDebt, sumMin, avgRate: rateBase > 0 ? wsum / rateBase : 0 };
}

/* ---------------------------------------------------------------- симуляция */

/**
 * @param {Array} debts   [{ id, name, amount, rate, minPay, term, dueDay, ownerId, ownerName }]
 * @param {number} budget общий платёж в месяц
 * @param {"avalanche"|"snowball"|"minimum"} ordering
 * @param {{extras?:Array, growth?:number, now?:Date|string}} opts
 */
export function simulate(debts, budget, ordering, opts) {
  opts = opts || {};
  const extras = opts.extras || [];
  const growth = opts.growth || 0;
  const now = opts.now;

  const items = (debts || []).filter(function (d) { return num(d.amount, 0) > 0.005; }).map(function (d, i) {
    const rate = clamp(num(d.rate, 0), 0, 300);
    return {
      key: d.id || ("k" + i),
      name: String(d.name || ("Долг " + (i + 1))),
      ownerId: d.ownerId || null,
      ownerName: d.ownerName || null,
      color: d.color || PALETTE[i % PALETTE.length],
      rate: rate,
      mrate: rate / 100 / 12,
      amount: r2(d.amount),
      minPay: Math.max(0, num(d.minPay, 0)),
      dueDay: clamp(Math.round(num(d.dueDay, 1)), 1, 31),
      start: r2(d.amount),
      /** Исходный размер долга: по нему «снежный ком» выбирает цель и он не меняется
       *  в ходе расчёта (в отличие от amount, который уменьшается с платежами). */
      startAmount: r2(d.amount),
      totalInterest: 0,
      totalPaid: 0,
      principalPaid: 0,
      paidMonth: null,
      idx: i
    };
  });

  const startTotal = r2(items.reduce(function (s, d) { return s + d.start; }, 0));
  const minSum = r2(items.reduce(function (s, d) { return s + d.minPay; }, 0));

  let queue = items.slice();
  function reorder() {
    // Внимание: сортируем по ИСХОДНОМУ размеру долга (startAmount), а не по текущему
    // остатку — иначе «снежный ком» менял бы цель по мере погашения.
    if (ordering === "avalanche") queue.sort(function (a, b) { return (b.mrate - a.mrate) || (b.startAmount - a.startAmount); });
    else if (ordering === "snowball") queue.sort(function (a, b) { return (a.startAmount - b.startAmount) || (b.mrate - a.mrate); });
    else queue.sort(function (a, b) { return a.idx - b.idx; });
    queue = queue.filter(function (d) { return d.amount > 0.005; });
  }
  reorder();

  const months = [];
  let t = 0, everGrew = false;

  for (t = 0; t < MAX_MONTHS && queue.length > 0; t++) {
    const interestByKey = {};
    let interestTotal = 0;
    queue.forEach(function (d) {
      const before = d.amount;
      const intr = d.amount * d.mrate;
      d.totalInterest += intr;
      interestTotal += intr;
      d.amount += intr;
      interestByKey[d.key] = intr;
      if (d.amount > before && d.minPay <= intr + 0.01) everGrew = true;
    });

    const factor = growth > 0 ? Math.pow(1 + growth / 100, Math.floor(t / 12)) : 1;
    let pool = (ordering === "minimum") ? minSum : Math.max(budget * factor, minSum);
    for (let ei = 0; ei < extras.length; ei++) {
      if (Math.round(num(extras[ei].month, -1)) === t) pool += num(extras[ei].amount, 0);
    }
    if (!(pool > 0)) pool = minSum;

    let need = 0;
    queue.forEach(function (d) { need += Math.min(d.minPay, d.amount); });
    let extraPool = Math.max(0, Math.max(pool, need) - need);

    const payByKey = {};
    const closedItems = [];
    let paidTotal = 0;

    queue.forEach(function (d) {
      const p = Math.min(d.minPay, d.amount);
      d.amount = r2(d.amount - p);
      d.totalPaid += p;
      d.principalPaid += Math.max(0, p - Math.min(interestByKey[d.key] || 0, p));
      paidTotal += p;
      payByKey[d.key] = r2((payByKey[d.key] || 0) + p);
      // минимальный платёж тоже может закрыть долг — отмечаем сразу,
      // иначе следующая пересортировка уберёт его из очереди без даты закрытия
      if (d.amount <= 0.005 && d.paidMonth === null) {
        d.amount = 0;
        d.paidMonth = t + 1;
        closedItems.push({ key: d.key, name: d.name, ownerId: d.ownerId, ownerName: d.ownerName });
      }
    });

    let guard = 0;
    while (extraPool > 0.005 && guard++ < 500) {
      reorder();
      if (!queue.length) break;
      const target = queue[0];
      const pay = Math.min(extraPool, target.amount);
      if (pay <= 0.005) break;
      target.amount = r2(target.amount - pay);
      target.totalPaid += pay;
      target.principalPaid += pay;
      paidTotal += pay;
      extraPool -= pay;
      payByKey[target.key] = r2((payByKey[target.key] || 0) + pay);

      // Долг может закрыться прямо здесь, досрочным платежом. Если это не отметить
      // сразу, он останется без даты закрытия: следующий виток цикла его уже
      // отфильтрует, и до проверки ниже он не дойдёт.
      if (target.amount <= 0.005 && target.paidMonth === null) {
        target.amount = 0;
        target.paidMonth = t + 1;
        closedItems.push({ key: target.key, name: target.name, ownerId: target.ownerId, ownerName: target.ownerName });
        queue = queue.filter(function (d) { return d !== target; });
      }
    }

    queue.forEach(function (d) {
      if (d.amount <= 0.005 && d.paidMonth === null) {
        d.amount = 0;
        d.paidMonth = t + 1;
        closedItems.push({ key: d.key, name: d.name, ownerId: d.ownerId, ownerName: d.ownerName });
      }
    });
    queue = queue.filter(function (d) { return d.amount > 0.005; });

    const rec = {
      monthIdx: t,
      label: monthLabel(t, true, now),
      labelShort: monthLabel(t, false, now),
      labelFull: monthLabelFull(t, now),
      year: yearOf(t, now),
      payment: r2(paidTotal),
      interest: r2(interestTotal),
      principal: r2(Math.max(0, paidTotal - interestTotal)),
      totalBalance: r2(queue.reduce(function (s, d) { return s + d.amount; }, 0)),
      bal: {},
      pay: {},
      closed: closedItems.map(function (d) { return d.name; }),
      closedItems: closedItems,
      closedCount: items.filter(function (d) { return d.paidMonth !== null && d.paidMonth <= t + 1; }).length,
      activeCount: queue.length,
      byOwner: {}
    };

    items.forEach(function (d) {
      const ownerKey = d.ownerId || "__none__";
      const bal = (d.paidMonth !== null && d.paidMonth <= t + 1) ? 0 : r2(d.amount);
      rec.bal[d.key] = bal;
      rec.pay[d.key] = payByKey[d.key] || 0;
      if (!rec.byOwner[ownerKey]) rec.byOwner[ownerKey] = { bal: 0, pay: 0, interest: 0 };
      rec.byOwner[ownerKey].bal = r2(rec.byOwner[ownerKey].bal + bal);
      rec.byOwner[ownerKey].pay = r2(rec.byOwner[ownerKey].pay + (rec.pay[d.key] || 0));
    });
    queue.forEach(function (d) {
      const ownerKey = d.ownerId || "__none__";
      if (!rec.byOwner[ownerKey]) rec.byOwner[ownerKey] = { bal: 0, pay: 0, interest: 0 };
    });
    items.forEach(function (d) {
      const ownerKey = d.ownerId || "__none__";
      if (d.paidMonth === t + 1) rec.byOwner[ownerKey].interest = r2(rec.byOwner[ownerKey].interest + d.totalInterest);
    });
    months.push(rec);
  }

  const totalInterest = r2(items.reduce(function (s, d) { return s + d.totalInterest; }, 0));
  const totalPaid = r2(items.reduce(function (s, d) { return s + d.totalPaid; }, 0));
  const unreachable = queue.length > 0;

  // агрегаты по владельцам
  const perOwner = {};
  function bucket(id, name, color) {
    if (!perOwner[id]) perOwner[id] = { id: id, name: name || "Без владельца", color: color || "#94a3b8",
      count: 0, start: 0, interest: 0, paid: 0, minSum: 0, lastPaidMonth: 0, firstPaidMonth: null, debts: [] };
    return perOwner[id];
  }
  items.forEach(function (d) {
    const key = d.ownerId || "__none__";
    const b = bucket(key, d.ownerName, d.color);
    b.count++;
    b.start = r2(b.start + d.start);
    b.interest = r2(b.interest + d.totalInterest);
    b.paid = r2(b.paid + d.totalPaid);
    b.minSum = r2(b.minSum + d.minPay);
    if (d.paidMonth) {
      if (!b.lastPaidMonth || d.paidMonth > b.lastPaidMonth) b.lastPaidMonth = d.paidMonth;
      if (b.firstPaidMonth === null || d.paidMonth < b.firstPaidMonth) b.firstPaidMonth = d.paidMonth;
    }
    b.debts.push({ key: d.key, name: d.name, start: d.start, interest: r2(d.totalInterest),
      paidMonth: d.paidMonth, rate: d.rate, minPay: d.minPay });
  });

  return {
    months,
    items,
    perOwner,
    ordering,
    startTotal,
    minSum,
    totalInterest,
    totalPaid,
    period: months.length,
    unreachable,
    negativeAmortization: everGrew,
    freeMonthOffset: months.length ? months.length - 1 : 0,
    freeMonthLabel: months.length ? monthLabelFull(months.length - 1, now) : null
  };
}

/** Сравнение стратегий + экономия. */
export function compareStrategies(debts, budget, opts) {
  opts = opts || {};
  const base = simulate(debts, 0, "minimum", { now: opts.now });
  const avalanche = simulate(debts, budget, "avalanche", opts);
  const snowball = simulate(debts, budget, "snowball", opts);

  function savings(res) {
    return {
      interest: base.unreachable ? null : Math.max(0, r2(base.totalInterest - res.totalInterest)),
      months: base.unreachable ? null : Math.max(0, base.period - res.period)
    };
  }
  return {
    minimumOnly: base,
    avalanche: avalanche,
    snowball: snowball,
    savings: {
      avalanche: savings(avalanche),
      snowball: savings(snowball),
      avalancheVsSnowball: (avalanche.unreachable || snowball.unreachable) ? null : {
        interest: r2(snowball.totalInterest - avalanche.totalInterest),
        months: snowball.period - avalanche.period
      }
    }
  };
}

/** Сценарии «а если платить больше» — для витрины возможностей. */
export function whatIf(debts, budgets, opts) {
  const base = simulate(debts, 0, "minimum", { now: (opts || {}).now });
  return (budgets || []).map(function (b) {
    const res = simulate(debts, b, "avalanche", opts);
    return {
      budget: b,
      period: res.period,
      freeMonthLabel: res.freeMonthLabel,
      totalInterest: res.totalInterest,
      totalPaid: res.totalPaid,
      unreachable: res.unreachable,
      savedInterest: base.unreachable ? null : Math.max(0, r2(base.totalInterest - res.totalInterest)),
      savedMonths: base.unreachable ? null : Math.max(0, base.period - res.period)
    };
  });
}

/** Строит сетку бюджетов вокруг текущего: 100%, 110%, 125%, 150%, 200%. */
export function budgetGrid(budget) {
  const seen = [];
  [budget, budget * 1.1, budget * 1.25, budget * 1.5, budget * 2].forEach(function (b) {
    const rounded = Math.round(b / 1000) * 1000;
    if (rounded > 0 && seen.indexOf(rounded) < 0) seen.push(rounded);
  });
  return seen.sort(function (a, b) { return a - b; }).slice(0, 6);
}

/** Нормализует долг из внешнего источника (API, файл) в канонический вид. */
export function normalizeDebt(d, i) {
  return {
    id: d.id || null,
    name: String(d.name == null ? ("Долг " + (i + 1)) : d.name).slice(0, 80),
    amount: Math.max(0, r2(num(d.amount, 0))),
    rate: clamp(num(d.rate, 0), 0, 300),
    minPay: Math.max(0, r2(num(d.minPay, 0))),
    term: Math.max(0, Math.round(num(d.term, 0))),
    dueDay: clamp(Math.round(num(d.dueDay, 1)), 1, 31)
  };
}
