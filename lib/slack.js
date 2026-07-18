// Slack reporter: set SLACK_WEBHOOK_URL (an Incoming Webhook) and the chiller
// alerts the moment something goes wrong — a controller alarm, a propane leak, a
// pressostat trip, glycol out of band, lost flow — and again when it clears,
// with how long the incident lasted. Nothing else posts except one daily summary.
// A message in the channel always means something changed.
//
// Edge-triggered: each poll re-evaluates every condition against a fresh read.
// A key that appears posts an alert; a key that disappears posts a recovery. That
// is the whole deduplication mechanism — one alert per incident, no cooldown
// table, no dedupe window.
const { scale, read } = require("./modbus");
const { readWeb } = require("./webvars");
const { readAlarms } = require("./alarms");
const dateTime = require("./datetime");

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const POLL_MIN = Number(process.env.SLACK_POLL_MIN || 1);
const DAILY_HOUR = Number(process.env.SLACK_DAILY_HOUR || 8); // site-local
const DASH_URL = process.env.SLACK_DASHBOARD_URL || ""; // linked in every alert; omitted if unset

// Thresholds. Hardware never matches the ideal on paper — a leak sensor reads a
// few percent off, a flow switch has its own lag — so every one is tunable.
const LEL_PCT = Number(process.env.SLACK_LEL_PCT || 10); // % of lower explosive limit
const HIGH_F = Number(process.env.SLACK_HIGH_F || 5); // °F above setpoint = warning
const CRIT_F = Number(process.env.SLACK_CRIT_F || 45); // °F absolute = critical
const HYST_F = Number(process.env.SLACK_HYST_F || 2); // °F back inside the band before it clears
const FREEZE_F = Number(process.env.SLACK_FREEZE_F || 20); // °F absolute floor
const IMBAL_H = Number(process.env.SLACK_IMBALANCE_H || 100); // hours of A-vs-B runtime divergence
const HIGH_DWELL = Number(process.env.SLACK_DWELL_MIN || 5); // min a temperature fault must persist
const COOL_DWELL = Number(process.env.SLACK_NOTCOOL_MIN || 20); // min a compressor may run without progress
const BOOST_F = Number(process.env.SLACK_BOOST_F || 40); // °F supply that prompts a temporary setpoint drop
const BOOST_DROP_F = Number(process.env.SLACK_BOOST_DROP_F || 10); // °F below the current reading to suggest as the temporary setpoint

const minute = (n) => n * 60000;

/**
 * One poll's readings, plus the wall clock (passed in, never read, so step()
 * stays pure and testable). Any reading may be null — a source that failed to
 * read can't raise its conditions (except `offline`, which is that fact).
 * @typedef {{t: number,
 *            regs: Record<number, number> | null,
 *            web: Record<string, number> | null,
 *            alarms: {active: Array<{name: string, since: string}>} | null}} State
 */

const F = (/** @type {number} */ n) => `${n.toFixed(1)}°F`;
const elapsed = (/** @type {number} */ ms) => dateTime.duration(ms) || "—";

// The context lines under every glycol alert: where the loop is, and what's running.
const glycolCtx = (/** @type {State} */ s) => {
  const running = [s.regs[31] && "A", s.regs[62] && "B"].filter(Boolean);
  return [
    `${F(scale(s.regs[68]))} out, setpoint ${F(scale(s.regs[70]))} · ${F(scale(s.regs[69]))} return`,
    running.length ? `Compressors ${running.join(" + ")} running` : "No compressors running",
  ];
};

/** @typedef {{key: string, level: string, title: string,
 *             source?: string, dwellMs?: number, samples?: number,
 *             test: (s: State, ctx: {hist: Array<{t: number, out: number}>}) => boolean,
 *             clear?: (s: State, ctx: {hist: Array<{t: number, out: number}>}) => boolean,
 *             detail: (s: State, ctx: {hist: Array<{t: number, out: number}>}) => string[]}} Condition */

/**
 * The conditions. Each is {key, level, title, source, dwellMs|samples, test,
 * detail} plus optional clear:
 *   test(s, ctx)  — truthy while the condition holds. ctx.hist is the recent
 *                   glycol trend (see step()).
 *   clear(s, ctx) — hysteresis. Once active, the condition holds until clear()
 *                   is true — not merely until test() goes false. Temperature
 *                   bands need this: a value sitting on its threshold would
 *                   otherwise alert and recover all afternoon.
 *   detail(s,ctx) — the context lines printed under the title.
 * Controller alarms aren't in the table: they're dynamic (one key per standing
 * fault), and step() folds them in.
 * ponytail: a flat table, no registry indirection. It's a dozen conditions.
 */
/** @type {Condition[]} */
const CONDITIONS = [
  { key: "offline", level: "⚠️", title: "Chiller unreachable", samples: 2,
    test: (/** @type {State} */ s) => !s.regs,
    detail: () => ["No Modbus reads getting through"] },

  ...["A", "B"].map((c) => ({
    key: `leak:${c}`, level: "🚨", title: `Propane detected — sensor ${c}`, source: "web", dwellMs: 0,
    test: (/** @type {State} */ s) => s.web?.[`LEL ${c} %`] >= LEL_PCT,
    // A leak hovering on the trip point must not flap: hold the alert open until
    // the sensor reads properly clean, not merely a hair under the threshold.
    clear: (/** @type {State} */ s) => s.web?.[`LEL ${c} %`] < LEL_PCT / 2,
    detail: (/** @type {State} */ s) =>
      [`${s.web[`LEL ${c} %`]}% of the lower explosive limit (alerts at ${LEL_PCT}%)`],
  })),

  // A leak sensor that stops reporting is itself a fault: this is an R290 unit,
  // and a silent sensor is indistinguishable from a working one seeing nothing.
  ...["A", "B"].map((c) => ({
    key: `leak-sensor:${c}`, level: "⚠️", title: `Propane sensor ${c} stopped reporting`, source: "web", samples: 2,
    test: (/** @type {State} */ s) => !!s.web && !(`LEL ${c} %` in s.web),
    detail: () => ["A blind leak sensor is a fault in its own right"],
  })),

  { key: "pstat:HP", level: "🚨", title: "High-pressure switch tripped", source: "web", dwellMs: 0,
    test: (/** @type {State} */ s) => s.web?.["HP pressostat trip"] === 1,
    detail: () => ["Mechanical safety — the circuit stays locked out until it's reset"] },
  { key: "pstat:LP", level: "🚨", title: "Low-pressure switch tripped", source: "web", dwellMs: 0,
    test: (/** @type {State} */ s) => s.web?.["LP pressostat trip"] === 1,
    detail: () => ["Mechanical safety — the circuit stays locked out until it's reset"] },

  // Two glycol bands, both with hysteresis: fire at the threshold, clear only
  // once the temperature has fallen HYST_F back inside it. Dwell keeps pulldown quiet.
  { key: "glycol-crit", level: "🔴", title: "Critical glycol supply temperature", source: "regs", dwellMs: minute(HIGH_DWELL),
    test: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) > CRIT_F,
    clear: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) < CRIT_F - HYST_F,
    detail: glycolCtx },
  { key: "glycol-high", level: "🟠", title: "High glycol supply temperature", source: "regs", dwellMs: minute(HIGH_DWELL),
    test: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) > scale(s.regs[70]) + HIGH_F,
    clear: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) < scale(s.regs[70]) + HIGH_F - HYST_F,
    detail: glycolCtx },

  // An actionable nudge, not a fault. The controller is read-only from here, so
  // when glycol supply climbs past BOOST_F this can't lower the setpoint itself —
  // it tells the operator to temporarily set the setpoint BOOST_DROP_F below the
  // current reading to pull the loop back, and to restore the normal setpoint once
  // supply is back under BOOST_F. The recovery edge (supply back inside the band)
  // is that "restore it now" cue. Same dwell + hysteresis as the bands above so it
  // doesn't flap on the threshold. Overlaps glycol-high when the setpoint sits near
  // BOOST_F − HIGH_F; that's two views of one event, not a bug.
  { key: "glycol-boost", level: "🟠", title: `Glycol supply above ${BOOST_F}°F`, source: "regs", dwellMs: minute(HIGH_DWELL),
    test: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) > BOOST_F,
    clear: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) < BOOST_F - HYST_F,
    detail: (/** @type {State} */ s) => [
      ...glycolCtx(s),
      `Temporarily set the setpoint to ${F(scale(s.regs[68]) - BOOST_DROP_F)} — ${BOOST_DROP_F}°F below the current ${F(scale(s.regs[68]))}. Restore the normal setpoint (${F(scale(s.regs[70]))}) once supply is back under ${BOOST_F}°F.`,
    ] },

  { key: "glycol-freeze", level: "🚨", title: "Glycol supply below the freeze floor", source: "regs", dwellMs: minute(5),
    test: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) < FREEZE_F,
    clear: (/** @type {State} */ s) => !!s.regs && scale(s.regs[68]) > FREEZE_F + HYST_F,
    detail: glycolCtx },

  // Flow only means anything while a pump runs: both switches read no-flow with
  // the pumps off, which is not a fault.
  ...[["A", "Chiller pump on"], ["B", "Process pump on"]].map(([c, pump]) => ({
    key: `no-flow:${c}`, level: "🚨", title: `No glycol flow, circuit ${c}`, source: "web", dwellMs: minute(2),
    test: (/** @type {State} */ s) => s.web?.[pump] === 1 && s.web[`Glycol flow ${c} ok`] === 0,
    detail: () => [`The ${c === "A" ? "chiller" : "process"} pump reports running, but its flow switch sees nothing`],
  })),

  // No soft "reservoir-low" condition: Modbus_FB.ResLvl is listed under
  // UNUSED_WEB_VARS (this unit has no level sensor; the point stays 0). If a
  // real float ever trips, Al_LowlvlSensor still arrives via readAlarms().

  // A circuit that runs and doesn't cool throws no alarm — the controller sees a
  // compressor doing its job. Catch it by trend instead: a compressor has been on
  // for COOL_DWELL minutes, glycol is still off setpoint, and it isn't falling.
  { key: "not-cooling", level: "🔴", title: "Compressors running but not cooling", source: "regs", dwellMs: 0,
    test: (/** @type {State} */ s, ctx) => {
      if (!s.regs || !(s.regs[31] || s.regs[62])) return false;
      const out = scale(s.regs[68]);
      if (out <= scale(s.regs[70]) + HIGH_F) return false; // at setpoint: it's working
      const old = ctx.hist[0]; // oldest sample still inside the trend window
      return !!old && s.t - old.t >= COOL_DWELL * 60000 && out >= old.out - 0.5;
    },
    detail: (/** @type {State} */ s, ctx) => [
      ...glycolCtx(s),
      `Glycol has moved ${F(scale(s.regs[68]) - ctx.hist[0].out)} in ${COOL_DWELL} min of compressor runtime`,
    ] },

  // Runtime imbalance is slow-moving: it fires once and stands until the hours
  // converge, which is the point — a "rebalance the lead/lag" nudge, not a fault.
  { key: "runtime-imbalance", level: "⚠️", title: "Circuit runtime imbalance", source: "regs", dwellMs: 0,
    test: (/** @type {State} */ s) => !!s.regs && Math.abs(s.regs[135] - s.regs[141]) > IMBAL_H,
    detail: (/** @type {State} */ s) => [
      `Compressor A ${s.regs[135]} h vs B ${s.regs[141]} h — ${Math.abs(s.regs[135] - s.regs[141])} h apart (warns past ${IMBAL_H} h)`,
    ] },
];

/**
 * The pure core: given the last poll's conclusions and this poll's readings,
 * decide what to post. Free of I/O and of the clock (s.t carries the time), so
 * test.js can drive it through whole incidents with no device attached.
 *
 * @param {{active: Map<string, {title: string, since: number}>,
 *          counts: Map<string, {since: number, samples: number}>,
 *          hist: Array<{t: number, out: number}>}} prev
 * @param {State} s
 * @returns {{active: Map<string, {title: string, since: number}>,
 *            counts: Map<string, {since: number, samples: number}>,
 *            hist: Array<{t: number, out: number}>,
 *            posts: string[]}} active/counts/hist feed the next call.
 */
function step(prev, s) {
  // Glycol trend, trimmed to the not-cooling window. Only the temperature is
  // kept — a ring buffer of a few dozen floats, not a second log cache.
  const hist = [...prev.hist, ...(s.regs ? [{ t: s.t, out: scale(s.regs[68]) }] : [])]
    .filter((h) => s.t - h.t <= COOL_DWELL * 60000);
  const ctx = { hist };

  const counts = new Map(prev.counts);
  const active = new Map();
  const posts = [];

  // Controller alarms are dynamic — one condition per standing fault, named by
  // readAlarms()'s NICE map. No dwell: the controller already debounced them.
  /** @type {Condition[]} */
  const dyn = (s.alarms?.active ?? []).map((a) => ({
    key: `alarm:${a.name}`, level: "🚨", title: a.name, source: "alarms", dwellMs: 0,
    test: () => true, clear: undefined, detail: () => [`Controller alarm, active since ${dateTime.moment(a.since)}`],
  }));

  for (const c of [...CONDITIONS, ...dyn]) {
    const was = prev.active.get(c.key);
    // A timeout is unknown, not healthy. Freeze both an announced incident and
    // an in-progress dwell until this condition's own source succeeds again.
    // `offline` deliberately has no source because a failed register read is
    // the condition it detects.
    const sourceMissing = c.source === "regs" ? s.regs === null
      : c.source === "web" ? s.web === null
      : c.source === "alarms" ? s.alarms === null : false;
    if (sourceMissing) {
      if (was) active.set(c.key, was);
      continue;
    }
    // Hysteresis lives here: an active condition holds until its clear() says
    // otherwise; an inactive one needs test(). Without clear(), the two are the
    // same predicate and the condition simply drops when test() goes false.
    const holds = was && c.clear ? !c.clear(s, ctx) : !!c.test(s, ctx);
    if (!holds) { counts.delete(c.key); continue; }
    const prior = counts.get(c.key);
    const run = { since: prior?.since ?? s.t, samples: (prior?.samples ?? 0) + 1 };
    counts.set(c.key, run);
    const ready = c.samples ? run.samples >= c.samples : s.t - run.since >= (c.dwellMs ?? 0);
    if (!ready) continue;

    // The incident begins at the first bad sample, not when its dwell expires.
    active.set(c.key, was ?? { title: c.title, since: run.since });
    if (was) continue; // already announced — this is the deduplication
    posts.push([
      `${c.level} *${c.title}*`,
      ...c.detail(s, ctx),
      `Active for ${elapsed(s.t - run.since)}`,
      ...(DASH_URL ? [`Dashboard: ${DASH_URL}`] : []),
    ].join("\n"));
  }
  // An alarm that clears vanishes from readAlarms().active, so its key never
  // enters `active` above and falls out as a recovery below. But a FAILED alarm
  // read looks identical — hold standing alarms rather than faking an all-clear
  // every time the controller's web server hiccups.
  if (!s.alarms) for (const [k, v] of prev.active) if (k.startsWith("alarm:")) active.set(k, v);
  else {
    const standing = new Set(dyn.map((c) => c.key));
    for (const k of counts.keys()) if (k.startsWith("alarm:") && !standing.has(k)) counts.delete(k);
  }

  for (const [k, v] of prev.active) {
    if (active.has(k)) continue;
    posts.push(`✅ *${v.title} recovered*\nIncident lasted ${elapsed(s.t - v.since)}` +
      (s.regs ? `\n${glycolCtx(s)[0]}` : ""));
  }
  return { active, counts, hist, posts };
}

/**
 * @param {object} body Slack webhook body
 * @param {typeof fetch} send injectable for the offline test
 * @param {typeof console.error} log injectable so expected test failures stay quiet
 * @returns {Promise<boolean>} true only when Slack accepted the message
 */
async function post(body, send = fetch, log = console.error) {
  try {
    const res = await send(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    return true;
  } catch (e) {
    log("slack post failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Send queued alert edges in order, retaining the failed edge and everything
 * behind it for the next poll. @param {object[]} queue @param {(body: object) => Promise<boolean>} send */
async function flushPosts(queue, send = post) {
  while (queue.length) {
    if (!await send(queue[0])) return false;
    queue.shift();
  }
  return true;
}

// Daily-summary stats, accumulated from the poll loop itself. The datalogger
// cache looks like the obvious source but it's °C/bar and lags 5 min — these
// reads are already in hand, in °F. A restart resets the window, and the summary
// says which window it actually covers rather than claiming a full day.
let stats = null;
const resetStats = () => {
  stats = { since: new Date(), n: 0, outMin: Infinity, outMax: -Infinity, outSum: 0, inSum: 0, faults: new Set() };
};

/** @param {Record<number, number>} regs raw registers, for the live setpoint/reservoir/hours */
const summary = (regs) => ({
  attachments: [{ color: "#cccccc", text: [
    `*Chiller daily summary* (${stats.since.toDateString() === new Date().toDateString()
      ? `since ${dateTime.clock(stats.since)}` : "past 24 h"})`,
    `Glycol out ${F(stats.outMin)}–${F(stats.outMax)}, avg ${F(stats.outSum / stats.n)} · setpoint ${F(scale(regs[70]))}`,
    `Glycol in avg ${F(stats.inSum / stats.n)} · reservoir ${F(scale(regs[132]))}`,
    `Compressor hours: A ${regs[135]} · B ${regs[141]}`,
    `Alarms: ${stats.faults.size ? [...stats.faults].join(", ") : "none"}`,
  ].join("\n") }],
});

let cond = { active: new Map(), counts: new Map(), hist: [] };
const pendingPosts = [];
const dayKey = (/** @type {Date} */ d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// A startup before the scheduled hour may still post today's first summary. A
// startup at/after it waits until tomorrow rather than calling a tiny window a day.
const initialDailyKey = (/** @type {Date} */ now, hour = DAILY_HOUR) =>
  now.getHours() >= hour ? dayKey(now) : null;
let lastDaily = null;

async function slackTick() {
  if (!stats) resetStats(); // normally seeded by startSlack, but don't depend on it
  const [regs, web, alarms] = await Promise.all([read(), readWeb(), readAlarms()]);
  const next = step(cond, { t: Date.now(), regs, web, alarms });
  cond = next;
  pendingPosts.push(...next.posts.map((text) => ({ text })));
  const alertsDelivered = await flushPosts(pendingPosts);

  if (regs) {
    const out = scale(regs[68]);
    stats.n++;
    stats.outMin = Math.min(stats.outMin, out);
    stats.outMax = Math.max(stats.outMax, out);
    stats.outSum += out;
    stats.inSum += scale(regs[69]);
  }
  for (const a of alarms?.active ?? []) stats.faults.add(a.name);

  const now = new Date();
  const today = dayKey(now);
  if (alertsDelivered && regs && stats.n && now.getHours() >= DAILY_HOUR && today !== lastDaily) {
    // Do not advance the schedule or discard the accumulated window until Slack
    // accepts it. A failed daily post is rebuilt from the still-growing window
    // and retried on the next poll.
    if (await post(summary(regs))) {
      lastDaily = today;
      resetStats();
    }
  }
}

const startSlack = () => { // no-op unless SLACK_WEBHOOK_URL is set
  if (!SLACK_URL) return;
  resetStats();
  lastDaily = initialDailyKey(new Date());
  slackTick();
  setInterval(slackTick, POLL_MIN * 60 * 1000);
};

module.exports = { step, CONDITIONS, post, flushPosts, initialDailyKey, startSlack };
