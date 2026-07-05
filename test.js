// Offline self-check for scale/sign logic, getvar.csv row parsing, and page wiring
// (no device needed).  Run: node test.js
const assert = require("node:assert");
const { scale, ROW, WEB_VARS, PAGE } = require("./chiller_dashboard.js");

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
console.log("ok");
