# Chiller — G&D glycol chiller Modbus decode

Read-only monitoring of a G&D glycol chiller (Carel c.pCO controller) over Modbus TCP.
The chiller lives at **192.168.1.69** on a remote site LAN behind a UniFi gateway.

## Files

- `chiller_dashboard.py` — FastAPI web view of live INPUT registers (FC4), labels confirmed
  by time-series correlation. Cloudflare Access is the intended auth layer.
- `correlate_registers.py` — maps registers to variables by sampling the controller's own
  `getvar.csv` (name/desc/type/live value for all ~4000 variables) together with a register
  dump repeatedly; a register earns a label only by tracking its variable across every sample.
- `find_registers.py` — superseded by `correlate_registers.py` (single-snapshot matching
  with hardcoded target values; kept for reference, safe to delete).
- `teleport_split.sh` — see Network access below.

Run with `CHILLER_IP=192.168.1.69` (the default). Analog temps/pressures are signed
int16 ×10; integer status/count registers are not scaled.

## Register map (confirmed 2026-07-04, chiller running)

See `LABELS` in `chiller_dashboard.py` for the full map. Layout: circuit 1 at INPUT 0–28,
circuit 2 mirrors it at 32–56, glycol temps at 68/69/132, setpoint at 70, working-hour
counters at 131/135/141/158. Corrections vs. the old guesses: 1 = power request (not
suction temp), 9 = suction temp circ 1 (not glycol inlet), 11 = evaporating temp (not
ΔP), 42 = suction pres circ 2 (not user water outlet).

Not available over Modbus TCP: fan speed, EEV position, glycol supply pressure, pump/flow
status — they exist only in the `Modbus_FB` program block, which feeds the serial BMS port.
The dashboard fetches these over HTTP instead: `getvar.csv?name=A&name=B` returns just the
requested variables (~150 ms; see `WEB_VARS`/`read_web()`). They appear as `web` rows on
the page and at `GET /api/web`, already in engineering units (no ×10 scaling).

## Network access — current state (2026-07-04)

Problem: Teleport (WiFiman) is hardcoded full-tunnel, so connecting it kills Claude's API
access (all traffic exits via the site). No split-tunnel option exists in WiFiman.

**Current solution: `teleport_split.sh`.** Connect Teleport in WiFiman, then run
`./teleport_split.sh` (asks for sudo). Teleport overrides the default route with 0/1 +
128.0/1 half-range routes (it leaves default and DNS alone — verified via diag capture);
the script deletes those two and routes only 192.168.1.0/24 through the tunnel —
internet/Claude go direct, chiller via Teleport. Re-run after every Teleport reconnect
(WiFiman reinstalls the routes each time).

### Abandoned: UniFi WireGuard VPN Server (kept for reference)

A WireGuard VPN Server was created on the site gateway (port 51830; 51820 taken by
Teleport) with client conf `~/Downloads/Chiller-Tunnel-Chiller-Client.conf`, edited for
split tunnel (`AllowedIPs = 192.168.1.0/24`, no DNS line). Split-tunnel side verified —
Claude API stayed up with the tunnel connected.

Dead end: the site is double-NATed — UniFi WAN is 10.1.10.180 behind a Comcast Business
gateway at 10.1.10.1, public IP 24.3.243.191 (not CGNAT). The required port forward
(UDP 51830 → 10.1.10.180) can't be added on the Comcast gateway, so the tunnel never
handshakes. Revive this path only if Comcast port forwarding becomes possible (Comcast
Business support can add it on request, or bridge mode).

### Fallback / future

The dashboard was designed for Cloudflare Access. An on-site box running it plus
`cloudflared` would remove the need for any VPN for reads.
