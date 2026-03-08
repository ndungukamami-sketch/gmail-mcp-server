import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ListEmailsSchema,
  SearchEmailsSchema,
  handleGetAttachments,
} from "../../src/tools/read.js";

// ── Schema validation ──────────────────────────────────────────────────────

describe("ListEmailsSchema", () => {
  it("defaults to INBOX with maxResults 20", () => {
    const r = ListEmailsSchema.parse({});
    expect(r.folder).toBe("INBOX");
    expect(r.maxResults).toBe(20);
  });

  it("rejects maxResults > 500", () => {
    const r = ListEmailsSchema.safeParse({ maxResults: 501 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe("too_big");
  });

  it("accepts maxResults = 1", () => {
    expect(ListEmailsSchema.safeParse({ maxResults: 1 }).success).toBe(true);
  });

  it("accepts maxResults = 500", () => {
    expect(ListEmailsSchema.safeParse({ maxResults: 500 }).success).toBe(true);
  });
});

describe("SearchEmailsSchema", () => {
  it("rejects empty query string", () => {
    const r = SearchEmailsSchema.safeParse({ query: "" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("empty");
  });

  it("accepts a valid query", () => {
    const r = SearchEmailsSchema.safeParse({ query: "from:alice@example.com is:unread" });
    expect(r.success).toBe(true);
  });
});

// ── handleGetAttachments — size cap ───────────────────────────────────────

describe("handleGetAttachments", () => {
  const makeClient = (totalSize: number) => ({
    getMessage: vi.fn().mockResolvedValue({
      id: "msg-001",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "application/pdf",
            filename: "large.pdf",
            body: { attachmentId: "att-001", size: totalSize },
          },
        ],
      },
    }),
    getAttachment: vi.fn().mockResolvedValue({
      data: Buffer.alloc(100).toString("base64"),
      size: totalSize,
    }),
  });

  beforeEach(() => vi.clearAllMocks());

  it("returns metadata-only when total size exceeds cap", async () => {
    const overCapSize = 6 * 1024 * 1024; // 6 MB > 5 MB cap
    const client = makeClient(overCapSize);

    const result = await handleGetAttachments(client as any, {
      emailId: "msg-001",
    });

    expect(result.metadataOnly).toBe(true);
    expect(result.attachments[0]?.data).toBeNull();
    expect(result.attachments[0]?.note).toContain("download_attachment");
    expect(client.getAttachment).not.toHaveBeenCalled();
  });

  it("returns full data when total size is within cap", async () => {
    const underCapSize = 1024; // 1 KB
    const client = makeClient(underCapSize);

    const result = await handleGetAttachments(client as any, {
      emailId: "msg-001",
    });

    expect(result.metadataOnly).toBe(false);
    expect(result.attachments[0]?.data).not.toBeNull();
    expect(client.getAttachment).toHaveBeenCalled();
  });

  it("returns empty array for emails with no attachments", async () => {
    const client = {
      getMessage: vi.fn().mockResolvedValue({
        id: "msg-001",
        payload: {
          mimeType: "text/plain",
          body: { data: "aGVsbG8=" },
        },
      }),
      getAttachment: vi.fn(),
    };

    const result = await handleGetAttachments(client as any, {
      emailId: "msg-001",
    });

    expect(result.attachments).toEqual([]);
    expect(result.metadataOnly).toBe(false);
    expect(client.getAttachment).not.toHaveBeenCalled();
  });
});
