# Read-only web view of the G&D glycol chiller (c.pCO) over Modbus TCP + HTTP.
# Cloudflare Access sits in front for auth; this app has no login of its own by design.
# Run:  pip install fastapi uvicorn pymodbus
#       CHILLER_IP=192.168.1.69 uvicorn chiller_dashboard:app --host 0.0.0.0 --port 8000
import csv
import io
import os
import urllib.request
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from pymodbus.client import ModbusTcpClient

HOST = os.environ.get("CHILLER_IP", "192.168.1.69")

# INPUT-register labels confirmed by time-series correlation against the
# controller's own getvar.csv (see correlate_registers.py): a register earns a
# label only by tracking that variable across every sample while running.
# Circuit 1 occupies 0..28, circuit 2 mirrors it at 32..56. Integer regs
# (status/counts) are NOT ×10; only analog temps/pressures are. Fan speed, EEV
# position, and glycol supply pressure are NOT on the Modbus TCP map at all
# (they exist only in the Modbus_FB block for the serial BMS port).
LABELS = {
    0: "Chiller status (int enum, Modbus_FB.ChillerStat)",
    1: "Power request (int, tenths of %; 1000=100%)",
    2: "Power running circ 1 (int, tenths of %)",
    3: "Discharge pres circ 1 psi",
    4: "Condensing temp circ 1 °F",
    9: "Suction temp circ 1 °F",
    10: "Suction pres circ 1 psi",
    11: "Evaporating temp circ 1 °F",
    23: "Suction superheat circ 1",
    24: "Discharge superheat circ 1",
    28: "EVD valve status circ 1 (int)",
    35: "Discharge pres circ 2 psi",
    36: "Condensing temp circ 2 °F",
    41: "Suction temp circ 2 °F",
    42: "Suction pres circ 2 psi",
    43: "Evaporating temp circ 2 °F",
    55: "Suction superheat circ 2",
    56: "Discharge superheat circ 2",
    68: "Glycol outlet °F",
    69: "Glycol inlet °F",
    70: "Cooling setpoint °F",
    131: "User pump 2 hours (int)",
    132: "Glycol reservoir temp °F",
    135: "Compressor 1 circ 1 hours (int)",
    141: "Compressor 1 circ 2 hours (int)",
    158: "Source fan 1 circ 1 hours (int)",
}
COUNT = int(os.environ.get("CHILLER_REGS", "160"))  # confirmed map spans 0..158

app = FastAPI()


def scale(v):
    # CAREL analog values are signed int16, stored ×10 (one decimal). Handle negatives.
    return (v - 65536 if v > 32767 else v) / 10


def read():
    # INPUT registers (FC4) hold the live sensor feed; HOLDING (FC3) are setpoints.
    c = ModbusTcpClient(HOST, timeout=3)
    try:
        out = {}  # addr -> raw uint16; chunked: Modbus allows max 125 regs/read
        for base in range(0, COUNT, 100):
            rr = c.read_input_registers(address=base, count=min(100, COUNT - base), device_id=1)
            if rr.isError():
                return None
            out.update({base + i: v for i, v in enumerate(rr.registers)})
        return out
    finally:
        c.close()


# Points that exist only in the Modbus_FB block (feeds the serial BMS port, not
# the TCP map). The controller's getvar.csv endpoint accepts repeated ?name=
# params, so one filtered HTTP request (~150 ms) fetches all of these live.
WEB_VARS = {
    "Modbus_FB.FanSpA": "Fan speed A %",
    "Modbus_FB.FanSpB": "Fan speed B %",
    "Modbus_FB.EEVPosA": "EEV position A %",
    "Modbus_FB.EEVPosB": "EEV position B %",
    "Modbus_FB.GlySupPres": "Glycol supply pres psi",
    "Modbus_FB.ResLvl": "Reservoir level",
    "Modbus_FB.ChPmpStat": "Chiller pump on",
    "Modbus_FB.ProcPmpStat": "Process pump on",
    "Modbus_FB.FlowStatA": "Glycol flow A ok",
    "Modbus_FB.FlowStatB": "Glycol flow B ok",
    "Modbus_FB.CompStatA": "Compressor A on",
    "Modbus_FB.CompStatB": "Compressor B on",
}


def read_web():
    # {label: value} from getvar.csv, already in engineering units (no ×10); None on failure.
    qs = "&".join(f"name={n}" for n in WEB_VARS)
    try:
        with urllib.request.urlopen(f"http://{HOST}/getvar.csv?{qs}", timeout=5) as r:
            rows = csv.DictReader(io.TextIOWrapper(r, encoding="latin-1"))
            return {WEB_VARS[x["name"]]: float(x["val"]) for x in rows if x["name"] in WEB_VARS}
    except (OSError, ValueError):
        return None


@app.get("/api")
def api():
    return JSONResponse(read() or {"error": "modbus read failed"})


@app.get("/api/web")
def api_web():
    return JSONResponse(read_web() or {"error": "getvar.csv fetch failed"})


@app.get("/api/all")
def api_all():
    # One call for the page's refresh loop: raw regs + web vars in one payload.
    return JSONResponse({"regs": read(), "web": read_web()})


# The page is a static shell; all rendering happens client-side from /api/all,
# so live values tick in place every 5 s without a page flash.
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glycol Chiller</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #08090c; --line: #1b1d23; --ink: #e2e4ea; --mut: #8a8f98; --dim: #62666e;
  --accent: #7b86e0; --ok: #4cb782; --warn: #d9a132; --bad: #eb5757;
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--bg); color: var(--ink);
  font: 400 14px/1.45 "Inter", -apple-system, sans-serif;
  font-variant-numeric: tabular-nums;
  max-width: 760px; margin: 0 auto; padding: 40px 24px 60px;
}
section { padding: 20px 0; border-bottom: 1px solid var(--line); }
header { display: flex; align-items: center; gap: 10px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
h1 { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
#stat { color: var(--mut); font-size: 13px; display: flex; align-items: center; gap: 7px; margin-left: 4px; }
#net { margin-left: auto; color: var(--dim); font-size: 12px; }
#net.down { color: var(--bad); }
.hero { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hero .t { font-size: 30px; font-weight: 500; letter-spacing: -.02em; }
.hero .t.out { color: var(--accent); }
.hero .u { color: var(--dim); font-size: 14px; }
.hero .to { color: var(--dim); font-size: 18px; padding: 0 4px; }
.facts { display: flex; gap: 28px; flex-wrap: wrap; margin-top: 14px; }
.facts div { font-size: 13px; color: var(--mut); }
.facts b { display: block; font-size: 14px; font-weight: 500; color: var(--ink); margin-top: 1px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
@media (max-width: 560px) { .cols { grid-template-columns: 1fr; } }
h2 { font-size: 13px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.row .k { color: var(--mut); }
.row .v { color: var(--ink); font-weight: 500; }
.row .v i { color: var(--dim); font-style: normal; font-weight: 400; }
.bar { width: 72px; height: 3px; border-radius: 2px; background: var(--line); display: inline-block; vertical-align: middle; margin-right: 8px; }
.bar i { display: block; height: 100%; border-radius: 2px; background: var(--mut); transition: width .6s; }
.pills { display: flex; gap: 22px; flex-wrap: wrap; }
.pills span { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--mut); }
.hours { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: var(--dim); }
.hours b { color: var(--mut); font-weight: 500; }
details { padding-top: 18px; color: var(--dim); font-size: 13px; }
summary { cursor: pointer; }
details table { border-collapse: collapse; margin-top: 10px; font-size: 12px; }
details td, details th { border: 1px solid var(--line); padding: 3px 10px; text-align: left; color: var(--mut); }
footer { padding-top: 16px; font-size: 12px; color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>Glycol Chiller</h1>
  <span id="stat"><span class="dot" id="statdot"></span><span id="stattxt">connecting</span></span>
  <span id="net"></span>
</header>

<section class="hero-wrap">
  <div class="hero">
    <span class="t" id="glyIn">–</span><span class="u">°F in</span>
    <span class="to">→</span>
    <span class="t out" id="glyOut">–</span><span class="u">°F out</span>
  </div>
  <div class="facts">
    <div>Setpoint<b id="setp">–</b></div>
    <div>Reservoir<b id="resT">–</b></div>
    <div>Supply pressure<b id="supP">–</b></div>
    <div>Power request<b id="pwr">–</b></div>
  </div>
</section>

<section class="cols">
  <div>
    <h2><span class="dot" id="comp1"></span>Circuit A</h2>
    <div class="row"><span class="k">Discharge pressure</span><span class="v"><span id="dscgP1">–</span> <i>psi</i></span></div>
    <div class="row"><span class="k">Suction pressure</span><span class="v"><span id="suctP1">–</span> <i>psi</i></span></div>
    <div class="row"><span class="k">Condensing temp</span><span class="v"><span id="condT1">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Evaporating temp</span><span class="v"><span id="evapT1">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Suction temp</span><span class="v"><span id="suctT1">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Suction superheat</span><span class="v" id="ssh1">–</span></div>
    <div class="row"><span class="k">Fan</span><span class="v"><span class="bar"><i id="fanB1"></i></span><span id="fan1">–</span></span></div>
    <div class="row"><span class="k">EEV</span><span class="v"><span class="bar"><i id="eevB1"></i></span><span id="eev1">–</span></span></div>
  </div>
  <div>
    <h2><span class="dot" id="comp2"></span>Circuit B</h2>
    <div class="row"><span class="k">Discharge pressure</span><span class="v"><span id="dscgP2">–</span> <i>psi</i></span></div>
    <div class="row"><span class="k">Suction pressure</span><span class="v"><span id="suctP2">–</span> <i>psi</i></span></div>
    <div class="row"><span class="k">Condensing temp</span><span class="v"><span id="condT2">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Evaporating temp</span><span class="v"><span id="evapT2">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Suction temp</span><span class="v"><span id="suctT2">–</span> <i>°F</i></span></div>
    <div class="row"><span class="k">Suction superheat</span><span class="v" id="ssh2">–</span></div>
    <div class="row"><span class="k">Fan</span><span class="v"><span class="bar"><i id="fanB2"></i></span><span id="fan2">–</span></span></div>
    <div class="row"><span class="k">EEV</span><span class="v"><span class="bar"><i id="eevB2"></i></span><span id="eev2">–</span></span></div>
  </div>
</section>

<section>
  <div class="pills" id="pills"></div>
  <div class="hours" id="hours"></div>
</section>

<details><summary>Raw registers</summary><table id="raw"></table></details>
<footer>Read-only · Modbus TCP + getvar.csv · refreshes every 5 s</footer>

<script>
const S = v => (v > 32767 ? v - 65536 : v) / 10;          // signed int16, ×10
const STATUS = {1:"Standby",2:"Off — alarm",3:"Off — BMS",4:"Off — schedule",
                5:"Off — input",6:"Off — keyboard",9:"Running"};
const $ = id => document.getElementById(id);
const set = (id, txt) => { $(id).textContent = txt; };
const sh = v => (v < -50 ? "—" : v.toFixed(1));            // sentinel: probe not fitted

async function tick() {
  let d;
  try { d = await (await fetch("/api/all")).json(); }
  catch { return net(false); }
  if (!d.regs) return net(false);
  net(true);
  const r = a => S(d.regs[a] ?? 0), w = d.web || {};

  const st = d.regs[0];
  set("stattxt", STATUS[st] || "Status " + st);
  $("statdot").className = "dot " + (st === 9 ? "ok" : st === 2 ? "bad" : "warn");

  set("glyIn", r(69).toFixed(1)); set("glyOut", r(68).toFixed(1));
  set("setp", r(70).toFixed(1) + " °F"); set("resT", r(132).toFixed(1) + " °F");
  set("supP", (w["Glycol supply pres psi"] ?? NaN).toFixed(1) + " psi");
  set("pwr", (d.regs[1] / 10).toFixed(0) + "%");

  for (const [n, sfx] of [["1", "A"], ["2", "B"]]) {
    const base = n === "1" ? 0 : 32;
    set("dscgP" + n, r(base + 3).toFixed(1)); set("suctP" + n, r(base + 10).toFixed(1));
    set("condT" + n, r(base + 4).toFixed(1)); set("evapT" + n, r(base + 11).toFixed(1));
    set("suctT" + n, r(base + 9).toFixed(1)); set("ssh" + n, sh(r(base + 23)));
    $("comp" + n).className = "dot" + (w["Compressor " + sfx + " on"] ? " ok" : "");
    const fan = w["Fan speed " + sfx + " %"] ?? 0, eev = w["EEV position " + sfx + " %"] ?? 0;
    set("fan" + n, fan.toFixed(0) + "%"); $("fanB" + n).style.width = fan + "%";
    set("eev" + n, eev.toFixed(0) + "%"); $("eevB" + n).style.width = eev + "%";
  }

  const pill = (name, on, badWhenOff) =>
    `<span><span class="dot ${on ? "ok" : badWhenOff ? "bad" : ""}"></span>${name}</span>`;
  $("pills").innerHTML =
    pill("Chiller pump", w["Chiller pump on"]) + pill("Process pump", w["Process pump on"]) +
    pill("Flow A", w["Glycol flow A ok"], true) + pill("Flow B", w["Glycol flow B ok"], true);

  $("hours").innerHTML =
    `<span>Comp A <b>${d.regs[135]} h</b></span><span>Comp B <b>${d.regs[141]} h</b></span>` +
    `<span>Fan A <b>${d.regs[158]} h</b></span><span>Pump 2 <b>${d.regs[131]} h</b></span>`;

  $("raw").innerHTML =
    "<tr><th>reg</th><th>raw</th><th>÷10</th></tr>" +
    Object.entries(d.regs).filter(([, v]) => v !== 0)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${S(v)}</td></tr>`).join("");
}
function net(ok) {
  const el = $("net");
  el.textContent = ok ? new Date().toLocaleTimeString() : "offline";
  el.className = ok ? "" : "down";
}
tick(); setInterval(tick, 5000);
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def index():
    return PAGE


if __name__ == "__main__":
    # self-check for the scale/sign logic and page wiring (no device needed)
    assert scale(270) == 27.0
    assert scale(65516) == -2.0  # negative temp wraps correctly
    for anchor in ("glyIn", "comp2", "/api/all", "Raw registers"):
        assert anchor in PAGE, anchor
    print("ok")
