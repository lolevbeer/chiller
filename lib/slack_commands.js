// Read-only /chiller command over Slack Socket Mode. Unlike the incoming
// webhook in slack.js, Socket Mode is bidirectional: the Pi opens an outbound
// WebSocket to Slack, receives commands, reads the same controller sources as
// the dashboard, and answers privately unless the user explicitly says share.
const { scale, read } = require("./modbus");
const { readWeb } = require("./webvars");
const { readAlarms } = require("./alarms");
const { logSlice, logLoading } = require("./logcache");

const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const DASH_URL = process.env.SLACK_DASHBOARD_URL || "";
const HIGH_F = Number(process.env.SLACK_HIGH_F || 5);
const LEL_PCT = Number(process.env.SLACK_LEL_PCT || 10);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const finite = (n) => Number.isFinite(n);
const raw = (regs, addr) => regs && finite(regs[addr]) ? regs[addr] : null;
const eng = (regs, addr) => raw(regs, addr) === null ? null : scale(regs[addr]);
const fixed = (n, suffix = "") => finite(n) ? `${n.toFixed(1)}${suffix}` : "—";
const whole = (n, suffix = "") => finite(n) ? `${n}${suffix}` : "—";
const state = (v) => v === 1 ? "on" : v === 0 ? "off" : "—";
const ok = (v) => v === 1 ? "good" : v === 0 ? "NO FLOW" : "—";
const trip = (v) => v === 1 ? "TRIPPED" : v === 0 ? "good" : "—";
const dashboard = () => DASH_URL ? `\n<${DASH_URL}|Open dashboard>` : "";
const cToF = (c) => c * 9 / 5 + 32;

const HELP = [
  "*/chiller commands*",
  "`/chiller status` — current temperatures, demand, equipment, and safety",
  "`/chiller alarms` — standing alarms and recent alarm history",
  "`/chiller trend 6h` — glycol min/max/average (`24h` and `7d` also work)",
  "`/chiller circuit a` — refrigeration-loop readings for circuit A or B",
  "`/chiller runtimes` — pump, compressor, and condenser-fan hours",
  "`/chiller why` — abnormal things visible in the current snapshot",
  "Add `share` to post the answer in the channel; replies are private otherwise.",
].join("\n");

/** @typedef {{active: Array<{name: string, since: string}>,
 *             recent: Array<{name: string, at: string, cleared: string | null}>}} AlarmRead */

/** @param {Record<number, number> | null} regs
 * @param {Record<string, number> | null} web
 * @param {AlarmRead | null} alarms */
function statusText(regs, web, alarms) {
  if (!regs) return `:red_circle: *Chiller unreachable*\nNo Modbus readings are available.${dashboard()}`;
  const active = alarms?.active ?? [];
  const title = alarms === null ? ":large_yellow_circle: *Chiller online · alarm status unavailable*"
    : active.length ? `:red_circle: *Chiller online · ${active.length} active alarm${active.length === 1 ? "" : "s"}*`
    : ":large_green_circle: *Chiller online · no active alarms*";
  const out = eng(regs, 68), inlet = eng(regs, 69);
  const alarmLine = active.length ? `\nAlarms: ${active.map((a) => esc(a.name)).join(", ")}` : "";
  const safety = web ? `Gas A/B ${whole(web["LEL A %"], "%")}/${whole(web["LEL B %"], "%")} LEL · HP/LP switches ${trip(web["HP pressostat trip"])}/${trip(web["LP pressostat trip"])}`
    : "Safety inputs unavailable";
  return [
    title,
    `Glycol ${fixed(inlet, "°F")} in → *${fixed(out, "°F")} out* · ΔT ${fixed(finite(inlet) && finite(out) ? inlet - out : null, "°F")} · setpoint ${fixed(eng(regs, 70), "°F")}`,
    `Reservoir ${fixed(eng(regs, 132), "°F")} · demand ${fixed(eng(regs, 1), "%")} · compressors A ${state(raw(regs, 31))} / B ${state(raw(regs, 62))}`,
    web ? `Pumps chiller ${state(web["Chiller pump on"])} / process ${state(web["Process pump on"])} · flow A ${ok(web["Glycol flow A ok"])} / B ${ok(web["Glycol flow B ok"])}` : "Pump and flow inputs unavailable",
    safety + alarmLine,
  ].join("\n") + dashboard();
}

/** @param {AlarmRead | null} alarms */
function alarmsText(alarms) {
  if (!alarms) return `:large_yellow_circle: *Alarm log unavailable*\nThe controller did not answer the alarm-history request.${dashboard()}`;
  const lines = [alarms.active.length ? `:red_circle: *${alarms.active.length} standing alarm${alarms.active.length === 1 ? "" : "s"}*` : ":large_green_circle: *No standing alarms*"];
  for (const a of alarms.active) lines.push(`• ${esc(a.name)} — since ${esc(a.since)}`);
  lines.push("", "*Recent history*");
  if (!alarms.recent.length) lines.push("No recent alarms in the controller log.");
  for (const a of alarms.recent.slice(0, 8)) {
    lines.push(`• ${esc(a.name)} — ${esc(a.at)}${a.cleared ? ` → cleared ${esc(a.cleared)}` : " → stop not present in log"}`);
  }
  return lines.join("\n") + dashboard();
}

/** Parse the controller log slice and calculate glycol stats. The datalogger
 * stores temperatures in °C even though the live registers use °F.
 * @param {string} csv */
function trendFromCsv(csv) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const columns = lines[0].split(",").map((v) => v.replace(/^"|"$/g, ""));
  const iTime = columns.indexOf("TIME");
  const iIn = columns.indexOf("W_InTempUser");
  const iOut = columns.indexOf("W_OutTempUser");
  if (iTime < 0 || iIn < 0 || iOut < 0) return null;
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(","); // logger data fields are numeric and contain no commas
    const inlet = Number(cells[iIn]), out = Number(cells[iOut]);
    if (!finite(inlet) || !finite(out)) continue;
    rows.push({ at: cells[iTime].slice(0, 19), inlet: cToF(inlet), out: cToF(out) });
  }
  if (!rows.length) return null;
  let outMin = Infinity, outMax = -Infinity, outSum = 0, inSum = 0;
  for (const row of rows) {
    outMin = Math.min(outMin, row.out);
    outMax = Math.max(outMax, row.out);
    outSum += row.out;
    inSum += row.inlet;
  }
  return {
    n: rows.length, first: rows[0], last: rows[rows.length - 1],
    outMin, outMax, outAvg: outSum / rows.length, inAvg: inSum / rows.length,
  };
}

/** @param {string} label @param {ReturnType<typeof trendFromCsv>} trend @param {boolean} loading */
function trendText(label, trend, loading) {
  if (!trend) return `:large_yellow_circle: *No ${label} history available*\n${loading ? "The log cache is still filling." : "The controller log has no samples in that window."}${dashboard()}`;
  const delta = trend.last.out - trend.first.out;
  const direction = Math.abs(delta) < 0.5 ? "steady" : delta < 0 ? "falling" : "rising";
  return [
    `:chart_with_upwards_trend: *Glycol trend · ${label}*`,
    `Outlet ${fixed(trend.outMin, "°F")}–${fixed(trend.outMax, "°F")} · avg ${fixed(trend.outAvg, "°F")} · latest ${fixed(trend.last.out, "°F")}`,
    `Inlet avg ${fixed(trend.inAvg, "°F")} · outlet ${direction} (${delta >= 0 ? "+" : ""}${fixed(delta, "°F")} across available samples)`,
    `${trend.n.toLocaleString()} samples · ${esc(trend.first.at)} → ${esc(trend.last.at)}`,
    ...(loading ? ["_The cache is still backfilling; this window may be incomplete._"] : []),
  ].join("\n") + dashboard();
}

/** @param {Record<number, number> | null} regs @param {"A" | "B"} circuit */
function circuitText(regs, circuit) {
  if (!regs) return `:red_circle: *Chiller unreachable*\nCircuit ${circuit} readings are unavailable.${dashboard()}`;
  const a = circuit === "A";
  const addr = a ? { comp: 31, power: 2, suction: 10, evap: 11, sh: 23, eev: 26, discharge: 3, cond: 4, fan: 33 }
    : { comp: 62, power: 34, suction: 42, evap: 43, sh: 55, eev: 58, discharge: 35, cond: 36, fan: 64 };
  return [
    `*Circuit ${circuit} · compressor ${state(raw(regs, addr.comp))} · load ${fixed(eng(regs, addr.power), "%")}*`,
    `Low side: suction ${fixed(eng(regs, addr.suction), " psi")} · evaporating ${fixed(eng(regs, addr.evap), "°F")} · superheat ${fixed(eng(regs, addr.sh), "°F")}`,
    `EEV ${fixed(eng(regs, addr.eev), "%")}`,
    `High side: discharge ${fixed(eng(regs, addr.discharge), " psi")} · condensing ${fixed(eng(regs, addr.cond), "°F")} · fan ${fixed(eng(regs, addr.fan), "%")}`,
  ].join("\n") + dashboard();
}

/** @param {Record<number, number> | null} regs */
function runtimesText(regs) {
  if (!regs) return `:red_circle: *Chiller unreachable*\nRuntime counters are unavailable.${dashboard()}`;
  return [
    "*Chiller runtimes*",
    `Pumps: chiller ${whole(raw(regs, 129), " h")} · process ${whole(raw(regs, 131), " h")}`,
    `Compressors: A ${whole(raw(regs, 135), " h")} · B ${whole(raw(regs, 141), " h")}`,
    `Condenser fans: A ${whole(raw(regs, 158), " h")} · B ${whole(raw(regs, 160), " h")}`,
  ].join("\n") + dashboard();
}

/** A snapshot explanation, not a diagnosis: enumerate abnormal facts without
 * pretending the available telemetry proves a root cause.
 * @param {Record<number, number> | null} regs
 * @param {Record<string, number> | null} web
 * @param {AlarmRead | null} alarms */
function whyText(regs, web, alarms) {
  const reasons = [];
  if (!regs) reasons.push("The Modbus feed is offline, so live refrigeration readings are unavailable.");
  for (const a of alarms?.active ?? []) reasons.push(`Controller alarm: ${esc(a.name)} (since ${esc(a.since)}).`);
  if (regs) {
    const out = eng(regs, 68), setpoint = eng(regs, 70), demand = eng(regs, 1);
    if (finite(out) && finite(setpoint) && out > setpoint + HIGH_F) reasons.push(`Glycol outlet is ${fixed(out, "°F")}, more than ${HIGH_F}°F above the ${fixed(setpoint, "°F")} setpoint.`);
    if (finite(demand) && demand > 0 && raw(regs, 31) === 0 && raw(regs, 62) === 0) reasons.push(`Cooling demand is ${fixed(demand, "%")}, but neither compressor reports running.`);
  }
  if (web) {
    for (const c of ["A", "B"]) if (web[`LEL ${c} %`] >= LEL_PCT) reasons.push(`Propane sensor ${c} reads ${web[`LEL ${c} %`]}% LEL.`);
    if (web["HP pressostat trip"] === 1) reasons.push("The high-pressure mechanical safety is tripped.");
    if (web["LP pressostat trip"] === 1) reasons.push("The low-pressure mechanical safety is tripped.");
    if (web["Chiller pump on"] === 1 && web["Glycol flow A ok"] === 0) reasons.push("The chiller pump reports running without flow A.");
    if (web["Process pump on"] === 1 && web["Glycol flow B ok"] === 0) reasons.push("The process pump reports running without flow B.");
  }
  if (!reasons.length) reasons.push("No obvious fault is visible in the current snapshot. Check `trend 6h` for behavior over time.");
  return ["*What stands out right now*", ...reasons.map((r) => `• ${r}`), "_This describes observed symptoms; it is not a root-cause diagnosis._"].join("\n") + dashboard();
}

const RANGE = {
  "6h": { ms: 6 * 3600e3, label: "6 hours" },
  "24h": { ms: 24 * 3600e3, label: "24 hours" },
  "7d": { ms: 7 * 86400e3, label: "7 days" },
};

/** Build one slash-command response. Dependencies are injectable so every
 * command is covered offline without Slack or a controller.
 * @param {string} input
 * @param {Partial<{read: typeof read, readWeb: typeof readWeb,
 *                  readAlarms: typeof readAlarms, logSlice: typeof logSlice,
 *                  logLoading: typeof logLoading, now: () => number}>} deps */
async function commandResponse(input, deps = {}) {
  const io = { read, readWeb, readAlarms, logSlice, logLoading, now: Date.now, ...deps };
  const words = String(input || "status").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shared = words.includes("share");
  const args = words.filter((w) => w !== "share");
  const command = args[0] || "status";
  let text;
  if (command === "status") {
    const [regs, web, alarms] = await Promise.all([io.read(), io.readWeb(), io.readAlarms()]);
    text = statusText(regs, web, alarms);
  } else if (command === "alarms") {
    text = alarmsText(await io.readAlarms());
  } else if (command === "trend") {
    const range = RANGE[args[1] || "6h"];
    text = range ? trendText(range.label, trendFromCsv(io.logSlice(io.now() - range.ms, io.now())), io.logLoading())
      : "Trend range must be `6h`, `24h`, or `7d`.";
  } else if (command === "circuit") {
    const circuit = (args[1] || "").toUpperCase();
    text = circuit === "A" || circuit === "B" ? circuitText(await io.read(), circuit) : "Choose `circuit a` or `circuit b`.";
  } else if (command === "runtimes") {
    text = runtimesText(await io.read());
  } else if (command === "why") {
    const [regs, web, alarms] = await Promise.all([io.read(), io.readWeb(), io.readAlarms()]);
    text = whyText(regs, web, alarms);
  } else {
    text = HELP;
  }
  return { response_type: shared ? "in_channel" : "ephemeral", text };
}

let socketApp = null;

/** Start the outbound Socket Mode connection. Both tokens absent means the
 * feature is intentionally disabled; one missing token is a configuration error.
 * @returns {Promise<boolean>} whether the listener was started */
async function startSlackCommands() {
  if (!APP_TOKEN && !BOT_TOKEN) return false;
  if (!APP_TOKEN || !BOT_TOKEN) {
    console.error("Slack commands disabled: set both SLACK_APP_TOKEN and SLACK_BOT_TOKEN");
    return false;
  }
  if (socketApp) return true;
  const { App } = require("@slack/bolt"); // lazy: webhook-only installs do not load Bolt
  socketApp = new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true });
  socketApp.command("/chiller", async ({ command, ack, respond }) => {
    await ack(); // Slack requires an acknowledgement within three seconds
    try {
      await respond(await commandResponse(command.text));
    } catch (e) {
      console.error("Slack command failed:", e instanceof Error ? e.message : String(e));
      await respond({ response_type: "ephemeral", text: ":warning: Chiller request failed. Try again in a moment." });
    }
  });
  socketApp.error(async (e) => console.error("Slack Socket Mode error:", e instanceof Error ? e.message : String(e)));
  await socketApp.start();
  console.log("Slack /chiller command listening over Socket Mode");
  return true;
}

module.exports = {
  commandResponse, trendFromCsv, statusText, alarmsText, circuitText,
  runtimesText, whyText, startSlackCommands,
};
