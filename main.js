// --- Constants --------------------------------------------------------
const TILE = 16;                 // source tile size in tiles.png

// Zoom ladder, in screen pixels per grid tile (one tile = 4 m of ground).
// At or above TILE we blit the spritesheet at an integer scale (1x..4x).
// Below TILE we draw a pre-rendered flat-colour overview scaled by an
// integer factor: a 16px tile cannot shrink to 6px without smearing its
// pixels, and campus is 354x445 tiles, so these overview levels are the
// only way the whole map ever fits on screen.
const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8, 12, 16, 32, 48, 64];
const SPRITE_MIN = TILE;         // at or above this, use the spritesheet
const LABEL_MIN = 32;            // px/tile before building labels appear
const CLICK_SLOP = 6;            // px of movement still counted as a click
const PAN_MS = 320;              // click-to-centre glide

const VOID_COLOR = "#1a1c2c";    // outside the map bounds
const GRASS_COLOR = "#4a7a3a";   // tile 0, painted as one rect not blitted

// Must match the base colours in tools/make_placeholder_tiles.py.
const TILE_COLORS = [
  [74, 122, 58], [194, 168, 120], [107, 107, 107],
  [143, 74, 58], [58, 110, 165], [46, 84, 46],
];

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

let zoomIndex = 0;
let map = null;
let sheetReady = false;
let overview = null;             // offscreen canvas, 1 px per tile

const camera = { x: 0, y: 0 };
const sheet = new Image();

sheet.onload = () => { sheetReady = true; requestDraw(); };
sheet.onerror = () => console.error("Failed to load assets/tiles.png");
sheet.src = "assets/tiles.png";

function pxPerTile() { return ZOOM_LEVELS[zoomIndex]; }

// --- Overview bitmap --------------------------------------------------
// One pixel per tile, built once. Scaling this up is a single drawImage
// instead of ~158k fillRects, which is what keeps the zoomed-out view
// cheap enough to pan smoothly.
function buildOverview() {
  overview = document.createElement("canvas");
  overview.width = map.width;
  overview.height = map.height;
  const octx = overview.getContext("2d");
  const img = octx.createImageData(map.width, map.height);
  const d = img.data;
  let i = 0;
  for (let r = 0; r < map.height; r++) {
    const row = map.grid[r];
    for (let c = 0; c < map.width; c++) {
      const rgb = TILE_COLORS[row[c]] || TILE_COLORS[0];
      d[i++] = rgb[0]; d[i++] = rgb[1]; d[i++] = rgb[2]; d[i++] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
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
    if (overview) ctx.drawImage(overview, ox, oy, map.width * px, map.height * px);
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
        id * TILE, 0, TILE, TILE,
        Math.round(c * px - camera.x),
        Math.round(r * px - camera.y),
        px, px
      );
    }
  }

  drawLabels(px);
}

function drawLabels(px) {
  if (px < LABEL_MIN) return;
  ctx.font = Math.max(10, Math.round(px / 4)) + "px ui-monospace, monospace";
  ctx.textAlign = "center";
  for (const lab of map.labels) {
    const x = lab.col * px - camera.x;
    const y = lab.row * px - camera.y;
    if (x < -100 || x > window.innerWidth + 100) continue;
    if (y < -40 || y > window.innerHeight + 40) continue;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    const w = ctx.measureText(lab.name).width + 8;
    ctx.fillRect(x - w / 2, y - 12, w, 15);
    ctx.fillStyle = "#f4f4f4";
    ctx.fillText(lab.name, x, y);
  }
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

window.addEventListener("keydown", function (e) {
  if (e.key === "+" || e.key === "=") zoomAt(1, centreX(), centreY());
  else if (e.key === "-" || e.key === "_") zoomAt(-1, centreX(), centreY());
  else if (e.key === "0" || e.key.toLowerCase() === "f") fitCampus();
});

// --- Boot -------------------------------------------------------------
async function loadMap() {
  const res = await fetch("data/campus.json");
  if (!res.ok) throw new Error("campus.json: " + res.status);
  map = await res.json();
  buildOverview();
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
