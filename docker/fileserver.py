"""Vonzio file server — serves files from /workspace/ (port 8000).

Directory listing is disabled for security (defense in depth).
Files are served by exact path only.
"""

import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class StyledHandler(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    os.chdir("/workspace")
    # ThreadingHTTPServer (not the single-threaded HTTPServer): a PDF viewer
    # issues range requests over multiple connections, and any slow/cancelled
    # client (BrokenPipe mid-transfer) would otherwise block the one handler
    # thread and wedge the whole server — connections pile up ESTABLISHED and
    # every later request hangs. One thread per connection isolates that.
    server = ThreadingHTTPServer(("0.0.0.0", 8000), StyledHandler)
    server.daemon_threads = True
    server.serve_forever()
