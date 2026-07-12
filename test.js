// Offline self-check for scale/sign logic, getvar.csv row parsing, and page wiring
// (no device needed).  Run: node test.js
const assert = require("node:assert");
const { scale, ROW, WEB_VARS, PAGE, TSTAMP, slackPayload, logInsert, logSlice } = require("./chiller_dashboard.js");

assert.strictEqual(scale(270), 27.0);
assert.strictEqual(scale(65516), -2.0); // negative temp wraps correctly

// row parser: name is first quoted field, val is last; desc commas must not break it
const row = '"Modbus_FB.FanSpA",5676,"Condenser Fan VFD Speed Reference A, common",REAL,RW,"98.40"';
const m = row.match(ROW);
assert.ok(m && m[1] === "Modbus_FB.FanSpA" && parseFloat(m[2]) === 98.4);
assert.ok(WEB_VARS["Modbus_FB.FanSpA"] === "Fan speed A %");

// the page's scripts live in public/ (served at /app.js and /unit3d.js)
const APP = require("node:fs").readFileSync(require("node:path").join(__dirname, "public/app.js"), "utf8");
const UNIT3D = require("node:fs").readFileSync(require("node:path").join(__dirname, "public/unit3d.js"), "utf8");

for (const anchor of ["glyIn", "comp2", "/app.js", "/unit3d.js", "Raw registers"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}

// the page scripts must at least parse — a syntax error kills the whole page
// silently (every function, including tick(), just never exists). vm.Script
// compiles the source without running it; it's classic-only, so the 3D
// module's import lines (three + its postprocessing addons) are all stripped
// before compiling.
new (require("node:vm").Script)(APP);
new (require("node:vm").Script)(UNIT3D.replace(/^import .*$/gm, ""));

// /api/log param whitelist: controller date format only, nothing else passes through
assert.ok(TSTAMP.test("2026-07-11T00:00:00"));
for (const bad of ["2026-07-11", "2026-07-11T00:00:00Z", "0;id=1", ""]) {
  assert.ok(!TSTAMP.test(bad), bad);
}

// Slack payload: glycol-out picks the color — green <30°F, red >40°F, plain between;
// x10 registers scale into one-decimal °F (negative wrap included)
const cold = slackPayload({ 68: 271, 69: 442, 70: 400, 132: 65516 });
assert.strictEqual(cold.attachments[0].color, "good");
assert.strictEqual(
  cold.attachments[0].text,
  "Glycol 44.2°F in → 27.1°F out · setpoint 40°F · reservoir -2°F"
);
assert.strictEqual(slackPayload({ 68: 401, 69: 442, 70: 400, 132: 413 }).attachments[0].color, "danger");
assert.ok(slackPayload({ 68: 351, 69: 442, 70: 400, 132: 413 }).text.includes("35.1°F out")); // no attachment in band

// log cache: chunks merge deduped on timestamp, stay sorted; slice = header + window.
// Timestamps built relative to now — logInsert trims rows older than its 7 d window.
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60e3); // whole seconds, a minute ago
const at = (s) => new Date(t0.getTime() + s * 1000);
const chunk = (...rows) => "TIME,EVENT,\"W_InTempUser\"\r\n" +
  rows.map(([s, v]) => `${stamp(at(s))}+00:00,,${v}`).join("\r\n");
assert.strictEqual(logInsert(chunk([5, 5.6], [10, 5.7])), 2);
assert.strictEqual(logInsert(chunk([0, 5.5], [5, 9.9])), 1); // overlap at +5 s deduped
const sliced = logSlice(at(0).getTime(), at(6).getTime()).split("\n");
assert.strictEqual(sliced.length, 3); // header + rows at +0 s and +5 s
assert.ok(sliced[0].startsWith("TIME") && sliced[1].includes("5.5") && sliced[2].includes("5.6"));

// disk persistence roundtrip: reloading a saved cache file adds nothing new
assert.strictEqual(logInsert(logSlice(-Infinity, Infinity) + "\n"), 0);

// history chart wiring: uplot assets + section in the page; the log columns the
// refresh script reads (temps + per-circuit compressor states for the run
// strips) and the indefinite backfill indicator fed by /api/log's
// X-Log-Loading header in app.js; the three.js import + bridge in unit3d.js
for (const anchor of ["/uplot.js", "ranges", "histpct"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}
for (const anchor of ["/api/all", "/api/log", "W_InTempUser", "W_OutTempUser",
                      "Comp1Circ1_Dout.Val", "Comp2Circ2_On", "Comp B",
                      "X-Log-Loading", "unit3d"]) {
  assert.ok(APP.includes(anchor), anchor);
}
for (const anchor of ["/three.js", "unit3d", "chipAnchors"]) {
  assert.ok(UNIT3D.includes(anchor), anchor);
}
console.log("ok");
