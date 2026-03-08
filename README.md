# Gmail MCP Server

A **secure**, production-ready [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude full Gmail integration — reading, searching, sending, replying, forwarding, managing labels, and more.

> **v2.0** — This release resolves all security findings from the audit:  
> encrypted token storage, CSRF protection, confirmation guards on destructive operations,  
> HTML sanitisation, attachment size caps, rate-limit backoff, and minimal OAuth scopes.

---

## Features

| Category | Tools |
|----------|-------|
| **Read** | `list_emails`, `read_email`, `search_emails`, `get_attachments`, `download_attachment` |
| **Write** | `send_email`, `reply_to_email`, `forward_email`, `save_draft` |
| **Manage** | `delete_email`, `move_email`, `mark_email`, `create_label`, `delete_label`, `list_labels`, `batch_delete`, `empty_trash` |
| **Health** | `ping` |

---

## Prerequisites

- **Node.js 20+** (LTS recommended)
- A **Google Cloud Console project** with the Gmail API enabled
- OAuth 2.0 Desktop application credentials (`credentials.json`)

---

## Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services → Library** and enable the **Gmail API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `Gmail MCP Server` (or any name)
5. Download the credentials JSON file — save it as `credentials.json` in the project root
6. Go to **APIs & Services → OAuth consent screen**
   - Add your Google account as a **Test user** (required while the app is in testing mode)

### Required OAuth Scopes

The server requests these minimal scopes (not the full `https://mail.google.com/`):

| Scope | Used for |
|-------|----------|
| `gmail.readonly` | `list_emails`, `read_email`, `search_emails`, `get_attachments` |
| `gmail.send` | `send_email`, `reply_to_email`, `forward_email` |
| `gmail.compose` | `save_draft` |
| `gmail.modify` | `move_email`, `mark_email`, `delete_email`, `create_label`, `delete_label`, `batch_delete`, `empty_trash` |

---

## Installation

```bash
git clone https://github.com/yourusername/gmail-mcp-server.git
cd gmail-mcp-server
npm install
npm run build
```

---

## Configuration

### 1. Generate an encryption key

The server encrypts your OAuth tokens at rest using AES-256-GCM. Generate a 32-byte key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output — you will need it in every environment where the server runs.  
**If you lose the key, you must delete the token file and re-authenticate.**

### 2. Set environment variables

```bash
# Required — 64 hex characters (32 bytes)
export GMAIL_MCP_TOKEN_KEY="your-64-char-hex-key-here"

# Optional
export GMAIL_MCP_LOG_LEVEL="info"          # debug | info | warn | error
export GMAIL_MCP_CONCURRENCY="5"           # parallel API fetch limit
export GMAIL_MCP_MAX_ATTACHMENT_BYTES="5242880"  # 5 MB inline attachment cap
export GMAIL_MCP_MAX_BODY_BYTES="5242880"        # 5 MB email body cap
export GMAIL_MCP_CONFIG_DIR="$HOME/.config/gmail-mcp"  # token storage dir
export GMAIL_MCP_CREDENTIALS_PATH="./credentials.json"  # credentials location
export GMAIL_MCP_REDIRECT_PORT="3000"      # OAuth callback port
```

---

## Claude Desktop Configuration

Add the following to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp-server/dist/index.js"],
      "env": {
        "GMAIL_MCP_TOKEN_KEY": "your-64-char-hex-key-here",
        "GMAIL_MCP_LOG_LEVEL": "info",
        "GMAIL_MCP_CREDENTIALS_PATH": "/absolute/path/to/credentials.json"
      }
    }
  }
}
```

> **Important:** Use absolute paths. Claude Desktop may not inherit your shell's `PATH` or working directory.

---

## First-Time Authentication

On first launch, the server will print an authorization URL to its log output (stderr).  
Open it in your browser, sign in with your Google account, and grant the requested permissions.

The server will automatically:
1. Complete the OAuth callback (on `http://localhost:3000/oauth2callback`)
2. Exchange the authorization code for tokens
3. Encrypt and save the tokens to `~/.config/gmail-mcp/token.enc`

Subsequent launches will use the saved (encrypted) tokens and refresh them automatically.

To view the authorization URL when running through Claude Desktop, check the MCP server logs.

---

## Security

| Feature | Implementation |
|---------|---------------|
| **Token encryption** | AES-256-GCM, key from environment variable |
| **Token file permissions** | `0o600` (owner read/write only) |
| **CSRF protection** | 16-byte random state parameter verified on OAuth callback |
| **Minimal OAuth scopes** | Four granular scopes instead of full `https://mail.google.com/` |
| **HTML sanitisation** | `sanitize-html` with strict allowlist before sending/drafting |
| **Destructive operation guards** | `permanent:true` and `empty_trash` require `confirmed:true` |
| **Attachment size cap** | Returns metadata-only above 5 MB; use `download_attachment` for individual files |
| **Body size cap** | Emails and drafts capped at 5 MB at schema validation level |
| **Rate-limit backoff** | Exponential backoff with jitter on 429/5xx responses |
| **Concurrent fetch limit** | Configurable semaphore (default: 5 parallel requests) |
| **Token refresh mutex** | Single refresh-at-a-time to prevent `invalid_grant` race condition |
| **Safe error messages** | Raw API errors logged to stderr only; LLM receives whitelisted messages |
| **From: header** | Always populated from authenticated user's profile |
| **BCC in reply-all** | Filtered by actual email address; BCC never exposed to CC recipients |
| **Subject deduplication** | `Re:` and `Fwd:` prefixes stripped before re-prepending |

---

## Tool Reference

### `ping`
Health check. Returns server version, authenticated user, token expiry, and mailbox stats.

### `list_emails`
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `folder` | string | `"INBOX"` | Gmail label ID (e.g. `"INBOX"`, `"SENT"`, `"Label_42"`) |
| `maxResults` | number | `20` | 1–500 |
| `query` | string | — | Gmail search query to filter results |
| `pageToken` | string | — | Pagination token from previous response |

### `read_email`
| Parameter | Type | Description |
|-----------|------|-------------|
| `emailId` | string | Gmail message ID |

### `search_emails`
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Gmail search syntax (e.g. `"from:alice is:unread"`) |
| `maxResults` | number | `20` | 1–500 |
| `pageToken` | string | — | Pagination token |

### `get_attachments`
| Parameter | Type | Description |
|-----------|------|-------------|
| `emailId` | string | Gmail message ID |

Returns inline base64 data if total size ≤ 5 MB; metadata-only otherwise.  
Use `download_attachment` for individual files above the cap.

### `download_attachment`
| Parameter | Type | Description |
|-----------|------|-------------|
| `emailId` | string | Gmail message ID |
| `attachmentId` | string | Attachment ID (from `get_attachments` response) |

### `send_email`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | ✅ | Recipient(s), comma-separated |
| `cc` | string | — | CC recipients |
| `bcc` | string | — | BCC recipients |
| `subject` | string | ✅ | Subject line |
| `body` | string | ✅ | Email body (max 5 MB) |
| `isHtml` | boolean | — | Set `true` for HTML email (sanitised) |

### `reply_to_email`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `emailId` | string | ✅ | ID of email to reply to |
| `threadId` | string | ✅ | Thread ID |
| `body` | string | ✅ | Reply body (max 5 MB) |
| `isHtml` | boolean | — | HTML reply |
| `replyAll` | boolean | — | Include all CC recipients |

### `forward_email`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `emailId` | string | ✅ | ID of email to forward |
| `to` | string | ✅ | Forward-to address(es) |
| `additionalMessage` | string | — | Text/HTML prepended before forwarded content |
| `isHtml` | boolean | — | HTML format |

### `save_draft`
All fields optional except `body` (default: empty string).

### `delete_email`
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `emailId` | string | required | Gmail message ID |
| `permanent` | boolean | `false` | If `true`, permanently delete (irreversible) |
| `confirmed` | boolean | — | **Required when `permanent:true`** |

### `move_email`
| Parameter | Type | Description |
|-----------|------|-------------|
| `emailId` | string | Gmail message ID |
| `targetLabel` | string | Destination label ID |

### `mark_email`
| Parameter | Type | Description |
|-----------|------|-------------|
| `emailId` | string | Gmail message ID |
| `action` | enum | `read` \| `unread` \| `star` \| `unstar` \| `important` \| `unimportant` |

### `create_label`
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | string | required | Label name |
| `visibility` | enum | `"show"` | `show` \| `hide` \| `showIfUnread` |

### `delete_label`
| Parameter | Type | Description |
|-----------|------|-------------|
| `labelId` | string | Label ID (system labels cannot be deleted) |

### `list_labels`
No parameters. Returns `systemLabels` and `userLabels` arrays with message counts.

### `batch_delete`
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `emailIds` | string[] | required | 1–1000 message IDs |
| `permanent` | boolean | `false` | Permanent delete if `true` (requires `confirmed:true`) |
| `confirmed` | boolean | — | **Required when `permanent:true`** |

Returns `{ succeeded: string[], failed: Array<{id, reason}> }`.

### `empty_trash`
| Parameter | Type | Description |
|-----------|------|-------------|
| `confirmed` | `true` | **Must be literal `true`** — permanently deletes all Trash messages |

Returns `{ deletedCount: number }`.

---

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build TypeScript
npm run build

# Start server directly (after building)
npm start
```

---

## Token Rotation

OAuth refresh tokens do not expire unless revoked, but periodic rotation is good practice.

```bash
# 1. Delete the encrypted token file
rm ~/.config/gmail-mcp/token.enc

# 2. Restart Claude Desktop (or the MCP server)
#    You will be prompted to re-authorize in your browser.

# 3. Revoke the old token (optional but recommended)
#    https://myaccount.google.com/permissions
```

---

## Logs

All server logs are written to **stderr** as structured JSON (never stdout, which is reserved for the MCP protocol). To capture logs when running through Claude Desktop, check the MCP server log files:

- **macOS:** `~/Library/Logs/Claude/mcp-server-gmail.log`

Log levels: `debug`, `info`, `warn`, `error` — controlled by `GMAIL_MCP_LOG_LEVEL`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `GMAIL_MCP_TOKEN_KEY must be set` | Missing env var | Set the 64-char hex key |
| `credentials.json not found` | Wrong path | Set `GMAIL_MCP_CREDENTIALS_PATH` |
| `Authentication failed` | Expired/revoked token | Delete `token.enc` and re-authenticate |
| `Permission denied` | Wrong OAuth scope | Re-authenticate (scopes changed) |
| `OAuth state mismatch` | Stale browser tab | Restart the auth flow |
| `Conflict — resource exists` | Duplicate label name | Choose a different label name |

---

## License

MIT
