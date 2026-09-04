// Vercel serverless proxy for Blacksburg Transit.
//
// BT's com_ajax endpoints are public and keyless, but they send no
// Access-Control-Allow-Origin header, so a static page cannot call them
// from the browser. This forwards the handful of calls the map needs.
//
// tools/serve.py implements the same contract for local development --
// keep the two in step.

const BT_BASE =
  "https://ridebt.org/index.php?option=com_ajax&module=bt_map" +
  "&format=json&Itemid=101&method=";
const USER_AGENT = "pixel-campus-map/0.1 (student project)";
const MAX_STOPS = 60;          // cap the fan-out so one click cannot hammer BT
const PASSTHROUGH = ["getBuses", "getRoutes", "getRoutePatterns", "getActiveAlerts"];

async function btGet(method, params = {}) {
  let url = BT_BASE + method;
  for (const [k, v] of Object.entries(params)) {
    url += `&${k}=${encodeURIComponent(v)}`;
  }
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  return body && body.data !== undefined ? body.data : body;
}

// BT only answers this one as a POST; a GET returns an empty list.
async function departures(stopCode, trips) {
  const res = await fetch(BT_BASE + "getNextDeparturesForStop", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ stopCode, numOfTrips: String(trips) }),
  });
  if (!res.ok) throw new Error(`departures ${stopCode}: HTTP ${res.status}`);
  const body = await res.json();
  return (body && body.data) || [];
}

export default async function handler(req, res) {
  const { method = "", stops = "", trips = "3", patternName = "" } = req.query;

  try {
    if (method === "departures") {
      const codes = String(stops).split(",").filter(Boolean).slice(0, MAX_STOPS);
      const n = Math.max(1, Math.min(10, parseInt(trips, 10) || 3));
      const settled = await Promise.allSettled(codes.map(c => departures(c, n)));
      const data = {};
      codes.forEach((code, i) => {
        data[code] = settled[i].status === "fulfilled" ? settled[i].value : [];
      });
      // Live times: short shared cache, long stale window.
      res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
      return res.status(200).json({ data });
    }

    if (method === "getPatternPoints") {
      res.setHeader("Cache-Control", "s-maxage=86400");
      return res.status(200).json({ data: await btGet(method, { patternName }) });
    }

    if (PASSTHROUGH.includes(method)) {
      // Vehicle positions move constantly; routes barely ever do.
      res.setHeader(
        "Cache-Control",
        method === "getBuses" ? "s-maxage=10, stale-while-revalidate=30" : "s-maxage=3600"
      );
      return res.status(200).json({ data: await btGet(method) });
    }

    return res.status(400).json({ error: "unknown method: " + method });
  } catch (err) {
    return res.status(502).json({ error: String(err && err.message || err) });
  }
}
