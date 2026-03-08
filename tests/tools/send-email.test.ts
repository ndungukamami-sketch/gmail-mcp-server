import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendEmailSchema, handleSendEmail } from "../../src/tools/write.js";

// Mock the GmailClient
const mockClient = {
  sendMessage: vi.fn(),
  getProfile: vi.fn().mockResolvedValue({
    emailAddress: "sender@example.com",
    messagesTotal: 100,
    threadsTotal: 50,
    historyId: "12345",
  }),
};

describe("SendEmailSchema validation", () => {
  it("accepts a valid plain-text email", () => {
    const result = SendEmailSchema.safeParse({
      to: "recipient@example.com",
      subject: "Hello",
      body: "World",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid to address", () => {
    const result = SendEmailSchema.safeParse({
      to: "not-an-email",
      subject: "Hello",
      body: "World",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty subject", () => {
    const result = SendEmailSchema.safeParse({
      to: "recipient@example.com",
      subject: "",
      body: "World",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Subject");
  });

  it("rejects empty body", () => {
    const result = SendEmailSchema.safeParse({
      to: "recipient@example.com",
      subject: "Hello",
      body: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects body over 5 MB", () => {
    const result = SendEmailSchema.safeParse({
      to: "recipient@example.com",
      subject: "Hello",
      body: "x".repeat(5 * 1024 * 1024 + 1),
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.code).toBe("too_big");
  });

  it("accepts multiple comma-separated to addresses", () => {
    const result = SendEmailSchema.safeParse({
      to: "a@example.com, b@example.com",
      subject: "Hello",
      body: "World",
    });
    expect(result.success).toBe(true);
  });
});

describe("handleSendEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path — sends email and returns messageId", async () => {
    mockClient.sendMessage.mockResolvedValue({
      id: "msg-001",
      threadId: "thread-001",
    });

    const result = await handleSendEmail(mockClient as any, {
      to: "recipient@example.com",
      subject: "Hello",
      body: "World",
      isHtml: false,
    });

    expect(mockClient.sendMessage).toHaveBeenCalledOnce();
    expect(result.messageId).toBe("msg-001");
    expect(result.status).toBe("sent");
  });

  it("includes From: in the raw message passed to sendMessage", async () => {
    mockClient.sendMessage.mockResolvedValue({ id: "msg-002", threadId: "t-002" });

    await handleSendEmail(mockClient as any, {
      to: "recipient@example.com",
      subject: "Test",
      body: "Body",
      isHtml: false,
    });

    const rawArg: string = mockClient.sendMessage.mock.calls[0]?.[0] as string;
    const decoded = Buffer.from(
      rawArg.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");

    expect(decoded).toContain("From: sender@example.com");
  });

  it("sanitises HTML body — strips script tags", async () => {
    mockClient.sendMessage.mockResolvedValue({ id: "msg-003", threadId: "t-003" });

    await handleSendEmail(mockClient as any, {
      to: "recipient@example.com",
      subject: "XSS test",
      body: '<p>Hello</p><script>alert("xss")</script>',
      isHtml: true,
    });

    const rawArg: string = mockClient.sendMessage.mock.calls[0]?.[0] as string;
    const decoded = Buffer.from(
      rawArg.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");

    // The base64-encoded body should not contain script tag
    expect(decoded).not.toContain("<script>");
    expect(decoded).not.toContain("alert");
  });

  it("propagates Gmail API errors (will be caught at server level)", async () => {
    mockClient.sendMessage.mockRejectedValue(
      Object.assign(new Error("API error"), { response: { status: 429 } })
    );

    await expect(
      handleSendEmail(mockClient as any, {
        to: "recipient@example.com",
        subject: "Hello",
        body: "World",
        isHtml: false,
      })
    ).rejects.toThrow();
  });
});
