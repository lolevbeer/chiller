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
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;800&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0a111e; --panel: #101b2d; --line: #1c2c44; --ink: #e8f2ff;
  --dim: #6f83a2; --ice: #6fd7ff; --cold: #37b6ff; --ok: #4ade80;
  --warn: #fbbf24; --bad: #fb7185; --mono: "IBM Plex Mono", ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; }
body {
  background:
    radial-gradient(1200px 500px at 80% -10%, rgba(55,182,255,.10), transparent 60%),
    radial-gradient(900px 400px at 10% 110%, rgba(55,182,255,.06), transparent 60%),
    var(--bg);
  color: var(--ink); font-family: "Oxanium", sans-serif;
  min-height: 100vh; padding: 22px clamp(12px, 3vw, 40px) 40px;
}
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
h1 { font-weight: 800; font-size: clamp(20px, 3vw, 28px); letter-spacing: .12em; }
h1 span { color: var(--cold); }
.chip {
  font-family: var(--mono); font-size: 13px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim); background: var(--panel);
}
#stat.on { color: var(--ok); border-color: rgba(74,222,128,.4); }
#stat.off { color: var(--warn); border-color: rgba(251,191,36,.4); }
#stat.alarm, #net.down { color: var(--bad); border-color: rgba(251,113,133,.5); }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.card {
  background: linear-gradient(180deg, rgba(111,215,255,.04), transparent 40%), var(--panel);
  border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px;
}
.card h2 {
  font-size: 12px; font-weight: 600; letter-spacing: .28em; color: var(--dim);
  text-transform: uppercase; margin-bottom: 14px; display: flex; align-items: center; gap: 10px;
}
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.on { background: var(--ok); box-shadow: 0 0 8px rgba(74,222,128,.7); }
.hero { grid-column: 1 / -1; display: flex; align-items: center; gap: clamp(16px, 4vw, 48px); flex-wrap: wrap; }
.big { font-family: var(--mono); font-weight: 600; font-size: clamp(38px, 6vw, 64px); line-height: 1; color: var(--ice); }
.big small { font-size: .35em; color: var(--dim); font-weight: 400; margin-left: 2px; }
.lbl { font-size: 11px; letter-spacing: .22em; color: var(--dim); text-transform: uppercase; margin-bottom: 6px; }
.arrow { color: var(--cold); font-size: clamp(22px, 3vw, 34px); }
.sub { display: flex; gap: 26px; flex-wrap: wrap; margin-left: auto; }
.sub .v { font-family: var(--mono); font-size: 20px; }
.row { display: flex; justify-content: space-between; align-items: baseline; padding: 5px 0; border-bottom: 1px dashed var(--line); }
.row:last-child { border-bottom: 0; }
.row .k { color: var(--dim); font-size: 13px; }
.row .v { font-family: var(--mono); font-size: 16px; }
.meter { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.meter .k { color: var(--dim); font-size: 13px; width: 44px; }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--cold), var(--ice)); transition: width .8s; }
.meter .v { font-family: var(--mono); font-size: 14px; width: 58px; text-align: right; }
.pills { display: flex; gap: 10px; flex-wrap: wrap; }
.pill {
  font-family: var(--mono); font-size: 13px; padding: 6px 14px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim); display: flex; gap: 8px; align-items: center;
}
.pill.on { color: var(--ok); border-color: rgba(74,222,128,.35); }
.pill.bad { color: var(--bad); border-color: rgba(251,113,133,.5); }
.hours { display: flex; gap: 24px; flex-wrap: wrap; font-family: var(--mono); font-size: 13px; color: var(--dim); }
.hours b { color: var(--ink); font-weight: 600; }
details { margin-top: 22px; color: var(--dim); }
details table { border-collapse: collapse; font-family: var(--mono); font-size: 13px; margin-top: 10px; }
details td, details th { border: 1px solid var(--line); padding: 4px 10px; text-align: left; }
footer { margin-top: 18px; font-size: 12px; color: var(--dim); letter-spacing: .08em; }
</style>
</head>
<body>
<header>
  <h1>GLYCOL <span>CHILLER</span></h1>
  <span class="chip" id="stat">…</span>
  <span class="chip" id="net">connecting</span>
</header>

<div class="grid">
  <div class="card hero">
    <div><div class="lbl">Glycol in</div><div class="big" id="glyIn">–<small>°F</small></div></div>
    <div class="arrow">→</div>
    <div><div class="lbl">Glycol out</div><div class="big" id="glyOut">–<small>°F</small></div></div>
    <div class="sub">
      <div><div class="lbl">Setpoint</div><div class="v" id="setp">–</div></div>
      <div><div class="lbl">Reservoir</div><div class="v" id="resT">–</div></div>
      <div><div class="lbl">Supply pres</div><div class="v" id="supP">–</div></div>
      <div><div class="lbl">Power req</div><div class="v" id="pwr">–</div></div>
    </div>
  </div>

  <div class="card" id="c1">
    <h2><span class="dot" id="comp1"></span>Circuit A</h2>
    <div class="row"><span class="k">Discharge / suction pres</span><span class="v"><span id="dscgP1">–</span> / <span id="suctP1">–</span> psi</span></div>
    <div class="row"><span class="k">Condensing / evap temp</span><span class="v"><span id="condT1">–</span> / <span id="evapT1">–</span> °F</span></div>
    <div class="row"><span class="k">Suction temp</span><span class="v"><span id="suctT1">–</span> °F</span></div>
    <div class="row"><span class="k">Suction superheat</span><span class="v" id="ssh1">–</span></div>
    <div class="meter"><span class="k">Fan</span><div class="bar"><i id="fanB1"></i></div><span class="v" id="fan1">–</span></div>
    <div class="meter"><span class="k">EEV</span><div class="bar"><i id="eevB1"></i></div><span class="v" id="eev1">–</span></div>
  </div>

  <div class="card" id="c2">
    <h2><span class="dot" id="comp2"></span>Circuit B</h2>
    <div class="row"><span class="k">Discharge / suction pres</span><span class="v"><span id="dscgP2">–</span> / <span id="suctP2">–</span> psi</span></div>
    <div class="row"><span class="k">Condensing / evap temp</span><span class="v"><span id="condT2">–</span> / <span id="evapT2">–</span> °F</span></div>
    <div class="row"><span class="k">Suction temp</span><span class="v"><span id="suctT2">–</span> °F</span></div>
    <div class="row"><span class="k">Suction superheat</span><span class="v" id="ssh2">–</span></div>
    <div class="meter"><span class="k">Fan</span><div class="bar"><i id="fanB2"></i></div><span class="v" id="fan2">–</span></div>
    <div class="meter"><span class="k">EEV</span><div class="bar"><i id="eevB2"></i></div><span class="v" id="eev2">–</span></div>
  </div>

  <div class="card">
    <h2>Plant</h2>
    <div class="pills" id="pills"></div>
    <div style="height:14px"></div>
    <div class="hours" id="hours"></div>
  </div>
</div>

<details><summary>Raw registers</summary><table id="raw"></table></details>
<footer>read-only · Modbus TCP + getvar.csv · refreshes every 5 s</footer>

<script>
const S = v => (v > 32767 ? v - 65536 : v) / 10;          // signed int16, ×10
const STATUS = {1:"STANDBY",2:"OFF · ALARM",3:"OFF · BMS",4:"OFF · SCHEDULE",
                5:"OFF · INPUT",6:"OFF · KEYBOARD",9:"RUNNING"};
// every target's first child is its text node; <small> units stay untouched
const set = (id, txt) => { document.getElementById(id).firstChild.nodeValue = txt; };
const sh = v => (v < -50 ? "—" : v.toFixed(1));            // sentinel: probe not fitted

async function tick() {
  let d;
  try { d = await (await fetch("/api/all")).json(); }
  catch { return net(false); }
  if (!d.regs) return net(false);
  net(true);
  const r = a => S(d.regs[a] ?? 0), w = d.web || {};

  const st = d.regs[0];
  const el = document.getElementById("stat");
  el.textContent = STATUS[st] || ("STATUS " + st);
  el.className = "chip " + (st === 9 ? "on" : st === 2 ? "alarm" : "off");

  set("glyIn", r(69).toFixed(1)); set("glyOut", r(68).toFixed(1));
  set("setp", r(70).toFixed(1) + " °F"); set("resT", r(132).toFixed(1) + " °F");
  set("supP", (w["Glycol supply pres psi"] ?? NaN).toFixed(1) + " psi");
  set("pwr", (d.regs[1] / 10).toFixed(0) + " %");

  for (const [n, sfx] of [["1", "A"], ["2", "B"]]) {
    const base = n === "1" ? 0 : 32;
    set("dscgP" + n, r(base + 3).toFixed(1)); set("suctP" + n, r(base + 10).toFixed(1));
    set("condT" + n, r(base + 4).toFixed(1)); set("evapT" + n, r(base + 11).toFixed(1));
    set("suctT" + n, r(base + 9).toFixed(1)); set("ssh" + n, sh(r(base + 23)));
    document.getElementById("comp" + n).className = "dot" + (w["Compressor " + sfx + " on"] ? " on" : "");
    const fan = w["Fan speed " + sfx + " %"] ?? 0, eev = w["EEV position " + sfx + " %"] ?? 0;
    set("fan" + n, fan.toFixed(1) + "%"); document.getElementById("fanB" + n).style.width = fan + "%";
    set("eev" + n, eev.toFixed(1) + "%"); document.getElementById("eevB" + n).style.width = eev + "%";
  }

  const pill = (name, on, badWhenOff) =>
    `<span class="pill ${on ? "on" : badWhenOff ? "bad" : ""}"><span class="dot ${on ? "on" : ""}"></span>${name}</span>`;
  document.getElementById("pills").innerHTML =
    pill("Chiller pump", w["Chiller pump on"]) + pill("Process pump", w["Process pump on"]) +
    pill("Flow A", w["Glycol flow A ok"], true) + pill("Flow B", w["Glycol flow B ok"], true);

  document.getElementById("hours").innerHTML =
    `<span>Comp A <b>${d.regs[135]} h</b></span><span>Comp B <b>${d.regs[141]} h</b></span>` +
    `<span>Fan A <b>${d.regs[158]} h</b></span><span>Pump 2 <b>${d.regs[131]} h</b></span>`;

  document.getElementById("raw").innerHTML =
    "<tr><th>reg</th><th>raw</th><th>÷10</th></tr>" +
    Object.entries(d.regs).filter(([, v]) => v !== 0)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${S(v)}</td></tr>`).join("");
}
function net(ok) {
  const el = document.getElementById("net");
  el.textContent = ok ? new Date().toLocaleTimeString() : "OFFLINE";
  el.className = "chip" + (ok ? "" : " down");
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
