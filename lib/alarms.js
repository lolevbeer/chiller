// The controller's alarm log — the one place that says WHICH fault tripped.
// Reg 0 only reports "Off by alarm" (enum 2); the name lives here.
//
// alarms.htm renders in the browser from alarms.cgi (found by watching the
// page's network calls — nothing links to it):
//   alarms.cgi?action=getActive   -> "id,name,timestamp" + one row per alarm
//                                    currently standing (header only when clear)
//   alarms.cgi?action=getHistory  -> "TIME,ID,NAME,EVENT,VAR1,VAR2", newest
//                                    first, EVENT is Start or Stop
// Timestamps are stamped +00:00 but the controller clock runs site-local, same
// quirk as the datalogger — they're passed through as wall-clock strings.
//
// This unit's history: Al_HiW_Temp (high glycol temp, frequent), Al_FreezeCirc1/2,
// Al_OvldComp1Circ1/2 (compressor overload), Al_PhaseMonitor, Al_LowlvlSensor.
const { HOST } = require("./config");

// Alarm var names are machine-ish (Al_HiW_Temp.Active). Prettify the ones this
// unit actually throws; anything else falls back to the stripped raw name.
const NICE = {
  Al_HiW_Temp: "High glycol temp",
  Al_FreezeCirc1: "Freeze protection, circuit A",
  Al_FreezeCirc2: "Freeze protection, circuit B",
  Al_OvldComp1Circ1: "Compressor A overload",
  Al_OvldComp1Circ2: "Compressor B overload",
  Al_PhaseMonitor: "Phase monitor (supply power)",
  Al_LowlvlSensor: "Reservoir low level",
  Al_OfflineEVD_Circ1: "EEV driver offline, circuit A",
  Al_OfflineEVD_Circ2: "EEV driver offline, circuit B",
  Al_FlwSwUserPmp1: "No glycol flow, pump 1",
  Al_FlwSwUserPmp2: "No glycol flow, pump 2",
};
/** @param {string} v raw alarm var name @returns {string} human label */
const label = (v) => NICE[v.replace(/\.Active$/, "")] || v.replace(/\.Active$/, "");

const trim = (s) => s.replace(/"/g, "").trim();
const csv = async (action) => {
  const res = await fetch(`http://${HOST}/alarms.cgi?action=${action}`,
    { signal: AbortSignal.timeout(5000) });
  return (await res.text()).trim().split(/\r?\n/).slice(1) // drop header
    .map((l) => l.split(",").map(trim)).filter((c) => c.length > 1);
};

/**
 * @returns {Promise<{active: Array<{name: string, since: string}>,
 *                    recent: Array<{name: string, at: string, cleared: string | null}>} | null>}
 *          active = alarms standing right now; recent = past faults, newest first,
 *          each with when it hit and when it cleared (null = never did).
 *          null if the controller is unreachable.
 */
async function readAlarms() {
  try {
    const [act, hist] = await Promise.all([csv("getActive"), csv("getHistory")]);
    // The log is a flat Start/Stop event stream. Fold it into one row per fault:
    // walk newest-first, and pair each Start with the Stop already seen for that
    // alarm id (a Stop always post-dates its Start, so it comes first here).
    const stops = new Map(); // alarm id -> most recent unclaimed Stop timestamp
    const recent = [];
    for (const [ts, id, name, event] of hist) {
      if (event === "Stop") { if (!stops.has(id)) stops.set(id, ts); continue; }
      if (event !== "Start") continue;
      recent.push({ name: label(name), at: ts, cleared: stops.get(id) ?? null });
      stops.delete(id); // that Stop belongs to this Start; an older Start needs its own
    }
    return {
      active: act.map(([, name, ts]) => ({ name: label(name), since: ts })),
      recent: recent.slice(0, 50),
    };
  } catch {
    return null;
  }
}

module.exports = { readAlarms, NICE };
