import { describe, it, expect } from "vitest";
import { imapImplicitTls, smtpImplicitTls } from "./mail-service.js";

describe("mail TLS mode derived per-port (not a shared flag)", () => {
  it("IMAP 993 = implicit TLS, 143 = STARTTLS", () => {
    expect(imapImplicitTls(993)).toBe(true);
    expect(imapImplicitTls(143)).toBe(false);
  });

  it("SMTP 465 = implicit TLS, 587/25 = STARTTLS — regardless of IMAP port", () => {
    const base = { imap_host: "x", imap_port: 993, smtp_host: "y", username: "u", password: "p" };
    expect(smtpImplicitTls({ ...base, smtp_port: 465 })).toBe(true);
    expect(smtpImplicitTls({ ...base, smtp_port: 587 })).toBe(false);
    expect(smtpImplicitTls({ ...base, smtp_port: 25 })).toBe(false);
  });

  it("regression: SMTP on 587 (STARTTLS) does NOT force STARTTLS onto IMAP 993", () => {
    // The exact bug: a 587 SMTP config previously flipped IMAP 993 to
    // STARTTLS → "failed to receive greeting". IMAP must stay implicit.
    expect(imapImplicitTls(993)).toBe(true);
  });

  it("explicit security override applies to SMTP only", () => {
    const base = { imap_host: "x", imap_port: 993, smtp_host: "y", smtp_port: 587, username: "u", password: "p" };
    expect(smtpImplicitTls({ ...base, security: "tls" })).toBe(true);
    expect(smtpImplicitTls({ ...base, security: "starttls" })).toBe(false);
  });
});
