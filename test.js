// Offline self-check for scale/sign logic, getvar.csv row parsing, and page wiring
// (no device needed).  Run: node test.js
const assert = require("node:assert");
const { scale, ROW, WEB_VARS, UNUSED_WEB_VARS, PAGE, TSTAMP, step, logInsert, logSlice } = require("./chiller_dashboard.js");
const { post, flushPosts, initialDailyKey } = require("./lib/slack");
const { decide, reviveState, validBoostThresholds, IDLE: BOOST_IDLE, TRIP_F, BOOST_MARGIN_F } = require("./lib/boost");
const { writeSetpoint } = require("./lib/modbus");
const { commandResponse, trendFromCsv, alarmsText } = require("./lib/slack_commands");
const dateTime = require("./lib/datetime");

assert.strictEqual(scale(270), 27.0);
assert.strictEqual(scale(65516), -2.0); // negative temp wraps correctly

// row parser: name is first quoted field, val is last; desc commas must not break it
const row = '"Modbus_FB.FanSpA",5676,"Condenser Fan VFD Speed Reference A, common",REAL,RW,"98.40"';
const m = row.match(ROW);
assert.ok(m && m[1] === "Modbus_FB.FanSpA" && parseFloat(m[2]) === 98.4);
assert.ok(WEB_VARS["Modbus_FB.FanSpA"] === "Fan speed A %");
// ResLvl is documented but not live: no sensor on this unit, so it is not in
// WEB_VARS (would always read 0) and is not a Slack condition.
assert.ok(UNUSED_WEB_VARS["Modbus_FB.ResLvl"] === "Reservoir level");
assert.ok(!("Modbus_FB.ResLvl" in WEB_VARS));

// the page's scripts live in public/ (served at /app.js and /unit3d.js)
const APP = require("node:fs").readFileSync(require("node:path").join(__dirname, "public/app.js"), "utf8");
const UNIT3D = require("node:fs").readFileSync(require("node:path").join(__dirname, "public/unit3d.js"), "utf8");
const DATETIME = require("node:fs").readFileSync(require("node:path").join(__dirname, "lib/datetime.js"), "utf8");

// "Raw registers" was an anchor here until the debug table was dropped from the page
for (const anchor of ["glyIn", "comp2", "/datetime.js", "/app.js", "/unit3d.js"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}

// the page scripts must at least parse — a syntax error kills the whole page
// silently (every function, including tick(), just never exists). vm.Script
// compiles the source without running it; it's classic-only, so the 3D
// module's import lines (three + its postprocessing addons) are all stripped
// before compiling.
new (require("node:vm").Script)(APP);
new (require("node:vm").Script)(UNIT3D.replace(/^import .*$/gm, ""));
new (require("node:vm").Script)(DATETIME);

// Human-facing time has one shared contract in Node and the browser. Display
// preserves controller wall time; offsets affect elapsed-time math only.
assert.strictEqual(dateTime.moment("2026-07-13T04:56:38-07:00"), "Jul 13, 2026 at 4:56 AM");
assert.strictEqual(dateTime.range("2026-07-13T04:56:38-07:00", "2026-07-13T10:54:48-07:00"),
  "Jul 13, 2026 · 4:56–10:54 AM");
assert.strictEqual(dateTime.range("2026-07-12T23:00:00-07:00", "2026-07-13T01:00:00-07:00"),
  "Jul 12, 2026 at 11:00 PM → Jul 13, 2026 at 1:00 AM");
assert.strictEqual(dateTime.elapsed("2026-07-11T03:26:41-07:00", "2026-07-11T03:29:05-07:00"), 144000);
assert.strictEqual(dateTime.duration(24911000), "6 hr 55 min");
assert.strictEqual(dateTime.clock(new Date(2026, 6, 13, 8, 5, 6), true), "8:05:06 AM");
const browserContext = {};
require("node:vm").runInNewContext(DATETIME, browserContext);
assert.strictEqual(browserContext.ChillerDateTime.moment("2026-07-13T04:56:38-07:00"),
  dateTime.moment("2026-07-13T04:56:38-07:00"));

// /api/log param whitelist: controller date format only, nothing else passes through
assert.ok(TSTAMP.test("2026-07-11T00:00:00"));
for (const bad of ["2026-07-11", "2026-07-11T00:00:00Z", "0;id=1", ""]) {
  assert.ok(!TSTAMP.test(bad), bad);
}

// Slack alerting is edge-triggered: step() is pure — no clock, no I/O — so drive
// it through whole incidents with no device. Defaults apply: elapsed-time dwells
// are glycol/freeze 5 min and no-flow 2 min; offline and a missing leak
// sensor deliberately use two samples; alarms/leaks/pressostats fire at once.
const WEB_OK = {
  "LEL A %": 0, "LEL B %": 0, "HP pressostat trip": 0, "LP pressostat trip": 0,
  "Chiller pump on": 1, "Process pump on": 1, "Glycol flow A ok": 1, "Glycol flow B ok": 1,
};
// 28°F out, 29°F setpoint (in band), 40°F return, both compressors off, hours balanced
const REGS_OK = { 31: 0, 62: 0, 68: 280, 69: 400, 70: 290, 132: 400, 135: 500, 141: 505 };
const OK = { regs: REGS_OK, web: WEB_OK, alarms: { active: [] } };
const ZERO = { active: new Map(), counts: new Map(), hist: [] };
// Run a sequence from a fresh start, one poll per minute; returns each poll's posts.
const seq = (...states) => {
  let c = ZERO, out = [];
  states.forEach((s, i) => { c = step(c, { ...s, t: i * 60000 }); out.push(c.posts); });
  return out;
};
const rep = (n, s) => Array(n).fill(s);

// A standing alarm posts once, stays silent while it stands, and posts a recovery
// carrying the incident duration when it clears.
const alarmed = { ...OK, alarms: { active: [{ name: "High glycol temp", since: "2026-07-12T09:00:00" }] } };
const [p1, p2, p3] = seq(alarmed, alarmed, OK);
assert.strictEqual(p1.length, 1);
assert.ok(p1[0].includes("High glycol temp") && p1[0].includes("Jul 12, 2026 at 9:00 AM"));
assert.ok(!p1[0].includes("2026-07-12T"));
assert.deepStrictEqual(p2, []); // still standing — no repeat. This is the deduplication.
assert.ok(p3[0].includes("High glycol temp recovered") && p3[0].includes("lasted 2 min"));

// A failed alarm read is not a recovery: the fault is held until a read says it cleared
assert.deepStrictEqual(seq(alarmed, { ...OK, alarms: null })[1], []);

// Propane and pressostats fire on the first poll — no dwell on a safety
assert.ok(seq({ ...OK, web: { ...WEB_OK, "LEL A %": 12 } })[0][0].includes("12% of the lower explosive limit"));
assert.ok(seq({ ...OK, web: { ...WEB_OK, "HP pressostat trip": 1 } })[0][0].includes("High-pressure switch tripped"));
assert.deepStrictEqual(seq({ ...OK, web: { ...WEB_OK, "LEL A %": 9 } })[0], []); // under the 10% threshold

// Leak hysteresis: an alert opened at 12% does NOT clear at 8% (still above half
// the trip point) — a leak hovering on the threshold must not flap.
const leak = (pct) => ({ ...OK, web: { ...WEB_OK, "LEL A %": pct } });
assert.deepStrictEqual(seq(leak(12), leak(8))[1], []);
assert.ok(seq(leak(12), leak(8), leak(3))[2][0].includes("recovered"));
// A whole getvar.csv failure is unknown, not proof that a safety cleared.
assert.deepStrictEqual(seq(leak(12), { ...OK, web: null })[1], []);
assert.ok(seq(leak(12), { ...OK, web: null }, leak(3))[2][0].includes("recovered"));

// A leak sensor that drops out of the getvar response is itself a fault (2-poll dwell)
const { "LEL B %": _b, ...blind } = WEB_OK;
const noSensor = { ...OK, web: blind };
assert.deepStrictEqual(seq(noSensor)[0], []);
assert.ok(seq(noSensor, noSensor)[1][0].includes("Propane sensor B stopped reporting"));

// Glycol high: the first and fifth bad samples are only four minutes apart, so it
// fires on the sixth sample after five full elapsed minutes.
const hot = { ...OK, regs: { ...REGS_OK, 31: 1, 62: 1, 68: 400, 69: 518 } }; // 40°F out vs 29°F setpoint
const hotRun = seq(...rep(6, hot));
assert.deepStrictEqual(hotRun.slice(0, 5).flat(), []);
assert.ok(hotRun[5][0].includes("High glycol supply temperature"));
assert.ok(hotRun[5][0].includes("40.0°F out, setpoint 29.0°F · 51.8°F return"));
assert.ok(hotRun[5][0].includes("Compressors A + B running"));
// a lapse resets the dwell — five hot samples, one in-band, five hot is silent
assert.deepStrictEqual(seq(...rep(5, hot), OK, ...rep(5, hot)).flat(), []);

// Glycol hysteresis: fired at 40°F over a 29°F setpoint (threshold 34°F), it does
// NOT clear at 33°F — only once the temp is a full HYST_F back inside the band.
const warm = (t) => ({ ...OK, regs: { ...REGS_OK, 68: t } });
assert.deepStrictEqual(seq(...rep(6, hot), warm(330))[6], []); // 33°F: inside the band, not clear of it
const recov = seq(...rep(6, hot), warm(310))[6]; // 31°F: clear
assert.ok(recov[0].includes("High glycol supply temperature recovered") && recov[0].includes("lasted 6 min"));
// A register timeout likewise cannot clear an active temperature condition.
assert.deepStrictEqual(seq(...rep(6, hot), { ...OK, regs: null })[6], []);

// The critical band is its own condition, above the warning one
assert.ok(seq(...rep(6, warm(460)))[5][0].includes("Critical glycol supply temperature"));

// Glycol boost nudge (manual fallback): margin over the setpoint > BOOST_MARGIN_F
// (13°F — 5°F short of the firmware's setpoint+18°F shutdown) for the 5-min
// dwell posts a "temporarily RAISE the setpoint to supply − 10°F" note, and
// names the normal setpoint to restore. Gated off entirely under SETPOINT_WRITE=1.
const TRIP_TITLE = `Glycol supply within ${TRIP_F - BOOST_MARGIN_F}°F of the shutdown trip`;
const nearTrip = (t) => ({ ...OK, regs: { ...REGS_OK, 68: t, 70: 350 } }); // 35°F setpoint
assert.deepStrictEqual(seq(...rep(6, nearTrip(490))).slice(0, 5).flat().filter((p) => p.includes(TRIP_TITLE)), []); // dwell not yet met
const boostPost = seq(...rep(6, nearTrip(490)))[5].find((p) => p.includes(TRIP_TITLE));
assert.ok(boostPost && boostPost.includes(`setpoint + ${TRIP_F}°F`) && boostPost.includes("RAISE the setpoint to 39.0°F"));
assert.ok(boostPost.includes("below the current 49.0°F supply") && boostPost.includes("Restore the normal setpoint (35.0°F)"));
assert.deepStrictEqual(seq(...rep(6, nearTrip(480))).flat().filter((p) => p.includes(TRIP_TITLE)), []); // margin exactly 13°F does not trip
// …and the boundary is float-class independent: 32.2−19.2 computes to
// 13.000000000000004, but compared in tenths it is still exactly 13°F — no trip.
assert.deepStrictEqual(seq(...rep(6, { ...OK, regs: { ...REGS_OK, 68: 322, 70: 192 } }))
  .flat().filter((p) => p.includes(TRIP_TITLE)), []);
// Recovers with hysteresis once the margin is a full HYST_F back under the threshold.
assert.deepStrictEqual(seq(...rep(6, nearTrip(490)), nearTrip(465)).at(-1).filter((p) => p.includes(`${TRIP_TITLE} recovered`)), []); // margin 11.5°F: still within hysteresis
assert.ok(seq(...rep(6, nearTrip(490)), nearTrip(455)).at(-1).find((p) => p.includes(`${TRIP_TITLE} recovered`))); // margin 10.5°F: clear
// With SETPOINT_WRITE=1 the boost module's own posts are the notification — the
// manual nudge must not fire at all (the condition reads the env per evaluation).
process.env.SETPOINT_WRITE = "1";
assert.deepStrictEqual(seq(...rep(6, nearTrip(490))).flat().filter((p) => p.includes(TRIP_TITLE)), []);
delete process.env.SETPOINT_WRITE;

// Setpoint boost pure core: decide() drives whole incidents offline, exactly
// like step() above — samples in, {state, action} out, the shell does the I/O.
// Defaults: margin 13°F, drop 10°F, restore 8°F, ceiling 45°F, dwell 5 samples.
const bs = (supplyF, setpointF) => ({ supplyF, setpointF });
const brun = (start, samples, th) => {
  let state = start; const actions = [];
  samples.forEach((x, i) => { const r = decide(state, { t: i * 60000, ...x }, th); state = r.state; actions.push(r.action); });
  return { state, actions };
};

// Trigger fires after the dwell, not before, and the raise math is supply − 10°F.
assert.ok(brun({ ...BOOST_IDLE }, rep(4, bs(43, 29))).actions.every((a) => a === null)); // 14°F margin, 4 samples: not yet
let boost = brun({ ...BOOST_IDLE }, rep(5, bs(43, 29)));
assert.ok(boost.actions[4] && boost.actions[4].type === "raise" && boost.actions[4].targetF === 33);
assert.deepStrictEqual(boost.state, { phase: "active", originalF: 29, lastWrittenF: 33, writes: 1, trigCount: 0, restoreCount: 0 });
const ACTIVE = boost.state; // active incident reused below: original 29°F, written 33°F

// Ratchet: while active the margin test re-arms against the CURRENT setpoint;
// a second sustained climb raises again and originalF stays the first setpoint.
boost = brun(ACTIVE, rep(5, bs(47, 33)));
assert.ok(boost.actions[4].type === "raise" && boost.actions[4].targetF === 37);
assert.ok(boost.state.writes === 2 && boost.state.originalF === 29);

// Ceiling: the target clamps to 45°F, and once the clamp can't raise the
// setpoint any further the action is ceiling-alert (shutdown imminent), which
// re-arms its own dwell so a standing condition re-alerts once per dwell.
boost = brun({ ...BOOST_IDLE }, rep(5, bs(57, 40)));
assert.strictEqual(boost.actions[4].targetF, 45); // min(57−10, 45)
boost = brun(boost.state, rep(10, bs(59, 45)));
assert.deepStrictEqual(boost.actions.map((a) => a && a.type),
  [null, null, null, null, "ceiling-alert", null, null, null, null, "ceiling-alert"]);
assert.strictEqual(boost.state.phase, "active");

// Max writes per incident: an 11th raise is refused with ceiling-alert instead.
// Custom thresholds (dwell 1, cap 3, no ceiling) keep the incident short.
const th = { MARGIN_F: 13, DROP_F: 10, RESTORE_F: 8, CEIL_F: 500, DWELL: 1, MAX_WRITES: 3 };
{
  let st = { ...BOOST_IDLE }; const acts = [];
  for (let i = 0; i < 5; i++) { // supply climbs forever; setpoint tracks each write
    const r = decide(st, { t: i * 60000, ...bs(30 + i * 4, st.lastWrittenF ?? 15) }, th);
    st = r.state; acts.push(r.action && r.action.type);
  }
  assert.deepStrictEqual(acts, ["raise", "raise", "raise", "ceiling-alert", "ceiling-alert"]);
}

// Restore measures against the ORIGINAL setpoint, not the raised one: 38°F is
// within 8°F of the current 33°F but 9°F over the original 29°F — no restore.
assert.ok(brun(ACTIVE, rep(8, bs(38, 33))).actions.every((a) => a === null));
boost = brun(ACTIVE, rep(5, bs(36.5, 33))); // 7.5°F over the original: restores after the dwell
assert.ok(boost.actions.slice(0, 4).every((a) => a === null));
assert.ok(boost.actions[4].type === "restore" && boost.actions[4].targetF === 29);
assert.deepStrictEqual(boost.state, { ...BOOST_IDLE }); // incident cleared

// Sanity guards: null or insane readings never act and reset the dwell, so a
// glitch splitting two 4-sample runs keeps the trigger silent (9 samples total).
for (const glitch of [bs(null, null), bs(95, 29), bs(9, 29), bs(43, 12), bs(43, 61), bs(NaN, 29)]) {
  assert.ok(brun({ ...BOOST_IDLE }, [...rep(4, bs(43, 29)), glitch, ...rep(4, bs(43, 29))]).actions.every((a) => a === null));
}

// Tamper: an active incident whose setpoint no longer matches the last write
// means a human intervened — abort and stand down, naming the pre-boost
// setpoint so the human can restore it.
boost = brun(ACTIVE, [bs(43, 31)]);
assert.ok(boost.actions[0].type === "abort" && boost.actions[0].reason.includes("human"));
assert.ok(boost.actions[0].reason.includes("29.0°F")); // the original setpoint, for manual restore
assert.strictEqual(boost.state.phase, "idle");
// …but readback noise within 0.2°F of the written value is not tampering.
assert.strictEqual(brun(ACTIVE, [bs(43, 33.1)]).actions[0], null);
// The 0.2°F tolerance is compared in register counts, so it holds for EVERY
// written value: 30.6 vs 30.4 float-subtracts to 0.20000000000000284, which
// must still read as noise (two counts), while three counts is tampering.
assert.strictEqual(brun({ ...ACTIVE, lastWrittenF: 30.4 }, [bs(43, 30.6)]).actions[0], null);
assert.strictEqual(brun({ ...ACTIVE, lastWrittenF: 30.4 }, [bs(43, 30.7)]).actions[0].type, "abort");

// Threshold boundaries are float-class independent too: setpoint 19.2 makes an
// exactly-13.0°F margin compute to 13.000000000000004, yet it must behave like
// the exact 13.0 at line ~149 — never a trigger. Same for an exactly-8.0°F
// recovery delta (32.3 − 24.3 = 7.9999999999999964): NOT within 8°F, no restore.
assert.ok(brun({ ...BOOST_IDLE }, rep(6, bs(32.2, 19.2))).actions.every((a) => a === null));
const A243 = { phase: "active", originalF: 24.3, lastWrittenF: 33, writes: 1, trigCount: 0, restoreCount: 0 };
assert.ok(brun(A243, rep(8, bs(32.3, 33))).actions.every((a) => a === null)); // exactly 8.0°F over: not within
assert.strictEqual(brun(A243, rep(5, bs(32.2, 33))).actions[4].type, "restore"); // 7.9°F over: restores

// A raise that can't restore at least 1°F of margin is ceiling-bound: alert
// that automation can't help instead of spending a write on a 0.1°F bump.
boost = brun({ ...BOOST_IDLE }, rep(5, bs(58.1, 44.9))); // target min(48.1, 45) = 45: a 0.1°F "raise"
assert.strictEqual(boost.actions[4].type, "ceiling-alert");
assert.strictEqual(boost.state.writes, 0); // no write budget spent

// Malformed thresholds must refuse to start (validBoostThresholds) AND fail
// safe inside decide(): a NaN dwell (BOOST_DWELL_MIN="5m") satisfies neither
// dwell gate, so nothing ever fires — no instant raise, no ceiling-alert spam,
// and no phantom restore.
assert.ok(validBoostThresholds(th));
for (const bad of [{ DWELL: NaN }, { DWELL: 0 }, { DWELL: 2.5 }, { MAX_WRITES: 0 }, { MAX_WRITES: NaN }, { MARGIN_F: NaN }, { CEIL_F: Infinity }]) {
  assert.ok(!validBoostThresholds({ ...th, ...bad }), JSON.stringify(bad));
}
const nanTh = { ...th, DWELL: NaN };
assert.ok(brun({ ...BOOST_IDLE }, rep(6, bs(50, 29)), nanTh).actions.every((a) => a === null)); // 21°F over: still no raise
assert.ok(brun(ACTIVE, rep(50, bs(30, 33)), nanTh).actions.every((a) => a === null)); // recovered: no alert/restore spam

// State survives a JSON round-trip (boost_state.json persistence): a restart
// mid-incident restores the same behavior, including the original setpoint.
const revived = JSON.parse(JSON.stringify(ACTIVE));
assert.deepStrictEqual(brun(revived, rep(5, bs(36.5, 33))), brun(ACTIVE, rep(5, bs(36.5, 33))));

// reviveState guards what actually comes off disk. Dwell counters do NOT
// survive a restart — "5 consecutive samples" means consecutive from this
// process, so a process that died at trigCount 4 must re-earn the full dwell.
assert.deepStrictEqual(reviveState({ ...ACTIVE, trigCount: 4, restoreCount: 4 }),
  { state: { ...ACTIVE, trigCount: 0, restoreCount: 0 }, latched: false });
assert.strictEqual(brun(reviveState({ ...ACTIVE, trigCount: 4 }).state, [bs(47, 33)]).actions[0], null); // over-margin, but 1 of 5
// An "active" record missing finite originalF/lastWrittenF (hand edit, schema
// drift) falls back to idle instead of making decide() throw every tick.
assert.deepStrictEqual(reviveState({ phase: "active" }), { state: { ...BOOST_IDLE }, latched: false });
assert.strictEqual(reviveState({ phase: "active", originalF: 29 }).state.phase, "idle");
assert.deepStrictEqual(reviveState(null).state, { ...BOOST_IDLE });
assert.strictEqual(reviveState({ ...ACTIVE, writes: "many" }).state.writes, 0); // junk writes clamps to 0
// The wrong-register latch persists across restarts: one bad register must not
// earn a fresh live write per systemd restart.
assert.strictEqual(reviveState({ ...BOOST_IDLE, latched: true }).latched, true);

// Freeze floor (5 elapsed min) and lost flow while the pump runs (2 elapsed min)
assert.ok(seq(...rep(6, warm(195)))[5][0].includes("below the freeze floor")); // 19.5°F
const dry = { ...OK, web: { ...WEB_OK, "Glycol flow A ok": 0 } };
assert.deepStrictEqual(seq(dry, dry)[1], []); // samples at t=0 and t=1 are only one minute apart
assert.ok(seq(dry, dry, dry)[2][0].includes("No glycol flow, circuit A"));
assert.deepStrictEqual(seq(dry, dry, dry, { ...OK, web: null })[3], []);
// pumps off is not a flow fault, however the switches read
assert.deepStrictEqual(
  seq(...rep(3, { ...OK, web: { ...WEB_OK, "Chiller pump on": 0, "Process pump on": 0, "Glycol flow A ok": 0, "Glycol flow B ok": 0 } })).flat(),
  []);

// Even if something injects a dead ResLvl of 0 into web state, no derived
// reservoir-low Slack alert exists; Al_LowlvlSensor still uses the alarm path.
assert.deepStrictEqual(seq(...rep(6, { ...OK, web: { ...WEB_OK, "Reservoir level": 0 } })).flat(), []);

// Runtime imbalance past 100 h
assert.ok(seq({ ...OK, regs: { ...REGS_OK, 135: 900, 141: 500 } })[0][0].includes("400 h apart"));

// Not cooling: a compressor running 20 min with glycol off setpoint and NOT falling.
// The controller raises no alarm for this — the circuit looks like it's working.
assert.ok(seq(...rep(21, hot)).flat().join("\n").includes("Compressors running but not cooling"));
// but glycol that IS falling under the compressors is just a pulldown — never fires
const falling = Array.from({ length: 21 }, (_, i) => ({ ...hot, regs: { ...hot.regs, 68: 600 - i * 10 } }));
assert.ok(!seq(...falling).flat().join("\n").includes("not cooling"));

// Offline holds one poll: a restart loses the race for the chiller's Modbus socket,
// so the first failed read is expected and must not post.
const down = { regs: null, web: null, alarms: null };
assert.deepStrictEqual(seq(down)[0], []);
assert.ok(seq(down, down)[1][0].includes("Chiller unreachable"));
assert.ok(seq(down, down, OK)[2][0].includes("Chiller unreachable recovered"));

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
// strips). /api/log's X-Log-Loading header no longer drives a visible badge — it
// only speeds the poll and words the empty state — so app.js still anchors it but
// the page has nothing to show. Plus the three.js import + bridge in unit3d.js.
for (const anchor of ["/uplot.js", "ranges"]) {
  assert.ok(PAGE.includes(anchor), anchor);
}
for (const anchor of ["/api/all", "/api/log", "W_InTempUser", "W_OutTempUser",
                      // register names keep the controller's spelling; UI labels are spelled out
                      "Comp1Circ1_Dout.Val", "Comp2Circ2_On", "Compressor B",
                      "X-Log-Loading", "ChillerDateTime", "unit3d"]) {
  assert.ok(APP.includes(anchor), anchor);
}
for (const anchor of ["/three.js", "unit3d", "chipAnchors"]) {
  assert.ok(UNIT3D.includes(anchor), anchor);
}

// Starting before the scheduled hour leaves today's summary eligible; starting
// during or after it suppresses a misleading tiny same-day window.
assert.strictEqual(initialDailyKey(new Date(2026, 6, 13, 7, 0), 8), null);
assert.strictEqual(initialDailyKey(new Date(2026, 6, 13, 8, 0), 8), "2026-07-13");

// /chiller is rendered entirely from injectable reads. Exercise every command
// without a Slack connection or controller; Socket Mode is only the transport.
const CMD_REGS = {
  ...REGS_OK, 1: 520, 2: 480, 3: 1800, 4: 900, 10: 300, 11: 250, 23: 50, 26: 425, 31: 1, 33: 667,
  34: 0, 35: 1700, 36: 880, 42: 290, 43: 240, 55: 60, 58: 300, 62: 0, 64: 500,
  129: 1200, 131: 1100, 135: 500, 141: 505, 158: 800, 160: 810,
};
const CMD_ALARMS = {
  active: [],
  recent: [{ name: "High glycol temp", at: "2026-07-13T01:00:00", cleared: "2026-07-13T01:12:00" }],
};
const FRIENDLY_ALARMS = alarmsText({
  active: [{ name: "Reservoir low level", since: "2026-07-11T03:26:41-07:00" }],
  recent: [
    { name: "Reservoir low level", at: "2026-07-11T03:26:41-07:00", cleared: "2026-07-11T03:29:05-07:00" },
    { name: "Freeze protection, circuit A", at: "2026-07-11T02:14:44-07:00", cleared: "2026-07-11T02:14:44-07:00" },
    { name: "High glycol temp", at: "2026-07-10T17:56:29-07:00", cleared: "2026-07-11T00:51:40-07:00" },
  ],
});
assert.ok(FRIENDLY_ALARMS.includes("active since Jul 11, 2026 at 3:26 AM"));
assert.ok(FRIENDLY_ALARMS.includes("Jul 11, 2026 · 3:26–3:29 AM · lasted 2 min 24 sec"));
assert.ok(FRIENDLY_ALARMS.includes("Jul 11, 2026 at 2:14 AM · cleared immediately"));
assert.ok(FRIENDLY_ALARMS.includes("Jul 10, 2026 at 5:56 PM → Jul 11, 2026 at 12:51 AM · lasted 6 hr 55 min"));
assert.ok(!FRIENDLY_ALARMS.includes("T03:26:41"));
const TREND_CSV = [
  'TIME,"W_InTempUser","W_OutTempUser"',
  "2026-07-13T01:00:00-04:00,10,4",
  "2026-07-13T02:00:00-04:00,11,5",
].join("\n");
const TREND = trendFromCsv(TREND_CSV);
assert.ok(TREND && TREND.n === 2 && TREND.outMin === 39.2 && TREND.outMax === 41);
const cmdDeps = {
  read: async () => CMD_REGS,
  readWeb: async () => WEB_OK,
  readAlarms: async () => CMD_ALARMS,
  logSlice: () => TREND_CSV,
  logLoading: () => false,
  now: () => new Date(2026, 6, 13, 3).getTime(),
};

(async () => {
  // writeSetpoint's own hard clamp: values outside 15..60°F are refused before
  // any connection is attempted (wrote:false, no ambiguity), independent of the
  // env-tunable BOOST_* thresholds — the one function that touches hardware
  // does not trust its caller.
  for (const bad of [NaN, Infinity, 10, 14.9, 60.1, 80, null]) {
    const r = await writeSetpoint(/** @type {number} */ (bad));
    assert.ok(!r.ok && r.wrote === false && r.readback === null && /outside the hard/.test(r.error || ""), String(bad));
  }

  // fetch resolves for HTTP failures, so post() must inspect `ok` explicitly.
  assert.strictEqual(await post({}, async () => new Response("no", { status: 503 }), () => {}), false);

  // A failed edge stays at the head of the outbox. Once Slack recovers, both it
  // and the later edge are delivered in order instead of being consumed.
  const queue = [{ text: "critical" }, { text: "recovery" }];
  let attempts = 0;
  assert.strictEqual(await flushPosts(queue, async () => ++attempts > 1), false);
  assert.strictEqual(queue.length, 2);
  assert.strictEqual(await flushPosts(queue, async () => true), true);
  assert.strictEqual(queue.length, 0);

  let reply = await commandResponse("", cmdDeps); // empty command defaults to status
  assert.strictEqual(reply.response_type, "ephemeral");
  assert.ok(reply.text.includes("Chiller status — Online") && reply.text.includes("Alarms: none active") &&
    reply.text.includes("12.0°F drop") && reply.text.includes("52.0% demand"));
  reply = await commandResponse("status share", cmdDeps);
  assert.strictEqual(reply.response_type, "in_channel");
  assert.ok((await commandResponse("alarms", cmdDeps)).text.includes("High glycol temp"));
  const trendReply = await commandResponse("trend 6h", cmdDeps);
  assert.ok(trendReply.text.includes("Supply 39.2–41.0°F") && trendReply.text.includes("Jul 13, 2026 · 1:00–2:00 AM"));
  assert.ok(!trendReply.text.includes("2026-07-13T"));
  assert.ok((await commandResponse("trend month", cmdDeps)).text.includes("/chiller trend 6h"));
  assert.ok((await commandResponse("circuit a", cmdDeps)).text.includes("30.0 psi suction"));
  assert.ok((await commandResponse("circuit b", cmdDeps)).text.includes("170.0 psi discharge"));
  assert.ok((await commandResponse("runtimes", cmdDeps)).text.includes("chiller 1,200 h"));
  const whyDeps = { ...cmdDeps, read: async () => ({ ...CMD_REGS, 31: 0, 68: 400 }) };
  assert.ok((await commandResponse("why", whyDeps)).text.includes("neither compressor reports running"));
  assert.ok((await commandResponse("help", cmdDeps)).text.includes("/chiller commands"));

  // All command responses use plain text status labels: no Slack emoji codes,
  // Unicode pictographs, or raw logger timestamps should leak into the UI.
  const everyCommand = await Promise.all([
    "status", "alarms", "trend 6h", "circuit a", "circuit b", "runtimes", "why", "help",
  ].map(async (command) => (await commandResponse(command, cmdDeps)).text));
  for (const text of everyCommand) {
    assert.ok(!/:[a-z][a-z0-9_+-]*:/i.test(text), text);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), text);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), text);
  }
  console.log("ok");
})().catch((e) => { console.error(e); process.exitCode = 1; });
