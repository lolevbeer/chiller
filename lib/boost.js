// Automatic setpoint boost — the one write path in an otherwise read-only app.
//
// The c.pCO firmware has a HARDCODED high-glycol alarm: when supply temperature
// exceeds setpoint + 18°F (10°C, a firmware constant — TRIP_F below) it alarms
// and SHUTS THE UNIT DOWN. A shutdown is the worst outcome for the glycol loop,
// so when supply climbs to within 5°F of that trip (margin > BOOST_MARGIN_F)
// this module RAISES the setpoint to supply − BOOST_DROP_F, restoring 10°F of
// margin while the compressors keep pulling the loop down, and writes the
// original setpoint back once supply recovers to within BOOST_RESTORE_F of it.
//
// Structured like lib/slack.js: decide() is the pure core — no I/O, no clock,
// driven through whole incidents by test.js — and startBoost() is the thin
// shell that reads, writes, posts to Slack, and persists state across restarts.
// Everything is inert unless SETPOINT_WRITE=1, the BOOST_* thresholds validate
// (validBoostThresholds), and the writable holding register has been confirmed
// with probe_setpoint.js first — see README.
const fs = require("fs");
const path = require("path");
const { scale, read, writeSetpoint } = require("./modbus"); // also loads .env via ./config

// The firmware trip: supply > setpoint + TRIP_F ⇒ alarm + shutdown. Not a knob.
const TRIP_F = 18;

// Thresholds, all tunable. BOOST_MARGIN_F/BOOST_DROP_F are also read by the
// manual-fallback Slack nudge in lib/slack.js — one env name per knob.
const BOOST_MARGIN_F = Number(process.env.BOOST_MARGIN_F || 13); // °F over setpoint that arms a raise (5°F before the trip)
const BOOST_DROP_F = Number(process.env.BOOST_DROP_F || 10); // raise target = supply − this (margin restored to 10°F)
const BOOST_RESTORE_F = Number(process.env.BOOST_RESTORE_F || 8); // °F over the ORIGINAL setpoint that ends the incident
const BOOST_CEIL_F = Number(process.env.BOOST_CEIL_F || 45); // never write a setpoint above this
const BOOST_DWELL_MIN = Number(process.env.BOOST_DWELL_MIN || 5); // consecutive samples before acting
const BOOST_MAX_WRITES = Number(process.env.BOOST_MAX_WRITES || 10); // raises per incident before standing down

// Bundled so tests can drive decide() with overrides; production always uses env.
const TH = { MARGIN_F: BOOST_MARGIN_F, DROP_F: BOOST_DROP_F, RESTORE_F: BOOST_RESTORE_F,
  CEIL_F: BOOST_CEIL_F, DWELL: BOOST_DWELL_MIN, MAX_WRITES: BOOST_MAX_WRITES };

/**
 * Incident state. Plain JSON — it round-trips through boost_state.json so a
 * restart mid-incident still knows the original setpoint to restore.
 * @typedef {{phase: "idle" | "active",
 *            originalF: number | null,   // setpoint before the first raise — the restore target
 *            lastWrittenF: number | null, // what we last wrote; the tamper-guard reference
 *            writes: number,             // raises this incident, capped at MAX_WRITES
 *            trigCount: number,          // consecutive over-margin samples (dwell)
 *            restoreCount: number}} BoostState  // consecutive recovered samples (dwell)
 */
/** @typedef {{type: "raise" | "restore" | "abort" | "ceiling-alert", targetF?: number, reason: string}} BoostAction */
/** @typedef {{t: number, supplyF: number | null, setpointF: number | null}} BoostSample */

/** @type {BoostState} */
const IDLE = Object.freeze({ phase: "idle", originalF: null, lastWrittenF: null, writes: 0, trigCount: 0, restoreCount: 0 });

const F = (/** @type {number} */ n) => `${n.toFixed(1)}°F`;
const r1 = (/** @type {number} */ n) => Math.round(n * 10) / 10; // targets kept to the controller's 0.1°F resolution
// Threshold comparisons happen in integer tenths — the controller stores temps
// as x10 int16, and float subtraction of the scaled values makes an exactly-13.0°F
// margin read 13.000000000000004 for some register pairs and 13.0 for others.
// A boundary must behave the same for every setpoint value.
const t10 = (/** @type {number} */ n) => Math.round(n * 10);

/**
 * BOOST_* env values only become numbers when the .env said a number — "5m"
 * parses to NaN, and every NaN comparison is false, which would gut the dwell
 * gates (instant raises, ceiling-alert spam, no restore). startBoost refuses to
 * run with unusable thresholds rather than degrade like that.
 * @param {typeof TH} th @returns {boolean}
 */
const validBoostThresholds = (th = TH) =>
  Number.isInteger(th.DWELL) && th.DWELL >= 1 &&
  Number.isInteger(th.MAX_WRITES) && th.MAX_WRITES >= 1 &&
  [th.MARGIN_F, th.DROP_F, th.RESTORE_F, th.CEIL_F].every(Number.isFinite);

/**
 * The pure core: one poll's readings in, next state + at most one action out.
 * The shell performs the action (write/alert); decide never touches I/O.
 *
 * All temperature comparisons are done in integer tenths (t10) so float noise
 * on the x10-register-derived values can never move a boundary, and both dwell
 * gates are written to fail safe: a NaN dwell (malformed env, refused by
 * startBoost anyway) satisfies neither, so nothing ever fires.
 *
 * - Sanity guards: null/non-finite readings, supply outside 10..90°F, or
 *   setpoint outside 15..60°F act on nothing and reset both dwell counters —
 *   a glitch must never trigger, sustain, or end an incident.
 * - Tamper guard (active only): a setpoint more than 0.2°F (two register
 *   counts) from what we last wrote means a human intervened — the automation
 *   aborts and stands down, naming the pre-boost setpoint for manual restore.
 * - Trigger/ratchet: margin over the CURRENT setpoint > MARGIN_F for DWELL
 *   consecutive samples raises to min(supply − DROP_F, CEIL_F). When that
 *   target can't raise the setpoint by at least 1°F (a smaller raise can't
 *   meaningfully restore margin — don't spend a write on it), or the incident
 *   already spent MAX_WRITES raises, it emits ceiling-alert instead: shutdown
 *   may be imminent and automation can do no more. The dwell counter resets on
 *   every emit, so a standing ceiling condition re-alerts only once per dwell.
 * - Restore: while active, supply within RESTORE_F of the ORIGINAL setpoint
 *   for DWELL consecutive samples restores originalF and clears the incident.
 *
 * @param {BoostState} prev @param {BoostSample} s @param {typeof TH} th
 * @returns {{state: BoostState, action: BoostAction | null}}
 */
function decide(prev, s, th = TH) {
  const { supplyF, setpointF } = s;
  const sane = Number.isFinite(supplyF) && Number.isFinite(setpointF) &&
    supplyF >= 10 && supplyF <= 90 && setpointF >= 15 && setpointF <= 60;
  if (!sane) return { state: { ...prev, trigCount: 0, restoreCount: 0 }, action: null };

  // > 2 register counts, not > 0.2°F: the float form makes the 0.2 tolerance
  // effectively 0.1°F for ~half of all setpoint values (30.6−30.4 computes to
  // 0.20000000000000284), turning readback noise into a false abort.
  if (prev.phase === "active" && Math.abs(t10(setpointF) - t10(prev.lastWrittenF)) > 2) {
    return { state: { ...IDLE }, action: { type: "abort",
      reason: `setpoint reads ${F(setpointF)} but the automation last wrote ${F(prev.lastWrittenF)} — a human intervened, so the automation is standing down. The pre-boost setpoint was ${F(prev.originalF)}` } };
  }

  const restoreCount = prev.phase === "active" && t10(supplyF) - t10(prev.originalF) < t10(th.RESTORE_F) ? prev.restoreCount + 1 : 0;
  // Guarded on phase so restore can only ever fire from an active incident
  // (originalF is guaranteed finite there); >= fails safe under a NaN dwell.
  if (prev.phase === "active" && restoreCount >= th.DWELL) {
    return { state: { ...IDLE }, action: { type: "restore", targetF: prev.originalF,
      reason: `supply ${F(supplyF)} is back within ${th.RESTORE_F}°F of the original ${F(prev.originalF)} setpoint` } };
  }

  const margin = supplyF - setpointF; // display only — comparisons stay in tenths
  const trigCount = t10(supplyF) - t10(setpointF) > t10(th.MARGIN_F) ? prev.trigCount + 1 : 0;
  const state = { ...prev, trigCount, restoreCount };
  // Inverted (not `trigCount < DWELL`) so a NaN dwell fails safe: NaN satisfies
  // no comparison, and falling through here would raise on the FIRST sample.
  if (!(trigCount >= th.DWELL)) return { state, action: null };

  state.trigCount = 0; // every emit re-arms the dwell
  if (prev.writes >= th.MAX_WRITES) {
    return { state, action: { type: "ceiling-alert",
      reason: `already raised the setpoint ${prev.writes} times this incident (BOOST_MAX_WRITES) and supply ${F(supplyF)} is still ${F(margin)} over — shutdown at setpoint + ${TRIP_F}°F may be imminent` } };
  }
  const targetF = r1(Math.min(supplyF - th.DROP_F, th.CEIL_F));
  // Less than a 1°F raise cannot meaningfully restore margin — alert that the
  // ceiling has us pinned instead of spending a write (and a fresh dwell) on a
  // cosmetic 0.1°F bump while shutdown is genuinely imminent.
  if (t10(targetF) - t10(setpointF) < 10) {
    return { state, action: { type: "ceiling-alert",
      reason: `supply ${F(supplyF)} is ${F(margin)} over the ${F(setpointF)} setpoint but the ${F(th.CEIL_F)} ceiling leaves no useful room to raise it — shutdown at setpoint + ${TRIP_F}°F may be imminent` } };
  }
  return {
    state: { phase: "active", originalF: prev.phase === "active" ? prev.originalF : setpointF,
      lastWrittenF: targetF, writes: prev.writes + 1, trigCount: 0, restoreCount: 0 },
    action: { type: "raise", targetF,
      reason: `supply ${F(supplyF)} is ${F(margin)} over the ${F(setpointF)} setpoint — the controller shuts the unit down at setpoint + ${TRIP_F}°F` },
  };
}

// ---------------------------------------------------------------------------
// Shell: poll → decide → write → post → persist. Inert unless SETPOINT_WRITE=1.

const BOOST_POLL_MIN = Number(process.env.BOOST_POLL_MIN || 1);
// Same __dirname-relative pattern as logcache.js: under systemd the cwd isn't the repo.
const STATE_FILE = process.env.BOOST_STATE_FILE || path.join(__dirname, "..", "boost_state.json");

/** @type {BoostState} */
let state = { ...IDLE };
// Wrong-register latch: a write that "succeeded" but read back wrong means
// SETPOINT_WREG is not the setpoint — writing an unknown register is worse
// than a shutdown. The latch is PERSISTED in boost_state.json: the dashboard
// auto-restarts under systemd, and an in-memory latch would grant one fresh
// wrong-register write per restart. Clearing it takes a human — delete
// boost_state.json after re-verifying the register with probe_setpoint.js.
let latched = false;
let failedWrites = 0; // consecutive connection-level write failures (in-memory; a restart retries fresh)

/**
 * Validate a parsed boost_state.json into safe in-memory state. Pure; exported
 * for tests. Fields are whitelisted, never spread wholesale:
 * - an "active" record without finite originalF/lastWrittenF (truncation, hand
 *   edit, schema drift) would make decide() throw on every tick, so it falls
 *   back to idle instead;
 * - dwell counters are deliberately dropped — "DWELL consecutive samples"
 *   means consecutive from THIS process, not 4 samples from before an
 *   arbitrarily long outage.
 * @param {any} j @returns {{state: BoostState, latched: boolean}}
 */
const reviveState = (j) => {
  const wasLatched = !!(j && j.latched);
  if (!wasLatched && j && j.phase === "active" &&
      Number.isFinite(j.originalF) && Number.isFinite(j.lastWrittenF)) {
    return { latched: false, state: { ...IDLE, phase: "active", originalF: j.originalF,
      lastWrittenF: j.lastWrittenF, writes: Number.isFinite(j.writes) ? j.writes : 0 } };
  }
  return { state: { ...IDLE }, latched: wasLatched };
};
const loadState = () => {
  try { return reviveState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); }
  catch { return { state: { ...IDLE }, latched: false }; } // missing or corrupt file — fresh idle
};
const saveState = () => // atomic tmp+rename like logcache's saveLog: a crash can't leave a torn file
  fs.promises.writeFile(STATE_FILE + ".tmp", JSON.stringify(latched ? { ...state, latched: true } : state))
    .then(() => fs.promises.rename(STATE_FILE + ".tmp", STATE_FILE))
    .catch((e) => console.error("boost state save failed:", e.message));

// Alerts ride the same webhook as lib/slack.js — but only when it's configured.
// Failed deliveries are RETAINED and retried at the start of every tick (same
// flushPosts contract as slack.js): a live setpoint write must never go
// unreported because one webhook call happened to fail. Required lazily to keep
// the boost↔slack require edge one-directional at load (slack.js imports this
// module's thresholds).
const pendingNotes = [];
const flushNotes = () =>
  pendingNotes.length ? require("./slack").flushPosts(pendingNotes) : Promise.resolve(true);
const notify = (/** @type {string} */ text) => {
  if (!process.env.SLACK_WEBHOOK_URL) return Promise.resolve(false);
  pendingNotes.push({ text });
  return flushNotes();
};

// Only these fields need to reach disk: dwell counters are process-local by
// design (see reviveState), so counter-only changes skip the SD-card write.
const core = (/** @type {BoostState} */ st) => JSON.stringify([st.phase, st.originalF, st.lastWrittenF, st.writes]);

/** One poll of the boost loop. Never throws: startBoost calls this unawaited
 * from setInterval, so an uncaught error here would be an unhandled rejection —
 * a surprise must cost one tick, never the process. */
async function boostTick() {
  try { await boostCycle(); }
  catch (e) { console.error("boost tick failed:", e instanceof Error ? e.message : e); }
}

async function boostCycle() {
  await flushNotes(); // deliver any notification a previous tick failed to post
  if (latched) return; // wrong register — never write (or decide) again until boost_state.json is cleared
  const regs = await read();
  const s = { t: Date.now(),
    supplyF: regs ? scale(regs[68]) : null, setpointF: regs ? scale(regs[70]) : null };
  const prev = state;
  const { state: next, action } = decide(prev, s);
  state = next;
  const isWrite = action && (action.type === "raise" || action.type === "restore");
  // Persist non-write transitions (e.g. abort) now. Write outcomes persist only
  // AFTER writeSetpoint resolves: saving first would leave a crash window where
  // the file claims a write that never happened, and the next start would read
  // the stale register as tampering and falsely abort a live incident.
  if (!isWrite && core(next) !== core(prev)) await saveState();
  if (!action) return;

  if (action.type === "ceiling-alert") { await notify(`🚨 *Chiller shutdown may be imminent — setpoint boost can't help*\n${action.reason}`); return; }
  if (action.type === "abort") { await notify(`⚠️ *Setpoint boost aborted*\n${action.reason}`); return; }

  // raise or restore: perform the write, then report what actually happened.
  const res = await writeSetpoint(action.targetF);
  if (res.ok) {
    failedWrites = 0;
    await saveState();
    await notify(action.type === "raise"
      ? `🔺 *Chiller setpoint raised ${F(s.setpointF)} → ${F(action.targetF)}*\n${action.reason}. Raised to keep ${BOOST_DROP_F}°F of margin while the compressors pull the loop down. The original setpoint (${F(state.originalF)}) is restored automatically once supply is within ${BOOST_RESTORE_F}°F of it.`
      : `✅ *Chiller setpoint restored to ${F(action.targetF)} — boost incident over*\n${action.reason}. The loop is back down; normal setpoint is in effect.`);
  } else if (res.readback !== null) {
    // The controller accepted the write but the setpoint didn't move: we are
    // writing the WRONG register. Stand down for good — the latch persists
    // across restarts — and say so loudly.
    latched = true;
    state = { ...IDLE };
    await saveState();
    await notify(`🚨 *Setpoint boost disabled: write went to the wrong register*\nWrote ${F(action.targetF)} but the setpoint reads back ${F(res.readback)}. SETPOINT_WREG looks wrong — no further writes until the register is re-verified with probe_setpoint.js and boost_state.json is deleted.${prev.originalF != null ? ` Check the controller: the intended setpoint was ${F(prev.originalF)}.` : ""}`);
  } else if (res.wrote) {
    // The FC6 request went out but verification never completed — the write MAY
    // have landed. Forgetting it would orphan a raised setpoint with no restore
    // path, so assume it landed: keep the post-raise state (or, for a restore,
    // stay active tracking the still-raised setpoint) and let next tick's
    // tamper guard check reality — a matching readback continues normally, a
    // mismatch aborts loudly instead of silently abandoning a live write.
    state = action.type === "raise" ? next : prev;
    await saveState();
    await notify(`⚠️ *Setpoint ${action.type} sent but not verified (${res.error || "no response"})*\nWrote ${F(action.targetF)} but the readback never completed — the next poll re-checks whether it landed. ${action.reason}.`);
  } else {
    // Connection-level failure before the request went out: nothing was
    // written. Keep the pre-decide state so the same edge (dwell already
    // satisfied) retries next tick, bounded. Only the FIRST failure of a streak
    // posts — repeats would be spam, and the give-up alert closes the streak.
    failedWrites++;
    if (failedWrites > BOOST_MAX_WRITES) {
      state = { ...IDLE };
      failedWrites = 0;
      await saveState();
      await notify(`🚨 *Setpoint boost giving up after ${BOOST_MAX_WRITES} failed write attempts*\nThe chiller is not accepting Modbus writes. Set the setpoint by hand${prev.originalF != null ? ` (normal setpoint: ${F(prev.originalF)})` : ""} — the controller shuts down at setpoint + ${TRIP_F}°F.`);
    } else {
      state = prev;
      if (failedWrites === 1) await notify(`⚠️ *Setpoint write failed (${res.error || "no response"}) — retrying every poll*\nWanted to ${action.type} the setpoint to ${F(action.targetF)}. ${action.reason}. Further failures post only if the boost gives up.`);
    }
  }
}

/** Start the boost loop. No-op (returns false) unless SETPOINT_WRITE=1 AND
 * every BOOST_* threshold parses to a usable number — a malformed .env must
 * disable the automation, not degrade its gates (see validBoostThresholds). */
const startBoost = () => {
  if (process.env.SETPOINT_WRITE !== "1") return false;
  if (!validBoostThresholds()) {
    console.error("setpoint boost NOT started: a BOOST_* value in .env is not a usable number", TH);
    return false;
  }
  ({ state, latched } = loadState()); // resume a mid-incident restart (and any persisted wrong-register latch)
  if (latched) console.error("setpoint boost latched from a previous wrong-register write — no writes until boost_state.json is deleted after re-probing SETPOINT_WREG");
  boostTick();
  setInterval(boostTick, BOOST_POLL_MIN * 60 * 1000);
  return true;
};

module.exports = { decide, reviveState, validBoostThresholds, IDLE, TH, TRIP_F, BOOST_MARGIN_F, BOOST_DROP_F, startBoost };
