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

for (const anchor of ["glyIn", "comp2", "/api/all", "Raw registers"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}

// the page script must at least parse — a syntax error kills the whole page
// silently (every function, including tick(), just never exists). vm.Script
// compiles our own page source without running it.
new (require("node:vm").Script)(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);

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

// history chart wiring: uplot assets, section, the log columns the page reads
// (temps + per-circuit compressor states for the run strips), and the
// indefinite backfill indicator fed by /api/log's X-Log-Loading header
for (const anchor of ["/uplot.js", "/api/log", "W_InTempUser", "W_OutTempUser", "ranges",
                      "Comp1Circ1_Dout.Val", "Comp2Circ2_On", "Comp B",
                      "histpct", "X-Log-Loading"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}
console.log("ok");
