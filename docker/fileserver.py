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
