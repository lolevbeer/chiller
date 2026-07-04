# Chiller — G&D glycol chiller monitoring

Read-only monitoring of a G&D glycol chiller (Carel c.pCO controller, two refrigeration
circuits) at a remote site. A FastAPI dashboard reads live data over two interfaces the
controller exposes on its Ethernet port and serves it as a web page + JSON API.

```
Mac (home LAN 192.168.4.0/22)
 │  Teleport VPN (WiFiman) + teleport_split.sh — only 192.168.1.0/24 rides the tunnel
 ▼
site LAN 192.168.1.0/24, behind UniFi gateway (double-NATed behind Comcast Business)
 │
 ▼
c.pCO controller @ 192.168.1.69
 ├── Modbus TCP :502  — INPUT registers (FC4): temps, pressures, superheats, hours
 └── HTTP :80         — Carel microwebsite; getvar.csv exposes ALL ~4000 PLC variables
```

## Quick start

```sh
# 1. Get on the site network (see Network access below)
#    Connect Teleport in WiFiman, then:
./teleport_split.sh          # sudo; re-run after every Teleport reconnect

# 2. Run the dashboard
./.venv/bin/uvicorn chiller_dashboard:app --host 0.0.0.0 --port 8000
```

| Route      | Serves                                                                 |
|------------|------------------------------------------------------------------------|
| `/`        | Auto-refreshing HTML table: labeled Modbus registers + `web` rows      |
| `/api`     | JSON `{addr: raw_uint16}` of INPUT registers 0..159                    |
| `/api/web` | JSON `{label: value}` of the 12 web-only points (engineering units)    |

`CHILLER_IP` overrides the target (default 192.168.1.69); `CHILLER_REGS` the read span
(default 160). Deps: `pip install fastapi uvicorn pymodbus` (already in `.venv`).
Auth is deliberately absent — Cloudflare Access is the intended front when exposed.

## How the two data sources work

**Modbus TCP (FC4 input registers).** The PLC program maps internal strategy variables
onto INPUT registers 0..~158. Analog values are signed int16 stored ×10 (one decimal:
raw 2448 = 244.8 psi; negatives wrap, `scale()` handles both). Integer registers
(status enums, power %, hour counters) are NOT scaled. Reads are chunked ≤100 regs
because Modbus caps a single read at 125. HOLDING registers hold setpoints (CoolSetP
at HOLDING@1); the dashboard only reads.

**HTTP `getvar.csv`.** The Carel microwebsite exposes every PLC variable —
`name,id,desc,type,access,val` — at `http://<ip>/getvar.csv` (~4000 rows, ~5 s,
gzipped). Filtering is exact-name only, but the `name` param repeats:
`getvar.csv?name=A&name=B` returns just those rows in ~150 ms. That's how the
dashboard gets the points missing from the TCP map (`WEB_VARS` → `read_web()`).
Values arrive in engineering units — no ×10. The `id` column is the internal PLC
variable index, NOT a Modbus address (tested: registers at those addresses are zero).

## Register map (confirmed 2026-07-04, chiller running)

Layout: circuit 1 at 0–28, circuit 2 mirrors it at 32–56, glycol block at 68/69/132,
hour counters from 131. Full map lives in `LABELS` in `chiller_dashboard.py`:

| INPUT reg | Point                              | reg | Point (circuit 2 mirror)    |
|-----------|-----------------------------------|-----|------------------------------|
| 0         | Chiller status (int enum)         |     |                              |
| 1         | Power request (tenths of %)       | 2   | Power running circ 1         |
| 3         | Discharge pressure c1 (psi)       | 35  | Discharge pressure c2        |
| 4         | Condensing temp c1 (°F)           | 36  | Condensing temp c2           |
| 9         | Suction temp c1 (°F)              | 41  | Suction temp c2              |
| 10        | Suction pressure c1 (psi)         | 42  | Suction pressure c2          |
| 11        | Evaporating temp c1 (°F)          | 43  | Evaporating temp c2          |
| 23        | Suction superheat c1              | 55  | Suction superheat c2         |
| 24        | Discharge superheat c1 †          | 56  | Discharge superheat c2 †     |
| 28        | EVD valve status c1 (int)         |     |                              |
| 68 / 69   | Glycol outlet / inlet (°F)        | 132 | Glycol reservoir temp (°F)   |
| 70        | Cooling setpoint (°F)             |     |                              |
| 131 / 135 / 141 / 158 | Working hours: user pump 2, comp 1 c1, comp 1 c2, source fan 1 c1 | | |

† reads ≈ −86: the controller's own sentinel (no discharge temp probes fitted) —
its web UI shows the same.

**Web-only points** (`Modbus_FB.*` — the block feeds the serial BMS port and is absent
from the TCP map): fan speed A/B %, EEV position A/B %, glycol supply pressure,
reservoir level, chiller/process pump status, glycol flow A/B, compressor A/B status.

## How the map was found (`correlate_registers.py`)

Single-snapshot value matching is unreliable — different sensors routinely read the
same value at one instant (four of the old labels were wrong that way). The correlator
instead samples `getvar.csv` and a register dump together, repeatedly, while the
chiller runs: a register earns a variable's label only if it tracks that variable's
value (REAL: |var×10 − raw| ≤ 2; ints exact) across **every** sample. Drifting values
make coincidences die within a few rounds. Re-run anytime:

```sh
./.venv/bin/python correlate_registers.py     # ROUNDS/INTERVAL/CHILLER_IP env-tunable
```

Fast-oscillating points (fan, EEV) can't survive the ~2 s skew between the two fetches
— absence from the correlator's output plus absence from a full 0–1999 dump search
(×10 and IEEE-float encodings) is how they were proven off-map, not just unfound.

## Network access

The site is only reachable via Ubiquiti Teleport (WiFiman), which is hardcoded
full-tunnel: it installs `0/1` + `128.0/1` half-range routes that swallow the default
route, killing Claude's API access (and general egress) while connected. It does NOT
touch DNS, and it pins its own link to the site via a host route — both verified by
diag capture.

**`teleport_split.sh`** exploits that: after Teleport connects, it deletes the two
half-range routes and adds `192.168.1.0/24` via the tunnel interface. Internet flows
direct again; only chiller traffic uses the VPN. WiFiman reinstalls its routes on every
reconnect, so re-run the script each time.

### Abandoned: UniFi WireGuard VPN server (reference)

A WireGuard server on the site gateway (port 51830; 51820 taken by Teleport) with a
split-tunnel client conf (`AllowedIPs = 192.168.1.0/24`, DNS line removed) worked on
the client side but can never handshake: the site is double-NATed (UniFi WAN
10.1.10.180 behind a Comcast Business gateway at 10.1.10.1, public IP 24.3.243.191,
not CGNAT) and the required UDP 51830 forward can't be added on the Comcast box.
Revive only if that changes (Comcast Business support can add forwards, or bridge
mode). Client conf: `~/Downloads/Chiller-Tunnel-Chiller-Client.conf` (private key —
keep out of the repo).

### Future

An on-site box running the dashboard behind `cloudflared` + Cloudflare Access would
remove the VPN requirement entirely for reads.

## Files

- `chiller_dashboard.py` — the dashboard: Modbus reads (`read`, `scale`, `LABELS`),
  web-var reads (`WEB_VARS`, `read_web`), setpoint read, FastAPI routes. Self-check:
  `python chiller_dashboard.py` prints `ok`.
- `correlate_registers.py` — register↔variable mapper (above).
- `teleport_split.sh` — Teleport split-tunnel fix (above).
- `find_registers.py` — superseded single-snapshot matcher; safe to delete.
