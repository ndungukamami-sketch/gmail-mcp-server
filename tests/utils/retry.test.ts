import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/utils/retry.js";

describe("withRetry", () => {
  it("returns result immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds eventually", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const err = Object.assign(new Error("quota"), {
          response: { status: 429 },
        });
        throw err;
      }
      return "success";
    });

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable error (e.g. 404)", async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error("not found"), { response: { status: 404 } })
    );

    await expect(
      withRetry(fn, { baseDelayMs: 1 })
    ).rejects.toThrow("not found");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxAttempts are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error("server error"), { response: { status: 500 } })
    );

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toThrow("server error");

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
