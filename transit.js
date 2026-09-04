// Blacksburg Transit panel: pick a route, see its stops, see when the
// next bus is expected at each one, and watch the buses move on the map.
//
// Static route/stop/shape data comes from data/transit.json, baked by
// tools/fetch_transit.py. Live vehicle positions and departure times come
// from /api/bt, which is api/bt.js on Vercel and tools/serve.py locally --
// BT's own endpoints send no CORS header, so a proxy is not optional.

const DATA_URL = "data/transit.json";
const API = "api/bt";
const BUS_POLL_MS = 15000;
const TIME_POLL_MS = 30000;
const EARTH_RADIUS = 6378137.0;

const state = {
  data: null,
  open: false,
  loading: false,
  error: null,
  route: null,
  pattern: null,
  departures: {},        // stopCode -> [departure]
  buses: [],             // live vehicles, all routes
  selectedStop: null,
  timesAt: null,
  timesError: false,
};

let host = null;         // the panel element
let ctx = null;          // hooks back into main.js
let busTimer = null, timeTimer = null;

// --- Projection -------------------------------------------------------
// Mirrors lonlat_to_cell in tools/build_grid.py. Deriving the scale from
// the grid dimensions keeps buses aligned with the tiles even if
// METERS_PER_TILE changes.
let proj = null;
function initProjection(map) {
  const merc = (lon, lat) => [
    EARTH_RADIUS * lon * Math.PI / 180,
    EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)),
  ];
  const [ox, oy] = merc(map.bbox.west, map.bbox.north);
  const [fx] = merc(map.bbox.east, map.bbox.south);
  const units = (fx - ox) / map.width;
  proj = (lon, lat) => {
    const [x, y] = merc(lon, lat);
    return [(x - ox) / units, (oy - y) / units];
  };
}

// --- Data -------------------------------------------------------------
async function loadData() {
  if (state.data || state.loading) return;
  state.loading = true;
  render();
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error("transit.json: " + res.status);
    state.data = await res.json();
    state.error = null;
  } catch (err) {
    state.error = "Could not load route data. Run tools/fetch_transit.py.";
  }
  state.loading = false;
  render();
}

async function api(params) {
  const res = await fetch(API + "?" + new URLSearchParams(params));
  if (!res.ok) throw new Error("api/bt: " + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.data;
}

async function refreshBuses() {
  try {
    state.buses = (await api({ method: "getBuses" })) || [];
  } catch {
    state.buses = [];
  }
  renderStatus();
  ctx.requestDraw();
}

async function refreshTimes() {
  if (!state.pattern) return;
  const codes = stopsOf(state.pattern).map(s => s.code);
  try {
    state.departures = (await api({ method: "departures", stops: codes.join(","), trips: 3 })) || {};
    state.timesError = false;
  } catch {
    state.timesError = true;
  }
  state.timesAt = new Date();
  render();
}

// --- Helpers ----------------------------------------------------------
const stopsOf = pattern => pattern.stops.map(i => state.data.stops[i]);

function nextFor(stop, route) {
  const list = state.departures[stop.code] || [];
  const mine = list.filter(d => d.routeShortName === route.short);
  return (mine.length ? mine : list)[0] || null;
}

function minutesUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function busesOnRoute(route) {
  return state.buses.filter(b => b.routeId === route.id);
}

function busPosition(bus) {
  const st = bus.states && bus.states[0];
  if (!st || !st.latitude || !st.longitude) return null;
  return proj(parseFloat(st.longitude), parseFloat(st.latitude));
}

// --- Rendering: panel -------------------------------------------------
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function render() {
  if (!host) return;
  host.hidden = !state.open;
  if (!state.open) return;

  if (state.loading) return void (host.innerHTML = shell("Loading routes…", ""));
  if (state.error) return void (host.innerHTML = shell("Transit", `<p class="t-msg">${esc(state.error)}</p>`));
  if (!state.data) return;

  host.innerHTML = state.route ? routeView() : listView();
  wire();
}

function shell(title, body) {
  return `<div class="t-head"><span class="t-title">${esc(title)}</span>
    <button class="t-x" data-act="close" aria-label="Close">✕</button></div>${body}`;
}

function listView() {
  const rows = state.data.routes.map(r => `
    <li><button class="t-route" data-route="${esc(r.id)}">
      <span class="t-swatch" style="background:${esc(r.color)}"></span>
      <span class="t-rtext">
        <span class="t-rname">${esc(r.name)}</span>
        <span class="t-rmeta">${esc(r.short)}${r.service ? " · " + esc(r.service) : ""}</span>
      </span>
    </button></li>`).join("");
  return shell("Blacksburg Transit",
    `<p class="t-sub">${state.data.routes.length} routes · pick one to see stops and times</p>
     <ul class="t-routes">${rows}</ul>`);
}

function routeView() {
  const r = state.route;
  const dirs = r.patterns.length > 1 ? `<div class="t-dirs">${r.patterns.map(p => `
      <button class="t-dir${p === state.pattern ? " is-on" : ""}" data-pattern="${esc(p.name)}">
        ${esc(p.name)}</button>`).join("")}</div>` : "";

  const stops = stopsOf(state.pattern).map((s, i) => {
    const dep = nextFor(s, r);
    const mins = dep ? minutesUntil(dep.adjustedDepartureTime) : null;
    const soon = mins !== null && mins <= 2;
    const time = dep
      ? `<span class="t-clock">${esc(clockTime(dep.adjustedDepartureTime))}</span>
         <span class="t-mins${soon ? " is-soon" : ""}">${mins <= 0 ? "due" : mins + " min"}</span>`
      : `<span class="t-none">${state.timesError ? "—" : "no service"}</span>`;
    return `<li class="t-stop${s.code === state.selectedStop ? " is-sel" : ""}" data-stop="${esc(s.code)}">
        <span class="t-rail"><span class="t-dot${s.timed ? " is-timed" : ""}"></span></span>
        <span class="t-sname">${esc(s.name || "Stop " + s.code)}</span>
        <span class="t-times">${time}</span>
      </li>`;
  }).join("");

  return `<div class="t-head">
      <button class="t-x" data-act="back" aria-label="All routes">‹</button>
      <span class="t-title" style="border-color:${esc(r.color)}">${esc(r.name)}</span>
      <button class="t-x" data-act="close" aria-label="Close">✕</button>
    </div>
    ${dirs}
    <p class="t-status" id="t-status"></p>
    <ol class="t-stops" style="--rail:${esc(r.color)}">${stops}</ol>`;
}

function renderStatus() {
  const el = host && host.querySelector("#t-status");
  if (!el || !state.route) return;
  const n = busesOnRoute(state.route).length;
  const when = state.timesAt
    ? state.timesAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "…";
  el.textContent = state.timesError
    ? "Live times unavailable — showing stops only"
    : `${n} bus${n === 1 ? "" : "es"} running · updated ${when}`;
  el.classList.toggle("is-warn", state.timesError);
}

function wire() {
  host.querySelectorAll("[data-act=close]").forEach(b =>
    b.addEventListener("click", close));
  host.querySelectorAll("[data-act=back]").forEach(b =>
    b.addEventListener("click", () => { state.route = null; state.pattern = null; render(); ctx.requestDraw(); }));
  host.querySelectorAll("[data-route]").forEach(b =>
    b.addEventListener("click", () => selectRoute(b.dataset.route)));
  host.querySelectorAll("[data-pattern]").forEach(b =>
    b.addEventListener("click", () => {
      state.pattern = state.route.patterns.find(p => p.name === b.dataset.pattern);
      state.departures = {};
      render();
      refreshTimes();
      ctx.requestDraw();
    }));
  host.querySelectorAll("[data-stop]").forEach(li =>
    li.addEventListener("click", () => {
      const stop = state.data.stops.find(s => s.code === li.dataset.stop);
      state.selectedStop = stop.code;
      render();
      ctx.panTo(stop.col, stop.row);
    }));
  renderStatus();
}

function selectRoute(id) {
  state.route = state.data.routes.find(r => r.id === id);
  state.pattern = state.route.patterns[0];
  state.departures = {};
  state.selectedStop = null;
  render();
  refreshTimes();
  refreshBuses();
  ctx.requestDraw();
}

// --- Rendering: map overlay -------------------------------------------
// Stops and buses are drawn at a constant screen size rather than scaled
// with the zoom: they are map furniture, like pins, and a bus that shrank
// to a speck at low zoom would defeat the point of tracking it.

const STOP_DOT_PX = 0;        // stops are always worth showing as dots
const STOP_ICON_PX = 3;       // at/above this, draw the full sign icon

/** Every stop served by the five routes, deduplicated. */
function allStops() {
  if (!state.data) return [];
  const seen = new Set();
  const out = [];
  for (const r of state.data.routes) {
    for (const p of r.patterns) {
      for (const i of p.stops) {
        if (seen.has(i)) continue;
        seen.add(i);
        out.push({ stop: state.data.stops[i], color: r.color });
      }
    }
  }
  return out;
}

export function drawTransit(c, px, camera) {
  if (!state.data || !proj) return;
  const toScreen = (col, row) => [col * px - camera.x, row * px - camera.y];
  const onScreen = (x, y, m) =>
    x > -m && y > -m && x < window.innerWidth + m && y < window.innerHeight + m;

  c.save();
  c.lineJoin = "round";
  c.lineCap = "round";

  // Selected route shape, under everything else.
  if (state.route && state.pattern) {
    c.strokeStyle = "rgba(0,0,0,0.45)";
    c.lineWidth = Math.max(3, px * 0.9) + 3;
    strokePath(c, state.pattern.path, toScreen);
    c.strokeStyle = state.route.color;
    c.lineWidth = Math.max(3, px * 0.9);
    strokePath(c, state.pattern.path, toScreen);
  }

  // Stops for all five routes; the selected route's are emphasised.
  if (px >= STOP_DOT_PX) {
    const onRoute = new Set();
    if (state.pattern) state.pattern.stops.forEach(i => onRoute.add(state.data.stops[i].code));
    for (const { stop, color } of allStops()) {
      const [x, y] = toScreen(stop.col, stop.row);
      if (!onScreen(x, y, 24)) continue;
      const active = onRoute.has(stop.code);
      if (state.route && !active) continue;      // focus the chosen route
      drawStop(c, x, y, px, color, stop.code === state.selectedStop, active);
    }
  }

  // Live buses, every route, always.
  for (const bus of state.buses) {
    const route = routeById(bus.routeId);
    if (!route) continue;
    const pos = busPosition(bus);
    if (!pos) continue;
    const [x, y] = toScreen(pos[0], pos[1]);
    if (!onScreen(x, y, 40)) continue;
    drawBus(c, x, y, route, bus, px);
  }
  c.restore();
}

function routeById(id) {
  return state.data ? state.data.routes.find(r => r.id === id) : null;
}

function strokePath(c, path, toScreen) {
  c.beginPath();
  path.forEach((p, i) => {
    const [x, y] = toScreen(p[0], p[1]);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
}

/** A bus-stop sign: post, plate, and a bus glyph once there is room. */
function drawStop(c, x, y, px, color, selected, active) {
  x = Math.round(x); y = Math.round(y);
  if (px < STOP_ICON_PX) {
    c.beginPath();
    c.arc(x, y, selected ? 5 : 3.5, 0, Math.PI * 2);
    c.fillStyle = active ? "#f7f3e8" : "#cfc6b6";
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = "#2c2a26";
    c.stroke();
    return;
  }

  const w = 16, h = 13, post = 8;
  c.strokeStyle = "#2c2a26";
  c.lineWidth = 2;
  c.beginPath();                              // post
  c.moveTo(x, y);
  c.lineTo(x, y - post);
  c.stroke();

  const top = y - post - h;
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(x - w / 2 + 1, top + 2, w, h);
  c.fillStyle = selected ? "#f2c14e" : "#f7f3e8";
  c.fillRect(x - w / 2, top, w, h);
  c.strokeRect(x - w / 2, top, w, h);

  c.fillStyle = color;                        // little bus on the plate
  c.fillRect(x - 5, top + 3, 10, 6);
  c.fillStyle = "rgba(255,255,255,0.92)";     // windows
  c.fillRect(x - 4, top + 4, 8, 2);
  c.fillStyle = "#2c2a26";                    // wheels
  c.fillRect(x - 4, top + 9, 2, 2);
  c.fillRect(x + 2, top + 9, 2, 2);
}

/** A little bus, drawn side-on so it reads at a glance. */
function drawBus(c, x, y, route, bus, px) {
  const w = 22, h = 14;
  x = Math.round(x); y = Math.round(y);
  c.save();
  c.translate(x, y);

  c.fillStyle = "rgba(0,0,0,0.35)";           // ground shadow
  c.beginPath();
  c.ellipse(0, h / 2 + 2, w / 2 - 1, 3, 0, 0, Math.PI * 2);
  c.fill();

  c.fillStyle = route.color;                  // body
  c.fillRect(-w / 2, -h / 2, w, h);
  c.fillStyle = "rgba(255,255,255,0.9)";      // windows
  for (let i = 0; i < 3; i++) c.fillRect(-w / 2 + 3 + i * 6, -h / 2 + 3, 4, 4);
  c.fillStyle = "#ffe9a8";                    // headlight
  c.fillRect(w / 2 - 3, -1, 2, 3);
  c.fillStyle = "#241f1c";                    // wheels
  c.fillRect(-w / 2 + 3, h / 2 - 2, 4, 3);
  c.fillRect(w / 2 - 7, h / 2 - 2, 4, 3);
  c.strokeStyle = "#241f1c";
  c.lineWidth = 2;
  c.strokeRect(-w / 2, -h / 2, w, h);

  const load = parseInt(bus.percentOfCapacity, 10);
  if (!isNaN(load) && load >= 80) {           // nearly full
    c.fillStyle = "#e2564a";
    c.beginPath();
    c.arc(w / 2, -h / 2, 3.5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#241f1c";
    c.lineWidth = 1.5;
    c.stroke();
  }

  if (px >= 2) {                              // route badge under the bus
    c.font = "700 10px ui-monospace, monospace";
    c.textAlign = "center";
    const label = route.short;
    const tw = c.measureText(label).width + 6;
    c.fillStyle = "rgba(20,17,15,0.82)";
    c.fillRect(-tw / 2, h / 2 + 4, tw, 12);
    c.fillStyle = "#f4efe2";
    c.fillText(label, 0, h / 2 + 13);
  }
  c.restore();
}

// --- Open / close -----------------------------------------------------
function startPolling() {
  if (!busTimer) busTimer = setInterval(refreshBuses, BUS_POLL_MS);
  if (!timeTimer) timeTimer = setInterval(refreshTimes, TIME_POLL_MS);
}

function stopPolling() {
  clearInterval(timeTimer);          // bus tracking keeps running
  timeTimer = null;
}

export async function openTransit() {
  state.open = true;
  render();
  await loadData();
  refreshBuses();
  if (state.pattern) refreshTimes();
  startPolling();
  ctx.requestDraw();
}

export function close() {
  state.open = false;
  render();
  if (!state.route) stopPolling();   // keep a selected route live on the map
  ctx.requestDraw();
}

export function toggleTransit() {
  state.open ? close() : openTransit();
}

export function isOpen() { return state.open; }

export async function initTransit(hooks, map) {
  ctx = hooks;
  host = document.getElementById("transit");
  initProjection(map);
  render();
  // Load and start tracking straight away: the stop and bus icons are
  // part of the map, not part of the panel.
  await loadData();
  refreshBuses();
  busTimer = setInterval(refreshBuses, BUS_POLL_MS);
  ctx.requestDraw();
}
