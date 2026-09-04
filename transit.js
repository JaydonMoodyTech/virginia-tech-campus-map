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
export function drawTransit(c, px, camera) {
  // Deliberately not gated on the panel being open: collapsing the panel
  // on a narrow screen is how you get a look at the map, and losing the
  // route the moment you do that defeats the point. "Back" clears it.
  if (!state.route || !state.pattern || !proj) return;
  const r = state.route;
  const toScreen = (col, row) => [col * px - camera.x, row * px - camera.y];

  // Route shape.
  c.save();
  c.lineJoin = "round";
  c.lineCap = "round";
  c.strokeStyle = "rgba(0,0,0,0.45)";
  c.lineWidth = Math.max(3, px * 0.9) + 3;
  strokePath(c, state.pattern.path, toScreen);
  c.strokeStyle = r.color;
  c.lineWidth = Math.max(3, px * 0.9);
  strokePath(c, state.pattern.path, toScreen);

  // Stops.
  const dotR = Math.max(3, Math.min(9, px * 0.7));
  for (const s of stopsOf(state.pattern)) {
    const [x, y] = toScreen(s.col, s.row);
    if (x < -20 || y < -20 || x > window.innerWidth + 20 || y > window.innerHeight + 20) continue;
    const sel = s.code === state.selectedStop;
    c.beginPath();
    c.arc(x, y, sel ? dotR + 3 : dotR, 0, Math.PI * 2);
    c.fillStyle = "#f7f3e8";
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = sel ? "#f2c14e" : "#2c2a26";
    c.stroke();
  }

  // Live buses.
  for (const bus of busesOnRoute(r)) {
    const pos = busPosition(bus);
    if (!pos) continue;
    const [x, y] = toScreen(pos[0], pos[1]);
    if (x < -30 || y < -30 || x > window.innerWidth + 30 || y > window.innerHeight + 30) continue;
    drawBus(c, x, y, r.color, bus);
  }
  c.restore();
}

function strokePath(c, path, toScreen) {
  c.beginPath();
  path.forEach((p, i) => {
    const [x, y] = toScreen(p[0], p[1]);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
}

function drawBus(c, x, y, color, bus) {
  const w = 18, h = 12;
  c.save();
  c.translate(Math.round(x), Math.round(y));
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(-w / 2 + 1, -h / 2 + 2, w, h);
  c.fillStyle = color;
  c.fillRect(-w / 2, -h / 2, w, h);
  c.fillStyle = "rgba(255,255,255,0.85)";
  c.fillRect(-w / 2 + 2, -h / 2 + 2, w - 4, 4);          // windscreen band
  c.strokeStyle = "#241f1c";
  c.lineWidth = 2;
  c.strokeRect(-w / 2, -h / 2, w, h);
  const load = parseInt(bus.percentOfCapacity, 10);
  if (!isNaN(load) && load >= 80) {                       // nearly full
    c.fillStyle = "#e2564a";
    c.fillRect(w / 2 - 4, -h / 2 - 4, 4, 4);
  }
  c.restore();
}

// --- Open / close -----------------------------------------------------
function startPolling() {
  stopPolling();
  busTimer = setInterval(refreshBuses, BUS_POLL_MS);
  timeTimer = setInterval(refreshTimes, TIME_POLL_MS);
}

function stopPolling() {
  clearInterval(busTimer); clearInterval(timeTimer);
  busTimer = timeTimer = null;
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

export function initTransit(hooks, map) {
  ctx = hooks;
  host = document.getElementById("transit");
  initProjection(map);
  render();
}
