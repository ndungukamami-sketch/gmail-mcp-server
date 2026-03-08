import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DeleteEmailSchema,
  BatchDeleteSchema,
  EmptyTrashSchema,
  handleDeleteEmail,
  handleBatchDelete,
  handleMoveEmail,
  handleMarkEmail,
} from "../../src/tools/manage.js";

const mockClient = {
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  trashMessage: vi.fn().mockResolvedValue(undefined),
  modifyMessage: vi.fn().mockResolvedValue({ id: "msg-001", labelIds: ["SPAM"] }),
  getMessage: vi.fn().mockResolvedValue({
    id: "msg-001",
    labelIds: ["INBOX", "STARRED", "IMPORTANT"],
  }),
  listMessages: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

// ── DeleteEmailSchema ──────────────────────────────────────────────────────

describe("DeleteEmailSchema — confirmation guard", () => {
  it("allows soft delete without confirmed field", () => {
    const r = DeleteEmailSchema.safeParse({ emailId: "abc", permanent: false });
    expect(r.success).toBe(true);
  });

  it("blocks permanent delete without confirmed:true", () => {
    const r = DeleteEmailSchema.safeParse({ emailId: "abc", permanent: true });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("confirmed:true");
  });

  it("allows permanent delete with confirmed:true", () => {
    const r = DeleteEmailSchema.safeParse({
      emailId: "abc",
      permanent: true,
      confirmed: true,
    });
    expect(r.success).toBe(true);
  });
});

// ── BatchDeleteSchema ──────────────────────────────────────────────────────

describe("BatchDeleteSchema — validation", () => {
  it("rejects empty array", () => {
    const r = BatchDeleteSchema.safeParse({ emailIds: [] });
    expect(r.success).toBe(false);
  });

  it("rejects more than 1000 IDs", () => {
    const r = BatchDeleteSchema.safeParse({
      emailIds: Array.from({ length: 1001 }, (_, i) => `id${i}`),
    });
    expect(r.success).toBe(false);
  });

  it("rejects permanent:true without confirmed", () => {
    const r = BatchDeleteSchema.safeParse({
      emailIds: ["id1", "id2"],
      permanent: true,
    });
    expect(r.success).toBe(false);
  });

  it("accepts permanent:true with confirmed:true", () => {
    const r = BatchDeleteSchema.safeParse({
      emailIds: ["id1", "id2"],
      permanent: true,
      confirmed: true,
    });
    expect(r.success).toBe(true);
  });
});

// ── EmptyTrashSchema ───────────────────────────────────────────────────────

describe("EmptyTrashSchema — requires confirmed:true", () => {
  it("rejects when confirmed is not provided", () => {
    const r = EmptyTrashSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects confirmed:false", () => {
    const r = EmptyTrashSchema.safeParse({ confirmed: false });
    expect(r.success).toBe(false);
  });

  it("accepts confirmed:true", () => {
    const r = EmptyTrashSchema.safeParse({ confirmed: true });
    expect(r.success).toBe(true);
  });
});

// ── handleDeleteEmail ──────────────────────────────────────────────────────

describe("handleDeleteEmail", () => {
  it("soft delete calls trashMessage, not deleteMessage", async () => {
    const result = await handleDeleteEmail(mockClient as any, {
      emailId: "msg-001",
      permanent: false,
    });
    expect(mockClient.trashMessage).toHaveBeenCalledWith("msg-001");
    expect(mockClient.deleteMessage).not.toHaveBeenCalled();
    expect(result.status).toBe("moved_to_trash");
  });

  it("hard delete calls deleteMessage, not trashMessage", async () => {
    const result = await handleDeleteEmail(mockClient as any, {
      emailId: "msg-001",
      permanent: true,
      confirmed: true,
    });
    expect(mockClient.deleteMessage).toHaveBeenCalledWith("msg-001");
    expect(mockClient.trashMessage).not.toHaveBeenCalled();
    expect(result.status).toBe("permanently_deleted");
  });
});

// ── handleBatchDelete ──────────────────────────────────────────────────────

describe("handleBatchDelete — partial failure reporting", () => {
  it("reports succeeded and failed IDs separately", async () => {
    let callCount = 0;
    mockClient.trashMessage.mockImplementation(async (id: string) => {
      callCount++;
      if (id === "bad-id") throw new Error("Not found");
    });

    const result = await handleBatchDelete(mockClient as any, {
      emailIds: ["good-id", "bad-id", "good-id-2"],
      permanent: false,
    });

    expect(result.succeeded).toContain("good-id");
    expect(result.succeeded).toContain("good-id-2");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe("bad-id");
    expect(result.failed[0]?.reason).toContain("Not found");
  });
});

// ── handleMoveEmail — removes ALL location labels ─────────────────────────

describe("handleMoveEmail", () => {
  it("removes all location labels, not just INBOX", async () => {
    // getMessage returns an email with INBOX + STARRED + IMPORTANT
    mockClient.getMessage.mockResolvedValue({
      id: "msg-001",
      labelIds: ["INBOX", "STARRED", "IMPORTANT"],
    });

    await handleMoveEmail(mockClient as any, {
      emailId: "msg-001",
      targetLabel: "SPAM",
    });

    const modifyCall = mockClient.modifyMessage.mock.calls[0]?.[1] as {
      addLabelIds: string[];
      removeLabelIds: string[];
    };

    expect(modifyCall.addLabelIds).toContain("SPAM");
    // INBOX should be removed
    expect(modifyCall.removeLabelIds).toContain("INBOX");
    // STARRED is NOT a location label, should not be removed by moveEmail
    // (This tests the actual implementation — STARRED is kept)
    expect(modifyCall.removeLabelIds).not.toContain("STARRED");
  });
});

// ── handleMarkEmail ────────────────────────────────────────────────────────

describe("handleMarkEmail", () => {
  it.each([
    ["read", [], ["UNREAD"]],
    ["unread", ["UNREAD"], []],
    ["star", ["STARRED"], []],
    ["unstar", [], ["STARRED"]],
    ["important", ["IMPORTANT"], []],
    ["unimportant", [], ["IMPORTANT"]],
  ] as const)(
    "action %s adds %j and removes %j",
    async (action, addLabels, removeLabels) => {
      await handleMarkEmail(mockClient as any, {
        emailId: "msg-001",
        action,
      });

      const call = mockClient.modifyMessage.mock.calls[0]?.[1] as {
        addLabelIds: string[];
        removeLabelIds: string[];
      };
      expect(call.addLabelIds).toEqual(addLabels);
      expect(call.removeLabelIds).toEqual(removeLabels);
    }
  );
});
