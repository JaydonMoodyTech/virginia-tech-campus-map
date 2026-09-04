#!/usr/bin/env python3
"""Fetch Blacksburg Transit routes, patterns and stops into data/transit.json.

BT's live map is a Joomla module backed by com_ajax endpoints. They are
public and keyless, but they send no Access-Control-Allow-Origin, so the
browser cannot call them directly -- see tools/serve.py and api/bt.js for
the proxy that handles the live half.

Everything that does not change minute to minute (routes, the stops on
each pattern, the shape of each pattern) is baked out here at build time
so the page has something to draw before any network call succeeds.
"""
import json, os, sys, time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_grid  # reuse the exact projection the map grid was built with

BASE = ("https://ridebt.org/index.php?option=com_ajax&module=bt_map"
        "&format=json&Itemid=101&method=")
OUT_PATH = "data/transit.json"

# The routes this map covers. The campus bbox in build_grid.py is sized to
# hold these end to end -- widen both together if you add one.
ROUTES = ["CAS", "HXP", "HWA", "HWB", "HWC"]
USER_AGENT = "pixel-campus-map/0.1 (student project)"


def call(method, **params):
    url = BASE + method
    for k, v in params.items():
        url += f"&{k}={v}"
    for attempt in range(1, 4):
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
        if resp.status_code == 200:
            body = resp.json()
            return body.get("data") if isinstance(body, dict) else body
        print(f"  {method}: HTTP {resp.status_code}, retry {attempt}/3")
        time.sleep(5 * attempt)
    raise SystemExit(f"{method} failed after 3 attempts")


def main():
    print("Fetching routes...")
    routes_raw = call("getRoutes")
    print("Fetching patterns...")
    patterns_raw = call("getRoutePatterns")

    # Global stop table; patterns reference stops by index.
    stops = []
    stop_index = {}

    def stop_id(point):
        code = point.get("stopCode")
        if code in stop_index:
            return stop_index[code]
        lat, lon = float(point["latitude"]), float(point["longitude"])
        col, row = build_grid.lonlat_to_cell(lon, lat)
        stop_index[code] = len(stops)
        stops.append({
            "code": code,
            "name": point.get("patternPointName", "").strip(),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "col": round(col, 1),
            "row": round(row, 1),
            # A timepoint is a scheduled stop BT publishes times against.
            "timed": point.get("isTimePoint") == "Y",
        })
        return stop_index[code]

    by_route = {}
    for pat in patterns_raw:
        by_route.setdefault(pat["routeId"], []).append(pat["name"])

    routes = []
    total_patterns = 0
    for route_id, entries in routes_raw.items():
        if route_id not in ROUTES:
            continue
        info = entries[0] if isinstance(entries, list) else entries
        patterns = []
        for name in by_route.get(route_id, []):
            print(f"  pattern {name}")
            try:
                points = call("getPatternPoints", patternName=name.replace(" ", "%20"))
            except SystemExit:
                print(f"    skipped {name}")
                continue
            if not points:
                continue
            path, stop_ids = [], []
            for p in points:
                if not p.get("latitude") or not p.get("longitude"):
                    continue
                lat, lon = float(p["latitude"]), float(p["longitude"])
                col, row = build_grid.lonlat_to_cell(lon, lat)
                path.append([round(col, 1), round(row, 1)])
                if p.get("isBusStop") == "Y" and p.get("stopCode"):
                    stop_ids.append(stop_id(p))
            if not stop_ids:
                continue
            patterns.append({"name": name, "stops": stop_ids, "path": path})
            total_patterns += 1

        if not patterns:
            continue
        routes.append({
            "id": route_id,
            "name": info.get("routeName", route_id),
            "short": info.get("routeShortName", route_id),
            "color": "#" + (info.get("routeColor") or "888888"),
            "text": "#" + (info.get("routeTextColor") or "FFFFFF"),
            "service": info.get("routeServiceLevel", ""),
            "patterns": patterns,
        })

    routes.sort(key=lambda r: ROUTES.index(r["id"]))

    os.makedirs("data", exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({
            "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "grid": {"width": build_grid.WIDTH, "height": build_grid.HEIGHT},
            "stops": stops,
            "routes": routes,
        }, f, separators=(",", ":"))

    on_map = sum(1 for s in stops
                 if 0 <= s["col"] < build_grid.WIDTH and 0 <= s["row"] < build_grid.HEIGHT)
    size_kb = os.path.getsize(OUT_PATH) / 1000
    print(f"\nWrote {OUT_PATH} ({size_kb:.0f} KB)")
    print(f"  {len(routes)} routes ({', '.join(r['id'] for r in routes)}), "
          f"{total_patterns} patterns")
    print(f"  {len(stops)} stops ({on_map} inside the campus grid)")


if __name__ == "__main__":
    main()
