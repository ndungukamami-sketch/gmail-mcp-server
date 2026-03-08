/**
 * Exponential-backoff retry helper for Gmail API calls.
 * Handles 429 (quota exceeded) and 5xx (transient) errors.
 */

import { logger } from "./logger.js";
import { isRetryableError } from "./errors.js";

export interface RetryOptions {
  maxAttempts?: number; // default: 4
  baseDelayMs?: number; // default: 1000
  maxDelayMs?: number; // default: 30_000
  retryOn?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    retryOn = isRetryableError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!retryOn(err) || attempt === maxAttempts - 1) {
        throw err;
      }

      const jitter = Math.random() * 300;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + jitter, maxDelayMs);

      logger.warn({
        msg: "Gmail API error — retrying",
        attempt: attempt + 1,
        maxAttempts,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
