// Modbus TCP access to the c.pCO: the live INPUT-register feed (read), the x10
// scaling shared by everything that interprets those registers, and the one
// deliberate write path this project has — writeSetpoint(), used only by the
// opt-in setpoint-boost automation in lib/boost.js (gated on SETPOINT_WRITE=1).
// modbus-serial's CJS export is the class itself, but its .d.ts declares it as
// a default export — retype the require so tsc sees the constructor
const ModbusRTU = /** @type {typeof import("modbus-serial").default} */ (/** @type {unknown} */ (require("modbus-serial")));
const { HOST } = require("./config");

const COUNT = Number(process.env.CHILLER_REGS || 162); // confirmed map spans 0..160

// INPUT-register labels confirmed by time-series correlation against the
// controller's own getvar.csv (see correlate_registers.py): a register earns a
// label only by tracking that variable across every sample while running.
// Circuit 1 occupies 0..33, circuit 2 mirrors it ~+32 (a few points sit at +31:
// comp-on 31->62, fan set 32->63, fan out 33->64). Integer regs (status/counts)
// are NOT x10; only analog temps/pressures are. Fan speed and EEV position DO
// exist here (33/64, 26/58) — only glycol supply pressure remains web-only
// among the live analogs (Modbus_FB block for the serial BMS port). ResLvl is
// also exported there but is unused on this unit — see UNUSED_WEB_VARS.
const LABELS = {
  0: "Chiller status (int enum, Modbus_FB.ChillerStat)",
  1: "Power request (int, tenths of %; 1000=100%)",
  2: "Power running circ 1 (int, tenths of %)",
  29: "Suction SH setpoint circ 1 °F",
  32: "Condenser fan setpoint circ 1 °F",
  33: "Fan output circ 1 %",
  34: "Power running circ 2 (int, tenths of %)",
  3: "Discharge pres circ 1 psi",
  4: "Condensing temp circ 1 °F",
  9: "Suction temp circ 1 °F",
  10: "Suction pres circ 1 psi",
  11: "Evaporating temp circ 1 °F",
  13: "Circuit 1 status (int enum)",
  26: "EEV position circ 1 %",
  31: "Compressor circ 1 on (bool)",
  23: "Suction superheat circ 1",
  24: "Discharge superheat circ 1",
  28: "EVD valve status circ 1 (int)",
  35: "Discharge pres circ 2 psi",
  36: "Condensing temp circ 2 °F",
  41: "Suction temp circ 2 °F",
  42: "Suction pres circ 2 psi",
  43: "Evaporating temp circ 2 °F",
  45: "Circuit 2 status (int enum)",
  58: "EEV position circ 2 %",
  62: "Compressor circ 2 on (bool)",
  55: "Suction superheat circ 2",
  56: "Discharge superheat circ 2",
  61: "Suction SH setpoint circ 2 °F",
  63: "Condenser fan setpoint circ 2 °F",
  64: "Fan output circ 2 %",
  68: "Glycol outlet °F",
  69: "Glycol inlet °F",
  70: "Cooling setpoint °F",
  129: "User pump 1 hours (int)",
  131: "User pump 2 hours (int)",
  132: "Glycol reservoir temp °F",
  135: "Compressor 1 circ 1 hours (int)",
  141: "Compressor 1 circ 2 hours (int)",
  158: "Source fan 1 circ 1 hours (int)",
  160: "Source fan 1 circ 2 hours (int)",
};

// CAREL analog values are signed int16, stored x10 (one decimal). Handle negatives.
/** @param {number} v raw uint16 register @returns {number} engineering value */
const scale = (v) => (v > 32767 ? v - 65536 : v) / 10;

/** @returns {Promise<Record<number, number> | null>} addr -> raw uint16, null on failure */
async function read() {
  // INPUT registers (FC4) hold the live sensor feed; HOLDING (FC3) are setpoints.
  const c = new ModbusRTU();
  c.setTimeout(3000);
  try {
    // connectTCP has no connect timeout of its own (setTimeout above only covers
    // responses) — race it so an unreachable chiller answers null in 5 s, not the
    // OS's ~75 s. Promise.race marks the loser handled, so its rejection would
    // otherwise vanish — log it ourselves: it carries the real diagnostic
    // (ECONNREFUSED vs EHOSTUNREACH vs timed out).
    const conn = c.connectTCP(HOST, { port: 502 });
    conn.catch((e) => console.error("modbus connect:", e?.message ?? e));
    await Promise.race([conn,
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
    // destroy, not close: end() on a still-connecting socket waits out the OS
    // connect timeout, and each late-accepted socket pins one of the PLC's few
    // Modbus TCP slots — destroy() aborts the socket immediately
    try { c.destroy(); } catch {}
  }
}

// The HOLDING address the setpoint is written to. UNCONFIRMED by default — run
// probe_setpoint.js against the controller to verify it before ever setting
// SETPOINT_WRITE=1. (Input register 70 mirrors the value; the writable holding
// twin is assumed to sit at the same address until the probe says otherwise.)
// Default 1: FC3 holding address 1 is the active cooling setpoint per the
// README device findings (input register 70 is only the read-side mirror).
// Still probe-confirm with probe_setpoint.js before enabling SETPOINT_WRITE.
const SETPOINT_WREG = Number(process.env.SETPOINT_WREG || 1);

// Hard absolute bounds for ANY setpoint write, matching the sane-setpoint range
// boost.js accepts on reads. The env-tunable knobs (BOOST_CEIL_F et al.) are
// caller policy; the one function that touches hardware enforces its own floor
// and ceiling so a mis-set knob or future caller can never reach the controller
// with an insane value.
const WRITE_MIN_F = 15, WRITE_MAX_F = 60;

/**
 * Write the cooling setpoint (FC6, holding register SETPOINT_WREG) and verify
 * it took by reading input register 70 back through the existing FC4 path.
 * Refuses values outside the hard WRITE_MIN_F..WRITE_MAX_F bound without
 * touching the wire. Never throws; unlike the silent read path, every failure
 * is logged — a read that fails self-heals on the next poll, but a write that
 * fails (or lands in the wrong register) needs a human to hear about it.
 * @param {number} valueF setpoint in °F (stored x10 on the controller)
 * @returns {Promise<{ok: boolean, readback: number | null, wrote: boolean, error?: string}>}
 *   ok = write accepted AND readback within 0.05°F. readback null when the
 *   write or verify never completed (connection-level failure). wrote = the FC6
 *   request went out: when true with ok false the write is AMBIGUOUS — it may
 *   have landed without verification — and callers must not assume it didn't.
 */
async function writeSetpoint(valueF) {
  if (!(Number.isFinite(valueF) && valueF >= WRITE_MIN_F && valueF <= WRITE_MAX_F)) {
    const error = `refused: ${valueF}°F is outside the hard ${WRITE_MIN_F}..${WRITE_MAX_F}°F write bound`;
    console.error("setpoint write", error);
    return { ok: false, readback: null, wrote: false, error };
  }
  const c = new ModbusRTU();
  c.setTimeout(3000);
  let wrote = false;
  try {
    const conn = c.connectTCP(HOST, { port: 502 });
    conn.catch((e) => console.error("modbus connect:", e?.message ?? e));
    await Promise.race([conn,
      new Promise((_, rej) => setTimeout(rej, 5000, new Error("modbus connect timeout")).unref())]);
    c.setID(1);
    const w = c.writeRegister(SETPOINT_WREG, Math.round(valueF * 10));
    wrote = true; // request is on the wire — from here a failure is ambiguous, not "nothing written"
    await w;
    const rr = await c.readInputRegisters(70, 1);
    const readback = scale(rr.data[0]);
    const ok = Math.abs(readback - valueF) <= 0.05;
    if (!ok) console.error(`setpoint write did not take: wrote ${valueF}°F to holding ${SETPOINT_WREG}, input 70 reads back ${readback}°F`);
    return { ok, readback, wrote };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("setpoint write failed:", error);
    return { ok: false, readback: null, wrote, error };
  } finally {
    try { c.destroy(); } catch {}
  }
}

module.exports = { LABELS, scale, read, writeSetpoint };
