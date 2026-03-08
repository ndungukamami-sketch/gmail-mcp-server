/**
 * Structured JSON logger — all output goes to stderr so it never
 * interferes with the MCP stdio protocol on stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): LogLevel {
  const env = process.env["GMAIL_MCP_LOG_LEVEL"]?.toLowerCase();
  if (env && env in LEVEL_RANK) return env as LogLevel;
  return "info";
}

const configuredLevel = resolveLevel();

function log(level: LogLevel, data: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel]) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, ...data });
  process.stderr.write(entry + "\n");
}

export const logger = {
  debug: (data: Record<string, unknown>) => log("debug", data),
  info: (data: Record<string, unknown>) => log("info", data),
  warn: (data: Record<string, unknown>) => log("warn", data),
  error: (data: Record<string, unknown>) => log("error", data),
};
