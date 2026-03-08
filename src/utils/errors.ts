/**
 * Safe error handling — raw Gmail API errors are never forwarded to the
 * LLM caller. Only whitelisted, user-friendly messages are returned.
 * The full error is always logged to stderr for debugging.
 */

import { logger } from "./logger.js";

interface GaxiosLike {
  response?: { status?: number };
  message: string;
}

function isGaxiosError(err: unknown): err is GaxiosLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as GaxiosLike).message === "string"
  );
}

const SAFE_MESSAGES: Record<number, string> = {
  400: "Invalid request — check the email ID, label, or parameters.",
  401: "Authentication failed — please re-run the OAuth flow.",
  403: "Permission denied — the requested operation is not allowed.",
  404: "Resource not found — the email or label ID does not exist.",
  409: "Conflict — a resource with that name already exists (e.g. duplicate label).",
  429: "Gmail API quota exceeded — please wait before retrying.",
  500: "Gmail API server error — please try again shortly.",
  503: "Gmail API temporarily unavailable — please try again shortly.",
};

export function toSafeErrorMessage(err: unknown, context?: string): string {
  const prefix = context ? `[${context}] ` : "";

  if (isGaxiosError(err)) {
    const status = err.response?.status;
    if (status !== undefined && status in SAFE_MESSAGES) {
      return `${prefix}${SAFE_MESSAGES[status]}`;
    }
  }

  if (err instanceof Error) {
    // Surface only the first 200 chars of the message, never the stack
    return `${prefix}Operation failed: ${err.message.slice(0, 200)}`;
  }

  return `${prefix}An unexpected error occurred.`;
}

export function isRetryableError(err: unknown): boolean {
  if (isGaxiosError(err)) {
    const status = err.response?.status;
    return status === 429 || (status !== undefined && status >= 500);
  }
  return false;
}

export function logAndRethrow(err: unknown, tool: string): never {
  logger.error({ msg: "Tool call failed", tool, error: String(err) });
  throw err;
}
