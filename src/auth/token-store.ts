/**
 * Encrypted token storage using AES-256-GCM.
 *
 * The encryption key is derived from the GMAIL_MCP_TOKEN_KEY environment
 * variable (64 hex chars = 32 bytes). If not set, the server refuses to start.
 *
 * File format: base64( iv[12] || authTag[16] || ciphertext )
 * File permissions: 0o600 (owner read/write only)
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger.js";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_ENV = "GMAIL_MCP_TOKEN_KEY";

export interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

function getKey(): Buffer {
  const hex = process.env[KEY_ENV];
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Environment variable ${KEY_ENV} must be a 64-character hex string (32 bytes).\n` +
        `Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n` +
        `Then set it in your shell or Claude Desktop config.`
    );
  }
  return Buffer.from(hex, "hex");
}

export function writeTokens(tokenPath: string, tokens: StoredTokens): void {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // iv (12 bytes) + authTag (16 bytes) + ciphertext
  const payload = Buffer.concat([iv, authTag, encrypted]);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });

  // Write with restrictive permissions
  fs.writeFileSync(tokenPath, payload.toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });

  logger.debug({ msg: "Tokens written (encrypted)", path: tokenPath });
}

export function readTokens(tokenPath: string): StoredTokens | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  const key = getKey();
  const raw = Buffer.from(fs.readFileSync(tokenPath, "utf8"), "base64");

  if (raw.length < 29) {
    // 12 (iv) + 16 (tag) + 1 (min ciphertext)
    throw new Error("Token file is corrupt or truncated.");
  }

  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "Failed to decrypt token file — wrong key or file is corrupt. " +
        "Delete the token file and re-authenticate."
    );
  }

  return JSON.parse(decrypted.toString("utf8")) as StoredTokens;
}

export function deleteTokens(tokenPath: string): void {
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    logger.info({ msg: "Token file deleted", path: tokenPath });
  }
}
