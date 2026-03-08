import { describe, it, expect } from "vitest";
import { toSafeErrorMessage } from "../../src/utils/errors.js";

describe("toSafeErrorMessage", () => {
  it("returns safe message for 404", () => {
    const err = Object.assign(new Error("detailed internal msg"), {
      response: { status: 404 },
    });
    const msg = toSafeErrorMessage(err);
    expect(msg).toContain("not found");
    expect(msg).not.toContain("detailed internal msg");
  });

  it("returns safe message for 429", () => {
    const err = Object.assign(new Error("Quota exceeded details"), {
      response: { status: 429 },
    });
    expect(toSafeErrorMessage(err)).toContain("quota exceeded");
  });

  it("returns safe message for 401", () => {
    const err = Object.assign(new Error("token=secret123"), {
      response: { status: 401 },
    });
    const msg = toSafeErrorMessage(err);
    expect(msg).toContain("Authentication");
    expect(msg).not.toContain("secret123");
  });

  it("caps plain Error message at 200 chars", () => {
    const longMessage = "x".repeat(300);
    const err = new Error(longMessage);
    const msg = toSafeErrorMessage(err);
    // Should not expose more than 200 chars of the raw message
    expect(msg.length).toBeLessThan(250);
  });

  it("handles non-Error objects", () => {
    const msg = toSafeErrorMessage("a random string");
    expect(msg).toContain("unexpected");
  });

  it("prepends context when provided", () => {
    const err = Object.assign(new Error("x"), { response: { status: 404 } });
    const msg = toSafeErrorMessage(err, "read_email");
    expect(msg).toContain("[read_email]");
  });
});
