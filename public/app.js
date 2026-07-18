// Main page script (classic): the 5 s refresh loop (tick), offline handling,
// the click-to-edit setpoint control (rendered only when the server reports
// writesEnabled, i.e. SETPOINT_WRITE=1), and the uPlot glycol history chart.
// Loaded by dashboard.html at /app.js.
const S = v => (v > 32767 ? v - 65536 : v) / 10;          // signed int16, ×10
const STATUS = {1:"Standby",2:"Off — alarm",3:"Off — BMS",4:"Off — schedule",
                5:"Off — input",6:"Off — keyboard",9:"Running"};
const $ = id => document.getElementById(id);
const set = (id, txt) => { $(id).textContent = txt; };
const sh = v => (v < -50 ? "—" : v.toFixed(1));            // sentinel: probe not fitted
// Bridge to the 3D unit (unit3d.js — a classic script's top-level const is a
// global lexical binding, visible to the module): tick() writes live fan speeds and
// compressor states, then pokes changed(), which the module installs.
const unit3d = { fans: [0, 0], comps: [false, false], changed: null };

// Setpoint-write state from /api/all: whether the server accepts writes (the
// setpoint readout becomes a button), the boost automation's live snapshot
// (drives the "boost active"/latched lines), and the current supply temp
// (shown in the setpoint dialog for reference).
let writesOn = false, boostNow = null, liveSupplyF = null;

async function tick() {
  let d;
  try { d = await (await fetch("/api/all")).json(); }
  catch { return net(false); }
  if (!d.regs) return net(false);
  net(true);
  const r = a => S(d.regs[a] ?? 0), w = d.web || {};

  const st = d.regs[0];
  set("stattxt", STATUS[st] || "Status " + st);
  const grade = st === 9 ? "ok" : st === 2 ? "bad" : "warn";
  $("statdot").className = "dot " + grade;
  $("stat").className = grade === "ok" ? "" : grade; // text echoes the dot so alarms read at a glance

  set("glyIn", r(69).toFixed(1)); set("glyOut", r(68).toFixed(1));
  // health tint on the supply temp — amber above 30 °F, red above 40 °F
  $("glyOut").className = "t out" + (r(68) > 40 ? " bad" : r(68) > 30 ? " warn" : "");
  set("resT", r(132).toFixed(1) + " °F");
  histSetp = r(70); // feeds the history chart's setpoint reference line (and the setpoint dialog prefill)
  liveSupplyF = r(68);
  writesOn = !!d.writesEnabled;
  boostNow = d.boost || null;
  set("pwr", (d.regs[1] / 10).toFixed(0) + "%");

  for (const [n, sfx] of [["1", "A"], ["2", "B"]]) {
    const base = n === "1" ? 0 : 32;
    set("dscgP" + n, r(base + 3).toFixed(1)); set("suctP" + n, r(base + 10).toFixed(1));
    set("condT" + n, r(base + 4).toFixed(1)); set("evapT" + n, r(base + 11).toFixed(1));
    set("suctT" + n, r(base + 9).toFixed(1)); set("ssh" + n, sh(r(base + 23)));
    const comp = w["Compressor " + sfx + " on"];
    $("comp" + n).className = "dot" + (comp ? " ok" : "");
    unit3d.comps[+n - 1] = !!comp; // 3D unit: compressor lights up while running
    set("cst" + n, comp ? "· running" : "· idle");
    const fan = w["Fan speed " + sfx + " %"] ?? 0, eev = w["EEV position " + sfx + " %"] ?? 0;
    set("fan" + n, fan.toFixed(0) + "%"); $("fanB" + n).style.width = fan + "%";
    unit3d.fans[+n - 1] = fan; // drives the 3D unit's fan animation
    set("eev" + n, eev.toFixed(0) + "%"); $("eevB" + n).style.width = eev + "%";
  }
  // standby = both compressors off: in/out colors (and supply alerts) only show while running
  document.body.classList.toggle("run", unit3d.comps[0] || unit3d.comps[1]);
  unit3d.changed?.(); // repaint the 3D unit with the fresh compressor state

  const pill = (name, on, badWhenOff, tip) =>
    `<span title="${tip}"><span class="dot ${on ? "ok" : badWhenOff ? "bad" : ""}"></span>${name}</span>`;
  $("pills").innerHTML =
    pill("Chiller pump", w["Chiller pump on"], false, "Circulates glycol through the chiller") +
    pill("Process pump", w["Process pump on"], false, "Circulates glycol out to the process") +
    pill("Flow A", w["Glycol flow A ok"], true, "Flow switch, circuit A — red means no flow") +
    pill("Flow B", w["Glycol flow B ok"], true, "Flow switch, circuit B — red means no flow");

  safety(w, d.regs);
}
// --- Safety column (left of the cabinet) ---
// Everything here answers "is something wrong?", so the resting state is grey and
// quiet: a leak sensor reading 0 % says nothing more than "sensor is alive". Colour
// and detail appear only on a fault, which is why the alarm card is emitted at all
// only when the controller reports one.
let alarms = null; // latest /api/alarms payload; null until the first poll lands
// Unmapped alarm vars fall through to their raw controller name — escape before
// it reaches innerHTML rather than trust a string we don't control.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * @param {Record<string, number>} w web vars from /api/all
 * @param {Record<number, number>} regs raw registers (runtime hour counters)
 */
function safety(w, regs) {
  const lel = (sfx) => {
    const v = w["LEL " + sfx + " %"];
    // a leak sensor is the one thing on this machine that can hurt someone — an
    // unreadable sensor is itself a fault, so undefined reads amber, not grey
    if (v == null) return `<div class="s"><span class="dot warn"></span>Gas ${sfx} <b>no reading</b></div>`;
    return `<div class="s"><span class="dot ${v ? "bad" : "ok"}"></span>Gas ${sfx}` +
           (v ? ` <b>${v.toFixed(1)}% LEL</b>` : "") + `</div>`;
  };
  const trip = (key, name, tip) => w[key]
    ? `<div class="s" title="${tip}"><span class="dot bad"></span><b>${name} tripped</b></div>` : "";

  const active = (alarms?.active ?? []).map((a) =>
    `<div class="alarm"><span>${esc(a.name)}</span><span class="when">since ${when(a.since)}</span></div>`).join("");
  // no active alarm → show the last one instead: this unit trips high-glycol-temp
  // often enough that "nothing right now" alone would hide a real pattern
  const last = !active && alarms?.recent?.length
    ? `<div class="last">Last fault<br><b>${esc(alarms.recent[0].name)}</b> · ${when(alarms.recent[0].at)}</div>` : "";

  // runtime hours, paired A/B per device — wear on each half of the machine, and
  // the gap between a pair is the interesting bit (lead/lag imbalance)
  const hrs = (name, a, b) =>
    `<div class="hr"><span>${name}</span><b>${regs[a] ?? "–"}</b><b>${regs[b] ?? "–"}</b></div>`;

  // glycol loop targets, sitting above Safety in the left column: what the
  // controller is aiming for (CoolSetP, reg 70) and the supply pressure it sees.
  // When the server accepts writes the setpoint value renders as a button
  // (click or focus+Enter opens the editor dialog); otherwise it is the same
  // read-only <b> as always.
  const setpF = S(regs[70] ?? 0).toFixed(1);
  const setpVal = writesOn
    ? `<button class="setp" id="setp" title="Change the cooling setpoint — writes to the controller">${setpF} °F</button>`
    : `<b>${setpF} °F</b>`;
  // Boost status lines: everything interpolated is a number off the wire,
  // coerced through toFixed()/Math — no server string reaches innerHTML.
  const boostLine = boostNow?.phase === "active"
    ? `<div class="boost">Boost active: setpoint raised from ${(+boostNow.originalF).toFixed(1)} °F (write ${Math.round(+boostNow.writes)}/${Math.round(+boostNow.maxWrites)})</div>` : "";
  const latchLine = boostNow?.latched
    ? `<div class="latched">Setpoint writes latched off — the last automatic write read back wrong; no writes until the register is re-probed</div>` : "";
  const glycol =
    `<h3>Glycol</h3>` +
    `<div class="g" title="Target supply temperature (CoolSetP)"><span>Setpoint</span>${setpVal}</div>` +
    boostLine + latchLine +
    `<div class="g"><span>Supply</span><b>${(w["Glycol supply pres psi"] ?? NaN).toFixed(1)} psi</b></div>`;

  // The rail is rebuilt wholesale every tick; if the setpoint button held
  // keyboard focus, restore it so Tab position survives the refresh.
  const setpHadFocus = document.activeElement && document.activeElement.id === "setp";
  $("safety").innerHTML =
    glycol +
    `<h3 class="rt">Safety</h3>` +
    lel("A") + lel("B") +
    trip("HP pressostat trip", "HP switch",
         "High-pressure pressostat opened — refrigerant pressure exceeded the mechanical limit") +
    trip("LP pressostat trip", "LP switch",
         "Low-pressure pressostat opened — refrigerant pressure fell below the mechanical limit") +
    (active || last) +
    `<h3 class="rt">Runtime <span>hours · A / B</span></h3>` +
    hrs("Compressor", 135, 141) + hrs("Fan", 158, 160) + hrs("Pump", 129, 131);
  if (setpHadFocus) $("setp")?.focus();
}

// --- Setpoint editor -------------------------------------------------------
// Only reachable when /api/all reports writesEnabled (safety() renders the
// button then). The dialog shows the consequence of the value being typed —
// the firmware shuts the unit down at setpoint + 18 °F — and the confirm
// button POSTs {setpointF} to /api/setpoint. On success the dialog closes and
// tick() refreshes, so the new value on the page comes from a real read.
const TRIP_F = 18; // firmware shutdown constant; mirrors TRIP_F in lib/boost.js
const setpTripLine = () => {
  const v = parseFloat($("setpInput").value);
  $("setpTrip").textContent = isFinite(v)
    ? `Shutdown alarm would trip at ${(v + TRIP_F).toFixed(1)} °F` : "";
};
function openSetp() {
  $("setpInput").value = histSetp != null ? histSetp.toFixed(1) : "";
  $("setpSupply").textContent = liveSupplyF != null
    ? `Current supply temperature: ${liveSupplyF.toFixed(1)} °F` : "";
  $("setpErr").textContent = "";
  setpTripLine();
  $("setpDialog").showModal();
}
// Delegated: the safety rail's innerHTML is rebuilt every tick, so the button
// itself can't hold a listener. A <button> makes Enter fire "click" natively.
$("safety").addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("#setp")) openSetp();
});
$("setpInput").oninput = setpTripLine;
$("setpClose").onclick = $("setpCancel").onclick = () => $("setpDialog").close();
$("setpWrite").onclick = async () => {
  const v = parseFloat($("setpInput").value);
  if (!isFinite(v)) { $("setpErr").textContent = "Enter a number"; return; }
  const b = $("setpWrite");
  b.disabled = true; // one write in flight at a time
  $("setpErr").textContent = "";
  try {
    const res = await fetch("/api/setpoint", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setpointF: v }) });
    const j = await res.json().catch(() => null);
    if (!j || !j.ok) {
      // server-provided string → textContent, never markup
      $("setpErr").textContent = (j && j.error) || `write failed (HTTP ${res.status})`;
      return;
    }
    $("setpDialog").close();
    tick(); // re-render from a real read rather than trusting the echo
  } catch {
    $("setpErr").textContent = "network error — the write may not have reached the server";
  } finally { b.disabled = false; }
};

// Human-facing dates come from the same formatter used by Slack. It preserves
// the controller's site-local clock fields despite their misleading +00:00.
const stamp = (ts) => esc(ChillerDateTime.moment(ts));
const when = stamp;
// How long the fault stood — the useful part: a 6.9 h high-temp is a different
// story from a 2 min one, and the log's Start/Stop pair is the only place it shows.
// A Start with no Stop does NOT mean "still active": the controller's log holds
// only ~50 events, so old faults routinely have their Stop truncated off the end.
// Only an alarm the controller currently reports as active gets to say so.
const lasted = (a) => {
  if (!a.cleared) return alarms?.active?.some((x) => x.name === a.name) ? "still active" : "—";
  const ms = ChillerDateTime.elapsed(a.at, a.cleared);
  return ms === null ? "—" : ms === 0 ? "cleared immediately" : ChillerDateTime.duration(ms);
};

// The full fault log, newest first (the controller keeps ~50 events).
function drawAlarmLog() {
  if (!alarms) return;
  $("alarmlog").innerHTML = alarms.recent.length
    ? "<tr><th>fault</th><th>started</th><th>lasted</th></tr>" +
      alarms.recent.map((a) =>
        `<tr><td>${esc(a.name)}</td><td>${stamp(a.at)}</td><td>${lasted(a)}</td></tr>`).join("")
    : "<tr><td>no faults in the controller's log</td></tr>";
}

// Faults don't need 5 s resolution and cost two extra controller requests — poll slowly.
(async function alarmLoop() {
  try {
    const a = await (await fetch("/api/alarms")).json();
    if (!a.error) { alarms = a; drawAlarmLog(); }
  } catch { /* leave the last known alarms up; tick()'s offline banner covers the outage */ }
  setTimeout(alarmLoop, 60000);
})();

let lastGoodMs = 0; // last successful refresh, so "offline" can say how stale the data is
const age = ms => ChillerDateTime.duration(ms, 1) || "—";
function net(ok) {
  const el = $("net");
  if (ok) lastGoodMs = Date.now();
  el.textContent = ok ? "updated " + ChillerDateTime.clock(new Date(), true)
                      : "offline" + (lastGoodMs ? " · data " + age(Date.now() - lastGoodMs) + " old" : "");
  el.className = ok ? "" : "down";
  document.body.classList.toggle("offline", !ok);
}
tick(); setInterval(tick, 5000);

// --- Glycol history: the controller's onboard datalogger via /api/log ---
// Log rows are °C and stamped "+00:00" even though the controller clock runs
// site-local time, so timestamps are parsed as local wall-clock (Mac and site
// are assumed to share a timezone) and temps converted to °F to match the page.
const F = c => c * 9 / 5 + 32;
const pad = n => String(n).padStart(2, "0");
const tstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
                  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// True while the server backfill runs (X-Log-Loading header). No longer shown as a
// badge — it only speeds up the poll and words the empty-state message.
let histBackfilling = false;

async function loadHist(hours) {
  // -> uPlot data [[unix ts], [in °F], [out °F], [circ A run], [circ B run],
  //    [cond A °F], [cond B °F]] (cond = saturation temp from discharge pressure),
  // or null on failure. Run series are strip y-values (fixed "run" scale) while
  // either of the circuit's compressors is on, null while off.
  // /api/log answers instantly from the server's rolling cache; X-Log-Loading
  // says its startup backfill is still running. stop is padded +1 h: the
  // controller clock drifts fast (~25 min ahead as of 2026-07-11), and rows
  // stamped past "now" would otherwise be silently dropped.
  const now = Date.now();
  const stop = new Date(now + 3600e3), start = new Date(now - hours * 3600e3);
  let text;
  try {
    const res = await fetch(`/api/log?start=${tstr(start)}&stop=${tstr(stop)}`);
    histBackfilling = res.headers.get("X-Log-Loading") === "1";
    text = await res.text();
  } catch { return null; }
  const rows = text.trim().split(/\r?\n/); // controller CSV is CRLF
  const head = (rows.shift() || "").split(",").map(s => s.replace(/"/g, ""));
  const iT = head.indexOf("TIME"), iIn = head.indexOf("W_InTempUser"), iOut = head.indexOf("W_OutTempUser");
  const iP1 = head.indexOf("DscgP_Circ1"), iP2 = head.indexOf("DscgP_Circ2");
  // each circuit has two compressor state columns; "running" = either is 1
  const iA1 = head.indexOf("Comp1Circ1_Dout.Val"), iA2 = head.indexOf("Comp2Circ1_On");
  const iB1 = head.indexOf("Comp1Circ2_Dout.Val"), iB2 = head.indexOf("Comp2Circ2_On");
  if (iT < 0 || iIn < 0 || iOut < 0) return null;
  // missing compressor columns degrade to empty strips (index -1 → NaN → "off"),
  // which is indistinguishable from idle — say so instead of failing silently
  if ((iA1 < 0 && iA2 < 0) || (iB1 < 0 && iB2 < 0))
    console.warn("history: compressor column(s) missing from the log header — run strips will be empty");
  const xs = [], ins = [], outs = [], as = [], bs = [], ca = [], cb = [];
  histGaps = []; // [{a,b}] unix-sec spans where logging stopped (the controller log skips them)
  for (const line of rows) {
    const c = line.split(",");
    if (c.length < head.length) continue;
    const t = new Date(c[iT].slice(0, 19)).getTime() / 1000; // strip +00:00, parse as local
    if (!isFinite(t)) continue;
    if (xs.length && t - xs[xs.length - 1] > 900) {          // >15 min hole: break the lines
      histGaps.push({ a: xs[xs.length - 1], b: t });         // a gap in the controller's own log = logging was stopped
      xs.push(t - 1); ins.push(null); outs.push(null); as.push(null); bs.push(null);
      ca.push(null); cb.push(null);
    }
    xs.push(t); ins.push(F(parseFloat(c[iIn]))); outs.push(F(parseFloat(c[iOut])));
    as.push(+c[iA1] || +c[iA2] ? 1.5 : null);                // strip heights on the "run" scale
    bs.push(+c[iB1] || +c[iB2] ? 0.5 : null);
    ca.push(condF(parseFloat(c[iP1]))); cb.push(condF(parseFloat(c[iP2])));
  }
  return [xs, ins, outs, as, bs, ca, cb];
}

// Condensing temp isn't in the datalogger, but discharge pressure (bar abs) is,
// and saturated refrigerant pressure maps 1:1 to temperature — that's exactly
// how the controller computes the condensing temp it shows live. This is an
// R290 (propane) unit (hence the PctLEL sensors); table is NIST propane
// saturation, matches the controller's live reg-4/36 values within ~0.1 °F.
const SAT = [[0, 4.745], [5, 5.51], [10, 6.36], [15, 7.30], [20, 8.36], [25, 9.52],
  [30, 10.79], [35, 12.18], [40, 13.69], [45, 15.34], [50, 17.13], [55, 19.06], [60, 21.22]];
function condF(bar) { // °C sat temp for propane at `bar` abs, returned in °F; null off-table
  if (!isFinite(bar)) return null;
  for (let i = 1; i < SAT.length; i++) {
    const [t0, p0] = SAT[i - 1], [t1, p1] = SAT[i];
    if (bar <= p1) return bar < p0 ? null : F(t0 + (t1 - t0) * (bar - p0) / (p1 - p0));
  }
  return null; // above 60 °C sat — not a real operating point, likely a bad sample
}

// Current cooling setpoint (Modbus reg 70, °F), set by tick(). Drawn as a flat
// dashed reference across the window — the datalogger has no setpoint column,
// so past setpoint changes aren't recorded; only "where it should be now".
let histSetp = null;
let histGaps = []; // logging-stopped spans in the current range, set by loadHist

// The controller's onboard log freezes the instant a global alarm fires and does
// not re-arm when it clears — re-arming is manual. Shown in the stopped banner so
// whoever sees the frozen chart knows how to fix it without hunting for the steps.
const RESTART_STEPS = "On the controller display (pGD): hold Alarm + Enter ~3 s for the " +
  "system menu → LOGGER → RESTART LOGS. Logging re-arms even if it says “no logs to restart.”";

let histChart, histHours = 6;
function drawHist(data) {
  const el = $("chart");
  if (histChart) { histChart.destroy(); histChart = null; }
  if (!data || !data[0].length) {
    el.innerHTML = `<div class="msg">${histBackfilling ? "loading history…" : "no log data for this range"}</div>`;
    return;
  }
  el.innerHTML = "";
  // Datalogger currently stopped: newest row is stale while the controller itself
  // is live (offline is a different state — its own banner covers it). Drift runs
  // the clock fast, so a live tail sits at/ahead of now; only a real stop lags.
  const last = data[0][data[0].length - 1];
  if (!document.body.classList.contains("offline") && Date.now() / 1000 - last > 900) {
    const b = document.createElement("div");
    b.className = "log-stopped";
    b.innerHTML = `<strong>Datalogger stopped</strong> — no new rows for ${age(Date.now() - last * 1000)}. ` +
      `The onboard log halts on any alarm and won’t restart on its own. ${RESTART_STEPS}`;
    el.appendChild(b);
  }
  const css = getComputedStyle(document.documentElement);
  const v = p => css.getPropertyValue(p).trim();
  // hairline dashed grid, no tick marks: the data should carry the eye, not the frame
  const axis = { stroke: v("--dim"), grid: { stroke: v("--line"), width: 1, dash: [3, 5] },
                 ticks: { show: false }, font: '11px "Inter", sans-serif', gap: 8 };
  const degF = (u, x) => (x == null ? "–" : x.toFixed(1) + " °F");
  // soft vertical fade under the glycol lines — gives them a floor instead of
  // leaving them floating as bare strokes. Alpha suffix on the 6-digit hex.
  // uPlot resolves series.fill once before the plot is laid out, when bbox is still
  // empty — createLinearGradient throws on the NaN, so fall back to a flat wash
  // until there's a real box to gradient across.
  const fade = hex => u => {
    const { top, height } = u.bbox || {};
    if (!(height > 0)) return hex + "20";
    const g = u.ctx.createLinearGradient(0, top, 0, top + height);
    g.addColorStop(0, hex + "38"); g.addColorStop(1, hex + "00");
    return g;
  };
  // compressor run strips: one rounded pill per contiguous "on" run, at the chart
  // bottom on a fixed hidden scale (A above B). Idle time stays empty.
  // Circuit color (--ckt-a/--ckt-b) matches that circuit's compressor in the 3D unit.
  // Drawn as filled roundRects rather than a stepped line: uPlot 1.6 ignores the
  // series `cap`, so a stroked line ends square no matter what.
  const H = 6; // pill height in CSS px; the radius is half of it, so the ends are semicircles
  const pills = (u, si) => {
    const p = new Path2D(), xs = u.data[0], ys = u.data[si], r = u.ctx.canvas.height / u.height; // r: device px per CSS px
    // loadHist must emit one constant non-null value per strip; the first one fixes its vertical position.
    const h = H * r, y = u.valToPos(ys.find(v => v != null) ?? 0, "run", true) - h / 2;
    for (let i = 0; i < ys.length; i++) {
      if (ys[i] == null) continue;
      const s = i;
      while (i + 1 < ys.length && ys[i + 1] != null) i++;
      const x0 = u.valToPos(xs[s], "x", true), x1 = u.valToPos(xs[i], "x", true);
      p.roundRect(x0, y, Math.max(x1 - x0, h), h, h / 2); // min width h: a single-sample run stays a dot, not a sliver
    }
    return { fill: p };
  };
  const strip = (label, ckt) => ({ label, stroke: v(ckt), fill: v(ckt), width: 0, scale: "run",
    paths: pills, points: { show: false },
    value: (u, x) => (x == null ? "off" : "on") });
  const IN = v("--hist-in"), OUT = v("--accent");
  histChart = new uPlot({
    width: el.clientWidth, height: 260,
    // one hover dot on the hovered series, sized to be findable on a wall display
    cursor: { points: { size: 7 }, y: false },
    series: [
      // x series: the legend row is un-hidden (see dashboard.html) so the cursor
      // reads out the exact hovered time — the axis only labels every ~30 min.
      { label: "Time", value: (u, ts) => (ts == null ? "—" : ChillerDateTime.clock(ts * 1000, true)) },
      { label: "Return", stroke: IN,  width: 2, fill: fade(IN),  value: degF },
      { label: "Supply", stroke: OUT, width: 2, fill: fade(OUT), value: degF },
      strip("Compressor A", "--ckt-a"), strip("Compressor B", "--ckt-b"),
      // condensing temps live ~90–130 °F, far above the glycol lines — their own
      // right-hand scale keeps both readable instead of flattening the glycol detail.
      // Dotted so they read as secondary next to the solid glycol lines they share
      // a circuit color with.
      { label: "Condenser A", stroke: v("--ckt-a"), width: 1, dash: [1, 3], scale: "cond", value: degF },
      { label: "Condenser B", stroke: v("--ckt-b"), width: 1, dash: [1, 3], scale: "cond", value: degF },
      { label: "Setpoint", stroke: v("--dim"), width: 1, dash: [4, 4], value: degF },
    ],
    scales: { run: { range: [0, 15] } }, // strips occupy the bottom ~10%
    axes: [axis, { ...axis, size: 46, values: (u, vs) => vs.map(x => x + "°") },
      { ...axis, size: 46, scale: "cond", side: 1, grid: { show: false },
        values: (u, vs) => vs.map(x => x + "°") }],
    // shade each logging-stopped span so a hole reads as "logs stopped here", not
    // missing data. drawClear runs after the canvas clear, before the series paint,
    // so the band sits under the lines. uPlot only fires hooks registered via plugins.
    plugins: [{ hooks: { drawClear: u => {
      if (!histGaps.length) return;
      const { ctx } = u, { top, height } = u.bbox;
      ctx.save();
      ctx.font = '10px "Inter", sans-serif'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const band = v("--bad") + "1a", ink = v("--bad");
      for (const g of histGaps) {
        const x0 = u.valToPos(g.a, "x", true), x1 = u.valToPos(g.b, "x", true);
        ctx.fillStyle = band; ctx.fillRect(x0, top, Math.max(x1 - x0, 2), height);
        const label = "logs stopped";
        if (x1 - x0 > ctx.measureText(label).width + 8) {
          ctx.fillStyle = ink; ctx.fillText(label, (x0 + x1) / 2, top + height / 2);
        }
      }
      ctx.restore();
    } } }],
  }, [...data, data[0].map(() => histSetp)], el);
}

function histLoading() {
  // shown on initial load and range switches; the 60 s refresh redraws in place instead
  if (histChart) { histChart.destroy(); histChart = null; }
  $("chart").innerHTML = '<div class="msg">loading log…</div>';
}

$("ranges").onclick = async e => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of b.parentNode.children) x.classList.toggle("on", x === b);
  histHours = +b.dataset.h;
  histLoading();
  drawHist(await loadHist(histHours));
};
addEventListener("resize", () => histChart && histChart.setSize({ width: $("chart").clientWidth, height: 220 }));
histLoading();
(async function histLoop() {
  // fast ticks while the server backfills (chart grows chunk by chunk), then 60 s
  drawHist(await loadHist(histHours));
  setTimeout(histLoop, histBackfilling ? 5000 : 60000);
})();
