#!/usr/bin/env python3
"""Local dev server that never caches.

python -m http.server lets the browser hold on to main.js and
campus.json, so a rebuilt grid or a regenerated spritesheet can silently
keep rendering the previous version. This sends no-store on everything.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    print(f"Serving {__file__.rsplit('/', 2)[0] or '.'} on http://localhost:{PORT} (no-cache)")
    ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
