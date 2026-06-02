/**
 * Telegram Bot API client — send messages, set webhook, validate token.
 *
 * Bot API reference: https://core.telegram.org/bots/api
 *
 * Originally lived at packages/core-server/src/services/telegram-service.ts.
 * Moved here as part of the Phase 3C extraction (PR after the scaffold).
 * core-server still exports the same symbols via a re-export shim so
 * existing callers (notification-service, telegram-events.ts,
 * platform-bot-service.ts) don't have to change in this PR -- the
 * inversion to bus-dispatch happens in subsequent PRs once the
 * service-side surface has settled here.
 */

export interface TelegramSendMessage {
  chat_id: number | string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_to_message_id?: number;
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
}

export interface TelegramMe {
  id: number;
  is_bot: boolean;
  username: string;
  first_name: string;
}

export interface TelegramSentMessage {
  message_id: number;
  chat: { id: number };
  date: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export class TelegramService {
  private base = "https://api.telegram.org";

  async getMe(botToken: string): Promise<TelegramMe> {
    const data = await this.call<TelegramMe>(botToken, "getMe", {});
    return data;
  }

  async sendMessage(botToken: string, msg: TelegramSendMessage): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>(botToken, "sendMessage", msg as unknown as Record<string, unknown>);
  }

  async editMessageText(
    botToken: string,
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: { parse_mode?: "MarkdownV2" | "HTML"; reply_markup?: unknown },
  ): Promise<void> {
    await this.call(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...opts,
    });
  }

  async sendChatAction(botToken: string, chatId: number | string, action = "typing"): Promise<void> {
    await this.call(botToken, "sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  async answerCallbackQuery(
    botToken: string,
    callbackQueryId: string,
    opts?: { text?: string; show_alert?: boolean },
  ): Promise<void> {
    await this.call(botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...opts,
    }).catch(() => {});
  }

  async setWebhook(
    botToken: string,
    url: string,
    secretToken: string,
    allowedUpdates: string[] = ["message", "callback_query"],
  ): Promise<void> {
    await this.call(botToken, "setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: allowedUpdates,
      drop_pending_updates: true,
    });
  }

  async deleteWebhook(botToken: string): Promise<void> {
    await this.call(botToken, "deleteWebhook", { drop_pending_updates: true }).catch(() => {});
  }

  async setMyCommands(
    botToken: string,
    commands: Array<{ command: string; description: string }>,
  ): Promise<void> {
    await this.call(botToken, "setMyCommands", { commands }).catch(() => {});
  }

  /**
   * Resolve a file_id to a file_path so it can be downloaded. The Bot API's
   * 20 MB limit applies — anything larger comes back without a file_path.
   */
  async getFile(botToken: string, fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>(botToken, "getFile", { file_id: fileId });
  }

  /**
   * Download a file by its resolved file_path. Returns the raw bytes.
   * The path is what getFile() returned, NOT a user-supplied URL.
   */
  async downloadFile(botToken: string, filePath: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/file/bot${botToken}/${filePath}`);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }

  /**
   * Send a photo by URL. Telegram fetches the URL server-side and embeds
   * the result as an inline photo bubble. Caller must supply a URL that
   * Telegram's servers can actually reach (public DNS + auth handled
   * via query param, e.g. our signed `_pvt` token).
   */
  async sendPhoto(
    botToken: string,
    chatId: number | string,
    photoUrl: string,
    opts?: { caption?: string; parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<void> {
    await this.call(botToken, "sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      ...(opts?.caption ? { caption: opts.caption } : {}),
      ...(opts?.parse_mode ? { parse_mode: opts.parse_mode } : {}),
    });
  }

  /**
   * Upload a text/document attachment. Used when an agent response is too
   * long to read inline (>8KB) — we send a short preview message and the
   * full text as a .md file the user can open or download.
   *
   * Uses multipart/form-data because the document body is bytes, not JSON.
   */
  async sendDocument(
    botToken: string,
    chatId: number | string,
    filename: string,
    content: string,
    opts?: { caption?: string; parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([content], { type: "text/markdown" }), filename);
    if (opts?.caption) form.append("caption", opts.caption);
    if (opts?.parse_mode) form.append("parse_mode", opts.parse_mode);

    const res = await fetch(`${this.base}/bot${botToken}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error (sendDocument): ${data.description ?? "unknown"}`);
    }
  }

  private async call<T = unknown>(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.base}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error (${method}): ${data.description ?? "unknown"}`);
    }
    return data.result as T;
  }
}

/**
 * Escape text for Telegram MarkdownV2.
 * Required for any character outside the supported entities.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * Convert GitHub-flavored markdown to Telegram MarkdownV2.
 *
 * Supports: bold, italic, code, code blocks, links, strikethrough.
 * Headers become bold. All other special chars are escaped.
 */
export function markdownToTelegram(text: string): string {
  // Pull out fenced code blocks and inline code first so their contents
  // aren't escaped or transformed.
  const placeholders: string[] = [];
  const stash = (s: string) => {
    placeholders.push(s);
    return ` ${placeholders.length - 1} `;
  };

  let work = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const langTag = lang ? lang : "";
    return stash(`\`\`\`${langTag}\n${body.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\n\`\`\``);
  });
  work = work.replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`\`${body.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``));

  // Pull out links so the URL portion isn't mangled by escaping
  work = work.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const safeLabel = escapeMarkdownV2(label);
    const safeUrl = url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
    return stash(`[${safeLabel}](${safeUrl})`);
  });

  // Headers → bold (we'll do bold conversion below). Strip leading #s.
  work = work.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Stash bold/italic/strikethrough markers so escapeMarkdownV2 doesn't break them
  // **bold** → *bold* (after escape)
  work = work.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => stash(`*${escapeMarkdownV2(body)}*`));
  // __italic__ → _italic_ (after escape) — Telegram MarkdownV2 italic is _ … _
  work = work.replace(/(?<!_)__(?!_)([^_\n]+)(?<!_)__(?!_)/g, (_m, body: string) => stash(`_${escapeMarkdownV2(body)}_`));
  // *italic* (single asterisk) — only when not part of bold (already consumed above)
  work = work.replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, (_m, body: string) => stash(`_${escapeMarkdownV2(body)}_`));
  // _italic_ (single underscore)
  work = work.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_m, body: string) => stash(`_${escapeMarkdownV2(body)}_`));
  // ~~strike~~ → ~strike~
  work = work.replace(/~~([^~\n]+)~~/g, (_m, body: string) => stash(`~${escapeMarkdownV2(body)}~`));

  // Escape everything else
  work = escapeMarkdownV2(work);

  // Restore placeholders
  work = work.replace(/ (\d+) /g, (_m, idx: string) => placeholders[Number(idx)]);

  return work;
}

/** Split a long message into <=4096 char chunks, preferring newline boundaries. */
export function splitTelegramMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 2) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
