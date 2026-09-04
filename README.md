# Pixel Campus

An 8-bit interactive map of Virginia Tech, built from OpenStreetMap data.

![demo](docs/demo.gif)

**[Live demo](https://your-url.vercel.app)**

## How it works
A Python pipeline queries the Overpass API for campus geometry, projects
lat/lon into Web Mercator, snaps it to a 4 m tile grid, and rasterizes
building polygons (ray casting) and paths (Bresenham) into a 2D array.
The browser loads that array and renders it to a canvas with viewport
culling, so only on-screen tiles are drawn.

## Controls
Opens on the whole campus. Drag to pan, click (or tap) to travel to that
spot and zoom one step closer, right-click or `-` to back out, and **FIT**
(or `F`) to return to the full-campus view. Wheel and pinch also zoom.

## Run locally
    python3 tools/fetch_osm.py
    python3 tools/build_grid.py
    python3 -m http.server 8000

## Attribution
Map data © OpenStreetMap contributors, ODbL.
