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

import type { PluginHttp } from "@vonzio/plugin-api";
import { marked, type Token, type Tokens } from "marked";

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

  // `http` is the audited outbound surface (ctx.http). All plugin
  // callers thread it through. It's optional only so core-server's
  // vestigial `new TelegramService()` (a never-invoked
  // NotificationService dep -- see core server.ts) keeps compiling
  // during the extraction; that instance never reaches a fetch call.
  private http: PluginHttp;

  constructor(http?: PluginHttp) {
    this.http =
      http ??
      ({
        fetch: () => {
          throw new Error(
            "TelegramService used without an audited http surface (ctx.http)",
          );
        },
      } as PluginHttp);
  }

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
    // Request the audited surface's max response size (5 MiB). Routing through
    // ctx.http caps downloads — attachments larger than this are rejected (a
    // v1 limitation of the audited path; raw fetch was unbounded).
    const res = await this.http.fetch(`${this.base}/file/bot${botToken}/${filePath}`, {
      maxResponseBytes: 5 * 1024 * 1024,
    });
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

    const res = await this.http.fetch(`${this.base}/bot${botToken}/sendDocument`, {
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
    const res = await this.http.fetch(`${this.base}/bot${botToken}/${method}`, {
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

// ── Telegram HTML formatter ───────────────────────────────────────────────
// The MarkdownV2 path above is a fragile hand-rolled converter (numeric
// placeholder collisions corrupt code/links, no nesting, an 18-char escape
// minefield where one miss drops the whole message). The HTML path renders
// GitHub-flavored markdown through marked's token AST into Telegram's supported
// tag subset — escaping is just `& < >`, code never auto-links, nesting and
// lists work. New code uses these; the MarkdownV2 funcs stay for the existing
// re-export + tests.

/** Escape text-node content for Telegram HTML (Bot API special-cases & < >). */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Escape an href attribute value (text escape + quotes). */
function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, "&quot;");
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        out += tt.tokens ? renderInline(tt.tokens) : escHtml(tt.text);
        break;
      }
      case "escape":
        out += escHtml((t as Tokens.Escape).text);
        break;
      case "strong":
        out += `<b>${renderInline((t as Tokens.Strong).tokens)}</b>`;
        break;
      case "em":
        out += `<i>${renderInline((t as Tokens.Em).tokens)}</i>`;
        break;
      case "del":
        out += `<s>${renderInline((t as Tokens.Del).tokens)}</s>`;
        break;
      case "codespan":
        out += `<code>${escHtml((t as Tokens.Codespan).text)}</code>`;
        break;
      case "br":
        out += "\n";
        break;
      case "link": {
        const lt = t as Tokens.Link;
        out += `<a href="${escAttr(lt.href)}">${renderInline(lt.tokens)}</a>`;
        break;
      }
      case "image": {
        // Images are handled separately (image-rewriter → sendPhoto); keep alt.
        const it = t as Tokens.Image;
        out += escHtml(it.text || it.title || "");
        break;
      }
      default:
        out += escHtml((t as { raw?: string }).raw ?? "");
    }
  }
  return out;
}

function renderBlocks(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "heading":
        out += `<b>${renderInline((t as Tokens.Heading).tokens)}</b>\n\n`;
        break;
      case "paragraph":
        out += `${renderInline((t as Tokens.Paragraph).tokens)}\n\n`;
        break;
      case "text": {
        const tt = t as Tokens.Text;
        out += `${tt.tokens ? renderInline(tt.tokens) : escHtml(tt.text)}\n\n`;
        break;
      }
      case "code": {
        const ct = t as Tokens.Code;
        const lang = ct.lang ? ct.lang.split(/\s+/)[0] : "";
        const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
        out += `<pre><code${cls}>${escHtml(ct.text)}</code></pre>\n\n`;
        break;
      }
      case "blockquote": {
        const inner = renderBlocks((t as Tokens.Blockquote).tokens).trim().replace(/\n{2,}/g, "\n");
        out += `<blockquote>${inner}</blockquote>\n\n`;
        break;
      }
      case "list": {
        const lt = t as Tokens.List;
        lt.items.forEach((item, i) => {
          const marker = lt.ordered ? `${(Number(lt.start) || 1) + i}.` : "•";
          const check = item.task ? (item.checked ? "☑ " : "☐ ") : "";
          // Items hold block tokens; collapse to a single line and indent
          // continuation/nested content under the marker.
          const content = renderBlocks(item.tokens).trim().replace(/\n{2,}/g, "\n").replace(/\n/g, "\n   ");
          out += `${marker} ${check}${content}\n`;
        });
        out += "\n";
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        out += `<b>${tb.header.map((c) => renderInline(c.tokens)).join(" | ")}</b>\n`;
        for (const row of tb.rows) out += `${row.map((c) => renderInline(c.tokens)).join(" | ")}\n`;
        out += "\n";
        break;
      }
      case "hr":
        out += "———\n\n";
        break;
      default:
        out += escHtml((t as { raw?: string }).raw ?? "");
    }
  }
  return out;
}

/** Render GitHub-flavored markdown to Telegram-supported HTML. */
export function toTelegramHtml(markdown: string): string {
  return renderBlocks(marked.lexer(markdown)).replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip Telegram HTML tags + unescape entities — the plain-text fallback when
 *  a send is rejected for bad entities. */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Split source markdown into chunks under maxLen at block boundaries, so each
 *  chunk renders to standalone, balanced HTML (no mid-tag/mid-fence splits). A
 *  single oversized block falls back to a newline-preferring hard split. */
export function chunkMarkdown(markdown: string, maxLen = 3800): string[] {
  const tokens = marked.lexer(markdown);
  const groups: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const raw = t.raw ?? "";
    if (cur && cur.length + raw.length > maxLen) {
      groups.push(cur);
      cur = raw;
    } else {
      cur += raw;
    }
  }
  if (cur) groups.push(cur);
  return groups.length > 0 ? groups : [markdown];
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
