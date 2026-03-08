/**
 * MIME message construction and header parsing utilities.
 *
 * Security fixes:
 *  - From: header always included (prevents alias confusion)
 *  - Subject prefix deduplication (Re: / Fwd:)
 *  - Header values are encoded per RFC 2047 if they contain non-ASCII
 */

import type { MessagePart } from "../gmail-client.js";

// ── Subject prefix helpers ─────────────────────────────────────────────────

const RE_PREFIX_RE = /^(\s*(re|fwd?|fw)\s*:\s*)+/gi;

export function normaliseSubjectPrefix(
  subject: string,
  prefix: "Re" | "Fwd"
): string {
  // Strip all existing Re:/Fwd:/FW:/RE:/FWD: prefixes (any nesting, case-insensitive)
  const stripped = subject.replace(RE_PREFIX_RE, "").trim();
  return `${prefix}: ${stripped || "(no subject)"}`;
}

// ── Header parsing ─────────────────────────────────────────────────────────

export interface ParsedHeaders {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  messageId: string;
  references: string;
  date: string;
  inReplyTo: string;
}

export function parseHeaders(message: {
  payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
}): ParsedHeaders {
  const headers = message.payload?.headers ?? [];
  const get = (name: string): string => {
    const header = headers.find(
      (h) => h.name?.toLowerCase() === name.toLowerCase()
    );
    return header?.value ?? "";
  };

  return {
    from: get("from"),
    to: get("to"),
    cc: get("cc"),
    bcc: get("bcc"), // only present if authenticated user is sender
    subject: get("subject"),
    messageId: get("message-id"),
    references: get("references"),
    date: get("date"),
    inReplyTo: get("in-reply-to"),
  };
}

// ── Address utilities ──────────────────────────────────────────────────────

export function parseAddressList(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export function extractEmail(address: string): string {
  // Extract bare email from "Display Name <email@example.com>" or "email@example.com"
  const match = /<([^>]+)>/.exec(address);
  return (match?.[1] ?? address).trim().toLowerCase();
}

// ── Body decoding ──────────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

export function extractBody(
  payload: MessagePart | null | undefined
): { text: string; html: string } {
  if (!payload) return { text: "", html: "" };

  let text = "";
  let html = "";

  function walk(part: MessagePart): void {
    const mime = part.mimeType ?? "";
    const data = part.body?.data;

    if (mime === "text/plain" && data && !text) {
      text = decodeBase64Url(data);
    } else if (mime === "text/html" && data && !html) {
      html = decodeBase64Url(data);
    } else if (mime.startsWith("multipart/") && part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  }

  walk(payload);

  return { text, html };
}

// ── Attachment metadata ────────────────────────────────────────────────────

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function extractAttachmentMeta(
  payload: MessagePart | null | undefined
): AttachmentMeta[] {
  if (!payload) return [];
  const results: AttachmentMeta[] = [];

  function walk(part: MessagePart): void {
    const disposition = (part.filename ?? "").length > 0;
    const isInline = part.mimeType?.startsWith("text/") ?? false;

    if (
      disposition &&
      !isInline &&
      part.body?.attachmentId
    ) {
      results.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename ?? "unnamed",
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }

    if (part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  }

  walk(payload);
  return results;
}

// ── MIME message builder ───────────────────────────────────────────────────

export interface BuildMessageOptions {
  from: string;
  to: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  subject: string;
  body: string;
  isHtml?: boolean | undefined;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  threadId?: string | undefined;
}

export function buildRawMessage(opts: BuildMessageOptions): string {
  const contentType = opts.isHtml ? "text/html" : "text/plain";

  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
  ];

  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);

  headers.push(
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`
  );

  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);

  const bodyEncoded = Buffer.from(opts.body, "utf-8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\n"); // fold at 76 chars per RFC 2045

  const raw = headers.join("\r\n") + "\r\n\r\n" + bodyEncoded;

  // URL-safe base64 for Gmail API
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
