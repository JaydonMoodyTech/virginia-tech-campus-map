#!/usr/bin/env python3
"""Fetch campus geometry from the Overpass API and cache it locally."""
import json, os, sys, time
import requests

# Virginia Tech core campus. Verify on openstreetmap.org and adjust.
SOUTH, WEST, NORTH, EAST = 37.2200, -80.4290, 37.2360, -80.4130

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OUT_PATH = "raw/osm_dump.json"
USER_AGENT = "pixel-campus-map/0.1 (student project)"

QUERY = f"""
[out:json][timeout:90];
(
  way["building"]({SOUTH},{WEST},{NORTH},{EAST});
  way["highway"~"footway|path|pedestrian|steps|service|residential|tertiary|secondary|primary"]({SOUTH},{WEST},{NORTH},{EAST});
  way["natural"="water"]({SOUTH},{WEST},{NORTH},{EAST});
  way["leisure"~"park|pitch|garden"]({SOUTH},{WEST},{NORTH},{EAST});
);
out geom;
"""


def fetch(retries=3):
    for attempt in range(1, retries + 1):
        print(f"Requesting Overpass (attempt {attempt}/{retries})...")
        resp = requests.post(
            OVERPASS_URL,
            data={"data": QUERY},
            headers={"User-Agent": USER_AGENT},
            timeout=120,
        )
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 504):
            wait = 15 * attempt
            print(f"  Rate limited ({resp.status_code}). Waiting {wait}s.")
            time.sleep(wait)
            continue
        resp.raise_for_status()
    sys.exit("Overpass failed after retries. Try again in a few minutes.")


def main():
    if os.path.exists(OUT_PATH) and "--force" not in sys.argv:
        print(f"{OUT_PATH} already exists. Use --force to refetch.")
        return

    data = fetch()
    os.makedirs("raw", exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(data, f)

    elements = data.get("elements", [])
    buildings = sum(1 for e in elements if "building" in e.get("tags", {}))
    highways = sum(1 for e in elements if "highway" in e.get("tags", {}))
    print(f"Wrote {OUT_PATH}: {len(elements)} elements "
          f"({buildings} buildings, {highways} ways)")


if __name__ == "__main__":
    main()
