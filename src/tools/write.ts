/**
 * Write tools: send_email, reply_to_email, forward_email, save_draft.
 *
 * Security fixes:
 *  - HTML body is sanitised via sanitize-html before MIME encoding (XSS prevention)
 *  - From: header always populated from authenticated user's profile
 *  - Body size capped at MAX_BODY_BYTES (default 5 MB) in Zod schemas
 *  - Subject prefixes deduplicated (Re: / Fwd:)
 *  - BCC exposure in replyAll fixed — filters on actual email address, not "me"
 */

import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { GmailClient } from "../gmail-client.js";
import {
  buildRawMessage,
  parseHeaders,
  normaliseSubjectPrefix,
  extractBody,
  extractAttachmentMeta,
  parseAddressList,
  extractEmail,
} from "../utils/mime.js";
import { logger } from "../utils/logger.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = parseInt(
  process.env["GMAIL_MCP_MAX_BODY_BYTES"] ?? String(5 * 1024 * 1024),
  10
);

// ── HTML sanitisation ──────────────────────────────────────────────────────

const SANITISE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "h1", "h2", "h3", "h4", "h5", "h6",
    "img", "figure", "figcaption",
    "table", "thead", "tbody", "tr", "th", "td",
    "details", "summary",
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height", "title"],
    td: ["colspan", "rowspan", "align"],
    th: ["colspan", "rowspan", "align"],
    "*": ["style", "class"],
  },
  allowedStyles: {
    "*": {
      color: [/.*/],
      "background-color": [/.*/],
      "font-size": [/.*/],
      "font-weight": [/.*/],
      "font-style": [/.*/],
      "text-align": [/.*/],
      "text-decoration": [/.*/],
      padding: [/.*/],
      margin: [/.*/],
      border: [/.*/],
    },
  },
  // Discard any tag not in the allowlist (including <script>, <iframe>, etc.)
  disallowedTagsMode: "discard",
  // Strip event handler attributes (onerror, onclick, etc.)
  allowedSchemesByTag: {
    img: ["https", "cid"], // allow https images and inline cid references; block data: URIs
    a: ["https", "http", "mailto"],
  },
};

function sanitiseBody(body: string, isHtml: boolean): string {
  if (!isHtml) return body;
  const sanitised = sanitizeHtml(body, SANITISE_OPTIONS);
  logger.debug({ msg: "HTML body sanitised", originalLen: body.length, sanitisedLen: sanitised.length });
  return sanitised;
}

// ── Schemas ────────────────────────────────────────────────────────────────

const EmailAddressField = z.string().email("Must be a valid email address");
const EmailAddressListField = z
  .string()
  .refine(
    (v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .every((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    { message: "Must be a comma-separated list of valid email addresses" }
  );

export const SendEmailSchema = z.object({
  to: EmailAddressListField.describe("Recipient email address(es), comma-separated"),
  cc: EmailAddressListField.optional().describe("CC addresses, comma-separated"),
  bcc: EmailAddressListField.optional().describe("BCC addresses, comma-separated"),
  subject: z.string().min(1, "Subject must not be empty").max(998, "Subject too long"),
  body: z
    .string()
    .min(1, "Body must not be empty")
    .max(MAX_BODY_BYTES, `Body must be under ${MAX_BODY_BYTES / 1e6} MB`),
  isHtml: z.boolean().default(false).describe("Set true to send an HTML email"),
});

export const ReplyEmailSchema = z.object({
  emailId: z.string().min(1),
  threadId: z.string().min(1),
  body: z
    .string()
    .min(1)
    .max(MAX_BODY_BYTES, `Body must be under ${MAX_BODY_BYTES / 1e6} MB`),
  isHtml: z.boolean().default(false),
  replyAll: z.boolean().default(false).describe("If true, reply to all recipients"),
});

export const ForwardEmailSchema = z.object({
  emailId: z.string().min(1),
  to: EmailAddressListField.describe("Forward-to address(es)"),
  additionalMessage: z
    .string()
    .max(MAX_BODY_BYTES)
    .optional()
    .describe("Optional message to prepend above the forwarded content"),
  isHtml: z.boolean().default(false),
});

export const SaveDraftSchema = z.object({
  to: EmailAddressListField.optional(),
  cc: EmailAddressListField.optional(),
  bcc: EmailAddressListField.optional(),
  subject: z.string().max(998).optional(),
  body: z
    .string()
    .max(MAX_BODY_BYTES, `Body must be under ${MAX_BODY_BYTES / 1e6} MB`)
    .default(""),
  isHtml: z.boolean().default(false),
});

export type SendEmailInput = z.infer<typeof SendEmailSchema>;
export type ReplyEmailInput = z.infer<typeof ReplyEmailSchema>;
export type ForwardEmailInput = z.infer<typeof ForwardEmailSchema>;
export type SaveDraftInput = z.infer<typeof SaveDraftSchema>;

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleSendEmail(
  client: GmailClient,
  input: SendEmailInput
) {
  const profile = await client.getProfile();
  const body = sanitiseBody(input.body, input.isHtml);

  const raw = buildRawMessage({
    from: profile.emailAddress, // ✅ always set From:
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body,
    isHtml: input.isHtml,
  });

  const result = await client.sendMessage(raw);
  logger.info({ msg: "Email sent", messageId: result.id, to: input.to });

  return {
    messageId: result.id,
    threadId: result.threadId,
    status: "sent",
  };
}

export async function handleReplyToEmail(
  client: GmailClient,
  input: ReplyEmailInput
) {
  const profile = await client.getProfile();
  const myEmail = profile.emailAddress.toLowerCase();

  const original = await client.getMessage(input.emailId, "full");
  const headers = parseHeaders(original);

  // ✅ Always reply to the original sender
  const toAddresses: string[] = [headers.from];

  if (input.replyAll) {
    // ✅ Filter by actual email address, never the string "me"
    // ✅ BCC headers: Gmail strips these from non-sender views, but we explicitly
    //    never add them to CC even if present (paranoid safety check)
    const ccParsed = parseAddressList(headers.cc)
      .filter((addr) => {
        const email = extractEmail(addr);
        return email !== myEmail && email !== ""; // exclude self
      });

    toAddresses.push(...ccParsed);
  }

  // De-duplicate and exclude self
  const uniqueTo = [
    ...new Set(
      toAddresses
        .map((a) => a.trim())
        .filter((a) => extractEmail(a) !== myEmail)
    ),
  ].join(", ");

  const subject = normaliseSubjectPrefix(headers.subject, "Re");
  const body = sanitiseBody(input.body, input.isHtml);

  // Build References header per RFC 2822
  const references = [headers.references, headers.messageId]
    .filter(Boolean)
    .join(" ")
    .trim();

  const raw = buildRawMessage({
    from: profile.emailAddress,
    to: uniqueTo || headers.from,
    subject,
    body,
    isHtml: input.isHtml,
    inReplyTo: headers.messageId,
    references,
    threadId: input.threadId,
  });

  const result = await client.sendMessage(raw);
  logger.info({ msg: "Reply sent", messageId: result.id, threadId: input.threadId });

  return {
    messageId: result.id,
    threadId: result.threadId,
    status: "sent",
    subject,
    to: uniqueTo,
  };
}

export async function handleForwardEmail(
  client: GmailClient,
  input: ForwardEmailInput
) {
  const profile = await client.getProfile();
  const original = await client.getMessage(input.emailId, "full");
  const headers = parseHeaders(original);
  const { text, html } = extractBody(original.payload);
  const attachmentMetas = extractAttachmentMeta(original.payload);

  const subject = normaliseSubjectPrefix(headers.subject, "Fwd");

  // Build forwarded body
  const divider = input.isHtml
    ? `<hr><p><b>---------- Forwarded message ----------</b><br>` +
      `From: ${headers.from}<br>Date: ${headers.date}<br>` +
      `Subject: ${headers.subject}<br>To: ${headers.to}</p>`
    : `\n\n---------- Forwarded message ----------\n` +
      `From: ${headers.from}\nDate: ${headers.date}\n` +
      `Subject: ${headers.subject}\nTo: ${headers.to}\n\n`;

  const originalBody = input.isHtml ? (html || text) : (text || html);
  const additional = input.additionalMessage
    ? sanitiseBody(input.additionalMessage, input.isHtml)
    : "";

  const fullBody = additional
    ? additional + (input.isHtml ? "<br><br>" : "\n\n") + divider + originalBody
    : divider + originalBody;

  const raw = buildRawMessage({
    from: profile.emailAddress,
    to: input.to,
    subject,
    body: fullBody,
    isHtml: input.isHtml,
  });

  const result = await client.sendMessage(raw);
  logger.info({ msg: "Email forwarded", messageId: result.id, to: input.to });

  const attachmentCount = attachmentMetas.length;
  return {
    messageId: result.id,
    threadId: result.threadId,
    status: "sent",
    subject,
    note: attachmentCount > 0
      ? `Note: ${attachmentCount} attachment(s) from the original email were NOT forwarded. Forward attachments are not supported via the API in this version.`
      : undefined,
  };
}

export async function handleSaveDraft(
  client: GmailClient,
  input: SaveDraftInput
) {
  const profile = await client.getProfile();
  const body = sanitiseBody(input.body, input.isHtml);

  const raw = buildRawMessage({
    from: profile.emailAddress,
    to: input.to ?? "",
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject ?? "(no subject)",
    body,
    isHtml: input.isHtml,
  });

  const result = await client.saveDraft(raw);
  logger.info({ msg: "Draft saved", draftId: result.draftId });

  return {
    draftId: result.draftId,
    messageId: result.messageId,
    status: "draft_saved",
  };
}
