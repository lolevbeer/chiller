// Offline self-check for scale/sign logic, getvar.csv row parsing, and page wiring
// (no device needed).  Run: node test.js
const assert = require("node:assert");
const { scale, ROW, WEB_VARS, PAGE, TSTAMP, slackPayload } = require("./chiller_dashboard.js");

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

// history chart wiring: uplot assets, section, and the log columns the page reads
for (const anchor of ["/uplot.js", "/api/log", "W_InTempUser", "W_OutTempUser", "ranges"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}
console.log("ok");
