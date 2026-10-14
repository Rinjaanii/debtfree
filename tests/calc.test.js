/**
 * Тесты расчётного ядра.
 *
 * Главная проверка — сверка с независимо написанной моделью: она считает тот же
 * сценарий «в лоб», другим кодом. Если движок и эталон расходятся хотя бы на рубль,
 * тест падает: значит в ядре ошибка (или эталон устарел — но тогда это надо объяснить).
 *
 * Запуск: node tests/calc.test.js
 */

import {
  simulate, compareStrategies, validateDebts, whatIf, budgetGrid,
  fmtMoney, durationText, monthLabelFull, r2
} from "../src/calc.js";

let passed = 0, failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "получено " + JSON.stringify(actual) + ", ожидалось " + JSON.stringify(expected));
}
function near(name, actual, expected, tolerance) {
  ok(name, Math.abs(actual - expected) <= (tolerance == null ? 0.01 : tolerance),
    "получено " + actual + ", ожидалось " + expected);
}

/* ------------------------------------------------------------------ данные */

const DEMO = [
  { id: "d1", name: "Кредитная карта", amount: 350000, rate: 32.0, minPay: 18000, term: 36, dueDay: 5 },
  { id: "d2", name: "Потребительский", amount: 420000, rate: 19.5, minPay: 14500, term: 48, dueDay: 12 },
  { id: "d3", name: "Автокредит", amount: 640000, rate: 14.2, minPay: 19500, term: 60, dueDay: 20 },
  { id: "d4", name: "Рассрочка", amount: 78000, rate: 0, minPay: 6500, term: 12, dueDay: 8 },
  { id: "d5", name: "Долг другу", amount: 50000, rate: 0, minPay: 5000, term: 10, dueDay: 25 }
];
const BUDGET = 75000;

/* --------------------------------------------------- независимая модель */

/** Эталон: та же логика, но написанная отдельно и максимально прямолинейно. */
function reference(debts, budget, strategy) {
  const items = debts.map((d) => ({ name: d.name, amount: d.amount, mrate: d.rate / 100 / 12, minPay: d.minPay }));
  let months = 0, totalInterest = 0;

  while (items.some((d) => d.amount > 0.005) && months < 600) {
    // 1. проценты
    items.forEach((d) => {
      if (d.amount > 0) { const i = d.amount * d.mrate; totalInterest += i; d.amount += i; }
    });
    // 2. минимальные платежи
    let paid = 0;
    items.forEach((d) => {
      if (d.amount > 0) { const p = Math.min(d.minPay, d.amount); d.amount -= p; paid += p; }
    });
    // 3. свободные деньги — в один долг по приоритету
    let extra = budget - paid;
    const order = items.filter((d) => d.amount > 0.005).slice();
    order.sort(strategy === "snowball"
      ? (a, b) => (a.amount - b.amount) || (b.mrate - a.mrate)
      : (a, b) => (b.mrate - a.mrate) || (b.amount - a.amount));
    for (const d of order) {
      if (extra <= 0.005) break;
      const p = Math.min(extra, d.amount);
      d.amount -= p;
      extra -= p;
    }
    months++;
  }
  return { months, totalInterest: Math.round(totalInterest * 100) / 100 };
}

/* ------------------------------------------------------------------ тесты */

console.log("DebtFree — тесты расчётного ядра\n");

console.log("1. Сверка с независимой моделью");
{
  const engine = simulate(DEMO, BUDGET, "avalanche");
  const ref = reference(DEMO, BUDGET, "avalanche");
  eq("срок совпадает с эталоном", engine.period, ref.months);
  near("проценты совпадают с эталоном", engine.totalInterest, ref.totalInterest, 1);
  console.log("    движок: " + engine.period + " мес., " + fmtMoney(engine.totalInterest) +
              " · эталон: " + ref.months + " мес., " + fmtMoney(ref.totalInterest));

  const engineSnow = simulate(DEMO, BUDGET, "snowball");
  const refSnow = reference(DEMO, BUDGET, "snowball");
  eq("снежный ком: срок совпадает", engineSnow.period, refSnow.months);
  near("снежный ком: проценты совпадают", engineSnow.totalInterest, refSnow.totalInterest, 1);
}

console.log("\n2. Бухгалтерия по месяцам");
{
  const res = simulate(DEMO, BUDGET, "avalanche");
  let bad = 0, last = null;
  res.months.forEach(function (m) {
    if (Math.abs(m.payment - m.interest - m.principal) > 0.02) { bad++; last = m; }
  });
  eq("в каждом месяце платёж = проценты + тело", bad, 0,
    last ? ("первое расхождение в " + last.labelFull) : "");

  const sumInterest = r2(res.months.reduce((s, m) => s + m.interest, 0));
  near("сумма процентов по месяцам = итоговые проценты", sumInterest, res.totalInterest, 1);

  const sumPay = r2(res.months.reduce((s, m) => s + m.payment, 0));
  near("сумма платежей = выплачено всего", sumPay, res.totalPaid, 1);

  near("последний месяц закрывает долг в ноль", res.months[res.months.length - 1].totalBalance, 0, 0.01);

  const minSum = DEMO.reduce((s, d) => s + d.minPay, 0);
  eq("сумма минимальных платежей", res.minSum, minSum);
  eq("общий долг на старте", res.startTotal, DEMO.reduce((s, d) => s + d.amount, 0));
}

console.log("\n3. Стратегии и экономия");
{
  const cmp = compareStrategies(DEMO, BUDGET, {});
  ok("лавина выгоднее снежного кома по процентам",
    cmp.avalanche.totalInterest <= cmp.snowball.totalInterest,
    "лавина " + fmtMoney(cmp.avalanche.totalInterest) + " vs ком " + fmtMoney(cmp.snowball.totalInterest));
  ok("экономия против «только минимум» положительная", cmp.savings.avalanche.interest > 0,
    fmtMoney(cmp.savings.avalanche.interest));
  ok("минимальные платежи закрывают долг медленнее",
    cmp.minimumOnly.period >= cmp.avalanche.period,
    "минимум " + cmp.minimumOnly.period + " мес. vs лавина " + cmp.avalanche.period + " мес.");

  /* Главное отличие стратегий — куда идёт ДОСРОЧНАЯ часть платежа (сверх минимумов).
     Порядок закрытия сам по себе об этом не говорит: маленький долг с большим
     минимальным платежом может закрыться раньше по графику банка, хотя вся
     досрочка уходит в дорогой долг. Поэтому проверяем именно адресата досрочки. */
  const extraOf = (res, monthIdx) => {
    const m = res.months[monthIdx];
    const out = [];
    res.items.forEach(function (it) {
      const over = (m.pay[it.key] || 0) - Math.min(it.minPay, (m.pay[it.key] || 0));
      if (over > 0.5) out.push({ name: it.name, rate: it.rate, amount: over });
    });
    return out;
  };

  const av = compareStrategies(DEMO, BUDGET, {});
  const avExtra = extraOf(av.avalanche, 0);
  eq("лавина: досрочка идёт ровно в один долг", avExtra.length, 1);
  eq("лавина: досрочка идёт в самую дорогую ставку", avExtra[0] && avExtra[0].name, "Кредитная карта");
  eq("лавина: размер досрочки = бюджет минус минимумы", avExtra[0] && Math.round(avExtra[0].amount), BUDGET - 63500);

  const snExtra = extraOf(av.snowball, 0);
  eq("снежный ком: досрочка идёт ровно в один долг", snExtra.length, 1);
  eq("снежный ком: досрочка идёт в самый маленький долг", snExtra[0] && snExtra[0].name, "Долг другу");

  /* порядок закрытия: дорогой и дешёвый долги одного размера — дорогой раньше */
  const pair = [
    { id: "p1", name: "Дорогой", amount: 200000, rate: 30, minPay: 5000, term: 60, dueDay: 1 },
    { id: "p2", name: "Дешёвый", amount: 200000, rate: 5, minPay: 5000, term: 60, dueDay: 1 }
  ];
  const pairRes = simulate(pair, 20000, "avalanche");
  const closedOrder = pairRes.items.slice().sort((a, b) => a.paidMonth - b.paidMonth).map((i) => i.name);
  eq("при равных долгах лавина закрывает дорогой первым", closedOrder[0], "Дорогой");
  ok("лавина на паре долгов дешевле снежного кома",
    pairRes.totalInterest <= simulate(pair, 20000, "snowball").totalInterest);

  /* у каждого долга должна быть дата закрытия */
  const noDate = av.avalanche.items.filter((i) => !i.paidMonth).map((i) => i.name);
  eq("у всех долгов есть месяц закрытия", noDate.length, 0, noDate.join(", "));
  const noDateSnow = av.snowball.items.filter((i) => !i.paidMonth).map((i) => i.name);
  eq("снежный ком: у всех долгов есть месяц закрытия", noDateSnow.length, 0, noDateSnow.join(", "));
  ok("даты закрытия идут по возрастанию",
    av.snowball.items.slice().sort((a, b) => a.paidMonth - b.paidMonth)
      .every((it, i, arr) => i === 0 || it.paidMonth >= arr[i - 1].paidMonth));
}

console.log("\n4. Ловушка «проценты больше платежей»");
{
  const heavy = [{ id: "x", name: "Дорогой долг", amount: 500000, rate: 40, minPay: 5000, term: 0, dueDay: 1 }];
  const res = simulate(heavy, 5000, "avalanche");
  ok("долг помечен как незакрываемый", res.unreachable === true,
    "срок " + res.period + " мес., остаток " + fmtMoney(res.months[res.months.length - 1].totalBalance));
  ok("обнаружено отрицательное погашение", res.negativeAmortization === true);

  const validation = validateDebts(heavy, 5000);
  ok("валидация предупреждает о платеже меньше процентов",
    validation.problems.some((p) => /почти не уменьшает/.test(p.text)));

  const raised = simulate(heavy, 30000, "avalanche");
  eq("при достаточном бюджете долг закрывается", raised.unreachable, false);
}

console.log("\n5. Валидация данных");
{
  const v1 = validateDebts([{ name: "Без платежа", amount: 100000, rate: 10, minPay: 0 }], 50000);
  ok("ошибка: не указан минимальный платёж", v1.problems.some((p) => p.level === "error"));

  const v2 = validateDebts([{ name: "Долг", amount: 300000, rate: 20, minPay: 10000 }], 5000);
  ok("ошибка: минимальные платежи больше бюджета", v2.problems.some((p) => /больше бюджета/.test(p.text)));

  const v3 = validateDebts(DEMO, BUDGET);
  eq("корректные данные без ошибок уровня error", v3.problems.filter((p) => p.level === "error").length, 0);
  near("средневзвешенная ставка", v3.avgRate, 18.5, 0.3);
}

console.log("\n6. Владельцы (несколько участников)");
{
  const family = DEMO.map((d, i) => Object.assign({}, d, {
    ownerId: i < 2 ? "u1" : (i < 4 ? "u2" : "u3"),
    ownerName: i < 2 ? "Андрей" : (i < 4 ? "Ольга" : "Отец")
  }));
  const res = simulate(family, BUDGET, "avalanche");
  const owners = Object.keys(res.perOwner).map((k) => res.perOwner[k]);

  eq("участников с долгами", owners.length, 3);
  near("сумма долгов по участникам = общий долг",
    r2(owners.reduce((s, o) => s + o.start, 0)), res.startTotal, 0.01);
  near("сумма процентов по участникам = общие проценты",
    r2(owners.reduce((s, o) => s + o.interest, 0)), res.totalInterest, 0.5);
  eq("количество долгов по участникам совпадает",
    owners.reduce((s, o) => s + o.count, 0), DEMO.length);

  const andrey = res.perOwner["u1"], olga = res.perOwner["u2"], papa = res.perOwner["u3"];
  eq("у Андрея 2 долга", andrey.count, 2);
  eq("у Отца 1 долг", papa.count, 1);
  eq("у Отца беспроцентный долг — процентов нет", papa.interest, 0);
  ok("у Ольги есть проценты", olga.interest > 0);
  ok("Андрей закрывает свои долги не позже Ольги",
    andrey.lastPaidMonth <= olga.lastPaidMonth,
    "Андрей " + andrey.lastPaidMonth + " мес., Ольга " + olga.lastPaidMonth + " мес.");

  /* помесячные суммы по владельцам должны сходиться с общим остатком */
  let mismatch = 0;
  res.months.forEach(function (m) {
    const sum = Object.keys(m.byOwner).reduce((s, k) => s + m.byOwner[k].bal, 0);
    if (Math.abs(sum - m.totalBalance) > 0.02) mismatch++;
  });
  eq("остаток по владельцам = общий остаток в каждом месяце", mismatch, 0);
}

console.log("\n7. Доплаты и рост бюджета");
{
  const base = simulate(DEMO, BUDGET, "avalanche");
  const withExtra = simulate(DEMO, BUDGET, "avalanche", { extras: [{ month: 2, amount: 100000 }] });
  ok("разовая доплата сокращает срок", withExtra.period < base.period,
    base.period + " мес. → " + withExtra.period + " мес. с доплатой");
  ok("разовая доплата снижает проценты", withExtra.totalInterest < base.totalInterest);

  const growing = simulate(DEMO, BUDGET, "avalanche", { growth: 10 });
  ok("рост бюджета на 10% в год сокращает срок", growing.period < base.period,
    base.period + " → " + growing.period);

  const zeroGrowth = simulate(DEMO, BUDGET, "avalanche", { growth: 0 });
  eq("нулевой рост не меняет срок", zeroGrowth.period, base.period);
}

console.log("\n8. Границы и устойчивость");
{
  eq("пустой список долгов — срок 0", simulate([], 50000, "avalanche").period, 0);
  eq("нулевой бюджет без долгов — не падает", simulate([], 0, "avalanche").startTotal, 0);

  const oneShot = simulate([{ name: "Долг", amount: 10000, rate: 0, minPay: 10000 }], 10000, "avalanche");
  eq("долг закрывается за один месяц", oneShot.period, 1);
  near("процентов нет при ставке 0", oneShot.totalInterest, 0, 0.001);

  const tiny = simulate([{ name: "Копейки", amount: 0.004, rate: 10, minPay: 100 }], 100, "avalanche");
  eq("долг меньше половины копейки игнорируется", tiny.period, 0);

  const big = Array.from({ length: 50 }, (_, i) => ({
    id: "b" + i, name: "Долг " + (i + 1), amount: 100000 + i * 1000, rate: 5 + i % 20, minPay: 3000, term: 60, dueDay: 1
  }));
  const bigRes = simulate(big, 250000, "avalanche");
  ok("50 долгов считаются и закрываются", !bigRes.unreachable && bigRes.period > 0 && bigRes.period < 600,
    bigRes.period + " мес.");

  /* стабильность: повторный расчёт даёт тот же результат */
  const a = simulate(DEMO, BUDGET, "avalanche");
  const b = simulate(DEMO, BUDGET, "avalanche");
  eq("повторный расчёт идентичен", a.totalInterest, b.totalInterest);
  eq("повторный расчёт не портит исходные данные", DEMO[0].amount, 350000);
}

console.log("\n9. Что если платить больше");
{
  const rows = whatIf(DEMO, budgetGrid(BUDGET), {});
  ok("сценариев не меньше трёх", rows.length >= 3);
  ok("больший бюджет даёт не больший срок",
    rows.every((r, i) => i === 0 || r.unreachable || rows[i - 1].unreachable || r.period <= rows[i - 1].period));
  const last = rows[rows.length - 1];
  ok("на удвоенном бюджете экономия процентов положительная", last.savedInterest > 0, fmtMoney(last.savedInterest));
}

console.log("\n10. Форматирование");
{
  eq("деньги", fmtMoney(1488000), "1 488 000 \u20BD");
  eq("деньги с копейками округляются", fmtMoney(1234.6), "1 235 \u20BD");
  eq("срок: ровно год", durationText(12), "1 год");
  eq("срок: 2 года", durationText(24), "2 года");
  eq("срок: с остатком", durationText(13), "1 год 1 мес.");
  eq("срок: месяцы", durationText(5), "5 месяцев");
  ok("название месяца с годом", /^\S+ \d{4}$/.test(monthLabelFull(0)));
}

/* ------------------------------------------------------------------ итог */

console.log("\n" + "─".repeat(58));
console.log("Пройдено: " + passed + ", провалено: " + failed);
if (failed) {
  console.log("\nПроваленные проверки:");
  failures.forEach((f) => console.log("  • " + f));
  process.exit(1);
}
console.log("Все проверки пройдены.");
