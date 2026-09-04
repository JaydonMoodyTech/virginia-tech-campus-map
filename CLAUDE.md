# Campus Map — Project Conventions

## What this is
An 8-bit pixel-art interactive map of Virginia Tech, built from
OpenStreetMap data. Static site, no framework, no build step.

## Architecture
Python does all geospatial work offline and emits `data/campus.json`.
The browser only loads that JSON and draws it. Never do projection math
in JavaScript.

## Conventions
- Vanilla JS, ES modules, no dependencies, no bundler.
- Python 3.10+, stdlib only except `requests`.
- Tiles are 16x16 px. The spritesheet is only ever blitted at integer
  scale factors (16/32/48/64 px per tile). Zoom levels below 16 px per
  tile do NOT blit the sheet -- they scale a pre-rendered 1px-per-tile
  overview bitmap by an integer factor, because campus is 354x445 tiles
  and would otherwise never fit on screen.
- `ctx.imageSmoothingEnabled = false` everywhere. Non-negotiable.
- Grid coordinates are (col, row) with row 0 at the NORTH edge.
- The grid is 2 m per tile. Tile ids are defined once in
  tools/build_grid.py; tools/make_tiles.py and TILE_COLORS in main.js
  must be kept in the same order.
- Spritesheet layout is row = tile id, column = variant (19 x 8). The
  renderer picks a variant per cell by hashing (col, row) so large areas
  do not visibly repeat. Keep variants >= 8: at 4, every cell sharing a
  variant carried an identically placed skylight and the repeat read as
  a visible lattice.
- Buildings come in three roof palettes, chosen per building in
  build_grid.py, each with its own matching eave tile.
- Art direction is Stardew Valley: warm desaturated palette, three
  shades per material, hand-placed detail over noise, dark warm outlines
  on objects but never on ground.
- Constants in SCREAMING_SNAKE at the top of each file.

## Commands
- Local server: `python3 tools/serve.py 8000` (sends no-store;
  plain http.server caches main.js and campus.json and will silently
  render a stale grid after a rebuild)
- Controls: drag pans, click travels + zooms in, right-click zooms out,
  wheel/pinch zooms, `+` `-` `F`/`0` keys, and the on-screen buttons.
- Refetch OSM: `python3 tools/fetch_osm.py --force`
- Rebuild grid: `python3 tools/build_grid.py`
- Redraw tiles: `python3 tools/make_tiles.py`
- Refresh transit: `python3 tools/fetch_transit.py`

## Transit
- BT's com_ajax endpoints are public and keyless but send no CORS header,
  so the browser cannot call them directly. `api/bt.js` (Vercel) and
  `tools/serve.py` (local) expose the same `/api/bt` contract -- change
  one, change the other.
- Static route/stop/shape data is baked into `data/transit.json` at build
  time so the panel works before any live call returns.
- `getNextDeparturesForStop` only answers a POST. A GET returns an empty
  list with HTTP 200, which looks like "no service" rather than an error.

## Never
- Commit anything in `raw/` (large API dumps).
- Call the Overpass API at page load. It is a build-time step only.
- Add a JS dependency without asking.
