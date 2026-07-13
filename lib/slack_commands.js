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
const whole = (n, suffix = "") => finite(n) ? `${n.toLocaleString("en-US")}${suffix}` : "—";
const state = (v) => v === 1 ? "on" : v === 0 ? "off" : "—";
const ok = (v) => v === 1 ? "good" : v === 0 ? "NO FLOW" : "—";
const trip = (v) => v === 1 ? "TRIPPED" : v === 0 ? "good" : "—";
const dashboard = () => DASH_URL ? `\n<${DASH_URL}|Open dashboard>` : "";
const cToF = (c) => c * 9 / 5 + 32;

// Alarm timestamps arrive as ISO strings, which are precise but awkward to
// scan in Slack. Keep the clock face from the controller's timestamp (rather
// than silently converting it to the Pi's timezone), and use the offset only
// to calculate how long an incident stood.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {string} value */
function alarmStamp(value) {
  const source = String(value);
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, y, month, day, hour, minute, second = "00", zone = ""] = match;
  const parts = [y, month, day, hour, minute, second].map(Number);
  const wall = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (wall.getUTCFullYear() !== parts[0] || wall.getUTCMonth() !== parts[1] - 1 ||
      wall.getUTCDate() !== parts[2] || wall.getUTCHours() !== parts[3] ||
      wall.getUTCMinutes() !== parts[4] || wall.getUTCSeconds() !== parts[5]) return null;
  const normalizedZone = zone && zone !== "Z" && !zone.includes(":")
    ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const epoch = zone ? Date.parse(`${y}-${month}-${day}T${hour}:${minute}:${second}${normalizedZone}`)
    : wall.getTime();
  if (!finite(epoch)) return null;
  const h = parts[3] % 12 || 12;
  return {
    epoch,
    dateKey: `${y}-${month}-${day}`,
    date: `${MONTHS[parts[1] - 1]} ${parts[2]}, ${parts[0]}`,
    clock: `${h}:${minute}`,
    period: parts[3] < 12 ? "AM" : "PM",
  };
}

/** @param {ReturnType<typeof alarmStamp>} stamp */
const alarmClock = (stamp) => `${stamp.clock} ${stamp.period}`;

/** @param {string} value */
const alarmMoment = (value) => {
  const stamp = alarmStamp(value);
  return stamp ? `${stamp.date} at ${alarmClock(stamp)}` : esc(value);
};

/** @param {ReturnType<typeof alarmStamp>} start @param {ReturnType<typeof alarmStamp>} stop */
function stampRange(start, stop) {
  if (start.dateKey !== stop.dateKey) {
    return `${start.date} at ${alarmClock(start)} → ${stop.date} at ${alarmClock(stop)}`;
  }
  if (start.clock === stop.clock && start.period === stop.period) {
    return `${start.date} at ${alarmClock(start)}`;
  }
  const clocks = start.period === stop.period
    ? `${start.clock}–${stop.clock} ${start.period}`
    : `${alarmClock(start)}–${alarmClock(stop)}`;
  return `${start.date} · ${clocks}`;
}

/** @param {string} startValue @param {string} stopValue */
function readableRange(startValue, stopValue) {
  const start = alarmStamp(startValue), stop = alarmStamp(stopValue);
  return start && stop ? stampRange(start, stop) : `${esc(startValue)} → ${esc(stopValue)}`;
}

/** Human-scale elapsed time, capped at the two most useful units. @param {number} ms */
function alarmDuration(ms) {
  let seconds = Math.round(ms / 1000);
  if (seconds <= 0) return "cleared immediately";
  /** @type {Array<[number, string]>} */
  const units = [[86400, "day"], [3600, "hr"], [60, "min"], [1, "sec"]];
  const parts = [];
  for (const [size, label] of units) {
    const n = Math.floor(seconds / size);
    if (!n) continue;
    parts.push(`${n} ${label}${label === "day" && n !== 1 ? "s" : ""}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return `lasted ${parts.join(" ")}`;
}

/** @param {{at: string, cleared: string | null}} alarm */
function alarmHistoryTime(alarm) {
  const start = alarmStamp(alarm.at);
  if (!alarm.cleared) return `${start ? `${start.date} at ${alarmClock(start)}` : esc(alarm.at)} · clear time unavailable`;
  const stop = alarmStamp(alarm.cleared);
  if (!start || !stop) return `${start ? `${start.date} at ${alarmClock(start)}` : esc(alarm.at)} → cleared ${stop ? `${stop.date} at ${alarmClock(stop)}` : esc(alarm.cleared)}`;
  const elapsed = stop.epoch - start.epoch;
  const duration = elapsed >= 0 ? ` · ${alarmDuration(elapsed)}` : "";
  return `${stampRange(start, stop)}${duration}`;
}

const HELP = [
  "*/chiller commands*",
  "`/chiller status` — current temperatures, demand, equipment, and safety",
  "`/chiller alarms` — active alarms and recent alarm history",
  "`/chiller trend 6h` — supply-temperature range, average, and movement (`24h` and `7d` also work)",
  "`/chiller circuit a` — refrigeration readings for circuit A or B",
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
  if (!regs) return `*Chiller status — Unreachable*\nNo live controller readings are available.${dashboard()}`;
  const active = alarms?.active ?? [];
  const out = eng(regs, 68), inlet = eng(regs, 69);
  const delta = finite(inlet) && finite(out) ? inlet - out : null;
  const loopChange = finite(delta) ? `${fixed(Math.abs(delta), "°F")} ${delta < 0 ? "rise" : "drop"}` : "change —";
  const alarmLine = alarms === null ? "Alarms: status unavailable"
    : active.length ? `Alarms: ${active.map((a) => esc(a.name)).join(", ")}`
    : "Alarms: none active";
  const safety = web ? `Safety: propane A ${whole(web["LEL A %"], "% LEL")}, B ${whole(web["LEL B %"], "% LEL")} · pressure switches HP ${trip(web["HP pressostat trip"])}, LP ${trip(web["LP pressostat trip"])}`
    : "Safety inputs unavailable";
  return [
    "*Chiller status — Online*",
    alarmLine,
    `Glycol: ${fixed(inlet, "°F")} return → *${fixed(out, "°F")} supply* · ${loopChange} · setpoint ${fixed(eng(regs, 70), "°F")}`,
    `Cooling: ${fixed(eng(regs, 1), "%")} demand · compressor A ${state(raw(regs, 31))}, B ${state(raw(regs, 62))} · reservoir ${fixed(eng(regs, 132), "°F")}`,
    web ? `Pumps: chiller ${state(web["Chiller pump on"])}, process ${state(web["Process pump on"])} · flow A ${ok(web["Glycol flow A ok"])}, B ${ok(web["Glycol flow B ok"])}` : "Pumps and flow: inputs unavailable",
    safety,
  ].join("\n") + dashboard();
}

/** @param {AlarmRead | null} alarms */
function alarmsText(alarms) {
  if (!alarms) return `*Alarm history — Unavailable*\nThe controller did not answer the alarm-history request.${dashboard()}`;
  const lines = ["*Alarm history*", alarms.active.length
    ? `${alarms.active.length} active alarm${alarms.active.length === 1 ? "" : "s"}:`
    : "No active alarms."];
  for (const a of alarms.active) lines.push(`• ${esc(a.name)} — active since ${alarmMoment(a.since)}`);
  lines.push("", "*Recent alarms*");
  if (!alarms.recent.length) lines.push("No recent alarms in the controller log.");
  for (const a of alarms.recent.slice(0, 8)) {
    lines.push(`• ${esc(a.name)} — ${alarmHistoryTime(a)}`);
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
  if (!trend) return `*Glycol trend — No history available*\n${loading ? "The log cache is still filling." : `The controller log has no samples from the past ${label}.`}${dashboard()}`;
  const delta = trend.last.out - trend.first.out;
  const movement = Math.abs(delta) < 0.5
    ? `held steady (${fixed(Math.abs(delta), "°F")} change across available samples)`
    : `${delta < 0 ? "fell" : "rose"} ${fixed(Math.abs(delta), "°F")} across available samples`;
  return [
    `*Glycol trend — Past ${label}*`,
    `Supply ${fixed(trend.outMin)}–${fixed(trend.outMax, "°F")} · average ${fixed(trend.outAvg, "°F")} · latest ${fixed(trend.last.out, "°F")}`,
    `Return average ${fixed(trend.inAvg, "°F")} · supply ${movement}`,
    `Samples: ${trend.n.toLocaleString("en-US")} · ${readableRange(trend.first.at, trend.last.at)}`,
    ...(loading ? ["_The cache is still backfilling; this window may be incomplete._"] : []),
  ].join("\n") + dashboard();
}

/** @param {Record<number, number> | null} regs @param {"A" | "B"} circuit */
function circuitText(regs, circuit) {
  if (!regs) return `*Circuit ${circuit} — Unavailable*\nThe chiller is unreachable, so live circuit readings are unavailable.${dashboard()}`;
  const a = circuit === "A";
  const addr = a ? { comp: 31, power: 2, suction: 10, evap: 11, sh: 23, eev: 26, discharge: 3, cond: 4, fan: 33 }
    : { comp: 62, power: 34, suction: 42, evap: 43, sh: 55, eev: 58, discharge: 35, cond: 36, fan: 64 };
  return [
    `*Circuit ${circuit}*`,
    `Compressor: ${state(raw(regs, addr.comp))} · load ${fixed(eng(regs, addr.power), "%")}`,
    `Low side: ${fixed(eng(regs, addr.suction), " psi")} suction · ${fixed(eng(regs, addr.evap), "°F")} evaporating · ${fixed(eng(regs, addr.sh), "°F")} superheat`,
    `Expansion valve: ${fixed(eng(regs, addr.eev), "%")} open`,
    `High side: ${fixed(eng(regs, addr.discharge), " psi")} discharge · ${fixed(eng(regs, addr.cond), "°F")} condensing · condenser fan ${fixed(eng(regs, addr.fan), "%")}`,
  ].join("\n") + dashboard();
}

/** @param {Record<number, number> | null} regs */
function runtimesText(regs) {
  if (!regs) return `*Chiller runtimes — Unavailable*\nThe chiller is unreachable, so runtime counters are unavailable.${dashboard()}`;
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
  for (const a of alarms?.active ?? []) reasons.push(`Controller alarm: ${esc(a.name)} (active since ${alarmMoment(a.since)}).`);
  if (regs) {
    const out = eng(regs, 68), setpoint = eng(regs, 70), demand = eng(regs, 1);
    if (finite(out) && finite(setpoint) && out > setpoint + HIGH_F) reasons.push(`Glycol supply is ${fixed(out, "°F")}, more than ${HIGH_F}°F above the ${fixed(setpoint, "°F")} setpoint.`);
    if (finite(demand) && demand > 0 && raw(regs, 31) === 0 && raw(regs, 62) === 0) reasons.push(`Cooling demand is ${fixed(demand, "%")}, but neither compressor reports running.`);
  }
  if (web) {
    for (const c of ["A", "B"]) if (web[`LEL ${c} %`] >= LEL_PCT) reasons.push(`Propane sensor ${c} reads ${web[`LEL ${c} %`]}% LEL.`);
    if (web["HP pressostat trip"] === 1) reasons.push("The high-pressure mechanical safety is tripped.");
    if (web["LP pressostat trip"] === 1) reasons.push("The low-pressure mechanical safety is tripped.");
    if (web["Chiller pump on"] === 1 && web["Glycol flow A ok"] === 0) reasons.push("The chiller pump reports running without flow A.");
    if (web["Process pump on"] === 1 && web["Glycol flow B ok"] === 0) reasons.push("The process pump reports running without flow B.");
  }
  if (!reasons.length) reasons.push("No obvious fault is visible in the current snapshot. Check `/chiller trend 6h` for behavior over time.");
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
      : "Use `/chiller trend 6h`, `/chiller trend 24h`, or `/chiller trend 7d`.";
  } else if (command === "circuit") {
    const circuit = (args[1] || "").toUpperCase();
    text = circuit === "A" || circuit === "B" ? circuitText(await io.read(), circuit) : "Use `/chiller circuit a` or `/chiller circuit b`.";
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
      await respond({ response_type: "ephemeral", text: "Chiller request failed. Try again in a moment." });
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
