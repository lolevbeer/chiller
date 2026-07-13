// Modbus TCP reads from the c.pCO: the live INPUT-register feed (read) and the
// x10 scaling shared by everything that interprets those registers.
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
// exist here (33/64, 26/58) — only glycol supply pressure and reservoir level
// remain web-only (Modbus_FB block for the serial BMS port).
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

module.exports = { LABELS, scale, read };
