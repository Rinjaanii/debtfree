/**
 * Чтение настроек из файла .env рядом с проектом.
 *
 * Зачем: чтобы не писать каждый раз длинную команду с токеном в консоли.
 * Создайте файл `debtfree/.env`:
 *
 *   TELEGRAM_BOT_TOKEN=123456:AA...
 *   TELEGRAM_BOT_USERNAME=my_debtfree_bot
 *   PORT=8080
 *
 * Файл в git не попадает (см. .gitignore) — токен остаётся только у вас.
 * Значения из окружения имеют приоритет над файлом.
 */

import fs from "node:fs";
import path from "node:path";

export function loadEnv(rootDir) {
  const file = path.join(rootDir || process.cwd(), ".env");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { loaded: false, file: file };
  }

  const loaded = [];
  raw.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key) return;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  });

  return { loaded: true, file: file, keys: loaded };
}
