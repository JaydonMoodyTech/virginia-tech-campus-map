#!/usr/bin/env python3
"""Generate a placeholder 16x16 tile spritesheet."""
import struct, zlib

TILE = 16

# Tile index -> (base color, accent color)
TILES = [
    ((74, 122, 58),  (94, 142, 70)),    # 0 grass
    ((194, 168, 120),(174, 148, 100)),  # 1 path
    ((107, 107, 107),(87, 87, 87)),     # 2 road
    ((143, 74, 58),  (163, 94, 74)),    # 3 building
    ((58, 110, 165), (78, 130, 185)),   # 4 water
    ((46, 84, 46),   (36, 64, 36)),     # 5 tree
]

W, H = TILE * len(TILES), TILE
rows = []
for y in range(H):
    row = bytearray([0])  # PNG filter byte
    for i, (base, accent) in enumerate(TILES):
        for x in range(TILE):
            use_accent = (x + y) % 7 == 0 or (i == 3 and (x % 8 == 0 or y % 8 == 0))
            row += bytes(accent if use_accent else base)
    rows.append(bytes(row))

raw = b"".join(rows)

def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

with open("assets/tiles.png", "wb") as f:
    f.write(png)

print(f"Wrote assets/tiles.png ({W}x{H}, {len(TILES)} tiles)")
