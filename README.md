# Pixel Campus

An 8-bit interactive map of Virginia Tech, built from OpenStreetMap data.

![demo](docs/demo.gif)

**[Live demo](https://your-url.vercel.app)**

## How it works
A Python pipeline queries the Overpass API for campus geometry, projects
lat/lon into Web Mercator, snaps it to a 2 m tile grid, and rasterizes
building polygons (ray casting) and paths (Bresenham) into a 2D array of
19 tile types -- three roof palettes and their matching eaves, lawns,
dirt paths, plazas, parking bays and aisles, water, trees, hedges. A post-pass rings every building with a shadowed
eave so structures read as solid objects.

The browser loads that array and draws it two ways. Zoomed in it blits a
16x16 spritesheet, picking one of four variants per cell from a hash of
its coordinates so grass and roofs never visibly repeat. Zoomed out it
draws a pre-built mip pyramid, where each level collapses a 2x2 block to
its highest-precedence tile so roads and buildings survive instead of
averaging into grass -- one drawImage instead of 630k fills.

The tiles are generated, not hand-drawn: `tools/make_tiles.py` paints
them procedurally in a Stardew-Valley palette.

## Live bus tracking
Press **BUS** (or `B`) to open the Blacksburg Transit panel: pick one of
23 routes, and its stops appear as a timeline in the route's own colour,
each with the next expected departure and a countdown. The route shape,
its stops and every bus currently running on it are drawn on the map, and
clicking a stop flies there. Times refresh every 30s, vehicles every 15s.

Route, stop and shape data is baked into `data/transit.json` at build
time. Live times and vehicle positions come through `/api/bt` --
`api/bt.js` on Vercel, `tools/serve.py` locally. The proxy exists because
BT's endpoints send no CORS header, not because anything needs a key;
there are still no API keys in this project. Without the proxy the panel
degrades to stops without times rather than breaking.

## Controls
Opens on the whole campus. Drag to pan, click (or tap) to travel to that
spot and zoom one step closer, right-click or `-` to back out, and **FIT**
(or `F`) to return to the full-campus view. Wheel and pinch also zoom.

## Run locally
    python3 tools/fetch_osm.py
    python3 tools/build_grid.py
    python3 tools/make_tiles.py
    python3 tools/fetch_transit.py
    python3 tools/serve.py 8000

## Attribution
Map data © OpenStreetMap contributors, ODbL.
