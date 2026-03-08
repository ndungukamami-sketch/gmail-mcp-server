import { describe, it, expect } from "vitest";
import {
  normaliseSubjectPrefix,
  parseHeaders,
  buildRawMessage,
  extractAttachmentMeta,
} from "../../src/utils/mime.js";

describe("normaliseSubjectPrefix", () => {
  it("prepends Re: to a plain subject", () => {
    expect(normaliseSubjectPrefix("Hello", "Re")).toBe("Re: Hello");
  });

  it("deduplicates existing Re: prefix", () => {
    expect(normaliseSubjectPrefix("Re: Hello", "Re")).toBe("Re: Hello");
  });

  it("deduplicates multiple Re: prefixes", () => {
    expect(normaliseSubjectPrefix("Re: Re: Re: Hello", "Re")).toBe("Re: Hello");
  });

  it("deduplicates mixed case RE:/re:", () => {
    expect(normaliseSubjectPrefix("RE: re: Hello", "Re")).toBe("Re: Hello");
  });

  it("prepends Fwd: to a plain subject", () => {
    expect(normaliseSubjectPrefix("Hello", "Fwd")).toBe("Fwd: Hello");
  });

  it("deduplicates existing Fwd: prefix", () => {
    expect(normaliseSubjectPrefix("Fwd: Hello", "Fwd")).toBe("Fwd: Hello");
  });

  it("deduplicates FWD: on Fwd prefix", () => {
    expect(normaliseSubjectPrefix("FWD: FW: Hello", "Fwd")).toBe("Fwd: Hello");
  });

  it("handles empty subject gracefully", () => {
    expect(normaliseSubjectPrefix("", "Re")).toBe("Re: (no subject)");
  });
});

describe("parseHeaders", () => {
  const mockMessage = {
    payload: {
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "bob@example.com" },
        { name: "Cc", value: "carol@example.com" },
        { name: "Subject", value: "Test Subject" },
        { name: "Message-ID", value: "<msg-001@example.com>" },
        { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
      ],
    },
  };

  it("parses standard headers correctly", () => {
    const h = parseHeaders(mockMessage);
    expect(h.from).toBe("alice@example.com");
    expect(h.to).toBe("bob@example.com");
    expect(h.cc).toBe("carol@example.com");
    expect(h.subject).toBe("Test Subject");
    expect(h.messageId).toBe("<msg-001@example.com>");
  });

  it("returns empty strings for missing headers", () => {
    const h = parseHeaders({ payload: { headers: [] } });
    expect(h.from).toBe("");
    expect(h.bcc).toBe("");
  });

  it("handles null payload gracefully", () => {
    const h = parseHeaders({ payload: null });
    expect(h.from).toBe("");
  });
});

describe("buildRawMessage", () => {
  it("always includes From: header", () => {
    const raw = buildRawMessage({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      body: "World",
    });
    // Decode the base64url to check headers
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");
    expect(decoded).toContain("From: sender@example.com");
  });

  it("includes CC and BCC when provided", () => {
    const raw = buildRawMessage({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      body: "World",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
  });

  it("sets correct content type for HTML", () => {
    const raw = buildRawMessage({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      body: "<p>World</p>",
      isHtml: true,
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");
    expect(decoded).toContain("Content-Type: text/html");
  });
});

describe("extractAttachmentMeta", () => {
  it("returns empty array for message with no attachments", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: "aGVsbG8=" },
      parts: undefined,
      filename: "",
    };
    expect(extractAttachmentMeta(payload)).toEqual([]);
  });

  it("extracts attachment metadata from MIME parts", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: "aGVsbG8=" },
          filename: "",
        },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "att-001", size: 12345 },
        },
      ],
    };
    const metas = extractAttachmentMeta(payload as any);
    expect(metas).toHaveLength(1);
    expect(metas[0]?.filename).toBe("report.pdf");
    expect(metas[0]?.attachmentId).toBe("att-001");
    expect(metas[0]?.size).toBe(12345);
  });
});
