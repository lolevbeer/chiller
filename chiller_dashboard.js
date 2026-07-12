// Read-only web view of the G&D glycol chiller (c.pCO) over Modbus TCP + HTTP.
// Cloudflare Access sits in front for auth; this app has no login of its own by design.
// Run:  npm install
//       CHILLER_IP=192.168.1.69 node chiller_dashboard.js   (PORT defaults to 8000)
try { process.loadEnvFile(); } catch {} // optional .env (gitignored) — holds SLACK_WEBHOOK_URL etc.
const http = require("http");
const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");

// modbus-serial can leak an async socket error (e.g. connect ETIMEDOUT when the
// chiller is unreachable) outside the connectTCP promise, which would kill the
// process as an unhandled rejection. This is a read-only dashboard: log and keep
// serving — the page shows "offline" until reads succeed again.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e?.message ?? e));

const HOST = process.env.CHILLER_IP || "192.168.1.69";
const PORT = Number(process.env.PORT || 8000);
const COUNT = Number(process.env.CHILLER_REGS || 160); // confirmed map spans 0..158

// INPUT-register labels confirmed by time-series correlation against the
// controller's own getvar.csv (see correlate_registers.py): a register earns a
// label only by tracking that variable across every sample while running.
// Circuit 1 occupies 0..28, circuit 2 mirrors it at 32..56. Integer regs
// (status/counts) are NOT x10; only analog temps/pressures are. Fan speed, EEV
// position, and glycol supply pressure are NOT on the Modbus TCP map at all
// (they exist only in the Modbus_FB block for the serial BMS port).
const LABELS = {
  0: "Chiller status (int enum, Modbus_FB.ChillerStat)",
  1: "Power request (int, tenths of %; 1000=100%)",
  2: "Power running circ 1 (int, tenths of %)",
  3: "Discharge pres circ 1 psi",
  4: "Condensing temp circ 1 °F",
  9: "Suction temp circ 1 °F",
  10: "Suction pres circ 1 psi",
  11: "Evaporating temp circ 1 °F",
  23: "Suction superheat circ 1",
  24: "Discharge superheat circ 1",
  28: "EVD valve status circ 1 (int)",
  35: "Discharge pres circ 2 psi",
  36: "Condensing temp circ 2 °F",
  41: "Suction temp circ 2 °F",
  42: "Suction pres circ 2 psi",
  43: "Evaporating temp circ 2 °F",
  55: "Suction superheat circ 2",
  56: "Discharge superheat circ 2",
  68: "Glycol outlet °F",
  69: "Glycol inlet °F",
  70: "Cooling setpoint °F",
  131: "User pump 2 hours (int)",
  132: "Glycol reservoir temp °F",
  135: "Compressor 1 circ 1 hours (int)",
  141: "Compressor 1 circ 2 hours (int)",
  158: "Source fan 1 circ 1 hours (int)",
};

// CAREL analog values are signed int16, stored x10 (one decimal). Handle negatives.
const scale = (v) => (v > 32767 ? v - 65536 : v) / 10;

async function read() {
  // INPUT registers (FC4) hold the live sensor feed; HOLDING (FC3) are setpoints.
  const c = new ModbusRTU();
  c.setTimeout(3000);
  try {
    // connectTCP has no connect timeout of its own (setTimeout above only covers
    // responses) — race it so an unreachable chiller answers null in 5 s, not the
    // OS's ~75 s. A late loser rejection lands in the unhandledRejection log.
    await Promise.race([c.connectTCP(HOST, { port: 502 }),
      new Promise((_, rej) => setTimeout(rej, 5000, new Error("modbus connect timeout")).unref())]);
    c.setID(1);
    const out = {}; // addr -> raw uint16; chunked: Modbus allows max 125 regs/read
    for (let base = 0; base < COUNT; base += 100) {
      const rr = await c.readInputRegisters(base, Math.min(100, COUNT - base));
      rr.data.forEach((v, i) => { out[base + i] = v; });
    }
    return out;
  } catch {
    return null;
  } finally {
    try { c.close(); } catch {}
  }
}

// Points that exist only in the Modbus_FB block (feeds the serial BMS port, not
// the TCP map). The controller's getvar.csv endpoint accepts repeated ?name=
// params, so one filtered HTTP request (~150 ms) fetches all of these live.
const WEB_VARS = {
  "Modbus_FB.FanSpA": "Fan speed A %",
  "Modbus_FB.FanSpB": "Fan speed B %",
  "Modbus_FB.EEVPosA": "EEV position A %",
  "Modbus_FB.EEVPosB": "EEV position B %",
  "Modbus_FB.GlySupPres": "Glycol supply pres psi",
  "Modbus_FB.ResLvl": "Reservoir level",
  "Modbus_FB.ChPmpStat": "Chiller pump on",
  "Modbus_FB.ProcPmpStat": "Process pump on",
  "Modbus_FB.FlowStatA": "Glycol flow A ok",
  "Modbus_FB.FlowStatB": "Glycol flow B ok",
  "Modbus_FB.CompStatA": "Compressor A on",
  "Modbus_FB.CompStatB": "Compressor B on",
};

// getvar.csv row: "name",id,"desc",type,access,"val" — desc may hold commas, so
// anchor the last quoted field as val and the first as name (all fields we read
// are ASCII, so fetch's default UTF-8 decode is fine here).
const ROW = /^"([^"]*)",\d+,.*,"([^"]*)"\s*$/;

async function readWeb() {
  // {label: value} from getvar.csv, already in engineering units (no x10); null on failure.
  const qs = Object.keys(WEB_VARS).map((n) => "name=" + encodeURIComponent(n)).join("&");
  try {
    const res = await fetch(`http://${HOST}/getvar.csv?${qs}`, { signal: AbortSignal.timeout(5000) });
    const out = {};
    for (const line of (await res.text()).split("\n")) {
      const m = line.match(ROW);
      if (m && WEB_VARS[m[1]]) out[WEB_VARS[m[1]]] = parseFloat(m[2]);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

// The controller's onboard datalogger (log id 0, "GandDLog04162024") exports CSV
// at getlog.csv — glycol/suction temps (°C), pressures (bar), comp/fan states,
// sampled every 5 s. Its clock runs site-local time but stamps rows "+00:00";
// the page compensates by parsing timestamps as local wall-clock time.
const TSTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/; // controller date format, also our param whitelist

async function readLog(start, stop) {
  // One CSV query to the controller, buffered whole and merged with a single
  // logInsert. Only the cache loop below calls this — measured 2026-07-11, the
  // embedded server needs ~60 s per query before size even matters (1 h = 64 s,
  // 6 h = 95 s), hence the 5 min timeout and why /api/log never hits it live.
  // Returns rows added, or null on failure.
  if (!TSTAMP.test(start) || !TSTAMP.test(stop)) return null;
  try {
    const res = await fetch(`http://${HOST}/getlog.csv?id=0&start=${start}&stop=${stop}`,
      { signal: AbortSignal.timeout(300000) });
    return res.ok ? logInsert(await res.text()) : null;
  } catch {
    return null;
  }
}

// --- Datalogger cache ---
// logLoop() reloads the cache from disk, backfills only the missing window
// newest-chunk-first (so the default 6 h view fills after the first chunk),
// then polls only the tail — one controller request in flight, ever. /api/log
// answers instantly from logCache; an X-Log-Loading header (1 while the
// backfill runs) drives the page's indefinite loading indicator.
const LOG_DAYS = 7; // matches the page's longest range
const LOG_POLL_MIN = Number(process.env.LOG_POLL_MIN || 5);
const DAY = 86400e3, PAD = 3600e3; // PAD: controller clock runs fast (~25 min as of 2026-07-11)
const CHUNK = 6 * 3600e3; // largest query size measured reliable (6 h = 95 s; a full day risks the timeout)
const logCache = []; // [tMs, csvLine] ascending; 7 d of 5 s samples ≈ 120k rows, ~30 MB
let logHeader = "TIME"; // replaced by the real header on first chunk
let logLoading = true; // true until the startup backfill completes

const pad2 = (n) => String(n).padStart(2, "0");
const tstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
                    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logInsert(csv) {
  // Merge one controller CSV chunk: dedupe on timestamp, keep ascending, trim
  // to the LOG_DAYS window. Rows are stamped +00:00 but are wall-clock local
  // (controller quirk), so the first 19 chars parse as local time.
  if (!csv) return 0;
  const rows = csv.trim().split(/\r?\n/);
  logHeader = rows.shift() || logHeader;
  const seen = new Set(logCache.map((r) => r[0])); // ponytail: O(n) rebuild per call; readLog throttles flushes to every 5 s
  let added = 0;
  for (const line of rows) {
    const t = new Date(line.slice(0, 19)).getTime();
    if (!isFinite(t) || seen.has(t)) continue;
    seen.add(t);
    logCache.push([t, line]);
    added++;
  }
  if (added) logCache.sort((a, b) => a[0] - b[0]);
  while (logCache.length && logCache[0][0] < Date.now() - LOG_DAYS * DAY - PAD) logCache.shift();
  return added;
}

const logSlice = (t0, t1) => // CSV text for a [ms, ms] window, header always included
  [logHeader, ...logCache.filter((r) => r[0] >= t0 && r[0] <= t1).map((r) => r[1])].join("\n");

// The cache also persists to disk (LOG_FILE, gitignored) so a restart — every
// deploy does one — reloads 7 d instantly and backfills only the days missing
// since the last saved row, instead of re-downloading everything (~15 min).
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "log_cache.csv");
const saveLog = () => // full rewrite, async; trailing \n so tail appends start on a fresh line
  fs.promises.writeFile(LOG_FILE, logSlice(-Infinity, Infinity) + "\n").catch(() => {});

async function logLoop() {
  try { logInsert(fs.readFileSync(LOG_FILE, "utf8")); } catch {} // no/bad file = cold start
  const newest = logCache.length ? logCache[logCache.length - 1][0] : 0;
  // backfill everything between the last saved row (or the 7 d horizon) and
  // now, newest chunk first so the default 6 h view fills after one query
  const horizon = Math.max(newest, Date.now() - LOG_DAYS * DAY);
  for (let stop = Date.now() + PAD; stop > horizon; ) {
    const start = Math.max(horizon, stop - CHUNK);
    const n = await readLog(tstr(new Date(start)), tstr(new Date(stop)));
    if (n === null) { await sleep(60e3); continue; } // controller busy/offline — retry this chunk
    stop = start;
    await sleep(5e3); // breathe between minute-long queries
  }
  logLoading = false;
  await saveLog();
  let lastCompact = Date.now();
  while (true) { // tail poll: only rows newer than the cache
    await sleep(LOG_POLL_MIN * 60e3);
    const last = logCache.length ? logCache[logCache.length - 1][0] : Date.now() - DAY;
    await readLog(tstr(new Date(last)), tstr(new Date(Date.now() + PAD)));
    const fresh = logCache.filter((r) => r[0] > last).map((r) => r[1]);
    if (fresh.length) fs.promises.appendFile(LOG_FILE, fresh.join("\n") + "\n").catch(() => {});
    // ponytail: append-only file grows ~4 MB/day — a daily rewrite re-trims it to the 7 d window
    if (Date.now() - lastCompact > DAY) { await saveLog(); lastCompact = Date.now(); }
  }
}

// Optional Slack reporter: set SLACK_WEBHOOK_URL (an Incoming Webhook) and the
// glycol temps post every SLACK_EVERY_MIN minutes (default 10), plus once at
// startup — if that first read succeeds — so a bad webhook shows up quickly.
const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_EVERY_MIN = Number(process.env.SLACK_EVERY_MIN || 10);

// Glycol-out drives the message's color bar: green below 30 °F, red above 40 °F
// (Slack's legacy "good"/"danger" attachment colors), plain in between.
const slackPayload = (regs) => {
  const out = scale(regs[68]);
  const text = `Glycol ${scale(regs[69])}°F in → ${out}°F out · setpoint ${scale(regs[70])}°F · reservoir ${scale(regs[132])}°F`;
  const color = out < 30 ? "good" : out > 40 ? "danger" : null;
  return color ? { attachments: [{ color, text }] } : { text };
};

// One failure warning per outage, not one per tick. Starts true so the startup
// tick can't post a spurious warning: right after a service restart the chiller
// often still holds the dead process's Modbus socket, so the first read loses
// that race. Cost: an outage already in progress at boot isn't announced until
// after the first successful read.
let slackDown = true;
async function slackReport() {
  const regs = await read();
  if (!regs && slackDown) return;
  slackDown = !regs;
  const body = regs ? slackPayload(regs)
    : { text: "⚠️ Chiller Modbus read failed — temps resume when it recovers" };
  await fetch(SLACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => console.error("slack post failed:", e.message));
}

const PAGE = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
// uPlot renders the history chart; vendored from node_modules so the page has no CDN dependency.
const UPLOT_JS = fs.readFileSync(require.resolve("uplot/dist/uPlot.iife.min.js"));
const UPLOT_CSS = fs.readFileSync(require.resolve("uplot/dist/uPlot.min.css"));

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
    res.writeHead(200, { "Content-Type": "text/csv", "X-Log-Loading": logLoading ? 1 : 0 });
    return res.end(logSlice(new Date(start).getTime(), new Date(stop).getTime()));
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

if (require.main === module) {
  http.createServer(handle).listen(PORT, "0.0.0.0", () =>
    console.log(`chiller dashboard on http://0.0.0.0:${PORT}  (chiller ${HOST})`)
  );
  if (SLACK_URL) {
    slackReport();
    setInterval(slackReport, SLACK_EVERY_MIN * 60 * 1000);
  }
  logLoop(); // datalogger cache: 7 d backfill, then tail polling
}

module.exports = { scale, read, readWeb, readLog, TSTAMP, LABELS, WEB_VARS, ROW, PAGE, slackPayload, logInsert, logSlice };
