"""Vonzio file server — serves files from /workspace/.

Binds the FILE_SERVER_PORT env (default 8765), injected by the server so it stays
in sync with the {{file_server}} preview URL + the dashboard. The default is
uncommon so a docker_access workspace publishing a normal app port doesn't
collide with it; operators can override FILE_SERVER_PORT (config.ts).

Directory listing is disabled for security (defense in depth).
Files are served by exact path only. Hidden files/dirs (anything whose path has
a dot-prefixed component — .env, .git/, .claude/, .npmrc, …) are refused: the
whole /workspace tree is reachable here, and on a public_preview workspace this
endpoint is unauthenticated, so secrets/config must not be fetchable by path.
"""

import os
from urllib.parse import urlparse, unquote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class StyledHandler(SimpleHTTPRequestHandler):
    # Branded, dark-theme-safe error page. Python's default `error_message_format`
    # is a raw serif "Error response" page — unbranded and unreadable on a dark
    # UI. Self-contained (no external assets). http.server HTML-escapes the
    # message/explanation before substitution. Only %(code)d/%(message)s/%(explain)s
    # are format specifiers — keep any literal `%` out of this string.
    error_content_type = "text/html; charset=utf-8"
    error_message_format = (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>%(code)d · vonzio</title></head>"
        '<body style="margin:0;min-height:100vh;display:flex;align-items:center;'
        "justify-content:center;background:#0A0E14;color:#E6E9EE;"
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\">"
        '<div style="text-align:center;max-width:460px;padding:40px 24px;">'
        '<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" style="display:block;margin:0 auto 24px;">'
        '<rect width="64" height="64" rx="14" fill="#0E1116" stroke="#1F2630" stroke-width="1"/>'
        '<path d="M18 22 L32 44 L46 22" fill="none" stroke="#FF5722" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>'
        '<rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="#FF5722"/></svg>'
        '<div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;'
        'text-transform:uppercase;color:#FF5722;margin-bottom:12px;">// vonzio file server</div>'
        '<h1 style="margin:0 0 10px;font-size:22px;font-weight:600;color:#E6E9EE;">%(code)d — %(message)s</h1>'
        '<p style="margin:0;font-size:14px;line-height:1.6;color:#7A8290;">%(explain)s</p>'
        "</div></body></html>"
    )

    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def send_head(self):
        # Refuse any request touching a hidden component (dotfile/dotdir).
        # send_head backs both GET and HEAD, so this covers both.
        parts = unquote(urlparse(self.path).path).split("/")
        if any(seg.startswith(".") for seg in parts if seg):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    os.chdir("/workspace")
    # ThreadingHTTPServer (not the single-threaded HTTPServer): a PDF viewer
    # issues range requests over multiple connections, and any slow/cancelled
    # client (BrokenPipe mid-transfer) would otherwise block the one handler
    # thread and wedge the whole server — connections pile up ESTABLISHED and
    # every later request hangs. One thread per connection isolates that.
    port = int(os.environ.get("FILE_SERVER_PORT", "8765"))
    server = ThreadingHTTPServer(("0.0.0.0", port), StyledHandler)
    server.daemon_threads = True
    server.serve_forever()
