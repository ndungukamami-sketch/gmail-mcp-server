import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeTokens, readTokens } from "../../src/auth/token-store.js";

const TEST_KEY = "a".repeat(64); // 64 hex chars = 32 bytes
const TEST_TOKEN_PATH = path.join(os.tmpdir(), `gmail-mcp-test-${Date.now()}.enc`);

describe("token-store (AES-256-GCM)", () => {
  beforeAll(() => {
    process.env["GMAIL_MCP_TOKEN_KEY"] = TEST_KEY;
  });

  afterAll(() => {
    delete process.env["GMAIL_MCP_TOKEN_KEY"];
    if (fs.existsSync(TEST_TOKEN_PATH)) {
      fs.unlinkSync(TEST_TOKEN_PATH);
    }
  });

  it("round-trips tokens correctly", () => {
    const tokens = {
      access_token: "ya29.test-access-token",
      refresh_token: "1//test-refresh-token",
      expiry_date: Date.now() + 3600_000,
      token_type: "Bearer",
    };

    writeTokens(TEST_TOKEN_PATH, tokens);
    const recovered = readTokens(TEST_TOKEN_PATH);

    expect(recovered).toMatchObject(tokens);
  });

  it("writes file with mode 0o600", () => {
    writeTokens(TEST_TOKEN_PATH, { access_token: "test" });
    const stat = fs.statSync(TEST_TOKEN_PATH);
    // On Unix systems, check permissions (octal 0o600)
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not store plaintext token in the file", () => {
    const tokens = { access_token: "SUPER_SECRET_TOKEN_12345" };
    writeTokens(TEST_TOKEN_PATH, tokens);
    const fileContents = fs.readFileSync(TEST_TOKEN_PATH, "utf8");
    expect(fileContents).not.toContain("SUPER_SECRET_TOKEN_12345");
    expect(fileContents).not.toContain("access_token");
  });

  it("returns null when file does not exist", () => {
    const result = readTokens("/tmp/nonexistent-token-file-xyz.enc");
    expect(result).toBeNull();
  });

  it("throws on corrupt file", () => {
    const corruptPath = TEST_TOKEN_PATH + ".corrupt";
    fs.writeFileSync(corruptPath, "dGhpcyBpcyBub3QgdmFsaWQ=", { mode: 0o600 });
    expect(() => readTokens(corruptPath)).toThrow();
    fs.unlinkSync(corruptPath);
  });

  it("throws when GMAIL_MCP_TOKEN_KEY env is missing", () => {
    const savedKey = process.env["GMAIL_MCP_TOKEN_KEY"];
    delete process.env["GMAIL_MCP_TOKEN_KEY"];
    expect(() => writeTokens(TEST_TOKEN_PATH, {})).toThrow("GMAIL_MCP_TOKEN_KEY");
    process.env["GMAIL_MCP_TOKEN_KEY"] = savedKey;
  });

  it("throws when GMAIL_MCP_TOKEN_KEY env is wrong length", () => {
    const savedKey = process.env["GMAIL_MCP_TOKEN_KEY"];
    process.env["GMAIL_MCP_TOKEN_KEY"] = "tooshort";
    expect(() => writeTokens(TEST_TOKEN_PATH, {})).toThrow("GMAIL_MCP_TOKEN_KEY");
    process.env["GMAIL_MCP_TOKEN_KEY"] = savedKey;
  });
});
