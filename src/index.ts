#!/usr/bin/env node
/**
 * Gmail MCP Server v2
 *
 * Secure Gmail integration for Claude via the Model Context Protocol.
 * All security findings from the audit have been remediated in this version.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import { GmailClient } from "./gmail-client.js";
import { toSafeErrorMessage } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { VERSION } from "./version.js";

// ── Tool handlers ──────────────────────────────────────────────────────────
import {
  ListEmailsSchema, handleListEmails,
  ReadEmailSchema, handleReadEmail,
  SearchEmailsSchema, handleSearchEmails,
  GetAttachmentsSchema, handleGetAttachments,
  DownloadAttachmentSchema, handleDownloadAttachment,
} from "./tools/read.js";

import {
  SendEmailSchema, handleSendEmail,
  ReplyEmailSchema, handleReplyToEmail,
  ForwardEmailSchema, handleForwardEmail,
  SaveDraftSchema, handleSaveDraft,
} from "./tools/write.js";

import {
  DeleteEmailSchema, handleDeleteEmail,
  MoveEmailSchema, handleMoveEmail,
  MarkEmailSchema, handleMarkEmail,
  CreateLabelSchema, handleCreateLabel,
  DeleteLabelSchema, handleDeleteLabel,
  ListLabelsSchema, handleListLabels,
  BatchDeleteSchema, handleBatchDelete,
  EmptyTrashSchema, handleEmptyTrash,
} from "./tools/manage.js";

import { PingSchema, handlePing } from "./tools/health.js";

// ── Tool registry ──────────────────────────────────────────────────────────

const TOOLS = [
  // ── Read tools ──
  {
    name: "list_emails",
    description:
      "List emails in a Gmail folder/label. Returns message summaries with subject, sender, date, and snippet. " +
      "Use pageToken for pagination. Default folder is INBOX.",
    inputSchema: zodToJsonSchema(ListEmailsSchema),
  },
  {
    name: "read_email",
    description:
      "Read the full content of a single email by its ID. Returns headers, body (preferring plain text), " +
      "and attachment metadata. Use get_attachments to retrieve attachment data.",
    inputSchema: zodToJsonSchema(ReadEmailSchema),
  },
  {
    name: "search_emails",
    description:
      "Search emails using Gmail query syntax (e.g. 'from:alice@example.com is:unread after:2024/01/01'). " +
      "Returns matching message summaries. Use pageToken for pagination.",
    inputSchema: zodToJsonSchema(SearchEmailsSchema),
  },
  {
    name: "get_attachments",
    description:
      "Get attachments for an email. If total attachment size is under 5 MB, returns full base64 data. " +
      "If over 5 MB, returns metadata only — use download_attachment to fetch individual files.",
    inputSchema: zodToJsonSchema(GetAttachmentsSchema),
  },
  {
    name: "download_attachment",
    description:
      "Download a single attachment by its attachmentId (from get_attachments metadata). " +
      "Returns base64-encoded data for that specific attachment.",
    inputSchema: zodToJsonSchema(DownloadAttachmentSchema),
  },

  // ── Write tools ──
  {
    name: "send_email",
    description:
      "Send an email. Supports plain text and HTML (HTML is sanitised before sending). " +
      "Body is limited to 5 MB. CC and BCC are supported.",
    inputSchema: zodToJsonSchema(SendEmailSchema),
  },
  {
    name: "reply_to_email",
    description:
      "Reply to an existing email thread. Set replyAll:true to include all CC recipients. " +
      "Subject is automatically prefixed with 'Re:' (deduplicated). HTML is sanitised.",
    inputSchema: zodToJsonSchema(ReplyEmailSchema),
  },
  {
    name: "forward_email",
    description:
      "Forward an email to new recipients, optionally prepending an additional message. " +
      "Subject is automatically prefixed with 'Fwd:' (deduplicated).",
    inputSchema: zodToJsonSchema(ForwardEmailSchema),
  },
  {
    name: "save_draft",
    description:
      "Save an email as a draft. All fields except body are optional, allowing partial drafts.",
    inputSchema: zodToJsonSchema(SaveDraftSchema),
  },

  // ── Management tools ──
  {
    name: "delete_email",
    description:
      "Delete an email. By default (permanent:false) moves to Trash — recoverable. " +
      "With permanent:true, PERMANENTLY deletes — IRREVERSIBLE. " +
      "You MUST ask the user to confirm before setting permanent:true and confirmed:true.",
    inputSchema: zodToJsonSchema(DeleteEmailSchema),
  },
  {
    name: "move_email",
    description:
      "Move an email to a different label/folder. Removes all existing location labels " +
      "(INBOX, SENT, SPAM, TRASH) and adds only the target label.",
    inputSchema: zodToJsonSchema(MoveEmailSchema),
  },
  {
    name: "mark_email",
    description:
      "Mark an email as read/unread, starred/unstarred, or important/unimportant.",
    inputSchema: zodToJsonSchema(MarkEmailSchema),
  },
  {
    name: "create_label",
    description: "Create a new Gmail label with optional visibility settings.",
    inputSchema: zodToJsonSchema(CreateLabelSchema),
  },
  {
    name: "delete_label",
    description:
      "Delete a Gmail user label by its ID. System labels (INBOX, SENT, etc.) cannot be deleted.",
    inputSchema: zodToJsonSchema(DeleteLabelSchema),
  },
  {
    name: "list_labels",
    description:
      "List all Gmail labels (both system and user-created) with message counts.",
    inputSchema: zodToJsonSchema(ListLabelsSchema),
  },
  {
    name: "batch_delete",
    description:
      "Delete multiple emails at once (up to 1000). Default moves to Trash. " +
      "With permanent:true, PERMANENTLY deletes all — IRREVERSIBLE. " +
      "You MUST ask the user to confirm before setting permanent:true and confirmed:true. " +
      "Returns partial failure report if some IDs fail.",
    inputSchema: zodToJsonSchema(BatchDeleteSchema),
  },
  {
    name: "empty_trash",
    description:
      "PERMANENTLY delete ALL messages in the Trash folder. THIS IS IRREVERSIBLE. " +
      "You MUST explicitly warn the user and obtain confirmation before calling this. " +
      "Only set confirmed:true after the user has acknowledged this cannot be undone.",
    inputSchema: zodToJsonSchema(EmptyTrashSchema),
  },

  // ── Health ──
  {
    name: "ping",
    description:
      "Health check — returns server version, authenticated user email, " +
      "token expiry status, and mailbox stats.",
    inputSchema: zodToJsonSchema(PingSchema),
  },
] as const;

// ── Server setup ───────────────────────────────────────────────────────────

const client = new GmailClient();

const server = new Server(
  { name: "gmail-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Dispatch tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.debug({ msg: "Tool call received", tool: name });

  try {
    let result: unknown;

    switch (name) {
      // ── Read ──
      case "list_emails":
        result = await handleListEmails(client, ListEmailsSchema.parse(args));
        break;
      case "read_email":
        result = await handleReadEmail(client, ReadEmailSchema.parse(args));
        break;
      case "search_emails":
        result = await handleSearchEmails(client, SearchEmailsSchema.parse(args));
        break;
      case "get_attachments":
        result = await handleGetAttachments(client, GetAttachmentsSchema.parse(args));
        break;
      case "download_attachment":
        result = await handleDownloadAttachment(client, DownloadAttachmentSchema.parse(args));
        break;

      // ── Write ──
      case "send_email":
        result = await handleSendEmail(client, SendEmailSchema.parse(args));
        break;
      case "reply_to_email":
        result = await handleReplyToEmail(client, ReplyEmailSchema.parse(args));
        break;
      case "forward_email":
        result = await handleForwardEmail(client, ForwardEmailSchema.parse(args));
        break;
      case "save_draft":
        result = await handleSaveDraft(client, SaveDraftSchema.parse(args));
        break;

      // ── Manage ──
      case "delete_email":
        result = await handleDeleteEmail(client, DeleteEmailSchema.parse(args));
        break;
      case "move_email":
        result = await handleMoveEmail(client, MoveEmailSchema.parse(args));
        break;
      case "mark_email":
        result = await handleMarkEmail(client, MarkEmailSchema.parse(args));
        break;
      case "create_label":
        result = await handleCreateLabel(client, CreateLabelSchema.parse(args));
        break;
      case "delete_label":
        result = await handleDeleteLabel(client, DeleteLabelSchema.parse(args));
        break;
      case "list_labels":
        result = await handleListLabels(client);
        break;
      case "batch_delete":
        result = await handleBatchDelete(client, BatchDeleteSchema.parse(args));
        break;
      case "empty_trash":
        result = await handleEmptyTrash(client, EmptyTrashSchema.parse(args));
        break;

      // ── Health ──
      case "ping":
        result = await handlePing(client);
        break;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    // Zod validation errors get a detailed message; all others are sanitised
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Validation error for tool "${name}":\n${issues}`,
          },
        ],
        isError: true,
      };
    }

    // Log full error to stderr, return only safe message to LLM
    logger.error({
      msg: "Tool call failed",
      tool: name,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    return {
      content: [
        {
          type: "text",
          text: toSafeErrorMessage(err, name),
        },
      ],
      isError: true,
    };
  }
});

// ── Start server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ msg: "Gmail MCP Server starting", version: VERSION });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info({ msg: "Gmail MCP Server connected and ready" });
}

main().catch((err) => {
  logger.error({ msg: "Fatal error during startup", error: String(err) });
  process.exit(1);
});
