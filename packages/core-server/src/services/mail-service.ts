// Universal mail connector (feature 0035) — IMAP for reading, SMTP for
// sending. Provider-agnostic: Gmail (app password), Outlook, Fastmail,
// iCloud, Proton bridge, custom hosts. No OAuth apps, no verification
// surface — credentials are a user-pasted app password, encrypted at
// rest in the integration row like every other integration secret.
//
// Connections always originate from the SERVER (agents talk to the
// /mcp/mail channel with a per-session bearer token and never see the
// password). Each call opens a fresh IMAP connection and logs out —
// no pooling in v1; mail tools are low-frequency and IMAP servers cap
// concurrent sessions per account aggressively (Gmail: 15).

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { randomBytes } from "node:crypto";
import { assertSocketHostAllowed } from "../lib/safe-webhook-fetch.js";

// Cap on a single fetched message's raw source. IMAP servers can hand
// back multi-MB messages (fat attachments); buffering one unbounded per
// tool call — a few concurrent — would OOM the server that also runs
// the orchestrator. 2MB covers any realistic text/HTML body; oversized
// messages return a clear notice instead of a memory spike.
const MAX_MESSAGE_SOURCE_BYTES = 2 * 1024 * 1024;

export interface MailConfig {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
  /** "tls" (implicit, 993/465) or "starttls" (587/143). Default "tls". */
  security?: "tls" | "starttls";
  /** From header address; defaults to username. */
  from_address?: string;
  from_name?: string;
  /** Owner-controlled kill switch for the mail_send tool. Default true. */
  allow_send?: boolean;
}

export interface MailSearchParams {
  folder?: string;
  /** Free-text search over subject+body (IMAP TEXT). */
  text?: string;
  from?: string;
  subject?: string;
  unseen?: boolean;
  /** ISO date (YYYY-MM-DD) — messages on/after this date. */
  since?: string;
  limit?: number;
}

export interface MailSummary {
  uid: number;
  folder: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
}

function fromAddress(cfg: MailConfig): string {
  const addr = cfg.from_address || cfg.username;
  return cfg.from_name ? `"${cfg.from_name.replace(/"/g, "'")}" <${addr}>` : addr;
}

// TLS mode is derived PER PROTOCOL from the PORT — IMAP and SMTP are
// independent and the earlier single `security` flag conflated them
// (STARTTLS on IMAP 993, which expects implicit TLS → "failed to receive
// greeting"). Standard conventions:
//   IMAP: 993 → implicit TLS (secure). 143 → STARTTLS.
//   SMTP: 465 → implicit TLS (secure). 587/25 → STARTTLS.
// The explicit `security` field, when set, only overrides the SMTP side
// (kept for back-compat); IMAP always follows its own port. Either way
// plaintext auth is never allowed (implicit TLS, or requireTLS on the
// STARTTLS upgrade).
export function imapImplicitTls(port: number): boolean {
  return port !== 143; // 993 (and anything non-143) = implicit TLS
}
export function smtpImplicitTls(cfg: MailConfig): boolean {
  if (cfg.security === "starttls") return false;
  if (cfg.security === "tls") return true;
  return cfg.smtp_port === 465; // 465 implicit; 587/25 STARTTLS
}

// Both builders are async: they SSRF-check the user-controlled host and
// pin the connection to the resolved public IP, presenting the original
// hostname as the TLS servername so cert validation still works. This
// blocks pointing the connector at internal hosts (metadata, RFC1918,
// loopback) and defeats DNS rebinding.
async function imapClient(cfg: MailConfig): Promise<ImapFlow> {
  const { pinnedIp } = await assertSocketHostAllowed(cfg.imap_host);
  const implicit = imapImplicitTls(cfg.imap_port);
  return new ImapFlow({
    host: pinnedIp,
    port: cfg.imap_port,
    secure: implicit,
    disableAutoIdle: true,
    tls: { servername: cfg.imap_host, minVersion: "TLSv1.2" },
    // For the STARTTLS port, require the upgrade — never plaintext auth.
    ...(implicit ? {} : { requireTLS: true }),
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    socketTimeout: 30_000,
    greetingTimeout: 15_000,
  } as ConstructorParameters<typeof ImapFlow>[0]);
}

async function smtpTransport(cfg: MailConfig) {
  const { pinnedIp } = await assertSocketHostAllowed(cfg.smtp_host);
  const implicit = smtpImplicitTls(cfg);
  return nodemailer.createTransport({
    host: pinnedIp,
    port: cfg.smtp_port,
    secure: implicit,
    // On the STARTTLS port force the upgrade; never fall back to plaintext.
    requireTLS: !implicit,
    tls: { servername: cfg.smtp_host, minVersion: "TLSv1.2" },
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 30_000,
  });
}

function envelopeAddr(list?: Array<{ name?: string; address?: string }> | null): string {
  if (!list || list.length === 0) return "";
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")))
    .join(", ");
}

export class MailService {
  /** Live credential check: IMAP login + SMTP handshake. Throws with a
   *  human-readable reason on failure — surfaced in the connect modal. */
  async verify(cfg: MailConfig): Promise<void> {
    const client = await imapClient(cfg);
    try {
      await client.connect();
    } catch (err) {
      throw new Error(`IMAP connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await client.logout().catch(() => {});
    }
    try {
      await (await smtpTransport(cfg)).verify();
    } catch (err) {
      throw new Error(`SMTP connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listFolders(cfg: MailConfig): Promise<Array<{ path: string; specialUse?: string }>> {
    const client = await imapClient(cfg);
    await client.connect();
    try {
      const list = await client.list();
      return list.map((f) => ({ path: f.path, ...(f.specialUse ? { specialUse: f.specialUse } : {}) }));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async search(cfg: MailConfig, params: MailSearchParams): Promise<MailSummary[]> {
    const folder = params.folder || "INBOX";
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const client = await imapClient(cfg);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const query: Record<string, unknown> = {};
        if (params.text) query.text = params.text;
        if (params.from) query.from = params.from;
        if (params.subject) query.subject = params.subject;
        if (params.unseen) query.seen = false;
        if (params.since) query.since = new Date(params.since);
        const uids = (await client.search(
          Object.keys(query).length > 0 ? query : { all: true },
          { uid: true },
        )) as number[] | false;
        if (!uids || uids.length === 0) return [];
        // Newest first; IMAP search returns ascending UIDs.
        const slice = uids.slice(-limit).reverse();
        const out: MailSummary[] = [];
        for await (const msg of client.fetch(
          slice.join(","),
          { uid: true, envelope: true, flags: true },
          { uid: true },
        )) {
          out.push(this.toSummary(folder, msg));
        }
        // fetch yields in mailbox order; re-sort newest first.
        out.sort((a, b) => (a.date < b.date ? 1 : -1));
        return out;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async readMessage(cfg: MailConfig, folder: string, uid: number): Promise<{
    summary: MailSummary;
    messageId?: string;
    text: string;
  }> {
    const client = await imapClient(cfg);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder || "INBOX");
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, flags: true, size: true, source: { maxLength: MAX_MESSAGE_SOURCE_BYTES } },
          { uid: true },
        );
        if (!msg) throw new Error(`Message uid=${uid} not found in ${folder}`);
        if ((msg.size ?? 0) > MAX_MESSAGE_SOURCE_BYTES) {
          return {
            summary: this.toSummary(folder || "INBOX", msg),
            text: `(message is ${Math.round((msg.size ?? 0) / 1024)}KB — too large to read inline; open it in your mail client)`,
          };
        }
        if (!msg.source) throw new Error(`Message uid=${uid} not found in ${folder}`);
        const parsed = await simpleParser(msg.source);
        const html = typeof parsed.html === "string" ? parsed.html : "";
        const text = parsed.text?.trim() || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(no text body)";
        return {
          summary: this.toSummary(folder || "INBOX", msg),
          messageId: parsed.messageId ?? undefined,
          // Cap the body so one 5MB newsletter doesn't blow the agent's context.
          text: text.length > 50_000 ? `${text.slice(0, 50_000)}\n…[truncated]` : text,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async send(cfg: MailConfig, opts: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string; sentCopy: boolean }> {
    // One Message-ID shared by the transmitted mail and the Sent-folder
    // copy so they're the same message across the mailbox.
    const addr = (cfg.from_address || cfg.username).trim();
    const domain = addr.includes("@") ? addr.split("@")[1] : "localhost";
    const messageId = `<${Date.now()}.${randomBytes(8).toString("hex")}@${domain}>`;
    const mail = {
      from: fromAddress(cfg),
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.body,
      messageId,
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo, references: opts.inReplyTo } : {}),
    };
    // nodemailer handles Bcc correctly (envelope only, stripped from the
    // transmitted headers).
    const info = await (await smtpTransport(cfg)).sendMail(mail);

    // File a copy in the Sent folder over IMAP so agent-sent mail is
    // visible in the mailbox — SMTP submission alone never does this
    // (that's normally the mail client's job). Best-effort: the message
    // was already delivered, so an append failure must NOT fail the send.
    let sentCopy = false;
    try {
      const raw: Buffer = await new Promise((resolve, reject) => {
        new MailComposer(mail).compile().build((err, message) => (err ? reject(err) : resolve(message)));
      });
      await this.appendToMailbox(cfg, raw, "\\Sent", "Sent", ["\\Seen"]);
      sentCopy = true;
    } catch {
      // Swallow — the Sent copy is a nicety, not the send.
    }
    return { messageId: info.messageId ?? messageId, sentCopy };
  }

  /** APPEND a raw message to a special-use IMAP folder (\Sent, \Drafts),
   *  falling back to a conventional name when the server doesn't flag one. */
  private async appendToMailbox(
    cfg: MailConfig,
    raw: Buffer,
    specialUse: string,
    fallbackName: string,
    flags: string[],
  ): Promise<string> {
    const client = await imapClient(cfg);
    await client.connect();
    try {
      const folders = await client.list();
      const target = folders.find((f) => f.specialUse === specialUse)?.path ?? fallbackName;
      await client.append(target, raw, flags);
      return target;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** APPEND an unsent draft to the mailbox's \Drafts folder. */
  async createDraft(cfg: MailConfig, opts: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<{ folder: string }> {
    const raw: Buffer = await new Promise((resolve, reject) => {
      new MailComposer({
        from: fromAddress(cfg),
        to: opts.to,
        cc: opts.cc,
        bcc: opts.bcc,
        subject: opts.subject,
        text: opts.body,
      })
        .compile()
        .build((err, message) => (err ? reject(err) : resolve(message)));
    });
    const folder = await this.appendToMailbox(cfg, raw, "\\Drafts", "Drafts", ["\\Draft"]);
    return { folder };
  }

  private toSummary(folder: string, msg: FetchMessageObject): MailSummary {
    const env = msg.envelope;
    return {
      uid: msg.uid,
      folder,
      from: envelopeAddr(env?.from),
      to: envelopeAddr(env?.to),
      subject: env?.subject ?? "(no subject)",
      date: env?.date ? new Date(env.date).toISOString() : "",
      seen: msg.flags?.has("\\Seen") ?? false,
    };
  }
}
