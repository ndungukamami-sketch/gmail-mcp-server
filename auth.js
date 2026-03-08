#!/usr/bin/env node
/**
 * One-time OAuth setup script.
 * Run this once in CMD to authenticate with Google.
 * After it completes, Claude Desktop will use the saved token automatically.
 *
 * Usage:
 *   set GMAIL_MCP_TOKEN_KEY=your-key
 *   set GMAIL_MCP_CREDENTIALS_PATH=path\to\credentials.json
 *   set GMAIL_MCP_REDIRECT_PORT=3002
 *   node auth.js
 */

import { getOAuth2Client, performOAuthFlow, TOKEN_PATH } from "./dist/auth/oauth.js";
import { readTokens } from "./dist/auth/token-store.js";

console.log("=== Gmail MCP — One-time Authentication ===\n");

// Check token key is set
if (!process.env.GMAIL_MCP_TOKEN_KEY) {
  console.error("ERROR: GMAIL_MCP_TOKEN_KEY environment variable is not set.");
  console.error("Run: set GMAIL_MCP_TOKEN_KEY=your-64-char-key");
  process.exit(1);
}

// Check credentials file is set
if (!process.env.GMAIL_MCP_CREDENTIALS_PATH) {
  console.error("ERROR: GMAIL_MCP_CREDENTIALS_PATH environment variable is not set.");
  process.exit(1);
}

try {
  // Check if already authenticated
  const existing = readTokens(TOKEN_PATH);
  if (existing) {
    console.log("✅ Already authenticated! Token file found at:");
    console.log("   " + TOKEN_PATH);
    console.log("\nYou can now use Claude Desktop with Gmail.");
    process.exit(0);
  }

  // Run the OAuth flow
  console.log("No token found. Starting OAuth flow...");
  console.log("A URL will appear below — open it in your browser.\n");

  const client = getOAuth2Client();
  await performOAuthFlow(client);

  console.log("\n✅ Authentication complete!");
  console.log("Token saved to: " + TOKEN_PATH);
  console.log("\nYou can now close this window and use Claude Desktop with Gmail.");
} catch (err) {
  console.error("\n❌ Authentication failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
