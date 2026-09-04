import { initTransit, drawTransit, toggleTransit, isOpen as transitOpen } from "./transit.js";

// --- Constants --------------------------------------------------------
const TILE = 16;                 // source tile size in tiles.png

// Zoom ladder, in screen pixels per grid tile (one tile = 4 m of ground).
// At or above TILE we blit the spritesheet at an integer scale (1x..4x).
// Below TILE we draw a pre-rendered flat-colour overview scaled by an
// integer factor: a 16px tile cannot shrink to 6px without smearing its
// pixels, and campus is 354x445 tiles, so these overview levels are the
// only way the whole map ever fits on screen.
const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
const SPRITE_MIN = TILE;         // at or above this, use the spritesheet
const LABEL_PAD = 3;             // px of slack when rejecting overlapping labels
const CLICK_SLOP = 6;            // px of movement still counted as a click
const PAN_MS = 320;              // click-to-centre glide

const VOID_COLOR = "#1a1c2c";    // outside the map bounds
const GRASS_COLOR = "#70a44c";   // tile 0, painted as one rect not blitted

// Base colour of each tile, for the zoomed-out overview. Must match the
// palette in tools/make_tiles.py, and the order must match the tile ids
// in tools/build_grid.py.
const TILE_COLORS = [
  [112, 164, 76],   //  0 grass
  [178, 140, 96],   //  1 path
  [110, 108, 112],  //  2 road
  [170, 92, 64],    //  3 building
  [72, 140, 196],   //  4 water
  [56, 102, 48],    //  5 tree
  [104, 54, 38],    //  6 roof_edge
  [178, 174, 162],  //  7 plaza
  [96, 94, 100],    //  8 parking
  [132, 182, 90],   //  9 lawn
  [104, 158, 70],   // 10 pitch
  [126, 172, 84],   // 11 garden
  [178, 174, 162],  // 12 steps
  [52, 94, 46],     // 13 hedge
  [104, 116, 132],  // 14 building_b  (slate roof)
  [150, 120, 78],   // 15 building_c  (weathered roof)
  [58, 66, 80],     // 16 edge_b
  [92, 72, 44],     // 17 edge_c
  [104, 102, 108],  // 18 parking_stall
];

// Mirrors PRECEDENCE in tools/build_grid.py. Used when shrinking the
// overview: a 2x2 block collapses to its most important tile, so roads
// and buildings survive at low zoom instead of dissolving into grass.
const TILE_PRECEDENCE = [0, 9, 11, 12, 4, 5, 13, 8, 7, 1, 2, 3, 10, 6,
                         12, 12, 13, 13, 7];

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

let zoomIndex = 0;
let map = null;
let sheetReady = false;
let variants = 1;                // tile variants across the spritesheet
let mips = [];                   // overview pyramid, mips[0] = 1px/tile

const camera = { x: 0, y: 0 };
const sheet = new Image();

sheet.onload = () => {
  sheetReady = true;
  variants = Math.max(1, Math.floor(sheet.width / TILE));
  requestDraw();
};
sheet.onerror = () => console.error("Failed to load assets/tiles.png");
sheet.src = "assets/tiles.png";

function pxPerTile() { return ZOOM_LEVELS[zoomIndex]; }

// --- Overview pyramid -------------------------------------------------
// The grid is 709x890 tiles, so even one screen pixel per tile does not
// fit a phone. Each level halves the previous one, collapsing every 2x2
// block to its highest-precedence tile so roads and buildings stay
// visible instead of averaging away into grass. Drawing a level is one
// drawImage rather than ~630k fillRects.
function buildMips() {
  let w = map.width, h = map.height;
  let ids = new Uint8Array(w * h);
  for (let r = 0, i = 0; r < h; r++) {
    const row = map.grid[r];
    for (let c = 0; c < w; c++) ids[i++] = row[c];
  }

  mips = [];
  for (;;) {
    mips.push(renderIds(ids, w, h));
    if (w <= 64 || h <= 64) break;
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
    const next = new Uint8Array(w2 * h2);
    for (let r = 0; r < h2; r++) {
      for (let c = 0; c < w2; c++) {
        let best = ids[(r * 2) * w + c * 2];
        for (const [dc, dr] of [[1, 0], [0, 1], [1, 1]]) {
          const sc = c * 2 + dc, sr = r * 2 + dr;
          if (sc >= w || sr >= h) continue;
          const id = ids[sr * w + sc];
          if (TILE_PRECEDENCE[id] > TILE_PRECEDENCE[best]) best = id;
        }
        next[r * w2 + c] = best;
      }
    }
    ids = next; w = w2; h = h2;
  }
}

function renderIds(ids, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c2 = cv.getContext("2d");
  const img = c2.createImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < ids.length; i++) {
    const rgb = TILE_COLORS[ids[i]] || TILE_COLORS[0];
    d[j++] = rgb[0]; d[j++] = rgb[1]; d[j++] = rgb[2]; d[j++] = 255;
  }
  c2.putImageData(img, 0, 0);
  return { canvas: cv, w: w, h: h };
}

/** Pick the mip whose natural size is closest at or above `px` per tile. */
function mipFor(px) {
  let level = 0, scale = px;
  while (scale < 1 && level < mips.length - 1) { level++; scale *= 2; }
  return { mip: mips[level], scale: scale };
}

// Deterministic per-cell variant, so grass and roofs do not visibly tile.
function variantFor(col, row) {
  let h = (col * 73856093) ^ (row * 19349663);
  h ^= h >>> 13;
  return (h >>> 0) % variants;
}

// --- Camera -----------------------------------------------------------
// When the map is smaller than the viewport on an axis it is centred and
// pinned there, so the overview sits in the middle instead of drifting.
function clampAxis(value, mapPx, viewPx) {
  if (mapPx <= viewPx) return -(viewPx - mapPx) / 2;
  return Math.min(Math.max(value, 0), mapPx - viewPx);
}

function clampCamera() {
  if (!map) return;
  const px = pxPerTile();
  camera.x = clampAxis(camera.x, map.width * px, window.innerWidth);
  camera.y = clampAxis(camera.y, map.height * px, window.innerHeight);
}

// Largest ladder index at which the whole campus still fits on screen.
function fitIndex() {
  let best = 0;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    const px = ZOOM_LEVELS[i];
    if (map.width * px <= window.innerWidth &&
        map.height * px <= window.innerHeight) best = i;
  }
  return best;
}

function fitCampus() {
  cancelPan();
  zoomIndex = fitIndex();
  clampCamera();
  requestDraw();
  updateControls();
}

// --- Rendering --------------------------------------------------------
let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(function () { drawQueued = false; draw(); });
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const wasFit = map ? zoomIndex === fitIndex() : false;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (wasFit) zoomIndex = fitIndex();   // stay fitted across window resizes
  clampCamera();
  requestDraw();
  updateControls();
}

function draw() {
  ctx.fillStyle = VOID_COLOR;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  if (!map) return;

  const px = pxPerTile();
  const ox = Math.round(-camera.x);
  const oy = Math.round(-camera.y);

  if (px < SPRITE_MIN) {
    if (!mips.length) return;
    const sel = mipFor(px);
    ctx.drawImage(sel.mip.canvas, ox, oy,
                  sel.mip.w * sel.scale, sel.mip.h * sel.scale);
    drawTransit(ctx, px, camera);
    drawLabels(px);
    return;
  }

  if (!sheetReady) return;

  // Grass is the background: paint the whole map extent once, then blit
  // only the non-grass tiles over it. Without this the skipped grass
  // blits below would leave bare VOID_COLOR showing through.
  ctx.fillStyle = GRASS_COLOR;
  ctx.fillRect(ox, oy, map.width * px, map.height * px);

  // Viewport culling: only iterate cells that are actually on screen.
  const c0 = Math.max(0, Math.floor(camera.x / px));
  const r0 = Math.max(0, Math.floor(camera.y / px));
  const c1 = Math.min(map.width - 1, Math.ceil((camera.x + window.innerWidth) / px));
  const r1 = Math.min(map.height - 1, Math.ceil((camera.y + window.innerHeight) / px));

  for (let r = r0; r <= r1; r++) {
    const rowData = map.grid[r];
    for (let c = c0; c <= c1; c++) {
      const id = rowData[c];
      if (id === 0) continue;  // grass is the background; skip the blit
      ctx.drawImage(
        sheet,
        variantFor(c, r) * TILE, id * TILE, TILE, TILE,
        Math.round(c * px - camera.x),
        Math.round(r * px - camera.y),
        px, px
      );
    }
  }

  drawTransit(ctx, px, camera);
  drawLabels(px);
}

function drawLabels(px) {
  // Two filters keep this readable. Each label carries a minPx from
  // tools/build_grid.py, ranked by footprint, so the Drillfield and
  // Burruss survive to the overview while a small annex only appears up
  // close. Whatever passes that is then placed greedily, largest first,
  // and anything overlapping an already-placed box is dropped -- without
  // it, dense blocks like the Upper Quad turn into a smear.
  const boxes = [];
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  for (const lab of map.labels) {
    if (px < lab.minPx) continue;
    const x = lab.col * px - camera.x;
    const y = lab.row * px - camera.y;
    if (x < -120 || x > window.innerWidth + 120) continue;
    if (y < -40 || y > window.innerHeight + 40) continue;

    const size = lab.minPx <= 2 ? 13 : lab.minPx <= 8 ? 12 : 11;
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
    const w = ctx.measureText(lab.name).width + 10;
    const h = size + 6;
    const box = [x - w / 2, y - h, x + w / 2, y];
    if (boxes.some(b => overlaps(b, box))) continue;
    boxes.push(box);

    ctx.fillStyle = lab.kind === "building" ? "rgba(28,22,20,0.78)" : "rgba(28,44,22,0.72)";
    roundRect(ctx, box[0], box[1], w, h, 3);
    ctx.fill();
    ctx.fillStyle = "#f4efe2";
    ctx.fillText(lab.name, x, y - 5);
  }
}

function overlaps(a, b) {
  return !(a[2] + LABEL_PAD < b[0] || a[0] - LABEL_PAD > b[2] ||
           a[3] + LABEL_PAD < b[1] || a[1] - LABEL_PAD > b[3]);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// --- Navigation -------------------------------------------------------
let panAnim = null;
function cancelPan() {
  if (panAnim) { cancelAnimationFrame(panAnim); panAnim = null; }
}

// Glide the camera to a target, so a click reads as travel not teleport.
function glideTo(tx, ty) {
  cancelPan();
  const sx = camera.x, sy = camera.y;
  const dx = tx - sx, dy = ty - sy;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) { requestDraw(); return; }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / PAN_MS);
    const e = 1 - Math.pow(1 - t, 3);           // easeOutCubic
    camera.x = sx + dx * e;
    camera.y = sy + dy * e;
    clampCamera();
    draw();
    panAnim = t < 1 ? requestAnimationFrame(step) : null;
  }
  panAnim = requestAnimationFrame(step);
}

// Screen point -> grid coordinates, in tiles.
function screenToTile(x, y) {
  const px = pxPerTile();
  return { col: (camera.x + x) / px, row: (camera.y + y) / px };
}

// Zoom by `steps`, keeping the point under (focusX, focusY) fixed.
function zoomAt(steps, focusX, focusY) {
  if (!map) return;
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, zoomIndex + steps));
  if (next === zoomIndex) return;
  cancelPan();
  const at = screenToTile(focusX, focusY);
  zoomIndex = next;
  const px = pxPerTile();
  camera.x = at.col * px - focusX;
  camera.y = at.row * px - focusY;
  clampCamera();
  requestDraw();
  updateControls();
}

/** Centre the view on a grid cell, zooming in enough to be useful. */
function centreOn(col, row) {
  if (!map) return;
  if (pxPerTile() < 8) zoomIndex = ZOOM_LEVELS.indexOf(8);
  const px = pxPerTile();
  updateControls();
  glideTo(
    clampAxis(col * px - window.innerWidth / 2, map.width * px, window.innerWidth),
    clampAxis(row * px - window.innerHeight / 2, map.height * px, window.innerHeight)
  );
}

// Click: travel to that part of campus and move one step closer.
function goTo(x, y) {
  const at = screenToTile(x, y);
  const next = Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1);
  const zoomed = next !== zoomIndex;
  zoomIndex = next;
  const px = pxPerTile();
  // Keep the clicked point put, then glide it to the centre of the screen.
  camera.x = at.col * px - (zoomed ? x : window.innerWidth / 2);
  camera.y = at.row * px - (zoomed ? y : window.innerHeight / 2);
  clampCamera();
  updateControls();
  glideTo(
    clampAxis(at.col * px - window.innerWidth / 2, map.width * px, window.innerWidth),
    clampAxis(at.row * px - window.innerHeight / 2, map.height * px, window.innerHeight)
  );
}

// --- Input ------------------------------------------------------------
let dragging = false;
let lastX = 0, lastY = 0;
let downX = 0, downY = 0, moved = 0;
let pinchDist = 0;

function pointerDown(x, y) {
  cancelPan();
  dragging = true;
  lastX = x; lastY = y;
  downX = x; downY = y; moved = 0;
}

function pointerMove(x, y) {
  if (!dragging) return;
  camera.x -= x - lastX;
  camera.y -= y - lastY;
  moved = Math.max(moved, Math.hypot(x - downX, y - downY));
  lastX = x; lastY = y;
  clampCamera();
  requestDraw();
}

function pointerUp(x, y) {
  if (!dragging) return;
  dragging = false;
  if (moved <= CLICK_SLOP && map) goTo(x, y);   // a click, not a drag
}

canvas.addEventListener("mousedown", function (e) { pointerDown(e.clientX, e.clientY); });
window.addEventListener("mousemove", function (e) { pointerMove(e.clientX, e.clientY); });
window.addEventListener("mouseup", function (e) { pointerUp(e.clientX, e.clientY); });

canvas.addEventListener("touchstart", function (e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    pointerDown(e.touches[0].clientX, e.touches[0].clientY);
  } else if (e.touches.length === 2) {
    dragging = false;
    pinchDist = touchDistance(e.touches);
  }
}, { passive: false });

canvas.addEventListener("touchmove", function (e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    pointerMove(e.touches[0].clientX, e.touches[0].clientY);
  } else if (e.touches.length === 2) {
    const d = touchDistance(e.touches);
    if (pinchDist > 0 && Math.abs(d - pinchDist) > 10) {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      zoomAt(d > pinchDist ? 1 : -1, mx, my);
      pinchDist = d;
    }
  }
}, { passive: false });

canvas.addEventListener("touchend", function (e) {
  e.preventDefault();
  if (e.touches.length === 0) {
    pointerUp(lastX, lastY);   // a tap travels, same as a click
    pinchDist = 0;
  }
}, { passive: false });

canvas.addEventListener("wheel", function (e) {
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
}, { passive: false });

canvas.addEventListener("contextmenu", function (e) {
  e.preventDefault();                       // right-click backs out a step
  zoomAt(-1, e.clientX, e.clientY);
});

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// --- Controls ---------------------------------------------------------
const btnIn = document.getElementById("zoom-in");
const btnOut = document.getElementById("zoom-out");
const btnFit = document.getElementById("fit");
const btnBus = document.getElementById("bus");

function updateControls() {
  if (!btnIn || !map) return;
  btnIn.disabled = zoomIndex >= ZOOM_LEVELS.length - 1;
  btnOut.disabled = zoomIndex <= 0;
  btnFit.disabled = zoomIndex === fitIndex();
}

function centreX() { return window.innerWidth / 2; }
function centreY() { return window.innerHeight / 2; }

if (btnIn) btnIn.addEventListener("click", function () { zoomAt(1, centreX(), centreY()); });
if (btnOut) btnOut.addEventListener("click", function () { zoomAt(-1, centreX(), centreY()); });
if (btnFit) btnFit.addEventListener("click", fitCampus);
if (btnBus) btnBus.addEventListener("click", () => {
  toggleTransit();
  btnBus.classList.toggle("is-on", transitOpen());
});

window.addEventListener("keydown", function (e) {
  if (e.key === "+" || e.key === "=") zoomAt(1, centreX(), centreY());
  else if (e.key === "-" || e.key === "_") zoomAt(-1, centreX(), centreY());
  else if (e.key === "0" || e.key.toLowerCase() === "f") fitCampus();
  else if (e.key.toLowerCase() === "b" && btnBus) btnBus.click();
});

// --- Boot -------------------------------------------------------------
async function loadMap() {
  const res = await fetch("data/campus.json");
  if (!res.ok) throw new Error("campus.json: " + res.status);
  map = await res.json();
  buildMips();
  initTransit({ requestDraw: requestDraw, panTo: centreOn }, map);
  fitCampus();                 // open on the whole campus
}

window.addEventListener("resize", resize);
resize();

loadMap().catch(function (err) {
  console.error(err);
  document.body.innerHTML =
    "<p style='color:#fff;padding:2rem;font-family:monospace'>" +
    "Failed to load map data. Run tools/build_grid.py.</p>";
});
