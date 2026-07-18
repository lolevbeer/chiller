// Operator-run discovery of the WRITABLE cooling-setpoint holding register,
// run ONCE before ever enabling SETPOINT_WRITE=1. The read map is confirmed
// (input register 70 mirrors the setpoint) but the holding-register twin the
// controller accepts writes on is not — writing an unknown register is worse
// than the shutdown the boost automation exists to dodge, so this script:
//
//   1. --read           reads INPUT (FC4) and HOLDING (FC3) registers 0..80
//                       side by side and highlights holding addresses whose
//                       value equals input 70 (setpoint candidates). Read-only.
//                       Holding 1 is the expected match (README device findings).
//   2. --write --yes-i-am-sure
//                       additionally performs the ONE no-op probe write: FC6
//                       of the CURRENT setpoint value (unchanged!) to
//                       SETPOINT_WREG (env, default 1), then re-reads both
//                       spaces and reports whether anything moved.
//
// Run with no flags and it refuses and prints usage — an accidental
// `node probe_setpoint.js` touches nothing. Exits non-zero on connect failure.
//
// Usage:  CHILLER_IP=192.168.1.69 node probe_setpoint.js --read
//         SETPOINT_WREG=1 node probe_setpoint.js --write --yes-i-am-sure
const ModbusRTU = /** @type {typeof import("modbus-serial").default} */ (/** @type {unknown} */ (require("modbus-serial")));
const { HOST } = require("./lib/config");

const WREG = Number(process.env.SETPOINT_WREG || 1);
// Registers 0..80 in one FC3/FC4 pair: covers holding 1 (the active cooling
// setpoint per the README device findings — the expected answer) plus the
// 60..80 glycol neighborhood of the confirmed input map, so one --read run
// settles the question either way.
const BASE = 0, COUNT = 81;
const SETPOINT_INPUT = 70; // confirmed read-side setpoint (FC4)

const args = process.argv.slice(2);
if (!args.includes("--read") && !args.includes("--write")) {
  console.error([
    "probe_setpoint.js — find the writable setpoint holding register (refuses to run bare).",
    "",
    "  node probe_setpoint.js --read                  read-only compare of input vs holding 0..80",
    "  node probe_setpoint.js --write --yes-i-am-sure  + ONE no-op write of the current setpoint to",
    `                                                  holding ${WREG} (SETPOINT_WREG), then re-verify`,
    "",
    `Target: ${HOST} (CHILLER_IP)`,
  ].join("\n"));
  process.exit(1);
}
if (args.includes("--write") && !args.includes("--yes-i-am-sure")) {
  console.error("--write performs a real Modbus write. Add --yes-i-am-sure to confirm. Nothing was written.");
  process.exit(1);
}

/** @param {InstanceType<typeof ModbusRTU>} c @returns {Promise<{input: number[], holding: number[]}>} */
async function snapshot(c) {
  const input = (await c.readInputRegisters(BASE, COUNT)).data;
  const holding = (await c.readHoldingRegisters(BASE, COUNT)).data;
  return { input, holding };
}

/** @param {{input: number[], holding: number[]}} s */
function printTable({ input, holding }) {
  const sp = input[SETPOINT_INPUT - BASE];
  console.log(`\n  addr | input (FC4) | holding (FC3)   setpoint = input ${SETPOINT_INPUT} = ${sp} (${(sp / 10).toFixed(1)}°F)`);
  for (let i = 0; i < COUNT; i++) {
    const mark = holding[i] === sp ? `   <-- holding ${BASE + i} matches the setpoint value` : "";
    console.log(`  ${String(BASE + i).padStart(4)} | ${String(input[i]).padStart(11)} | ${String(holding[i]).padStart(13)}${mark}`);
  }
}

(async () => {
  const c = new ModbusRTU();
  c.setTimeout(3000);
  try {
    // Same connect pattern as lib/modbus.js: race connectTCP against a 5 s
    // timer so an unreachable chiller fails fast, not at the OS's ~75 s.
    const conn = c.connectTCP(HOST, { port: 502 });
    conn.catch(() => {}); // surfaced via the race below
    await Promise.race([conn,
      new Promise((_, rej) => setTimeout(rej, 5000, new Error("connect timeout")).unref())]);
    c.setID(1);

    // Step 1 — read-only compare.
    const before = await snapshot(c);
    printTable(before);
    const matches = before.holding
      .map((v, i) => (v === before.input[SETPOINT_INPUT - BASE] ? BASE + i : null))
      .filter((a) => a !== null);
    console.log(`\nHolding addresses matching the current setpoint value: ${matches.length ? matches.join(", ") : "none in 0..80"}`);

    if (!args.includes("--write")) {
      console.log(`Read-only pass done. To probe writes: node probe_setpoint.js --write --yes-i-am-sure  (targets holding ${WREG})`);
      process.exit(0);
    }

    // Step 2 — the ONE write: the current setpoint value, unchanged. If WREG is
    // the setpoint, this is a no-op; if it's something else, only that register
    // shifts and the diff below says so before SETPOINT_WRITE is ever enabled.
    const current = before.input[SETPOINT_INPUT - BASE];
    console.log(`\nWriting the CURRENT setpoint value ${current} (${(current / 10).toFixed(1)}°F) unchanged to holding ${WREG} (FC6)…`);
    await c.writeRegister(WREG, current);
    const after = await snapshot(c);
    printTable(after);
    const moved = [];
    for (let i = 0; i < COUNT; i++) {
      if (after.input[i] !== before.input[i]) moved.push(`input ${BASE + i}: ${before.input[i]} -> ${after.input[i]}`);
      if (after.holding[i] !== before.holding[i]) moved.push(`holding ${BASE + i}: ${before.holding[i]} -> ${after.holding[i]}`);
    }
    console.log(moved.length
      ? `\nChanged after the write (glycol temps drift on their own; only a setpoint change is meaningful):\n  ${moved.join("\n  ")}`
      : "\nNothing changed after the write — consistent with a true no-op on the setpoint register.");

    console.log([
      "",
      `Conclusion: the write to holding ${WREG} was ${after.input[SETPOINT_INPUT - BASE] === current ? "accepted with the setpoint intact" : "FOLLOWED BY A SETPOINT CHANGE — investigate before proceeding"}.`,
      `If holding ${WREG} is confirmed as the setpoint, set SETPOINT_WREG=${WREG} (or the confirmed address) and`,
      "SETPOINT_WRITE=1 in .env, then restart the service to enable the automatic boost.",
    ].join("\n"));
    process.exit(0);
  } catch (e) {
    console.error("probe failed:", e instanceof Error ? e.message : String(e));
    process.exit(1); // non-zero on connect failure — do not copy find_registers.py's exit-0 wart
  } finally {
    try { c.destroy(); } catch {}
  }
})();
