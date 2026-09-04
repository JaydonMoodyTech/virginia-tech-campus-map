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
- Constants in SCREAMING_SNAKE at the top of each file.

## Commands
- Local server: `python3 -m http.server 8000`
- Controls: drag pans, click travels + zooms in, right-click zooms out,
  wheel/pinch zooms, `+` `-` `F`/`0` keys, and the on-screen buttons.
- Refetch OSM: `python3 tools/fetch_osm.py`
- Rebuild grid: `python3 tools/build_grid.py`

## Never
- Commit anything in `raw/` (large API dumps).
- Call the Overpass API at page load. It is a build-time step only.
- Add a JS dependency without asking.
