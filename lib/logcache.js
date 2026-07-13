// The controller's onboard datalogger (log id 0, "GandDLog04162024") exports CSV
// at getlog.csv — glycol/suction temps (°C), pressures (bar), comp/fan states,
// sampled every 5 s. Its clock runs site-local time but stamps rows "+00:00";
// the page compensates by parsing timestamps as local wall-clock time.
//
// This module is the in-process cache in front of that endpoint: logLoop()
// reloads the cache from disk, backfills only the missing window
// newest-chunk-first (so the default 6 h view fills after the first chunk),
// then polls only the tail — one controller request in flight, ever. /api/log
// answers instantly from logSlice(); logLoading() (true while the backfill
// runs) drives the page's indefinite loading indicator.
const fs = require("fs");
const path = require("path");
const { HOST } = require("./config");

const TSTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/; // controller date format, also our param whitelist

/** @param {string} start @param {string} stop TSTAMP-format local times
 * @returns {Promise<number | null>} rows added, null on failure */
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

const LOG_DAYS = 7; // matches the page's longest range
const LOG_POLL_MIN = Number(process.env.LOG_POLL_MIN || 5);
const DAY = 86400e3, PAD = 3600e3; // PAD: controller clock runs fast (~25 min as of 2026-07-11)
const CHUNK = 6 * 3600e3; // largest query size measured reliable (6 h = 95 s; a full day risks the timeout)
const logCache = []; // [tMs, csvLine] ascending; 7 d of 5 s samples ≈ 120k rows, ~30 MB
const logSeen = new Set(); // timestamps in logCache — kept in sync by logInsert (no per-call rebuild)
let logHeader = "TIME"; // replaced by the real header on first chunk
let loading = true; // true until the startup backfill completes

const pad2 = (n) => String(n).padStart(2, "0");
const tstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
                    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} csv one controller CSV chunk @returns {number} rows added */
function logInsert(csv) {
  // Merge one controller CSV chunk: dedupe on timestamp, keep ascending, trim
  // to the LOG_DAYS window. Rows are stamped +00:00 but are wall-clock local
  // (controller quirk), so the first 19 chars parse as local time.
  if (!csv) return 0;
  const rows = csv.trim().split(/\r?\n/);
  // header guard: only a line that looks like the real header may replace
  // logHeader — a headerless file (e.g. appended after a failed save) or a
  // non-CSV 200 body must not poison the header /api/log serves. A data-row
  // first line just falls through to the merge loop below.
  if (rows[0] && !isFinite(new Date(rows[0].slice(0, 19)).getTime())) {
    const first = rows.shift();
    if (first.includes("TIME")) logHeader = first; // anything else (HTML error body etc.) is dropped
  }
  let added = 0;
  for (const line of rows) {
    const t = new Date(line.slice(0, 19)).getTime();
    if (!isFinite(t) || logSeen.has(t)) continue;
    logSeen.add(t);
    logCache.push([t, line]);
    added++;
  }
  if (added) logCache.sort((a, b) => a[0] - b[0]);
  const cut = Date.now() - LOG_DAYS * DAY - PAD;
  if (logCache.length && logCache[0][0] < cut) { // one splice, not shift()-per-row (O(n²) on a stale reload)
    const keep = logCache.findIndex((r) => r[0] >= cut);
    for (const r of logCache.splice(0, keep < 0 ? logCache.length : keep)) logSeen.delete(r[0]);
  }
  return added;
}

/** @param {number} t0 @param {number} t1 window in epoch ms @returns {string} */
const logSlice = (t0, t1) => // CSV text for a [ms, ms] window, header always included
  [logHeader, ...logCache.filter((r) => r[0] >= t0 && r[0] <= t1).map((r) => r[1])].join("\n");

// The cache also persists to disk (LOG_FILE, gitignored) so a restart — every
// deploy does one — reloads 7 d instantly and backfills only the days missing
// since the last saved row, instead of re-downloading everything (~15 min).
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "..", "log_cache.csv");
const saveLog = () => // full rewrite via tmp+rename so a crash can't leave a torn file; trailing \n so tail appends start on a fresh line
  fs.promises.writeFile(LOG_FILE + ".tmp", logSlice(-Infinity, Infinity) + "\n")
    .then(() => fs.promises.rename(LOG_FILE + ".tmp", LOG_FILE))
    .catch((e) => console.error("log cache save failed:", e.message)); // never silent — a dead cache re-costs the full backfill

const appendRows = (t0, t1) => { // persist one window's rows, headerless append (reload re-sorts + dedupes)
  const rows = logSlice(t0, t1).split("\n").slice(1); // drop the header line
  return rows.length ? fs.promises.appendFile(LOG_FILE, rows.join("\n") + "\n")
    .catch((e) => console.error("log cache append failed:", e.message)) : Promise.resolve();
};

// Walk (floor, now+PAD] newest-chunk-first — the largest reliable query is CHUNK
// (an un-chunked gap after a long outage would exceed the 5 min timeout forever).
// Each fetched window is appended to disk, so a restart mid-walk resumes instead
// of re-downloading. retry: keep retrying a failed chunk (backfill) vs bail and
// let the next poll try again (tail).
async function fetchBack(floor, retry) {
  for (let stop = Date.now() + PAD; stop > floor; ) {
    const start = Math.max(floor, stop - CHUNK);
    const n = await readLog(tstr(new Date(start)), tstr(new Date(stop)));
    if (n === null) { if (!retry) return; await sleep(60e3); continue; } // controller busy/offline
    if (n) await appendRows(start, stop);
    stop = start;
    await sleep(5e3); // breathe between minute-long queries
  }
}

async function logLoop() {
  try { logInsert(await fs.promises.readFile(LOG_FILE, "utf8")); } catch {} // no/bad file = cold start; async read keeps startup requests answering
  const newest = logCache.length ? logCache[logCache.length - 1][0] : 0;
  // backfill everything between the last saved row (or the 7 d horizon) and
  // now, newest chunk first so the default 6 h view fills after one query
  await fetchBack(Math.max(newest, Date.now() - LOG_DAYS * DAY), true);
  loading = false;
  await saveLog(); // compact once: trims the append-grown file and guarantees it starts with a header
  let lastCompact = Date.now();
  while (true) { // tail poll: only rows newer than the cache
    await sleep(LOG_POLL_MIN * 60e3);
    const last = logCache.length ? logCache[logCache.length - 1][0] : Date.now() - DAY;
    await fetchBack(last, false);
    // ponytail: appends grow the file ~4 MB/day — a daily rewrite re-trims it to the 7 d window
    if (Date.now() - lastCompact > DAY) { await saveLog(); lastCompact = Date.now(); }
  }
}

const logLoading = () => loading; // read by /api/log's X-Log-Loading header

module.exports = { TSTAMP, readLog, logInsert, logSlice, logLoop, logLoading };
