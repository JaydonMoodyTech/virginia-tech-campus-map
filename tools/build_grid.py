#!/usr/bin/env python3
"""Project OSM geometry into an 8-bit tile grid."""
import base64, json, math, os

# --- Config -----------------------------------------------------------
SOUTH, WEST, NORTH, EAST = 37.2110, -80.4570, 37.2360, -80.4130
METERS_PER_TILE = 2.0

IN_PATH = "raw/osm_dump.json"
OUT_PATH = "data/campus.json"

# Tile ids. Must stay in sync with tools/make_tiles.py and TILE_COLORS
# in main.js.
GRASS, PATH, ROAD, BUILDING, WATER, TREE, ROOF_EDGE = 0, 1, 2, 3, 4, 5, 6
PLAZA, PARKING, LAWN, PITCH, GARDEN, STEPS, HEDGE = 7, 8, 9, 10, 11, 12, 13
# Appended rather than renumbered, so existing ids keep their meaning.
BUILDING_B, BUILDING_C, EDGE_B, EDGE_C, PARKING_STALL = 14, 15, 16, 17, 18

# Three roof palettes, picked per building so a campus block is not one
# flat sheet of the same red. The choice is stable across rebuilds.
ROOF_STYLES = [BUILDING, BUILDING_B, BUILDING_C]
EDGE_FOR = {BUILDING: ROOF_EDGE, BUILDING_B: EDGE_B, BUILDING_C: EDGE_C}
BUILDINGS = set(EDGE_FOR)
EDGES = set(EDGE_FOR.values())

# Parking is laid out in bands: STALL_DEPTH rows of marked bays, then the
# same again of clear aisle, which is what a real lot looks like from above.
STALL_DEPTH = 3

TILE_NAMES = {
    GRASS: "grass", PATH: "path", ROAD: "road", BUILDING: "building",
    WATER: "water", TREE: "tree", ROOF_EDGE: "roof_edge", PLAZA: "plaza",
    PARKING: "parking", LAWN: "lawn", PITCH: "pitch", GARDEN: "garden",
    STEPS: "steps", HEDGE: "hedge", BUILDING_B: "building_b",
    BUILDING_C: "building_c", EDGE_B: "edge_b", EDGE_C: "edge_c",
    PARKING_STALL: "parking_stall",
}

# Higher wins when two features claim the same cell.
PRECEDENCE = {
    GRASS: 0, LAWN: 1, PITCH: 2, GARDEN: 3, WATER: 4, TREE: 5, HEDGE: 6,
    PARKING: 7, PLAZA: 8, PATH: 9, STEPS: 10, ROAD: 11, BUILDING: 12,
    ROOF_EDGE: 13,
    BUILDING_B: 12, BUILDING_C: 12, EDGE_B: 13, EDGE_C: 13,
    PARKING_STALL: 7,
}

LABEL_KINDS = {BUILDING: "building", LAWN: "park", WATER: "water",
               PITCH: "field", GARDEN: "garden"}

EARTH_RADIUS = 6378137.0  # WGS84 semi-major axis, metres

# Stroke width in cells, by highway value. At 2 m per tile these are
# roughly true to the ground: a service road is ~4 m, an arterial ~10 m.
ROAD_WIDTHS = {
    "primary": 5, "primary_link": 4, "secondary": 4, "secondary_link": 3,
    "tertiary": 4, "tertiary_link": 3, "residential": 3, "service": 2,
    "track": 2,
}
# Which filled areas get a name label, and what to call that kind.
LABELLED = LABEL_KINDS

# Label tiers by footprint rank: the biggest TIER_LARGE features show at
# the overview, the next TIER_MEDIUM once mid-zoomed, the rest up close.
TIER_LARGE, TIER_MEDIUM = 18, 70

PATH_WIDTHS = {
    "pedestrian": 3, "footway": 2, "path": 1, "cycleway": 2, "steps": 2,
}


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


def stroke_line_string(grid, pts, tile_id, width=1):
    """Stroke a polyline `width` cells across."""
    lo, hi = -(width // 2), (width + 1) // 2
    for i in range(len(pts) - 1):
        c0, r0 = int(pts[i][0]), int(pts[i][1])
        c1, r1 = int(pts[i + 1][0]), int(pts[i + 1][1])
        for col, row in bresenham(c0, r0, c1, r1):
            for dc in range(lo, hi):
                for dr in range(lo, hi):
                    paint(grid, col + dc, row + dr, tile_id)


def stamp_disc(grid, col, row, radius, tile_id):
    """Paint a filled disc -- used for individual mapped trees."""
    for dr in range(-radius, radius + 1):
        for dc in range(-radius, radius + 1):
            if dc * dc + dr * dr <= radius * radius + 1:
                paint(grid, col + dc, row + dr, tile_id)


def polygon_area(pts):
    """Shoelace area in cells. Used to rank how prominent a label is."""
    total = 0.0
    n = len(pts)
    for i in range(n):
        c0, r0 = pts[i]
        c1, r1 = pts[(i + 1) % n]
        total += c0 * r1 - c1 * r0
    return abs(total) / 2.0


def paint(grid, col, row, tile_id):
    if 0 <= col < WIDTH and 0 <= row < HEIGHT:
        if PRECEDENCE[tile_id] >= PRECEDENCE[grid[row][col]]:
            grid[row][col] = tile_id


def outline_buildings(grid):
    """Convert the outer ring of each building to its matching eave.

    Stardew's structures read as solid because every roof carries a dark
    border. Doing it here as a post-pass means the renderer stays a dumb
    blitter and the border never breaks across chunk seams. Each roof
    style keeps its own eave so the border matches the roof it rings.
    """
    edges = []
    for row in range(HEIGHT):
        line = grid[row]
        for col in range(WIDTH):
            style = line[col]
            if style not in BUILDINGS:
                continue
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                c, r = col + dc, row + dr
                inside = (0 <= c < WIDTH and 0 <= r < HEIGHT and
                          (grid[r][c] in BUILDINGS or grid[r][c] in EDGES))
                if not inside:
                    edges.append((col, row, EDGE_FOR[style]))
                    break
    for col, row, edge in edges:
        grid[row][col] = edge
    return len(edges)


def stripe_parking(grid):
    """Turn flat asphalt into alternating parking bays and driving aisles.

    Bay orientation is not in the OSM data, so deriving the bands from the
    row index is the honest approximation: it gives a lot the striped
    rhythm you see from above without inventing a layout per lot.
    """
    n = 0
    for row in range(HEIGHT):
        if (row // STALL_DEPTH) % 2:
            continue                      # this band is the driving aisle
        line = grid[row]
        for col in range(WIDTH):
            if line[col] == PARKING:
                line[col] = PARKING_STALL
                n += 1
    return n


# --- Classification ---------------------------------------------------
def classify(tags):
    """Return (tile_id, is_area, width) or None to skip."""
    if "building" in tags:
        return BUILDING, True, 0

    natural = tags.get("natural")
    if natural == "water" or natural == "wetland" or "waterway" in tags:
        is_area = natural in ("water", "wetland")
        return WATER, is_area, 2
    if natural in ("wood", "scrub") or tags.get("landuse") == "forest":
        return TREE, True, 0

    leisure = tags.get("leisure")
    if leisure in ("pitch", "track"):
        return PITCH, True, 0
    if leisure in ("park", "playground"):
        return LAWN, True, 0          # the Drillfield and the quads
    if leisure == "garden":
        return GARDEN, True, 0

    if tags.get("landuse") in ("grass", "meadow", "recreation_ground", "farmland"):
        return LAWN, True, 0
    if tags.get("amenity") == "parking":
        return PARKING, True, 0
    if tags.get("barrier") in ("hedge", "fence", "wall"):
        return HEDGE, False, 1

    hw = tags.get("highway")
    if hw == "steps":
        return STEPS, False, PATH_WIDTHS["steps"]
    if hw == "pedestrian":
        return PLAZA, False, PATH_WIDTHS["pedestrian"]
    if hw in PATH_WIDTHS:
        return PATH, False, PATH_WIDTHS[hw]
    if hw in ROAD_WIDTHS:
        return ROAD, False, ROAD_WIDTHS[hw]
    return None


# --- Main -------------------------------------------------------------
def main():
    with open(IN_PATH) as f:
        data = json.load(f)

    grid = [[GRASS] * WIDTH for _ in range(HEIGHT)]
    labels = []
    counts = {}
    trees = 0

    elements = data.get("elements", [])

    # Ways first, then tree nodes on top, so a tree beside a path still
    # shows rather than being buried by the path stroke.
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        result = classify(tags)
        if not result:
            continue
        tile_id, is_area, width = result

        pts = [lonlat_to_cell(n["lon"], n["lat"]) for n in el["geometry"]]
        if not pts:
            continue

        if tile_id == BUILDING:
            key = tags.get("name") or str(el.get("id", len(labels)))
            tile_id = ROOF_STYLES[hash(key) % len(ROOF_STYLES)]

        if is_area:
            fill_polygon(grid, pts, tile_id)
        else:
            stroke_line_string(grid, pts, tile_id, width)

        counts[tile_id] = counts.get(tile_id, 0) + 1

        name = tags.get("name")
        if tile_id in BUILDINGS:
            tile_id = BUILDING          # one label kind for all roof styles
        if name and is_area and tile_id in LABELLED:
            labels.append({
                "name": name,
                "col": int(sum(p[0] for p in pts) / len(pts)),
                "row": int(sum(p[1] for p in pts) / len(pts)),
                "kind": LABELLED[tile_id],
                "area": round(polygon_area(pts)),
            })

    for el in elements:
        if el.get("type") != "node" or el.get("tags", {}).get("natural") != "tree":
            continue
        col, row = lonlat_to_cell(el["lon"], el["lat"])
        stamp_disc(grid, int(col), int(row), 2, TREE)   # ~8 m canopy
        trees += 1

    # Rank labels by footprint and bucket them into zoom tiers, so the
    # Drillfield and Burruss are readable from the whole-campus view while
    # a 200 sq m annex only appears once you are close enough to care.
    labels.sort(key=lambda l: -l["area"])
    for rank, lab in enumerate(labels):
        if rank < TIER_LARGE:
            lab["minPx"] = 2          # visible from the overview
        elif rank < TIER_MEDIUM:
            lab["minPx"] = 8
        else:
            lab["minPx"] = 16         # only once zoomed right in
        del lab["area"]

    edge_cells = outline_buildings(grid)
    stall_cells = stripe_parking(grid)

    os.makedirs("data", exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({
            "width": WIDTH,
            "height": HEIGHT,
            "tile_size_m": METERS_PER_TILE,
            "bbox": {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST},
            # One byte per cell, base64'd. As nested JSON arrays this
            # same grid is 6.8 MB and costs a multi-second parse; packed
            # it is 3.6 MB of highly compressible text that decodes into
            # a Uint8Array in one pass.
            "encoding": "u8-base64",
            "grid": base64.b64encode(
                b"".join(bytes(row) for row in grid)).decode("ascii"),
            "labels": labels,
        }, f, separators=(",", ":"))

    size_mb = os.path.getsize(OUT_PATH) / 1e6
    print(f"Grid: {WIDTH}x{HEIGHT} @ {METERS_PER_TILE}m/tile")
    print(f"Ways: " + ", ".join(f"{TILE_NAMES[k]}={v}" for k, v in sorted(counts.items())))
    print(f"Trees: {trees}   Roof-edge cells: {edge_cells}   "
          f"Stall cells: {stall_cells}   Labels: {len(labels)}")
    print(f"Wrote {OUT_PATH} ({size_mb:.2f} MB)")

    # ASCII sanity dump -- verify BEFORE trying to render.
    chars = {GRASS: ".", PATH: "-", ROAD: "=", BUILDING: "#", WATER: "~",
             TREE: "*", ROOF_EDGE: "@", PLAZA: "+", PARKING: "P", LAWN: ",",
             PITCH: "\"", GARDEN: "%", STEPS: "s", HEDGE: "h",
             BUILDING_B: "#", BUILDING_C: "#", EDGE_B: "@", EDGE_C: "@",
             PARKING_STALL: "p"}
    step = max(1, WIDTH // 100)
    print("\n--- preview ---")
    for row in range(0, HEIGHT, step * 2):
        print("".join(chars[grid[row][c]] for c in range(0, WIDTH, step)))


if __name__ == "__main__":
    main()
