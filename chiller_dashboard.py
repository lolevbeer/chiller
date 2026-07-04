# Read-only web view of the G&D glycol chiller (c.pCO) over Modbus TCP.
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


def read_setpoint():
    # CoolSetP lives in HOLDING@1 (the setpoint block); returns °F or None.
    c = ModbusTcpClient(HOST, timeout=3)
    try:
        rr = c.read_holding_registers(address=1, count=1, device_id=1)
        return None if rr.isError() else scale(rr.registers[0])
    finally:
        c.close()


@app.get("/api")
def api():
    return JSONResponse(read() or {"error": "modbus read failed"})


@app.get("/api/web")
def api_web():
    return JSONResponse(read_web() or {"error": "getvar.csv fetch failed"})


@app.get("/", response_class=HTMLResponse)
def index():
    d = read() or {}
    sp = read_setpoint()
    actual = scale(d[68]) if 68 in d else None  # 68 = glycol outlet (10 is suction pres)
    banner = f"<h2>Setpoint {sp}&deg;F &nbsp;|&nbsp; Glycol outlet {actual}&deg;F</h2>"
    rows = "".join(
        f"<tr><td>INPUT@{k}</td><td>{LABELS.get(k, '')}</td>"
        f"<td>{raw}</td><td>{scale(raw)}</td></tr>"
        for k, raw in d.items()
    )
    rows += "".join(
        f"<tr><td>web</td><td>{label}</td><td colspan=2>{val:g}</td></tr>"
        for label, val in (read_web() or {}).items()
    )
    return (
        "<meta http-equiv=refresh content=5>"
        "<h1>Glycol chiller</h1>" + banner +
        f"<table border=1 cellpadding=6><tr><th>reg<th>label<th>raw<th>÷10</tr>{rows}</table>"
    )


if __name__ == "__main__":
    # self-check for the scale/sign logic (no device needed)
    assert scale(270) == 27.0
    assert scale(65516) == -2.0  # negative temp wraps correctly
    print("ok")
