/**
 * Shared email layout for all Vonzio transactional emails.
 * Brand: Deep Ocean palette, DM Sans, minimalist.
 * One place to update — used by auth, invites, and any future emails.
 */

interface EmailOptions {
  /** Recipient's name for the greeting. Omit to skip greeting. */
  name?: string;
  /** Main body text (can include HTML). */
  body: string;
  /** Optional call-to-action button. */
  cta?: { label: string; url: string };
  /** Optional footer text below the CTA. */
  footer?: string;
}

// Brand: Deep Ocean palette from docs/brand-guide.md
const B = {
  navy: "#0F2B46",
  ocean: "#1A4D6E",
  teal: "#00BFA5",
  tealHover: "#00A892",
  cloud: "#F5F7FA",
  silver: "#CBD5E1",
  slate900: "#1E293B",
  slate500: "#64748B",
  slate400: "#94A3B8",
  white: "#FFFFFF",
  url: "https://vonz.io",
  year: new Date().getFullYear(),
};

// Hosted logo PNG — email clients strip inline SVGs, so we use a hosted image
const LOGO_IMG = `<img src="${B.url}/vonzio-logo.png" alt="vonzio" width="48" height="48" style="vertical-align:middle;border-radius:10px;" />`;

export function emailLayout({ name, body, cta, footer }: EmailOptions): string {
  const greeting = name
    ? `<p style="margin:0 0 16px;color:${B.slate900};">Hi ${escapeHtml(name)},</p>`
    : "";

  const ctaBlock = cta ? `
    <p style="margin:24px 0 8px;">
      <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 28px;background:${B.teal};color:${B.white};text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${escapeHtml(cta.label)}</a>
    </p>
  ` : "";

  const footerNote = footer
    ? `<p style="margin:16px 0 0;font-size:13px;color:${B.slate500};line-height:1.5;">${footer}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:${B.cloud};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${B.slate900};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:48px 16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:460px;width:100%;">
          <tr>
            <td style="padding-bottom:28px;">
              <a href="${B.url}" style="text-decoration:none;">
                ${LOGO_IMG}
                <span style="margin-left:10px;font-size:20px;font-weight:700;color:${B.navy};letter-spacing:-0.02em;vertical-align:middle;"><span style="color:${B.teal};">v</span>onzio</span>
              </a>
            </td>
          </tr>
          <tr>
            <td style="background:${B.white};border:1px solid ${B.silver};border-radius:8px;padding:28px 24px;">
              ${greeting}
              <div>${body}</div>
              ${ctaBlock}
              ${footerNote}
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${B.slate400};">&copy; ${B.year} vonzio &middot; <a href="${B.url}" style="color:${B.slate400};text-decoration:none;">vonz.io</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
