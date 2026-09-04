# Pixel Campus

An 8-bit interactive map of Virginia Tech, built from OpenStreetMap data.

![demo](docs/demo.gif)

**[Live demo](https://your-url.vercel.app)**

## How it works
A Python pipeline queries the Overpass API for campus geometry, projects
lat/lon into Web Mercator, snaps it to a 2 m tile grid, and rasterizes
building polygons (ray casting) and paths (Bresenham) into a 2D array of
14 tile types -- roofs, eaves, lawns, dirt paths, plazas, parking, water,
trees, hedges and more. A post-pass rings every building with a shadowed
eave so structures read as solid objects.

The browser loads that array and draws it two ways. Zoomed in it blits a
16x16 spritesheet, picking one of four variants per cell from a hash of
its coordinates so grass and roofs never visibly repeat. Zoomed out it
draws a pre-built mip pyramid, where each level collapses a 2x2 block to
its highest-precedence tile so roads and buildings survive instead of
averaging into grass -- one drawImage instead of 630k fills.

The tiles are generated, not hand-drawn: `tools/make_tiles.py` paints
them procedurally in a Stardew-Valley palette.

## Controls
Opens on the whole campus. Drag to pan, click (or tap) to travel to that
spot and zoom one step closer, right-click or `-` to back out, and **FIT**
(or `F`) to return to the full-campus view. Wheel and pinch also zoom.

## Run locally
    python3 tools/fetch_osm.py
    python3 tools/build_grid.py
    python3 tools/make_tiles.py
    python3 tools/serve.py 8000

## Attribution
Map data © OpenStreetMap contributors, ODbL.
