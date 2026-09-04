#!/usr/bin/env python3
"""Fetch campus geometry from the Overpass API and cache it locally."""
import json, os, sys, time
import requests

# VT campus plus the Hethwood corridor, so the CAS/HXP/HW* routes
# fit end to end. Verify on openstreetmap.org and adjust.
SOUTH, WEST, NORTH, EAST = 37.2110, -80.4570, 37.2360, -80.4130

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OUT_PATH = "raw/osm_dump.json"
USER_AGENT = "pixel-campus-map/0.1 (student project)"

QUERY = f"""
[out:json][timeout:180];
(
  way["building"]({SOUTH},{WEST},{NORTH},{EAST});
  way["highway"~"footway|path|pedestrian|steps|service|residential|tertiary|secondary|primary|track|cycleway"]({SOUTH},{WEST},{NORTH},{EAST});
  way["natural"~"water|wood|scrub|wetland"]({SOUTH},{WEST},{NORTH},{EAST});
  way["waterway"~"stream|river|ditch"]({SOUTH},{WEST},{NORTH},{EAST});
  way["leisure"~"park|pitch|garden|playground|track"]({SOUTH},{WEST},{NORTH},{EAST});
  way["landuse"~"forest|grass|meadow|recreation_ground|farmland"]({SOUTH},{WEST},{NORTH},{EAST});
  way["amenity"="parking"]({SOUTH},{WEST},{NORTH},{EAST});
  way["barrier"~"hedge|fence|wall"]({SOUTH},{WEST},{NORTH},{EAST});
  node["natural"="tree"]({SOUTH},{WEST},{NORTH},{EAST});
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
    counts = {}
    for e in elements:
        tags = e.get("tags", {})
        for key in ("building", "highway", "natural", "waterway", "leisure",
                    "landuse", "amenity", "barrier"):
            if key in tags:
                counts[key] = counts.get(key, 0) + 1
                break
    print(f"Wrote {OUT_PATH}: {len(elements)} elements")
    for key in sorted(counts, key=lambda k: -counts[k]):
        print(f"  {key:10} {counts[key]}")


if __name__ == "__main__":
    main()
