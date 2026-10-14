/**
 * Разбор настроек для скрипта туннеля.
 *
 * Вынесено отдельно, чтобы это можно было проверить тестами без запуска процессов:
 * здесь нет ни сети, ни spawn — только разбор аргументов и выбор команды.
 */

/** Значение аргумента вида --name=value или --name value. */
export function argValue(args, name, dflt) {
  const list = args || [];
  const withEquals = list.find((a) => a.startsWith("--" + name + "="));
  if (withEquals) return withEquals.split("=").slice(1).join("=");
  const idx = list.indexOf("--" + name);
  if (idx >= 0 && list[idx + 1] && !list[idx + 1].startsWith("--")) return list[idx + 1];
  return dflt;
}

/** Доступные провайдеры туннеля. */
export const PROVIDERS = ["localtunnel", "cloudflared", "ngrok"];

/**
 * Команда для выбранного провайдера.
 * @returns {{cmd:string, args:string[], kind:string}|{error:string, available:string[]}}
 */
export function providerCommand(provider, port) {
  const name = String(provider || "localtunnel").toLowerCase();
  if (name === "localtunnel" || name === "lt") {
    return { cmd: "npx", args: ["--yes", "localtunnel", "--port", String(port)], kind: "localtunnel" };
  }
  if (name === "cloudflared") {
    return { cmd: "npx", args: ["--yes", "cloudflared", "tunnel", "--url", "http://localhost:" + port], kind: "cloudflared" };
  }
  if (name === "ngrok") {
    return { cmd: "npx", args: ["--yes", "ngrok", "http", String(port)], kind: "ngrok" };
  }
  return { error: "unknown_provider", available: PROVIDERS };
}

/** Разбирает аргументы командной строки в настройки запуска. */
export function parseTunnelArgs(argv, env) {
  const args = (argv || []).filter((a) => a !== "--");
  env = env || {};
  const portText = argValue(args, "port", env.PORT || "8080");
  const port = parseInt(portText, 10);
  return {
    provider: String(argValue(args, "provider", "localtunnel")).toLowerCase(),
    port: isFinite(port) && port > 0 && port < 65536 ? port : 8080,
    timeoutMs: Math.max(5000, parseInt(argValue(args, "timeout", "60000"), 10) || 60000),
    skipSetup: args.includes("--no-setup"),
    quiet: args.includes("--quiet")
  };
}

/** Ищет публичный адрес в выводе туннеля. */
export function urlFromText(text) {
  const match = String(text || "").match(
    /https?:\/\/[a-z0-9][a-z0-9.-]*\.(?:loca\.lt|trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app|ngrok-free\.dev)/i
  );
  if (!match) return null;
  return match[0].replace(/^http:/, "https:");
}
