#!/usr/bin/env python3
"""Local dev server: no caching, plus the /api/bt proxy.

Two jobs:

1. No-store on everything. python -m http.server lets the browser hold on
   to main.js and campus.json, so a rebuilt grid or a regenerated
   spritesheet can silently keep rendering the previous version.

2. Mirror api/bt.js locally. Blacksburg Transit's endpoints are public and
   keyless but send no Access-Control-Allow-Origin, so the browser cannot
   call them directly. Serving the same /api/bt path here as Vercel does
   in production means the frontend has one code path, and live times are
   testable without deploying.
"""
import json, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import requests

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

BT_BASE = ("https://ridebt.org/index.php?option=com_ajax&module=bt_map"
           "&format=json&Itemid=101&method=")
USER_AGENT = "pixel-campus-map/0.1 (student project)"
MAX_STOPS = 60          # cap the fan-out so one click cannot hammer BT
TIMEOUT = 20


def bt_get(method, **params):
    url = BT_BASE + method
    for k, v in params.items():
        url += f"&{k}={urllib.parse.quote(str(v))}"
    r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    r.raise_for_status()
    body = r.json()
    return body.get("data") if isinstance(body, dict) else body


def departures(stop_code, trips=3):
    """BT only answers this one as a POST; a GET returns an empty list."""
    r = requests.post(
        BT_BASE + "getNextDeparturesForStop",
        data={"stopCode": stop_code, "numOfTrips": trips},
        headers={"User-Agent": USER_AGENT},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    body = r.json()
    return body.get("data") or []


def handle_api(query):
    """Shared shape with api/bt.js -- keep the two in step."""
    method = query.get("method", [""])[0]

    if method == "departures":
        codes = [c for c in query.get("stops", [""])[0].split(",") if c][:MAX_STOPS]
        trips = int(query.get("trips", ["3"])[0])
        out = {}
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(departures, c, trips): c for c in codes}
            for fut, code in futures.items():
                try:
                    out[code] = fut.result()
                except Exception:
                    out[code] = []
        return {"data": out}

    if method in ("getBuses", "getRoutes", "getRoutePatterns", "getActiveAlerts"):
        return {"data": bt_get(method)}

    if method == "getPatternPoints":
        name = query.get("patternName", [""])[0]
        return {"data": bt_get("getPatternPoints", patternName=name)}

    return {"error": "unknown method: " + method, "_status": 400}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/bt":
            try:
                payload = handle_api(urllib.parse.parse_qs(parsed.query))
                code = payload.pop("_status", 200)
            except Exception as exc:                      # upstream hiccup
                payload = {"error": f"{type(exc).__name__}: {exc}"}
                code = 502
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/bt" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"http://localhost:{PORT}  (no-store, /api/bt proxied to ridebt.org)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
