// Re-arms the controller's onboard datalogger by driving its virtual keypad
// (pGD) over HTTP. The log halts the instant any alarm fires and never restarts
// itself; the only way back is the system menu's LOGGER → RESTART LOGS, and no
// writable variable or CGI does the same job.
//
// Wire protocol, decoded from the controller's own /pgd/lib/pLan-min.js:
//   pLanKey.cgi?keycode=K&keycount=N  one key press (N ≈ hold time in 100 ms ticks)
//   pLanWeb.cgi?sessionid=S           screen updates as Base64 <msg> blobs:
//                                     [11,row,...ascii] = a text row,
//                                     [12,row,col,char] = one char, [101,…] = clear
// This unit's pGD is text mode, 8 rows × 22 columns, and marks the selected
// menu item with a leading "> ". Every step below reads the screen and checks
// that text before pressing anything; nothing is navigated by counting.
//
// Menus as recorded live on 2026-09-24 (look-only walk):
//   main screen    row 0 is "MM/DD/YY hh:mm …"
//   system menu    INFORMATION, SETTINGS, APPLICATION, UPGRADE, LOGGER, DIAGNOSTICS
//   LOGGER menu    EXPORT LOGS, RESTART LOGS, FLUSH LOGS, WIPE LOGS
// WIPE LOGS deletes the log and sits two rows below RESTART LOGS, so Enter is
// pressed only when the selected row reads exactly "RESTART LOGS".
const { HOST } = require("./config");
const { readAlarms } = require("./alarms");

const KEY = { ESC: 0, ENTER: 13, DOWN: 15, SYSTEM_MENU: 130 }; // 130 = Alarm+Enter combo
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{screen: () => Promise<string[]>, key: (code: number, count?: number) => Promise<void>}} Pad */

/** The live keypad: one pLanWeb session, accumulating screen updates into 8 rows.
 * @returns {Pad} */
function httpPad(host = HOST) {
  let id = -1;
  const rows = Array(8).fill("");
  const poll = async () => {
    const res = await fetch(`http://${host}/pgd/pgd/pLanWeb.cgi?sessionid=${id}&_=${Date.now()}`,
      { signal: AbortSignal.timeout(12000) });
    const xml = await res.text();
    const m = /<id>(-?\d+)<\/id>/.exec(xml);
    if (m && +m[1] >= 0) id = +m[1];
    for (const [, b64] of xml.matchAll(/<msg>([^<]*)<\/msg>/g)) {
      const b = [...Buffer.from(b64, "base64")];
      if (b[0] === 11) rows[b[1]] = String.fromCharCode(...b.slice(2));
      if (b[0] === 12 && b[1] < 8) {
        const r = rows[b[1]].padEnd(b[2] + 1).split("");
        r[b[2]] = String.fromCharCode(b[3]);
        rows[b[1]] = r.join("");
      }
      if (b[0] === 101) rows.fill("");
    }
  };
  return {
    // Three polls: the first of a new session only hands out its id.
    async screen() { for (let i = 0; i < 3; i++) await poll(); return [...rows]; },
    async key(code, count = 1) {
      await fetch(`http://${host}/pgd/pgd/pLanKey.cgi?keycode=${code}&keycount=${count}&_=${Date.now()}`,
        { signal: AbortSignal.timeout(5000) });
      await sleep(count > 1 ? 1500 : 800); // let the controller redraw before the next read
    },
  };
}

const isHome = (/** @type {string[]} */ rows) => /^\d\d\/\d\d\/\d\d \d\d:\d\d/.test(rows[0] || "");
const selected = (/** @type {string[]} */ rows) => (rows.find((r) => r.startsWith("> ")) || "").slice(2).trim();

/** Esc until the main screen shows (Esc only ever backs out). @param {Pad} pad */
async function goHome(pad) {
  let rows = await pad.screen();
  for (let n = 0; n < 4 && !isHome(rows); n++) { await pad.key(KEY.ESC); rows = await pad.screen(); }
  return isHome(rows);
}

/** Press Down until the selected row reads exactly `item`, at most maxDowns times.
 * @param {Pad} pad @param {string} item @param {number} maxDowns */
async function select(pad, item, maxDowns) {
  let rows = await pad.screen();
  for (let n = 0; selected(rows) !== item; n++) {
    if (n >= maxDowns || !selected(rows)) return false;
    await pad.key(KEY.DOWN);
    rows = await pad.screen();
  }
  return true;
}

/** Walk main screen → system menu → LOGGER → RESTART LOGS → Enter.
 * @param {Pad} pad @returns {Promise<{error?: string, answer?: string}>} */
async function drive(pad) {
  if (!await goHome(pad)) return { error: "The keypad could not be returned to the main screen" };
  await pad.key(KEY.SYSTEM_MENU, 30); // held 3 s
  if (!await select(pad, "LOGGER", 6)) return { error: "LOGGER was not found in the system menu" };
  await pad.key(KEY.ENTER);
  if (!await select(pad, "RESTART LOGS", 3)) return { error: "RESTART LOGS could not be selected" };
  // Fresh read right before the one press that acts: someone at the physical
  // keypad could have moved the selection since the last check.
  if (selected(await pad.screen()) !== "RESTART LOGS") return { error: "The selection moved before Enter" };
  await pad.key(KEY.ENTER);
  return { answer: (await pad.screen())[0].trim() };
}

const MANUAL = "Re-arm it on the controller keypad: hold Alarm + Enter about 3 s, then LOGGER, then RESTART LOGS.";
let busy = false; // one run at a time: the button and /chiller rearm share one keypad

/**
 * Re-arm the datalogger and post the outcome to Slack. Refuses without
 * touching the keypad while an alarm stands (the log would stop again) or when
 * the alarm state is unknown. Always leaves the keypad on the main screen.
 * @param {{source: string, pad?: Pad, readAlarms?: typeof readAlarms,
 *          post?: (body: object) => Promise<boolean>}} opts source names who
 *   asked ("the dashboard", "Slack"); the rest is injectable for test.js.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function rearmLogger({ source, pad, readAlarms: alarmsOf = readAlarms, post }) {
  if (busy) return { ok: false, message: "A datalogger re-arm is already running" };
  busy = true;
  try {
    const alarms = await alarmsOf();
    if (!alarms) return { ok: false, message: "Could not read the controller's alarms, so the re-arm was not attempted" };
    if (alarms.active.length) {
      const names = alarms.active.map((a) => a.name).join(", ");
      return { ok: false, message: `Not re-armed: ${names} is still active, and the log would stop again. Re-arm after it clears.` };
    }
    const keypad = pad ?? httpPad();
    const send = post ?? ((/** @type {object} */ b) =>
      process.env.SLACK_WEBHOOK_URL ? require("./slack").post(b) : Promise.resolve(false)); // lazy, like lib/boost.js
    let result;
    try { result = await drive(keypad); } catch (e) { result = { error: `Keypad request failed (${e instanceof Error ? e.message : e})` }; }
    let home = false;
    try { home = await goHome(keypad); } catch {}
    if (result.answer !== undefined) {
      const message = `Controller reply: "${result.answer}". The Datalogger stopped alert resolves once new rows arrive, usually within 5 minutes.`;
      await send({ text: `*Notice: Datalogger re-armed from ${source}*\n${message}` });
      return { ok: true, message };
    }
    const message = `${result.error}. No log action was taken${home ? " and the keypad is back on the main screen" : "; the keypad may be left in a menu"}. ${MANUAL}`;
    await send({ text: `*Warning: Datalogger re-arm from ${source} failed*\n${message}` });
    return { ok: false, message };
  } finally {
    busy = false;
  }
}

module.exports = { rearmLogger, httpPad };
