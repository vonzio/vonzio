"""Vonzio file server — serves files from /workspace/output/ (port 8000).

Directory listing is disabled for security (defense in depth).
Files are served by exact path only.
"""

import os
from http.server import SimpleHTTPRequestHandler, HTTPServer


class StyledHandler(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    os.chdir("/workspace/output")
    HTTPServer(("0.0.0.0", 8000), StyledHandler).serve_forever()
