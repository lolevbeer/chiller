# Definitively map Modbus INPUT registers to c.pCO variables by time-series
# correlation: repeatedly sample the controller's own getvar.csv (name, desc,
# type, live value) together with a register dump, and pair a register with a
# variable only if they track each other across EVERY sample. Kills the value
# collisions that fool single-snapshot matching (find_registers.py).
# Run with the chiller RUNNING so values drift:  ./.venv/bin/python correlate_registers.py
import csv, io, time, os
import urllib.request
from pymodbus.client import ModbusTcpClient

HOST = os.environ.get("CHILLER_IP", "192.168.1.69")
ROUNDS = int(os.environ.get("ROUNDS", "20"))
INTERVAL = float(os.environ.get("INTERVAL", "3"))
NREGS = 80  # INPUT block of interest
TOL = 2     # max |var*10 - raw| per sample, covers rounding + sample skew


def signed(v):
    return v - 65536 if v > 32767 else v


def sample():
    """One simultaneous capture: (name -> (desc, type, value), addr -> signed raw)."""
    with urllib.request.urlopen(f"http://{HOST}/getvar.csv", timeout=10) as r:
        rows = list(csv.DictReader(io.TextIOWrapper(r, encoding="latin-1")))
    vars_ = {}
    for row in rows:
        try:
            vars_[row["name"]] = (row["desc"], row["type"], float(row["val"]))
        except ValueError:
            pass
    c = ModbusTcpClient(HOST, timeout=3)
    try:
        rr = c.read_input_registers(address=0, count=NREGS, device_id=1)
        regs = {} if rr.isError() else {i: signed(v) for i, v in enumerate(rr.registers)}
    finally:
        c.close()
    return vars_, regs


series_v, series_r = {}, {}  # name -> [values], addr -> [raws]
meta = {}                    # name -> (desc, type)
for n in range(ROUNDS):
    vars_, regs = sample()
    for name, (desc, typ, val) in vars_.items():
        series_v.setdefault(name, []).append(val)
        meta[name] = (desc, typ)
    for a, raw in regs.items():
        series_r.setdefault(a, []).append(raw)
    print(f"sample {n + 1}/{ROUNDS}", end="\r", flush=True)
    time.sleep(INTERVAL)
print()

for a, raws in sorted(series_r.items()):
    if all(r == 0 for r in raws):
        continue
    hits = []
    for name, vals in series_v.items():
        if len(vals) != len(raws):
            continue
        desc, typ = meta[name]
        if typ == "REAL":
            ok = all(abs(v * 10 - r) <= TOL for v, r in zip(vals, raws))
        else:
            ok = all(v == r for v, r in zip(vals, raws))
        if ok:
            hits.append((name, desc, typ))
    moving = len(set(raws)) > 1
    mb = [h for h in hits if h[0].startswith("Modbus_FB")]
    show = mb or hits
    if not show:
        continue
    tag = "" if moving else "  [constant — unverified]"
    if len(show) <= 3:
        s = " | ".join(f"{n} ({d[:50]})" for n, d, _ in show)
        print(f"{a:>3}  {s}{tag}")
    else:
        print(f"{a:>3}  {len(show)} candidates (all constant){tag}")
