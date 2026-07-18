// node:http request handler + the static assets it serves (page, vendored
// uPlot/three.js, seal art) — all read once at startup. No framework. Every
// route is read-only except POST /api/setpoint, the dashboard's manual
// setpoint control, gated (like the boost automation) on SETPOINT_WRITE=1.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { HOST } = require("./config");
const { read, writeSetpoint } = require("./modbus");
const { readWeb } = require("./webvars");
const { readAlarms } = require("./alarms");
const { TRIP_F, boostStatus } = require("./boost");
const { TSTAMP, logSlice, logLoading } = require("./logcache");

const ROOT = path.join(__dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
// uPlot renders the history chart; vendored from node_modules so the page has no CDN dependency.
const UPLOT_JS = fs.readFileSync(require.resolve("uplot/dist/uPlot.iife.min.js"));
const UPLOT_CSS = fs.readFileSync(require.resolve("uplot/dist/uPlot.min.css"));
// three.js renders the 3D unit model; vendored like uPlot so the page works with
// no internet. Two files: the module build imports "./three.core.min.js", so the
// core must be served at that exact path relative to /three.js (both at root).
// three's exports map blocks subpath resolution, so resolve the package itself
// (→ build/three.cjs) and read its siblings.
const THREE_DIR = path.dirname(require.resolve("three"));
const THREE_JS = fs.readFileSync(path.join(THREE_DIR, "three.module.min.js"));
const THREE_CORE = fs.readFileSync(path.join(THREE_DIR, "three.core.min.js"));
// three's addon modules (examples/jsm) — served under /three/addons/ for the
// postprocessing chain; they `import ... from "three"`, which the page's import
// map resolves back to /three.js.
const JSM_DIR = path.join(THREE_DIR, "..", "examples", "jsm");
// G&D Chillers seal (svgo-minified vendor art) — the page paints it onto the
// 3D unit's door badges (see the badge block in dashboard.html).
const LOGO_SVG = fs.readFileSync(path.join(ROOT, "gd_seal.svg"));
// The page's own scripts, split out of dashboard.html: the refresh loop/chart
// (classic) and the 3D unit model (ES module — browsers load it natively).
const DATETIME_JS = fs.readFileSync(path.join(ROOT, "lib", "datetime.js"));
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"));
const UNIT3D_JS = fs.readFileSync(path.join(ROOT, "public", "unit3d.js"));

// Discovery aid (CAPTURE_PGD=1 only): the controller has no restart-logs CGI in
// its documented API, but the HTML5 pGD sends every keypress as an HTTP request
// through this proxy. Log each /pgd/ request (method, url, body) to a file so a
// manual "system menu -> LOGGER -> RESTART LOGS" can be captured and replayed.
// Off by default — pure passthrough — so it never touches normal operation.
const CAPTURE = process.env.CAPTURE_PGD === "1"
  ? path.join(ROOT, "pgd-capture.log") : null;

// Same-origin bridge for the controller's HTML5 pGD. The dashboard is commonly
// served through HTTPS/Cloudflare while the controller is private HTTP; a direct
// iframe would be blocked as mixed content and unreachable away from the site LAN.
// Keep the proxy deliberately narrow: only the controller's /pgd/ tree is exposed.
function proxyPgd(req, res) {
  const headers = {};
  for (const name of ["accept", "content-type", "content-length"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const chunks = CAPTURE ? [] : null; // buffer the request body only while capturing
  const upstream = http.request({ hostname: HOST, port: 80, method: req.method,
    path: req.url, headers }, (response) => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders.connection;
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("pGD unavailable");
  });
  req.on("aborted", () => upstream.destroy());
  if (chunks) {
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString().replace(/\s+/g, " ").trim();
      fs.appendFile(CAPTURE, `${req.method} ${req.url}${body ? " " + body : ""}\n`, () => {});
    });
  }
  req.pipe(upstream);
}

// Collect a small request body. Resolves null once `limit` bytes are exceeded
// (the caller answers 413) — no route here legitimately takes a large payload.
/** @param {import("http").IncomingMessage} req @param {number} limit @returns {Promise<string | null>} */
const readBody = (req, limit) => new Promise((resolve) => {
  /** @type {Buffer[]} */ const chunks = [];
  let size = 0, over = false;
  req.on("data", (c) => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; resolve(null); } else chunks.push(c);
  });
  req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
  // A client that vanishes mid-body fires neither over-limit nor "end" — settle
  // on teardown too, or the awaiting handler (and this closure) leak forever.
  // A double resolve after a normal "end" is a harmless no-op.
  req.on("error", () => { over = true; resolve(null); });
  req.on("close", () => { if (!over) resolve(null); });
});

/**
 * POST /api/setpoint — the dashboard's manual setpoint control. Body
 * {setpointF: <number>} (application/json only, ≤ 1 KB), answers
 * {ok, setpointF} on a verified write. Trust boundary: the app has no auth of
 * its own (Cloudflare Access / trusted LAN in front — same posture as the
 * /pgd/ proxy, which already exposes full menu control), so the gates here are
 * about correctness, not identity. No coordination with lib/boost.js is
 * needed: a manual write mid-incident trips its tamper guard and the
 * automation stands down on its next tick.
 * @param {import("http").IncomingMessage} req @param {import("http").ServerResponse} res
 * @param {{writeSetpoint: typeof writeSetpoint,
 *          post?: (body: object) => Promise<boolean>}} deps injectable so
 *   test.js can exercise the success/failure paths without a controller — and
 *   the audit poster MUST flow through deps too, or the suite (which runs with
 *   the real .env loaded) delivers to the real webhook (bug, 2026-07-18).
 */
async function handleSetpoint(req, res, deps = { writeSetpoint }) {
  const reply = (/** @type {number} */ code, /** @type {object} */ obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // Read the env per request rather than hoisting it to a module const (the
  // way lib/slack.js hoists SLACK_URL) so tests can flip it — the same
  // deviation lib/slack.js itself makes for SETPOINT_WRITE in its
  // glycol-boost condition.
  if (process.env.SETPOINT_WRITE !== "1")
    return reply(403, { ok: false, error: "setpoint writes are disabled — the server runs read-only unless SETPOINT_WRITE=1" });
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
  // Requiring the JSON content type also blocks cross-site form CSRF: an HTML
  // form cannot send application/json without a CORS preflight (which this
  // server never grants).
  const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ctype !== "application/json")
    return reply(400, { ok: false, error: "Content-Type must be application/json" });
  const body = await readBody(req, 1024);
  // null + destroyed = the client vanished mid-body: nobody is listening, so
  // don't write a reply into a dead socket. null otherwise = over the cap.
  if (body === null) {
    if (req.destroyed) return;
    return reply(413, { ok: false, error: "body too large (1 KB max)" });
  }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return reply(400, { ok: false, error: "body is not valid JSON" }); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      typeof parsed.setpointF !== "number" || !Number.isFinite(parsed.setpointF))
    return reply(400, { ok: false, error: "body must be {setpointF: <number>}" });
  // Round to the controller's 0.1°F resolution, like lib/boost.js's r1().
  // Range stays writeSetpoint's job — its hard 15..60°F clamp refuses without
  // touching the wire, and that refusal maps to a 400 below.
  const targetF = Math.round(parsed.setpointF * 10) / 10;
  const r = await deps.writeSetpoint(targetF);
  if (!r.ok) {
    // wrote:false + a "refused:" error is the hard-bound refusal (caller's
    // value, nothing touched) → 400. Everything else — connection failure,
    // ambiguous write, wrong-register readback — is an upstream failure → 502.
    const refused = !r.wrote && !!r.error && r.error.startsWith("refused");
    // wrote:true means the FC6 request reached the wire — the setpoint on the
    // hardware MAY now be the new value even though verification failed, so an
    // unverified write still gets an audit post (lib/boost.js does the same
    // for its own ambiguous writes).
    if (r.wrote && process.env.SLACK_WEBHOOK_URL) {
      (deps.post ?? require("./slack").post)({ text:
        `⚠️ *Ambiguous manual setpoint write from the dashboard*\n` +
        `Sent ${targetF.toFixed(1)}°F but could not verify it took` +
        `${typeof r.readback === "number" ? ` — the setpoint reads back ${r.readback.toFixed(1)}°F` : ""}. Check the controller.` });
    }
    return reply(refused ? 400 : 502, { ok: false,
      error: r.error || `write did not take: setpoint reads back ${r.readback}°F, wanted ${targetF}°F` });
  }
  reply(200, { ok: true, setpointF: r.readback });
  // Audit trail (fire-and-forget): the old setpoint isn't in hand on this
  // request path — writeSetpoint only reads back the NEW value, and an extra
  // controller round-trip solely for the message isn't worth it — so the post
  // names the new value and the resulting shutdown trip. slack.post() never
  // throws and logs its own failures. Required lazily, matching lib/boost.js.
  if (process.env.SLACK_WEBHOOK_URL) {
    (deps.post ?? require("./slack").post)({ text:
      `🎛️ *Chiller setpoint set to ${r.readback.toFixed(1)}°F from the dashboard*\n` +
      `The controller shuts the unit down when supply exceeds setpoint + ${TRIP_F}°F — ` +
      `the shutdown alarm now trips at ${(r.readback + TRIP_F).toFixed(1)}°F.` });
  }
}

async function handle(req, res) {
  const url = req.url.split("?")[0];
  const json = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (url === "/uplot.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(UPLOT_JS);
  }
  if (url === "/uplot.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    return res.end(UPLOT_CSS);
  }
  // 24 h cache on three.js: ~750 KB combined, and it only changes on an npm update
  if (url === "/three.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" });
    return res.end(THREE_JS);
  }
  if (url === "/three.core.min.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" });
    return res.end(THREE_CORE);
  }
  // three.js addons (postprocessing: EffectComposer + UnrealBloomPass and the
  // passes/shaders they import) — the page's import map points "three/addons/"
  // here. Read on demand rather than listing every file at startup: the import
  // chain is a dozen small modules and the browser caches them for a day.
  if (url.startsWith("/three/addons/")) {
    const file = path.join(JSM_DIR, url.slice("/three/addons/".length));
    // trust boundary: the URL is client-controlled — serve only existing .js files
    // that resolve inside examples/jsm (blocks ../ traversal out of the package)
    if (!file.startsWith(JSM_DIR + path.sep) || !file.endsWith(".js") || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" });
    return res.end(fs.readFileSync(file));
  }
  if (url === "/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(APP_JS);
  }
  if (url === "/datetime.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(DATETIME_JS);
  }
  if (url === "/unit3d.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(UNIT3D_JS);
  }
  if (url === "/logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    return res.end(LOGO_SVG);
  }
  if (url.startsWith("/pgd/")) return proxyPgd(req, res);
  if (url === "/api/log") {
    // History chart data: instant slice of the in-process cache (see logLoop —
    // the controller is far too slow to query per request). ?start=&stop= in
    // YYYY-MM-DDThh:mm:ss local; X-Log-Loading: 1 while the backfill runs.
    const q = new URL(req.url, "http://x").searchParams;
    const start = q.get("start") || "", stop = q.get("stop") || "";
    if (!TSTAMP.test(start) || !TSTAMP.test(stop)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("bad start/stop");
    }
    res.writeHead(200, { "Content-Type": "text/csv", "X-Log-Loading": logLoading() ? 1 : 0 });
    return res.end(logSlice(new Date(start).getTime(), new Date(stop).getTime()));
  }
  // Dev live-reload: an SSE stream that never sends anything. `npm run dev`
  // (node --watch) kills the process on save, dropping this stream; the page
  // reconnects and reloads itself. Only mounted when DEV=1.
  if (url === "/reload" && process.env.DEV) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    return res.write(": connected\n\n");
  }
  if (url === "/api") return json((await read()) || { error: "modbus read failed" });
  if (url === "/api/web") return json((await readWeb()) || { error: "getvar.csv fetch failed" });
  // Alarm names/history — its own route, polled slowly (60 s): alarms.cgi is two
  // extra controller requests and faults don't need 5 s resolution.
  if (url === "/api/alarms") return json((await readAlarms()) || { error: "alarms.cgi fetch failed" });
  if (url === "/api/setpoint") return handleSetpoint(req, res);
  if (url === "/api/all") {
    // One call for the page's refresh loop: raw regs + web vars in one
    // payload, plus the setpoint-boost snapshot and the writesEnabled flag the
    // page uses to decide whether the setpoint control renders.
    const [regs, web] = await Promise.all([read(), readWeb()]);
    return json({ regs, web, boost: boostStatus(), writesEnabled: process.env.SETPOINT_WRITE === "1" });
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

module.exports = { handle, handleSetpoint, PAGE };
