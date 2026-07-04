/**
 * Tiny structured logger — JSON lines in production, readable text in dev.
 * Deliberately dependency-free; swap for pino later if log volume demands it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** New logger with `name` and extra bound fields attached to every line. */
  child(name: string, fields?: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel,
  options: { name?: string; json?: boolean; bound?: Record<string, unknown> } = {},
): Logger {
  const {
    name = "pigeon",
    json = process.env.NODE_ENV === "production",
    bound = {},
  } = options;
  const threshold = LEVEL_ORDER[level];

  function write(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const merged = { ...bound, ...fields };
    if (json) {
      process.stdout.write(
        JSON.stringify({ ts, level: lvl, name, msg, ...merged }) + "\n",
      );
    } else {
      const extras = Object.entries(merged)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      process.stdout.write(
        `${ts.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}${extras ? " " + extras : ""}\n`,
      );
    }
  }

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (childName, fields = {}) =>
      createLogger(level, {
        name: `${name}:${childName}`,
        json,
        bound: { ...bound, ...fields },
      }),
  };
}
