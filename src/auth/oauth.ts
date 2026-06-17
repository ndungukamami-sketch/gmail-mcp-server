/**
 * OAuth 2.0 flow for Gmail API access.
 *
 * Security fixes applied:
 *  - CSRF state parameter generated and verified on callback
 *  - Token refresh mutex prevents race condition under concurrent calls
 *  - Tokens encrypted at rest via token-store.ts
 *  - Minimal OAuth scopes (not the full https://mail.google.com/)
 *  - Callback server times out after 5 minutes
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import { readTokens, writeTokens, type StoredTokens } from "./token-store.js";
import { logger } from "../utils/logger.js";

// ── Minimal scope set — principle of least privilege ───────────────────────
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

// ── Paths ──────────────────────────────────────────────────────────────────
const CONFIG_DIR = process.env["GMAIL_MCP_CONFIG_DIR"]
  ?? path.join(os.homedir(), ".config", "gmail-mcp");

export const TOKEN_PATH = path.join(CONFIG_DIR, "token.enc");
export const CREDENTIALS_PATH =
  process.env["GMAIL_MCP_CREDENTIALS_PATH"] ??
  path.join(process.cwd(), "credentials.json");

const REDIRECT_PORT = parseInt(process.env["GMAIL_MCP_REDIRECT_PORT"] ?? "3000", 10);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// ── Singleton OAuth client ─────────────────────────────────────────────────
let _oauth2Client: OAuth2Client | null = null;

export function getOAuth2Client(): OAuth2Client {
  if (_oauth2Client) return _oauth2Client;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at: ${CREDENTIALS_PATH}\n` +
        "Download it from Google Cloud Console → APIs & Services → Credentials."
    );
  }

  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };

  const creds = raw.installed ?? raw.web;
  if (!creds) throw new Error("Invalid credentials.json format.");

  _oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    REDIRECT_URI
  );

  return _oauth2Client;
}

// ── Token refresh mutex ────────────────────────────────────────────────────
let _refreshPromise: Promise<void> | null = null;

export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  const client = getOAuth2Client();
  const tokens = readTokens(TOKEN_PATH);

  if (!tokens) {
    await performOAuthFlow(client);
    return client;
  }

  client.setCredentials(tokens as Credentials);

  // Refresh if within 60 seconds of expiry
  const expiry = tokens.expiry_date ?? 0;
  const needsRefresh = Date.now() >= expiry - 60_000;
  if (needsRefresh && !tokens.refresh_token) {
    logger.warn({ msg: "Token expired but no refresh_token - re-auth required" });
  } else if (needsRefresh && tokens.refresh_token) {
    // Mutex: only one refresh at a time; concurrent callers await the same promise
    if (!_refreshPromise) {
      _refreshPromise = (async () => {
        try {
          logger.info({ msg: "Refreshing access token" });
          const { credentials } = await client.refreshAccessToken();
          client.setCredentials(credentials);
          writeTokens(TOKEN_PATH, credentials as StoredTokens);
          logger.info({ msg: "Access token refreshed successfully" });
        } catch (err) {
          logger.error({ msg: "Token refresh failed", error: String(err) });
          throw err;
        } finally {
          _refreshPromise = null;
        }
      })();
    }
    await _refreshPromise;
  }

  return client;
}

// ── OAuth browser flow ─────────────────────────────────────────────────────
export async function performOAuthFlow(client: OAuth2Client): Promise<void> {
  // Generate CSRF state token
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  });

  logger.info({ msg: "=== Gmail MCP OAuth Authorization ===" });
  logger.info({ msg: "Open the following URL in your browser to authorize:" });
  logger.info({ msg: authUrl });
  logger.info({ msg: `Waiting for callback on port ${REDIRECT_PORT}...` });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request.");
        return;
      }

      const url = new URL(req.url, `http://localhost`);

      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found.");
        return;
      }

      // ✅ CSRF state verification
      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(400);
        res.end(
          "State mismatch — possible CSRF attack detected. " +
            "Please restart the authentication flow."
        );
        server.close();
        reject(new Error("OAuth state parameter mismatch — possible CSRF attack."));
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400);
        res.end(`Authorization error: ${error}. Please try again.`);
        server.close();
        reject(new Error(`OAuth authorization error: ${error}`));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code.");
        server.close();
        reject(new Error("OAuth callback missing authorization code."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>✅ Authorization successful!</h1>" +
          "<p>You may close this tab and return to your application.</p></body></html>"
      );
      server.close();
      resolve(code);
    });

    server.listen(REDIRECT_PORT, "127.0.0.1"); // bind to loopback only
    server.on("error", reject);

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    server.on("close", () => clearTimeout(timeout));
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  writeTokens(TOKEN_PATH, tokens as StoredTokens);

  logger.info({ msg: "OAuth flow complete — tokens saved (encrypted)." });
}
