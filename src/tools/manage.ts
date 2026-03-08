/**
 * Management tools: delete_email, move_email, mark_email, create_label,
 * delete_label, list_labels, batch_delete, empty_trash.
 *
 * Security fixes:
 *  - Irreversible operations (permanent delete, empty_trash) require confirmed:true
 *  - moveEmail removes ALL location labels, not just INBOX
 *  - batch_delete returns partial failure report
 *  - empty_trash returns count of deleted messages
 *  - Descriptive tool descriptions warn LLM before setting confirmed:true
 */

import { z } from "zod";
import { GmailClient } from "../gmail-client.js";
import { chunkArray } from "../utils/semaphore.js";
import { logger } from "../utils/logger.js";

// ── Schemas ────────────────────────────────────────────────────────────────

const CONFIRMED_FIELD = z
  .literal(true)
  .describe(
    "MUST be true. You MUST explicitly confirm with the user before setting this. " +
      "This operation is PERMANENT and IRREVERSIBLE."
  );

export const DeleteEmailSchema = z
  .object({
    emailId: z.string().min(1),
    permanent: z
      .boolean()
      .default(false)
      .describe(
        "If false (default), moves to Trash (recoverable). " +
          "If true, permanently deletes — requires confirmed:true."
      ),
    confirmed: z.boolean().optional(),
  })
  .refine((d) => !d.permanent || d.confirmed === true, {
    message:
      "permanent:true requires confirmed:true. " +
      "Ask the user to confirm before proceeding — this cannot be undone.",
    path: ["confirmed"],
  });

export const MoveEmailSchema = z.object({
  emailId: z.string().min(1),
  targetLabel: z
    .string()
    .min(1)
    .describe("Gmail label ID or system label (SPAM, TRASH, etc.)"),
});

export const MarkEmailSchema = z.object({
  emailId: z.string().min(1),
  action: z.enum(["read", "unread", "star", "unstar", "important", "unimportant"]),
});

export const CreateLabelSchema = z.object({
  name: z.string().min(1).max(225),
  visibility: z
    .enum(["show", "hide", "showIfUnread"])
    .default("show")
    .describe("Label list visibility"),
});

export const DeleteLabelSchema = z.object({
  labelId: z.string().min(1),
});

export const ListLabelsSchema = z.object({});

export const BatchDeleteSchema = z
  .object({
    emailIds: z
      .array(z.string().min(1))
      .min(1, "At least one email ID required")
      .max(1000, "Maximum 1000 email IDs per batch"),
    permanent: z
      .boolean()
      .default(false)
      .describe(
        "If false (default), moves to Trash. " +
          "If true, permanently deletes — requires confirmed:true."
      ),
    confirmed: z.boolean().optional(),
  })
  .refine((d) => !d.permanent || d.confirmed === true, {
    message:
      "permanent:true on batch_delete requires confirmed:true. " +
      "Warn the user this will permanently delete multiple emails.",
    path: ["confirmed"],
  });

export const EmptyTrashSchema = z.object({
  confirmed: CONFIRMED_FIELD,
});

export type DeleteEmailInput = z.infer<typeof DeleteEmailSchema>;
export type MoveEmailInput = z.infer<typeof MoveEmailSchema>;
export type MarkEmailInput = z.infer<typeof MarkEmailSchema>;
export type CreateLabelInput = z.infer<typeof CreateLabelSchema>;
export type DeleteLabelInput = z.infer<typeof DeleteLabelSchema>;
export type ListLabelsInput = z.infer<typeof ListLabelsSchema>;
export type BatchDeleteInput = z.infer<typeof BatchDeleteSchema>;
export type EmptyTrashInput = z.infer<typeof EmptyTrashSchema>;

// ── System label IDs that indicate "location" in the mailbox ──────────────
const LOCATION_LABELS = new Set([
  "INBOX",
  "SENT",
  "SPAM",
  "TRASH",
  "DRAFT",
  "UNREAD", // not a location but cleaned up on move
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function getMarkModify(action: MarkEmailInput["action"]): {
  addLabelIds: string[];
  removeLabelIds: string[];
} {
  switch (action) {
    case "read":
      return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "unread":
      return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "star":
      return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar":
      return { addLabelIds: [], removeLabelIds: ["STARRED"] };
    case "important":
      return { addLabelIds: ["IMPORTANT"], removeLabelIds: [] };
    case "unimportant":
      return { addLabelIds: [], removeLabelIds: ["IMPORTANT"] };
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleDeleteEmail(
  client: GmailClient,
  input: DeleteEmailInput
) {
  if (input.permanent) {
    await client.deleteMessage(input.emailId);
    logger.warn({
      msg: "Email permanently deleted",
      emailId: input.emailId,
    });
    return { status: "permanently_deleted", emailId: input.emailId };
  } else {
    await client.trashMessage(input.emailId);
    logger.info({ msg: "Email moved to Trash", emailId: input.emailId });
    return { status: "moved_to_trash", emailId: input.emailId };
  }
}

export async function handleMoveEmail(
  client: GmailClient,
  input: MoveEmailInput
) {
  // ✅ Fetch current labels to remove ALL location labels (not just INBOX)
  const msg = await client.getMessage(input.emailId, "minimal");
  const currentLabels: string[] = msg.labelIds ?? [];

  const removeLabelIds = currentLabels.filter((l) => LOCATION_LABELS.has(l));

  await client.modifyMessage(input.emailId, {
    addLabelIds: [input.targetLabel],
    removeLabelIds,
  });

  logger.info({
    msg: "Email moved",
    emailId: input.emailId,
    from: removeLabelIds,
    to: input.targetLabel,
  });

  return {
    status: "moved",
    emailId: input.emailId,
    removedLabels: removeLabelIds,
    addedLabel: input.targetLabel,
  };
}

export async function handleMarkEmail(
  client: GmailClient,
  input: MarkEmailInput
) {
  const modify = getMarkModify(input.action);
  await client.modifyMessage(input.emailId, modify);

  return {
    status: "marked",
    emailId: input.emailId,
    action: input.action,
  };
}

export async function handleCreateLabel(
  client: GmailClient,
  input: CreateLabelInput
) {
  const visibilityMap = {
    show: "labelShow",
    showIfUnread: "labelShowIfUnread",
    hide: "labelHide",
  } as const;

  const label = await client.createLabel({
    name: input.name,
    labelListVisibility: visibilityMap[input.visibility],
    messageListVisibility: input.visibility === "hide" ? "hide" : "show",
  });

  logger.info({ msg: "Label created", labelId: label.id, name: input.name });

  return {
    labelId: label.id ?? "",
    name: label.name ?? "",
    visibility: input.visibility,
  };
}

export async function handleDeleteLabel(
  client: GmailClient,
  input: DeleteLabelInput
) {
  await client.deleteLabel(input.labelId);
  logger.info({ msg: "Label deleted", labelId: input.labelId });
  return { status: "deleted", labelId: input.labelId };
}

export async function handleListLabels(client: GmailClient) {
  const labels = await client.listLabels();

  const systemLabels = labels
    .filter((l) => l.type === "system")
    .map((l) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      messagesTotal: l.messagesTotal ?? 0,
      messagesUnread: l.messagesUnread ?? 0,
    }));

  const userLabels = labels
    .filter((l) => l.type === "user")
    .map((l) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      messagesTotal: l.messagesTotal ?? 0,
      messagesUnread: l.messagesUnread ?? 0,
    }));

  return { systemLabels, userLabels };
}

export interface BatchDeleteResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
  permanentlyDeleted: boolean;
}

export async function handleBatchDelete(
  client: GmailClient,
  input: BatchDeleteInput
): Promise<BatchDeleteResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  // Process in chunks of 100
  const chunks = chunkArray(input.emailIds, 100);

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (id) => {
        if (input.permanent) {
          await client.deleteMessage(id);
        } else {
          await client.trashMessage(id);
        }
        return id;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        succeeded.push(result.value);
      } else {
        const id = chunk[results.indexOf(result)] ?? "unknown";
        const reason =
          result.reason instanceof Error
            ? result.reason.message.slice(0, 200)
            : "Unknown error";
        failed.push({ id, reason });
      }
    }
  }

  logger.info({
    msg: "Batch delete complete",
    total: input.emailIds.length,
    succeeded: succeeded.length,
    failed: failed.length,
    permanent: input.permanent,
  });

  return {
    succeeded,
    failed,
    permanentlyDeleted: input.permanent,
  };
}

export interface EmptyTrashResult {
  status: "completed";
  deletedCount: number;
  message: string;
}

export async function handleEmptyTrash(
  client: GmailClient,
  _input: EmptyTrashInput
): Promise<EmptyTrashResult> {
  let pageToken: string | undefined;
  let deletedCount = 0;

  logger.warn({ msg: "empty_trash initiated — this is irreversible" });

  do {
    const result = await client.listMessages({
      labelIds: ["TRASH"],
      maxResults: 500,
      pageToken,
    });

    const messages = result.messages;
    if (messages.length === 0) break;

    const ids = messages.map((m) => m.id);

    // Permanently delete in chunks
    const chunks = chunkArray(ids, 100);
    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map((id) => client.deleteMessage(id))
      );
      deletedCount += chunk.length;
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  logger.warn({ msg: "empty_trash complete", deletedCount });

  return {
    status: "completed",
    deletedCount,
    message: `Permanently deleted ${deletedCount} message(s) from Trash. This action cannot be undone.`,
  };
}
