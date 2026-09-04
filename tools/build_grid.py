#!/usr/bin/env python3
"""Project OSM geometry into an 8-bit tile grid."""
import json, math, os

# --- Config -----------------------------------------------------------
SOUTH, WEST, NORTH, EAST = 37.2200, -80.4290, 37.2360, -80.4130
METERS_PER_TILE = 4.0

IN_PATH = "raw/osm_dump.json"
OUT_PATH = "data/campus.json"

GRASS, PATH, ROAD, BUILDING, WATER, TREE = 0, 1, 2, 3, 4, 5

# Higher wins when two features claim the same cell.
PRECEDENCE = {GRASS: 0, WATER: 1, TREE: 2, PATH: 3, ROAD: 4, BUILDING: 5}

EARTH_RADIUS = 6378137.0  # WGS84 semi-major axis, metres

ROAD_TAGS = {"service", "residential", "tertiary", "secondary", "primary"}
PATH_TAGS = {"footway", "path", "pedestrian", "steps"}


# --- Web Mercator (EPSG:3857) ----------------------------------------
def lonlat_to_mercator(lon, lat):
    """Return (x, y) in metres. y increases NORTHWARD."""
    x = EARTH_RADIUS * math.radians(lon)
    lat = max(min(lat, 85.05112878), -85.05112878)
    y = EARTH_RADIUS * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


# Grid origin is the NORTHWEST corner: col grows east, row grows south.
ORIGIN_X, ORIGIN_Y = lonlat_to_mercator(WEST, NORTH)
FAR_X, FAR_Y = lonlat_to_mercator(EAST, SOUTH)

# Mercator overstates ground distance by 1/cos(latitude). Correct for it
# so METERS_PER_TILE means real metres on the ground.
MID_LAT = math.radians((NORTH + SOUTH) / 2)
SCALE_CORRECTION = 1.0 / math.cos(MID_LAT)
UNITS_PER_TILE = METERS_PER_TILE * SCALE_CORRECTION

WIDTH = int((FAR_X - ORIGIN_X) / UNITS_PER_TILE)
HEIGHT = int((ORIGIN_Y - FAR_Y) / UNITS_PER_TILE)


def lonlat_to_cell(lon, lat):
    """Return (col, row) as floats. Row 0 is the north edge."""
    x, y = lonlat_to_mercator(lon, lat)
    return (x - ORIGIN_X) / UNITS_PER_TILE, (ORIGIN_Y - y) / UNITS_PER_TILE


# --- Rasterization ----------------------------------------------------
def point_in_polygon(col, row, poly):
    """Ray casting. poly is a list of (col, row) tuples."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        ci, ri = poly[i]
        cj, rj = poly[j]
        if (ri > row) != (rj > row):
            x_int = (cj - ci) * (row - ri) / (rj - ri) + ci
            if col < x_int:
                inside = not inside
        j = i
    return inside


def fill_polygon(grid, poly, tile_id):
    """Fill every cell whose centre lies inside poly."""
    if len(poly) < 3:
        return
    min_c = max(0, int(min(p[0] for p in poly)))
    max_c = min(WIDTH - 1, int(max(p[0] for p in poly)) + 1)
    min_r = max(0, int(min(p[1] for p in poly)))
    max_r = min(HEIGHT - 1, int(max(p[1] for p in poly)) + 1)

    for row in range(min_r, max_r + 1):
        for col in range(min_c, max_c + 1):
            if point_in_polygon(col + 0.5, row + 0.5, poly):
                paint(grid, col, row, tile_id)

    # Always stroke the outline so thin buildings never vanish entirely.
    stroke_line_string(grid, poly, tile_id)


def bresenham(c0, r0, c1, r1):
    """Integer line between two cells."""
    cells = []
    dc, dr = abs(c1 - c0), abs(r1 - r0)
    sc = 1 if c0 < c1 else -1
    sr = 1 if r0 < r1 else -1
    err = dc - dr
    while True:
        cells.append((c0, r0))
        if c0 == c1 and r0 == r1:
            break
        e2 = 2 * err
        if e2 > -dr:
            err -= dr
            c0 += sc
        if e2 < dc:
            err += dc
            r0 += sr
    return cells


def stroke_line_string(grid, pts, tile_id, thickness=1):
    for i in range(len(pts) - 1):
        c0, r0 = int(pts[i][0]), int(pts[i][1])
        c1, r1 = int(pts[i + 1][0]), int(pts[i + 1][1])
        for col, row in bresenham(c0, r0, c1, r1):
            for dc in range(-(thickness // 2), thickness // 2 + 1):
                for dr in range(-(thickness // 2), thickness // 2 + 1):
                    paint(grid, col + dc, row + dr, tile_id)


def paint(grid, col, row, tile_id):
    if 0 <= col < WIDTH and 0 <= row < HEIGHT:
        if PRECEDENCE[tile_id] >= PRECEDENCE[grid[row][col]]:
            grid[row][col] = tile_id


# --- Classification ---------------------------------------------------
def classify(tags):
    """Return (tile_id, is_area) or None to skip."""
    if "building" in tags:
        return BUILDING, True
    if tags.get("natural") == "water" or tags.get("waterway"):
        return WATER, True
    if tags.get("leisure") in ("park", "pitch", "garden"):
        return TREE, True
    hw = tags.get("highway")
    if hw in PATH_TAGS:
        return PATH, False
    if hw in ROAD_TAGS:
        return ROAD, False
    return None


# --- Main -------------------------------------------------------------
def main():
    with open(IN_PATH) as f:
        data = json.load(f)

    grid = [[GRASS] * WIDTH for _ in range(HEIGHT)]
    labels = []
    counts = {}

    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        result = classify(tags)
        if not result:
            continue
        tile_id, is_area = result

        pts = [lonlat_to_cell(n["lon"], n["lat"]) for n in el["geometry"]]
        if not pts:
            continue

        if is_area:
            fill_polygon(grid, pts, tile_id)
        else:
            thickness = 2 if tile_id == ROAD else 1
            stroke_line_string(grid, pts, tile_id, thickness)

        counts[tile_id] = counts.get(tile_id, 0) + 1

        name = tags.get("name")
        if name and tile_id == BUILDING:
            labels.append({
                "name": name,
                "col": int(sum(p[0] for p in pts) / len(pts)),
                "row": int(sum(p[1] for p in pts) / len(pts)),
            })

    os.makedirs("data", exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({
            "width": WIDTH,
            "height": HEIGHT,
            "tile_size_m": METERS_PER_TILE,
            "bbox": {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST},
            "grid": grid,
            "labels": labels,
        }, f, separators=(",", ":"))

    print(f"Grid: {WIDTH}x{HEIGHT} @ {METERS_PER_TILE}m/tile")
    print(f"Features: {counts}")
    print(f"Labels: {len(labels)}")
    print(f"Wrote {OUT_PATH}")

    # ASCII sanity dump — verify BEFORE trying to render.
    chars = {GRASS: ".", PATH: "-", ROAD: "=", BUILDING: "#", WATER: "~", TREE: "*"}
    step = max(1, WIDTH // 100)
    print("\n--- preview ---")
    for row in range(0, HEIGHT, step * 2):
        print("".join(chars[grid[row][c]] for c in range(0, WIDTH, step)))


if __name__ == "__main__":
    main()
