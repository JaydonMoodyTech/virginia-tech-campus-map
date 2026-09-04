#!/usr/bin/env python3
"""Generate the 16x16 tile spritesheet, Stardew-Valley style.

The look comes from four rules, applied to every tile:
  1. A warm, slightly desaturated palette -- no pure greys, no pure black.
  2. Three shades per material: base, shadow, highlight. Never two.
  3. Hand-placed detail (tufts, pebbles, shingle rows) rather than noise,
     so the eye reads texture instead of static.
  4. Dark warm outlines on anything that is an object rather than ground.

Each tile id gets several variants, laid out left-to-right; the renderer
picks one per cell from a hash of its coordinates so large areas of grass
or roof do not visibly repeat.

Sheet layout: column = variant, row = tile id.
"""
import random, struct, zlib

TILE = 16
VARIANTS = 8   # 4 left a visible lattice: every variant-2 cell carried an
               # identically-placed skylight, so the repeat read as a grid

# --- Palette ----------------------------------------------------------
GRASS_BASE, GRASS_DARK, GRASS_LIGHT = (112, 164, 76), (92, 142, 60), (140, 188, 100)
LAWN_BASE, LAWN_ALT, LAWN_LIGHT = (132, 182, 90), (120, 170, 80), (156, 200, 112)
PITCH_BASE, PITCH_ALT = (104, 158, 70), (90, 144, 62)

DIRT_BASE, DIRT_DARK, DIRT_LIGHT = (178, 140, 96), (150, 114, 74), (202, 170, 126)
PEBBLE, PEBBLE_TOP = (128, 96, 64), (196, 164, 122)

STONE_BASE, STONE_DARK, STONE_LIGHT = (178, 174, 162), (144, 140, 130), (202, 198, 188)
ASPHALT, ASPHALT_D, ASPHALT_L = (110, 108, 112), (94, 92, 96), (128, 126, 130)
LOT_BASE, LOT_LINE = (96, 94, 100), (206, 198, 146)

ROOF_BASE, ROOF_DARK, ROOF_LIGHT = (170, 92, 64), (140, 70, 48), (194, 116, 84)
EDGE_BASE, EDGE_DARK, EDGE_LIGHT = (104, 54, 38), (74, 38, 28), (124, 68, 48)
EDGE_RIM = (58, 32, 26)

WATER_BASE, WATER_DARK, WATER_LIGHT = (72, 140, 196), (52, 112, 168), (128, 188, 226)

CANOPY, CANOPY_D, CANOPY_L = (56, 102, 48), (38, 76, 36), (86, 138, 66)
HEDGE_BASE, HEDGE_D, HEDGE_L = (52, 94, 46), (34, 66, 32), (78, 124, 58)

FLOWERS = [(214, 86, 96), (240, 206, 94), (238, 238, 232), (198, 128, 200)]


def blank(color):
    return [[color for _ in range(TILE)] for _ in range(TILE)]


def put(px, x, y, color):
    if 0 <= x < TILE and 0 <= y < TILE:
        px[y][x] = color


# --- Painters ---------------------------------------------------------
def grass(v, rng):
    px = blank(GRASS_BASE)
    for _ in range(rng.randint(5, 8)):          # blades: 2px verticals
        x, y = rng.randrange(TILE), rng.randrange(TILE)
        put(px, x, y, GRASS_DARK)
        put(px, x, y + 1, GRASS_DARK)
    for _ in range(rng.randint(4, 7)):          # sun-caught tips
        put(px, rng.randrange(TILE), rng.randrange(TILE), GRASS_LIGHT)
    if v in (3, 6):                             # some variants get a tuft
        cx, cy = rng.randrange(3, 12), rng.randrange(3, 12)
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, -1), (0, 1)):
            put(px, cx + dx, cy + dy, GRASS_DARK)
        put(px, cx, cy - 1, GRASS_LIGHT)
    return px


def lawn(v, rng):
    """Mown turf: the Drillfield and the quads. Stripes, like a real mow."""
    px = blank(LAWN_BASE)
    band = 4 if v % 2 == 0 else 8
    for y in range(TILE):
        if (y // band) % 2 == 1:
            for x in range(TILE):
                px[y][x] = LAWN_ALT
    for _ in range(rng.randint(2, 4)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), LAWN_LIGHT)
    return px


def pitch(v, rng):
    px = blank(PITCH_BASE)
    for y in range(TILE):
        if (y // 8) % 2 == 1:
            for x in range(TILE):
                px[y][x] = PITCH_ALT
    return px


def dirt(v, rng):
    """Footpath: packed earth, a few pebbles with a lit top edge."""
    px = blank(DIRT_BASE)
    for _ in range(rng.randint(6, 10)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), DIRT_DARK)
    for _ in range(rng.randint(4, 7)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), DIRT_LIGHT)
    for _ in range(rng.randint(1, 3)):
        x, y = rng.randrange(1, TILE - 1), rng.randrange(1, TILE - 1)
        put(px, x, y, PEBBLE)
        put(px, x + 1, y, PEBBLE)
        put(px, x, y - 1, PEBBLE_TOP)
    return px


def plaza(v, rng):
    """Paved pedestrian area: stone slabs with mortar joints."""
    px = blank(STONE_BASE)
    off = (v * 4) % 8
    for y in range(TILE):
        for x in range(TILE):
            if (y + off) % 8 == 0 or (x + (0 if (y + off) // 8 % 2 == 0 else 4)) % 8 == 0:
                px[y][x] = STONE_DARK
    for _ in range(rng.randint(3, 6)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), STONE_LIGHT)
    return px


def road(v, rng):
    px = blank(ASPHALT)
    for _ in range(rng.randint(8, 14)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), ASPHALT_D)
    for _ in range(rng.randint(5, 9)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), ASPHALT_L)
    return px


def parking(v, rng):
    """The driving aisle: plain asphalt. Markings belong to the bays.

    This used to carry a stray stall line of its own, which read as ticks
    scattered through the lane once the bays were banded in.
    """
    px = blank(LOT_BASE)
    for _ in range(rng.randint(6, 10)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), ASPHALT_D)
    for _ in range(rng.randint(2, 4)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), ASPHALT_L)
    if v == 2:                                   # worn patch
        x, y = rng.randrange(2, 11), rng.randrange(2, 11)
        for dy in range(3):
            for dx in range(4):
                put(px, x + dx, y + dy, ASPHALT_D)
    return px


# Three roof palettes: (base, dark, light, eave base, eave dark, eave
# light, eave rim). Assigned per building in tools/build_grid.py.
ROOF_PALETTES = {
    "a": ((170, 92, 64), (140, 70, 48), (194, 116, 84),
          (104, 54, 38), (74, 38, 28), (124, 68, 48), (58, 32, 26)),
    "b": ((104, 116, 132), (82, 94, 110), (128, 142, 158),
          (58, 66, 80), (42, 48, 60), (74, 84, 100), (32, 36, 46)),
    "c": ((150, 120, 78), (124, 96, 60), (176, 148, 102),
          (92, 72, 44), (66, 50, 30), (112, 90, 58), (52, 40, 24)),
}


def shingles(px, v, base, dark, light):
    """Staggered courses: lit nose, shadowed butt, offset row to row."""
    for y in range(TILE):
        stagger = 0 if (y // 4) % 2 == 0 else 3
        if y % 4 == 0:
            for x in range(TILE):
                px[y][x] = light
        elif y % 4 == 3:
            for x in range(TILE):
                px[y][x] = dark
        for x in range(TILE):
            if (x + stagger + v) % 6 == 0 and y % 4 != 0:
                px[y][x] = dark


def roof_for(style):
    def painter(v, rng):
        base, dark, light = ROOF_PALETTES[style][:3]
        px = blank(base)
        shingles(px, v, base, dark, light)
        # Rooftop clutter -- a vent on some variants, a skylight on others.
        # Real roofs are never clean, and it breaks up big flat blocks.
        if v == 1:                               # roof vent, 1 cell in 8
            x, y = rng.randrange(3, 10), rng.randrange(3, 10)
            for dy in range(3):
                for dx in range(4):
                    put(px, x + dx, y + dy, dark)
            for dx in range(4):
                put(px, x + dx, y - 1, light)
        elif v == 5:                             # skylight, 1 cell in 8
            x, y = rng.randrange(4, 11), rng.randrange(4, 11)
            for dy in range(2):
                for dx in range(3):
                    put(px, x + dx, y + dy, (188, 206, 214))   # glazing
            for dx in range(3):
                put(px, x + dx, y - 1, dark)
        return px
    return painter


def eave_for(style):
    """The eave ringing a building: the same shingles, in shadow.

    A solid dark band reads as a hole punched in the roof. Keeping the
    courses and dropping the value keeps the building one object, while
    the 2px rim gives the crisp outline Stardew relies on to separate a
    structure from the ground.
    """
    def painter(v, rng):
        _, _, _, base, dark, light, rim = ROOF_PALETTES[style]
        px = blank(base)
        shingles(px, v, base, dark, light)
        for i in range(TILE):
            for d in (0, 1):
                put(px, i, d, rim)
                put(px, i, TILE - 1 - d, rim)
                put(px, d, i, rim)
                put(px, TILE - 1 - d, i, rim)
        return px
    return painter


def parking_stall(v, rng):
    """Marked bays. The line sits at a fixed x so neighbouring cells join
    into one continuous stripe across the lot instead of dashing."""
    px = blank(LOT_BASE)
    for _ in range(rng.randint(5, 9)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), ASPHALT_D)
    for y in range(3, TILE - 1):                 # 1px line: 2px reads as a wall
        put(px, 1, y, LOT_LINE)
    for x in range(TILE):                        # kerb at the head of the bay
        put(px, x, 0, ASPHALT_L)
        put(px, x, 1, ASPHALT_D)
    return px


def water(v, rng):
    """Still water with drifting highlights, offset per variant."""
    px = blank(WATER_BASE)
    for y in range(TILE):
        for x in range(TILE):
            if (y + (x // 3) + v * 2) % 7 == 0:
                px[y][x] = WATER_DARK
    for i in range(2):
        y = (3 + i * 7 + v * 2) % TILE
        x0 = (v * 5 + i * 6) % TILE
        for dx in range(4):
            put(px, (x0 + dx) % TILE, y, WATER_LIGHT)
    return px


def tree(v, rng):
    """Dense canopy: dark base, rounded clumps, warm-lit tops."""
    px = blank(CANOPY)
    for _ in range(rng.randint(3, 5)):
        cx, cy, r = rng.randrange(TILE), rng.randrange(TILE), rng.randint(2, 4)
        for y in range(TILE):
            for x in range(TILE):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if d <= r * r:
                    px[y][x] = CANOPY_L if d <= (r - 1) ** 2 else CANOPY
    for _ in range(rng.randint(8, 14)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), CANOPY_D)
    return px


def garden(v, rng):
    px = grass(v, rng)
    for _ in range(rng.randint(3, 5)):
        x, y = rng.randrange(1, TILE - 1), rng.randrange(1, TILE - 1)
        c = rng.choice(FLOWERS)
        put(px, x, y, c)
        put(px, x + 1, y, c)
        put(px, x, y + 1, c)
        put(px, x + 1, y + 1, c)
    return px


def steps(v, rng):
    """Stone stair treads: lit nose, shadowed riser."""
    px = blank(STONE_BASE)
    for y in range(TILE):
        if y % 4 == 0:
            for x in range(TILE):
                px[y][x] = STONE_LIGHT
        elif y % 4 == 3:
            for x in range(TILE):
                px[y][x] = STONE_DARK
    return px


def hedge(v, rng):
    px = blank(HEDGE_BASE)
    for _ in range(rng.randint(10, 16)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), HEDGE_D)
    for _ in range(rng.randint(8, 12)):
        put(px, rng.randrange(TILE), rng.randrange(TILE), HEDGE_L)
    for x in range(TILE):
        if (x + v) % 3 != 0:
            put(px, x, 0, HEDGE_L)
    return px


# Row order MUST match the tile ids in tools/build_grid.py.
PAINTERS = [
    ("grass", grass), ("path", dirt), ("road", road),
    ("building", roof_for("a")), ("water", water), ("tree", tree),
    ("roof_edge", eave_for("a")), ("plaza", plaza), ("parking", parking),
    ("lawn", lawn), ("pitch", pitch), ("garden", garden), ("steps", steps),
    ("hedge", hedge),
    ("building_b", roof_for("b")), ("building_c", roof_for("c")),
    ("edge_b", eave_for("b")), ("edge_c", eave_for("c")),
    ("parking_stall", parking_stall),
]


# --- PNG --------------------------------------------------------------
def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def main():
    W, H = TILE * VARIANTS, TILE * len(PAINTERS)
    sheet = [[(0, 0, 0)] * W for _ in range(H)]

    for row, (name, painter) in enumerate(PAINTERS):
        for v in range(VARIANTS):
            rng = random.Random(hash((name, v)) & 0xFFFFFFFF)
            tile = painter(v, rng)
            for y in range(TILE):
                for x in range(TILE):
                    sheet[row * TILE + y][v * TILE + x] = tile[y][x]

    raw = b"".join(
        bytes([0]) + b"".join(bytes(c) for c in line) for line in sheet
    )
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))

    with open("assets/tiles.png", "wb") as f:
        f.write(png)

    print(f"Wrote assets/tiles.png ({W}x{H})")
    print(f"  {len(PAINTERS)} tiles x {VARIANTS} variants")
    for i, (name, _) in enumerate(PAINTERS):
        print(f"  {i:2}  {name}")


if __name__ == "__main__":
    main()
