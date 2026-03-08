/**
 * Read-only Gmail tools: list_emails, read_email, search_emails,
 * get_attachments, download_attachment.
 *
 * Security fixes:
 *  - get_attachments caps total download at MAX_INLINE_BYTES (default 5 MB)
 *    and returns metadata-only when the cap is exceeded, with a separate
 *    download_attachment tool for individual retrieval.
 *  - Concurrency-limited parallel metadata fetches via semaphore.
 */

import { z } from "zod";
import { GmailClient } from "../gmail-client.js";
import {
  parseHeaders,
  extractBody,
  extractAttachmentMeta,
  type AttachmentMeta,
} from "../utils/mime.js";
import { createSemaphore, getConcurrencyLimit } from "../utils/semaphore.js";
import { logger } from "../utils/logger.js";

// ── Schemas ────────────────────────────────────────────────────────────────

export const ListEmailsSchema = z.object({
  folder: z.string().default("INBOX"),
  maxResults: z.number().int().min(1).max(500).default(20),
  query: z.string().optional(),
  pageToken: z.string().optional(),
});

export const ReadEmailSchema = z.object({
  emailId: z.string().min(1),
});

export const SearchEmailsSchema = z.object({
  query: z.string().min(1, "Search query must not be empty"),
  maxResults: z.number().int().min(1).max(500).default(20),
  pageToken: z.string().optional(),
});

export const GetAttachmentsSchema = z.object({
  emailId: z.string().min(1),
});

export const DownloadAttachmentSchema = z.object({
  emailId: z.string().min(1),
  attachmentId: z.string().min(1),
});

// ── Types ──────────────────────────────────────────────────────────────────

export type ListEmailsInput = z.infer<typeof ListEmailsSchema>;
export type ReadEmailInput = z.infer<typeof ReadEmailSchema>;
export type SearchEmailsInput = z.infer<typeof SearchEmailsSchema>;
export type GetAttachmentsInput = z.infer<typeof GetAttachmentsSchema>;
export type DownloadAttachmentInput = z.infer<typeof DownloadAttachmentSchema>;

const MAX_INLINE_BYTES = parseInt(
  process.env["GMAIL_MCP_MAX_ATTACHMENT_BYTES"] ?? String(5 * 1024 * 1024),
  10
);

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleListEmails(
  client: GmailClient,
  input: ListEmailsInput
) {
  const sem = createSemaphore(getConcurrencyLimit());

  const listResult = await client.listMessages({
    labelIds: [input.folder],
    maxResults: input.maxResults,
    pageToken: input.pageToken,
    q: input.query,
  });

  if (listResult.messages.length === 0) {
    return {
      messages: [],
      resultSizeEstimate: 0,
      nextPageToken: listResult.nextPageToken,
    };
  }

  // Fetch metadata for each message with concurrency limit
  const messages = await Promise.all(
    listResult.messages.map(({ id }) =>
      sem.run(async () => {
        const msg = await client.getMessage(id, "metadata");
        const headers = parseHeaders(msg);
        return {
          id,
          threadId: msg.threadId ?? "",
          subject: headers.subject || "(no subject)",
          from: headers.from,
          date: headers.date,
          snippet: msg.snippet ?? "",
          labelIds: msg.labelIds ?? [],
        };
      })
    )
  );

  return {
    messages,
    resultSizeEstimate: listResult.resultSizeEstimate,
    nextPageToken: listResult.nextPageToken,
  };
}

export async function handleReadEmail(
  client: GmailClient,
  input: ReadEmailInput
) {
  const msg = await client.getMessage(input.emailId, "full");
  const headers = parseHeaders(msg);
  const { text, html } = extractBody(msg.payload);
  const attachments = extractAttachmentMeta(msg.payload);

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    subject: headers.subject || "(no subject)",
    from: headers.from,
    to: headers.to,
    cc: headers.cc || undefined,
    date: headers.date,
    // Prefer plain text; fall back to HTML notice
    body: text || (html ? "[HTML email — use get_attachments or request HTML rendering]" : ""),
    hasHtml: !!html,
    labelIds: msg.labelIds ?? [],
    attachments: attachments.map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    snippet: msg.snippet ?? "",
    messageId: headers.messageId,
    inReplyTo: headers.inReplyTo || undefined,
    references: headers.references || undefined,
  };
}

export async function handleSearchEmails(
  client: GmailClient,
  input: SearchEmailsInput
) {
  const sem = createSemaphore(getConcurrencyLimit());

  const listResult = await client.listMessages({
    maxResults: input.maxResults,
    pageToken: input.pageToken,
    q: input.query,
  });

  if (listResult.messages.length === 0) {
    return { messages: [], resultSizeEstimate: 0, nextPageToken: undefined };
  }

  const messages = await Promise.all(
    listResult.messages.map(({ id }) =>
      sem.run(async () => {
        const msg = await client.getMessage(id, "metadata");
        const headers = parseHeaders(msg);
        return {
          id,
          threadId: msg.threadId ?? "",
          subject: headers.subject || "(no subject)",
          from: headers.from,
          date: headers.date,
          snippet: msg.snippet ?? "",
          labelIds: msg.labelIds ?? [],
        };
      })
    )
  );

  return {
    messages,
    resultSizeEstimate: listResult.resultSizeEstimate,
    nextPageToken: listResult.nextPageToken,
  };
}

export interface AttachmentResult extends AttachmentMeta {
  data: string | null; // null when metadata-only mode
  note?: string;
}

export async function handleGetAttachments(
  client: GmailClient,
  input: GetAttachmentsInput
): Promise<{ attachments: AttachmentResult[]; metadataOnly: boolean }> {
  const msg = await client.getMessage(input.emailId, "full");
  const metas = extractAttachmentMeta(msg.payload);

  if (metas.length === 0) {
    return { attachments: [], metadataOnly: false };
  }

  const totalSize = metas.reduce((sum, m) => sum + m.size, 0);

  if (totalSize > MAX_INLINE_BYTES) {
    logger.warn({
      msg: "Attachment total exceeds inline cap — returning metadata only",
      emailId: input.emailId,
      totalBytes: totalSize,
      capBytes: MAX_INLINE_BYTES,
    });

    return {
      attachments: metas.map((m) => ({
        ...m,
        data: null,
        note:
          `Total attachment size (${(totalSize / 1e6).toFixed(1)} MB) exceeds the ` +
          `${(MAX_INLINE_BYTES / 1e6).toFixed(0)} MB inline limit. ` +
          `Use the download_attachment tool with the attachmentId to fetch individually.`,
      })),
      metadataOnly: true,
    };
  }

  // Download all attachments (within cap)
  const sem = createSemaphore(getConcurrencyLimit());
  const attachments = await Promise.all(
    metas.map((meta) =>
      sem.run(async () => {
        const att = await client.getAttachment(input.emailId, meta.attachmentId);
        return {
          ...meta,
          data: att.data,
          size: att.size,
        };
      })
    )
  );

  return { attachments, metadataOnly: false };
}

export async function handleDownloadAttachment(
  client: GmailClient,
  input: DownloadAttachmentInput
): Promise<{ attachmentId: string; data: string; size: number }> {
  const att = await client.getAttachment(input.emailId, input.attachmentId);
  return {
    attachmentId: input.attachmentId,
    data: att.data,
    size: att.size,
  };
}
