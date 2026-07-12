// node:http request handler + the static assets it serves (page, vendored
// uPlot/three.js, seal art) — all read once at startup. No framework.
const fs = require("fs");
const path = require("path");
const { read } = require("./modbus");
const { readWeb } = require("./webvars");
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
// G&D Chillers seal (svgo-minified vendor art) — the page paints it onto the
// 3D unit's door badges (see the badge block in dashboard.html).
const LOGO_SVG = fs.readFileSync(path.join(ROOT, "gd_seal.svg"));
// The page's own scripts, split out of dashboard.html: the refresh loop/chart
// (classic) and the 3D unit model (ES module — browsers load it natively).
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"));
const UNIT3D_JS = fs.readFileSync(path.join(ROOT, "public", "unit3d.js"));

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
  if (url === "/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(APP_JS);
  }
  if (url === "/unit3d.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(UNIT3D_JS);
  }
  if (url === "/logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    return res.end(LOGO_SVG);
  }
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
  if (url === "/api/all") {
    // One call for the page's refresh loop: raw regs + web vars in one payload.
    const [regs, web] = await Promise.all([read(), readWeb()]);
    return json({ regs, web });
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

module.exports = { handle, PAGE };
