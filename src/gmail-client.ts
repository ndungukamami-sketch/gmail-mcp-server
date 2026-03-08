/**
 * GmailClient — thin wrapper around the Gmail REST API.
 *
 * All calls go through withRetry() for automatic backoff on 429/5xx.
 * The authenticated OAuth2Client is obtained lazily and refreshed via mutex.
 */

import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { getAuthenticatedClient } from "./auth/oauth.js";
import { withRetry } from "./utils/retry.js";
import { logger } from "./utils/logger.js";

export type GmailMessage = gmail_v1.Schema$Message;
export type GmailDraft = gmail_v1.Schema$Draft;
export type GmailLabel = gmail_v1.Schema$Label;
export type GmailThread = gmail_v1.Schema$Thread;
export type MessagePart = gmail_v1.Schema$MessagePart;

export interface ListMessagesOptions {
  labelIds?: string[] | undefined;
  maxResults?: number | undefined;
  pageToken?: string | undefined;
  q?: string | undefined;
}

export interface ModifyMessageOptions {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface CreateLabelOptions {
  name: string;
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide" | undefined;
  messageListVisibility?: "show" | "hide" | undefined;
}

export interface UserProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export class GmailClient {
  private getGmail = async () => {
    const auth = await getAuthenticatedClient();
    return google.gmail({ version: "v1", auth });
  };

  async getProfile(): Promise<UserProfile> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.getProfile({ userId: "me" })
    );
    const data = res.data;
    return {
      emailAddress: data.emailAddress ?? "",
      messagesTotal: data.messagesTotal ?? 0,
      threadsTotal: data.threadsTotal ?? 0,
      historyId: data.historyId ?? "",
    };
  }

  async listMessages(opts: ListMessagesOptions): Promise<{
    messages: Array<{ id: string; threadId: string }>;
    nextPageToken?: string;
    resultSizeEstimate: number;
  }> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.messages.list({
        userId: "me",
        ...(opts.labelIds !== undefined && { labelIds: opts.labelIds }),
        ...(opts.maxResults !== undefined && { maxResults: opts.maxResults }),
        ...(opts.pageToken !== undefined && { pageToken: opts.pageToken }),
        ...(opts.q !== undefined && { q: opts.q }),
      })
    );

    const data = res.data;
    return {
      messages: (data.messages ?? []).map((m) => ({
        id: m.id ?? "",
        threadId: m.threadId ?? "",
      })),
      nextPageToken: data.nextPageToken ?? undefined,
      resultSizeEstimate: data.resultSizeEstimate ?? 0,
    };
  }

  async getMessage(
    id: string,
    format: "full" | "minimal" | "raw" | "metadata" = "full"
  ): Promise<GmailMessage> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.messages.get({ userId: "me", id, format })
    );
    return res.data;
  }

  async sendMessage(raw: string): Promise<{ id: string; threadId: string }> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      })
    );
    return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
  }

  async saveDraft(raw: string): Promise<{ draftId: string; messageId: string }> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      })
    );
    return {
      draftId: res.data.id ?? "",
      messageId: res.data.message?.id ?? "",
    };
  }

  async trashMessage(id: string): Promise<void> {
    const gmail = await this.getGmail();
    await withRetry(() => gmail.users.messages.trash({ userId: "me", id }));
  }

  async deleteMessage(id: string): Promise<void> {
    const gmail = await this.getGmail();
    await withRetry(() => gmail.users.messages.delete({ userId: "me", id }));
    logger.debug({ msg: "Permanently deleted message", id });
  }

  async modifyMessage(
    id: string,
    opts: ModifyMessageOptions
  ): Promise<GmailMessage> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: {
          addLabelIds: opts.addLabelIds ?? [],
          removeLabelIds: opts.removeLabelIds ?? [],
        },
      })
    );
    return res.data;
  }

  async batchModifyMessages(
    ids: string[],
    opts: ModifyMessageOptions
  ): Promise<void> {
    const gmail = await this.getGmail();
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids,
          addLabelIds: opts.addLabelIds ?? [],
          removeLabelIds: opts.removeLabelIds ?? [],
        },
      })
    );
  }

  async getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ data: string; size: number }> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      })
    );
    return {
      data: res.data.data ?? "",
      size: res.data.size ?? 0,
    };
  }

  async listLabels(): Promise<GmailLabel[]> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.labels.list({ userId: "me" })
    );
    return res.data.labels ?? [];
  }

  async getLabel(id: string): Promise<GmailLabel> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.labels.get({ userId: "me", id })
    );
    return res.data;
  }

  async createLabel(opts: CreateLabelOptions): Promise<GmailLabel> {
    const gmail = await this.getGmail();
    const res = await withRetry(() =>
      gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: opts.name,
          labelListVisibility: opts.labelListVisibility ?? "labelShow",
          messageListVisibility: opts.messageListVisibility ?? "show",
        },
      })
    );
    return res.data;
  }

  async deleteLabel(id: string): Promise<void> {
    const gmail = await this.getGmail();
    await withRetry(() =>
      gmail.users.labels.delete({ userId: "me", id })
    );
  }
}
