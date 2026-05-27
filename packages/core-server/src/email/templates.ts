/**
 * Shared email layout for all vonzio transactional emails.
 * Brand: Sodium accent (#FF5722) on warm paper background, DM Sans
 * (web font, falls back to system stack), text-only wordmark — no
 * hosted images, no inline SVG. Email clients strip SVG and external
 * PNGs sometimes 404 mid-flight; a text wordmark renders everywhere.
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

// Brand: Sodium palette (mirror of packages/dashboard/src/brand/tokens.css)
const B = {
  sodium: "#FF5722",
  sodiumDeep: "#E64A1A",
  graphite: "#0E1116",      // primary ink
  ink2: "#2A2F38",          // softer ink for body
  muted: "#6B6B73",         // captions / footer text
  mutedSoft: "#9B9BA3",     // © line and meta
  page: "#FAFAF7",          // outer canvas (warm paper)
  card: "#FFFFFF",          // card surface
  border: "#E8E6DF",
  white: "#FFFFFF",
  url: "https://vonz.io",
  year: new Date().getFullYear(),
};

// Text-only wordmark: lowercase, with the leading 'v' in sodium and
// the rest in graphite. Mirrors the SPA's auth-page brand mark.
const WORDMARK = `<span style="font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;"><span style="color:${B.sodium};">v</span><span style="color:${B.graphite};">onzio</span></span>`;

export function emailLayout({ name, body, cta, footer }: EmailOptions): string {
  const greeting = name
    ? `<p style="margin:0 0 16px;color:${B.ink2};">Hi ${escapeHtml(name)},</p>`
    : "";

  const ctaBlock = cta ? `
    <p style="margin:24px 0 8px;">
      <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:11px 24px;background:${B.sodium};color:${B.white};text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:0.01em;">${escapeHtml(cta.label)}</a>
    </p>
  ` : "";

  const footerNote = footer
    ? `<p style="margin:16px 0 0;font-size:13px;color:${B.muted};line-height:1.5;">${footer}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  </style>
</head>
<body style="margin:0;padding:0;background:${B.page};font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${B.ink2};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:48px 16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:460px;width:100%;">
          <tr>
            <td style="padding-bottom:28px;text-align:center;">
              <a href="${B.url}" style="text-decoration:none;">${WORDMARK}</a>
            </td>
          </tr>
          <tr>
            <td style="background:${B.card};border:1px solid ${B.border};border-radius:8px;padding:28px 24px;">
              ${greeting}
              <div>${body}</div>
              ${ctaBlock}
              ${footerNote}
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${B.mutedSoft};">&copy; ${B.year} vonzio &middot; <a href="${B.url}" style="color:${B.mutedSoft};text-decoration:none;">vonz.io</a></p>
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
