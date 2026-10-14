/**
 * DebtFree — проверка подлинности данных Telegram Mini App.
 *
 * Мини-аппа получает от Telegram подписанный набор данных (initData) и
 * отправляет его на сервер. Сервер проверяет подпись секретом бота и только
 * после этого доверяет идентификатору пользователя. Это заменяет логины и
 * пароли: пароль не нужен, потому что подпись может выдать только Telegram.
 *
 * Алгоритм (Bot API, раздел WebAppInitData):
 *   1. из initData убрать поле hash, остальные поля отсортировать по имени
 *      и склеить через \n в виде key=value;
 *   2. secret = HMAC_SHA256(key = "WebAppData", data = bot_token);
 *   3. hash   = HMAC_SHA256(key = secret,        data = склейка из п.1);
 *   4. сравнить полученный hash с присланным.
 */

import crypto from "node:crypto";

const HASH_FIELD = "hash";
const SIGNATURE_FIELD = "signature";

/**
 * @param {string} initData строка вида "query_id=...&user=...&auth_date=...&hash=..."
 * @param {string} botToken токен бота
 * @param {{maxAgeSeconds?:number, now?:number}} [opts]
 * @returns {{ok:boolean, error?:string, user?:object, authDate?:number, startParam?:string, data?:object}}
 */
export function verifyInitData(initData, botToken, opts) {
  opts = opts || {};
  const maxAge = opts.maxAgeSeconds == null ? 86400 : opts.maxAgeSeconds; // сутки
  const nowSec = Math.floor((opts.now == null ? Date.now() : opts.now) / 1000);

  if (!initData || typeof initData !== "string") return { ok: false, error: "initData_missing" };
  if (!botToken) return { ok: false, error: "bot_token_missing" };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return { ok: false, error: "initData_unparsable" };
  }

  const receivedHash = params.get(HASH_FIELD);
  if (!receivedHash) return { ok: false, error: "hash_missing" };

  const pairs = [];
  params.forEach(function (value, key) {
    if (key === HASH_FIELD || key === SIGNATURE_FIELD) return;
    pairs.push(key + "=" + value);
  });
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "hash_invalid" };
  }

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate) return { ok: false, error: "auth_date_missing" };
  if (nowSec - authDate > maxAge) return { ok: false, error: "auth_date_expired", authDate };
  if (authDate - nowSec > 300) return { ok: false, error: "auth_date_in_future", authDate };

  let user = null;
  try {
    const raw = params.get("user");
    if (raw) user = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "user_unparsable" };
  }
  if (!user || !user.id) return { ok: false, error: "user_missing" };

  return {
    ok: true,
    user: user,
    authDate: authDate,
    startParam: params.get("start_param") || null,
    data: Object.fromEntries(params.entries())
  };
}

/** Достаёт initData из заголовков запроса: Authorization: tma <initData>. */
export function initDataFromHeaders(headers) {
  const raw = headers && (headers["authorization"] || headers["Authorization"]);
  if (!raw) return null;
  const parts = String(raw).split(" ");
  if (parts.length < 2 || parts[0].toLowerCase() !== "tma") return null;
  return parts.slice(1).join(" ");
}

/** Короткий читаемый идентификатор пользователя — для логов, без персональных данных. */
export function shortUser(user) {
  if (!user) return "?";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return "#" + user.id + (name ? " (" + name + ")" : "");
}

/* ================================================================ веб-сессии
 *
 * Telegram гарантирует, кто вы, только внутри своего клиента. В обычном браузере
 * такой гарантии нет, поэтому вход в веб-версию устроен так:
 *
 *   1. браузер просит у сервера одноразовый код и открывает ссылку на бота;
 *   2. вы подтверждаете вход в Telegram (нажатием в боте) — сервер видит подтверждение
 *      из проверенного Telegram-соединения и связывает код с вашим аккаунтом;
 *   3. браузер забирает код и получает сессионную куку.
 *
 * Пароля нет: подтверждение приходит из Telegram, а не из браузера. Код одноразовый
 * и живёт несколько минут, сессия — месяц.
 */

const COOKIE_NAME = "df_session";
const LOGIN_TTL_MS = 10 * 60 * 1000;        // сколько ждём подтверждения
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // месяц

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Код подтверждения: короткий и без похожих символов, чтобы его можно было ввести руками. */
export function newLoginCode() {
  const alphabet = "ACDEFGHJKLMNPQRTUVWXY34679";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Хранилище сессий и кодов подтверждения.
 * Живёт в памяти: после перезапуска сервера нужно войти заново — это осознанный
 * компромисс ради простоты, данные пользователей при этом не теряются.
 */
export class SessionStore {
  constructor() {
    this.sessions = new Map(); // token -> { userId, createdAt, lastSeen }
    this.codes = new Map();    // code  -> { status: "pending"|"confirmed", userId, createdAt }
  }

  /** Шаг 1: браузер просит код. */
  startLogin() {
    this.cleanup();
    const code = newLoginCode();
    this.codes.set(code, { status: "pending", userId: null, createdAt: Date.now() });
    return code;
  }

  /** Шаг 2: Telegram подтверждает код (вызывается только из проверенного контекста). */
  confirmLogin(code, userId) {
    this.cleanup();
    const entry = this.codes.get(String(code || "").toUpperCase());
    if (!entry) return false;
    entry.status = "confirmed";
    entry.userId = String(userId);
    return true;
  }

  /** Шаг 3: браузер забирает код и получает сессию. */
  redeemLogin(code) {
    this.cleanup();
    const key = String(code || "").toUpperCase();
    const entry = this.codes.get(key);
    if (!entry || entry.status !== "confirmed") return null;
    this.codes.delete(key); // одноразовый
    const token = randomHex(24);
    this.sessions.set(token, { userId: entry.userId, createdAt: Date.now(), lastSeen: Date.now() });
    return { token, userId: entry.userId };
  }

  /** Проверяет сессию по токену из куки. */
  resolve(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    s.lastSeen = Date.now();
    return s.userId;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  cleanup() {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (now - entry.createdAt > LOGIN_TTL_MS) this.codes.delete(code);
    }
    for (const [token, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(token);
    }
  }

  stats() {
    return { sessions: this.sessions.size, pendingCodes: this.codes.size };
  }
}

/** Разбирает куки запроса в объект. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(";").forEach(function (part) {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function sessionTokenFromHeaders(headers) {
  const cookies = parseCookies(headers && headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

/** Заголовок Set-Cookie для сессии. secure=true обязателен для боевого HTTPS. */
export function sessionCookie(token, secure) {
  const parts = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure) {
  const parts = [COOKIE_NAME + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export const COOKIE = { name: COOKIE_NAME, loginTtlMs: LOGIN_TTL_MS, sessionTtlMs: SESSION_TTL_MS };
