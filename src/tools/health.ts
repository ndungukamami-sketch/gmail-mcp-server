/**
 * Health-check tool: returns server version, authenticated user,
 * token expiry, and mailbox stats.
 */

import { z } from "zod";
import { GmailClient } from "../gmail-client.js";
import { readTokens } from "../auth/token-store.js";
import { TOKEN_PATH } from "../auth/oauth.js";
import { VERSION } from "../version.js";

export const PingSchema = z.object({});

export interface PingResult {
  version: string;
  status: "ok";
  authenticatedAs: string;
  tokenExpiresAt: string;
  tokenExpiresInSeconds: number | null;
  tokenValid: boolean;
  messagesTotal: number;
  threadsTotal: number;
}

export async function handlePing(client: GmailClient): Promise<PingResult> {
  const [profile, tokens] = await Promise.all([
    client.getProfile(),
    Promise.resolve(readTokens(TOKEN_PATH)),
  ]);

  const expiryDate = (tokens as { expiry_date?: number } | null)?.expiry_date;
  const expiresInSeconds = expiryDate
    ? Math.round((expiryDate - Date.now()) / 1000)
    : null;

  return {
    version: VERSION,
    status: "ok",
    authenticatedAs: profile.emailAddress,
    tokenExpiresAt: expiryDate ? new Date(expiryDate).toISOString() : "unknown",
    tokenExpiresInSeconds: expiresInSeconds,
    tokenValid: expiresInSeconds === null || expiresInSeconds > 0,
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal,
  };
}
