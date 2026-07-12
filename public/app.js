// Main page script (classic): the 5 s refresh loop (tick), offline handling,
// and the uPlot glycol history chart. Loaded by dashboard.html at /app.js.
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
  // health tint on the supply temp — same bands the Slack reports use (see slackPayload)
  $("glyOut").className = "t out" + (r(68) > 40 ? " bad" : r(68) > 30 ? " warn" : "");
  set("setp", r(70).toFixed(1) + " °F"); set("resT", r(132).toFixed(1) + " °F");
  set("dt", (r(69) - r(68)).toFixed(1) + " °F");
  histSetp = r(70); // feeds the history chart's setpoint reference line
  set("supP", (w["Glycol supply pres psi"] ?? NaN).toFixed(1) + " psi");
  set("pwr", (d.regs[1] / 10).toFixed(0) + "%");

  for (const [n, sfx] of [["1", "A"], ["2", "B"]]) {
    const base = n === "1" ? 0 : 32;
    set("dscgP" + n, r(base + 3).toFixed(1)); set("suctP" + n, r(base + 10).toFixed(1));
    set("condT" + n, r(base + 4).toFixed(1)); set("evapT" + n, r(base + 11).toFixed(1));
    set("suctT" + n, r(base + 9).toFixed(1)); set("ssh" + n, sh(r(base + 23)));
    const comp = w["Compressor " + sfx + " on"];
    $("comp" + n).className = "dot" + (comp ? " ok" : "");
    unit3d.comps[+n - 1] = !!comp; // 3D unit: compressor lights up while running
    set("cst" + n, comp ? "· comp running" : "· comp idle");
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

  $("hours").innerHTML = `<span>Runtime</span>` +
    `<span>Comp A <b>${d.regs[135]} h</b></span><span>Comp B <b>${d.regs[141]} h</b></span>` +
    `<span>Fan A <b>${d.regs[158]} h</b></span><span>Pump 2 <b>${d.regs[131]} h</b></span>`;

  $("raw").innerHTML =
    "<tr><th>reg</th><th>raw</th><th>÷10</th></tr>" +
    Object.entries(d.regs).filter(([, v]) => v !== 0)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${S(v)}</td></tr>`).join("");
}
let lastGoodMs = 0; // last successful refresh, so "offline" can say how stale the data is
const age = ms => { const s = Math.round(ms / 1000);
  return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h"; };
function net(ok) {
  const el = $("net");
  if (ok) lastGoodMs = Date.now();
  el.textContent = ok ? "updated " + new Date().toLocaleTimeString()
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

let histBackfilling = false; // true while the server backfill runs (X-Log-Loading header)

async function loadHist(hours) {
  // -> uPlot data [[unix ts], [in °F], [out °F], [circ A run], [circ B run]],
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
  // each circuit has two compressor state columns; "running" = either is 1
  const iA1 = head.indexOf("Comp1Circ1_Dout.Val"), iA2 = head.indexOf("Comp2Circ1_On");
  const iB1 = head.indexOf("Comp1Circ2_Dout.Val"), iB2 = head.indexOf("Comp2Circ2_On");
  if (iT < 0 || iIn < 0 || iOut < 0) return null;
  // missing compressor columns degrade to empty strips (index -1 → NaN → "off"),
  // which is indistinguishable from idle — say so instead of failing silently
  if ((iA1 < 0 && iA2 < 0) || (iB1 < 0 && iB2 < 0))
    console.warn("history: compressor column(s) missing from the log header — run strips will be empty");
  const xs = [], ins = [], outs = [], as = [], bs = [];
  for (const line of rows) {
    const c = line.split(",");
    if (c.length < head.length) continue;
    const t = new Date(c[iT].slice(0, 19)).getTime() / 1000; // strip +00:00, parse as local
    if (!isFinite(t)) continue;
    if (xs.length && t - xs[xs.length - 1] > 900) {          // >15 min hole: break the lines
      xs.push(t - 1); ins.push(null); outs.push(null); as.push(null); bs.push(null);
    }
    xs.push(t); ins.push(F(parseFloat(c[iIn]))); outs.push(F(parseFloat(c[iOut])));
    as.push(+c[iA1] || +c[iA2] ? 1.5 : null);                // strip heights on the "run" scale
    bs.push(+c[iB1] || +c[iB2] ? 0.5 : null);
  }
  return [xs, ins, outs, as, bs];
}

// Current cooling setpoint (Modbus reg 70, °F), set by tick(). Drawn as a flat
// dashed reference across the window — the datalogger has no setpoint column,
// so past setpoint changes aren't recorded; only "where it should be now".
let histSetp = null;

let histChart, histHours = 6;
function drawHist(data) {
  const el = $("chart");
  $("histpct").textContent = histBackfilling ? "backfilling…" : "";
  if (histChart) { histChart.destroy(); histChart = null; }
  if (!data || !data[0].length) {
    el.innerHTML = `<div class="msg">${histBackfilling ? "loading history…" : "no log data for this range"}</div>`;
    return;
  }
  el.innerHTML = "";
  const css = getComputedStyle(document.documentElement);
  const v = p => css.getPropertyValue(p).trim();
  const axis = { stroke: v("--dim"), grid: { stroke: v("--line"), width: 1 },
                 ticks: { stroke: v("--line"), width: 1 }, font: '12px "Inter", sans-serif' };
  const degF = (u, x) => (x == null ? "–" : x.toFixed(1) + " °F");
  // compressor run strips: stepped bars at the chart bottom on a fixed hidden
  // scale (A above B), drawn only while running so idle time stays empty
  const strip = (label) => ({ label, stroke: v("--ok"), width: 4, scale: "run",
    paths: uPlot.paths.stepped({ align: 1 }), points: { show: false },
    value: (u, x) => (x == null ? "off" : "on") });
  histChart = new uPlot({
    width: el.clientWidth, height: 220,
    series: [
      {},
      { label: "In (return)",  stroke: v("--hist-in"), width: 2, value: degF },
      { label: "Out (supply)", stroke: v("--accent"),  width: 2, value: degF },
      strip("Comp A"), strip("Comp B"),
      { label: "Setpoint", stroke: v("--mut"), width: 1, dash: [4, 4], value: degF },
    ],
    scales: { run: { range: [0, 15] } }, // strips occupy the bottom ~10%
    axes: [axis, { ...axis, size: 46, values: (u, vs) => vs.map(x => x + "°") }],
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
