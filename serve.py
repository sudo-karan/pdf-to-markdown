#!/usr/bin/env python3
"""
Offline static server for the PDF -> Markdown app.

Why you need this: opening index.html directly via file:// makes browsers block
web-workers and local fetch(), which this converter relies on. This server binds
to localhost ONLY and serves the files in this folder. It makes no outbound
connections — it is just a local file host, so the app stays 100% air-gapped.

Usage:
    python3 serve.py            # http://localhost:8000
    python3 serve.py 9000       # custom port
"""
import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    # Ensure modern web assets get correct MIME types across Python versions.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".bcmap": "application/octet-stream",
        ".pfb": "application/octet-stream",
        ".ttf": "font/ttf",
        ".gz": "application/octet-stream",  # traineddata.gz: do NOT gzip-encode
        ".traineddata": "application/octet-stream",
        "": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        # Refuse any path containing a dotfile/dotdir segment (e.g. .git, .github,
        # .gitignore) so the dev server never exposes repository internals.
        path = self.translate_path(self.path)
        rel = os.path.relpath(path, ROOT)
        if any(part.startswith(".") for part in rel.replace("\\", "/").split("/") if part not in ("", ".", "..")):
            self.send_error(404, "Not Found")
            return None
        return super().send_head()

    def end_headers(self):
        # No caching during local use; never advertise gzip transport-encoding.
        self.send_header("Cache-Control", "no-store")
        # Defensive headers for the local dev server.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    # Bind to loopback only — nothing on the network can reach this.
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"\n  PDF → Markdown (offline) serving at:  http://localhost:{PORT}")
        print(f"  Root: {ROOT}")
        print("  Loopback only · no outbound connections · press Ctrl+C to stop\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped.")
