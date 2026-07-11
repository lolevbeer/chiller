# Chiller — G&D glycol chiller monitoring

Read-only monitoring of a G&D glycol chiller (Carel c.pCO controller, two refrigeration
circuits) at a remote site. A Node.js dashboard (`node:http`, no framework) reads live
data over two interfaces the controller exposes on its Ethernet port and serves it as a
web page + JSON API.

```
Mac (home LAN 192.168.4.0/22)
 │  Teleport VPN (WiFiman) + teleport_split.sh — only 192.168.1.0/24 rides the tunnel
 ▼
site LAN 192.168.1.0/24, behind UniFi gateway (double-NATed behind Comcast Business)
 │
 ├── Raspberry Pi (hostname `chiller`) — runs this dashboard 24/7 as a systemd
 │     service on :80 (see On-site host below); polls the controller over the LAN
 ▼
c.pCO controller @ 192.168.1.69
 ├── Modbus TCP :502  — INPUT registers (FC4): temps, pressures, superheats, hours
 └── HTTP :80         — Carel microwebsite; getvar.csv exposes ALL ~4000 PLC variables
```

## Quick start (dev machine)

The production copy runs on the on-site Pi (below); this is for hacking on it locally:

```sh
# 1. Get on the site network (see Network access below)
#    Connect Teleport in WiFiman, then:
./teleport_split.sh          # sudo; re-run after every Teleport reconnect

# 2. Run the dashboard
npm install        # one-time; installs modbus-serial + uplot
npm start          # CHILLER_IP=... PORT=... node chiller_dashboard.js
```

| Route      | Serves                                                                  |
|------------|-------------------------------------------------------------------------|
| `/`        | Minimal Linear-inspired page: glycol in→out hero, per-circuit columns with fan/EEV meters, pump/flow status dots, glycol history chart (6 h/24 h/7 d, dashed line = current setpoint — the log has no setpoint column, so no history for it), raw-register table under a disclosure; re-renders in place every 5 s |
| `/api`     | JSON `{addr: raw_uint16}` of INPUT registers 0..159                     |
| `/api/web` | JSON `{label: value}` of the 12 web-only points (engineering units)     |
| `/api/all` | `{"regs": ..., "web": ...}` combined payload the page's refresh loop uses |
| `/api/log` | CSV slice of the onboard datalogger (`?start=&stop=` in `YYYY-MM-DDThh:mm:ss`), served instantly from an in-process cache — the controller needs ~60 s per `getlog.csv` query (measured), so a background loop backfills 7 d newest-day-first (~15 min) then polls only the tail every `LOG_POLL_MIN` min (default 5). `X-Log-Progress` header = backfill %, which the page shows as a loading indicator |
| `/uplot.js` `/uplot.css` | [uPlot](https://github.com/leeoniya/uPlot) assets, vendored from `node_modules` (no CDN) |

`CHILLER_IP` overrides the target (default 192.168.1.69); `CHILLER_REGS` the read span
(default 160); `PORT` the listen port (default 8000). Needs Node 18+ (uses native
`fetch`); dependencies are `modbus-serial` and `uplot`. Auth is deliberately absent —
Cloudflare Access is the intended front when exposed.

Env vars can live in a gitignored `.env` next to the code (`KEY=value` lines, loaded
natively via `process.loadEnvFile()` — no dotenv). The webhook URL belongs there, not
in the repo or shell history.

Set `SLACK_WEBHOOK_URL` (a Slack Incoming Webhook) and the dashboard also posts the
glycol temps — in/out, setpoint, reservoir — every 10 minutes (`SLACK_EVERY_MIN`
overrides), plus once at startup so a bad webhook fails loudly. Glycol-out colors the
message bar: green below 30 °F, red above 40 °F, plain between. A failed Modbus read
posts one warning per outage, then goes quiet until it recovers — except at startup,
where a failed first read is suppressed (a service restart races the chiller still
holding the old process's Modbus socket; warning there is pure noise). Unset = off.

## On-site host (Raspberry Pi)

Since 2026-07-11 the dashboard runs continuously on a Pi on the site LAN — an
ARMv6 (Pi 1/Zero-class) board that was already there running OctoPrint, renamed
`chiller` (so `http://chiller.local` on the site LAN — mDNS is link-local and does
NOT cross the Teleport tunnel; from home, use the Pi's IP). It polls the controller
over the local subnet, so Slack reporting works with no VPN in the loop.

Setup notes, hard-won:

- **Node on armv6l**: official/NodeSource builds don't exist for ARMv6 — use
  [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org) (v20.19.4,
  `linux-armv6l`). Before extracting into `/usr/local`, **delete the old npm**
  (`sudo rm -rf /usr/local/lib/node_modules/npm`): tar overwrites files but never
  removes stale ones, and leftover nested deps from an ancient npm shadow the new
  ones (`Class extends value undefined is not a constructor`, `Minipass is not a
  constructor`). Verify the tarball before extracting (`tar -tJf … && echo OK`) —
  extraction takes 5–10 quiet minutes on ARMv6; don't interrupt it.
- **Raspbian Buster is EOL**: apt 404s until repointed —
  `sudo sed -i 's|raspbian.raspberrypi.org|legacy.raspbian.org|' /etc/apt/sources.list`
  then `sudo apt update --allow-releaseinfo-change`.
- **systemd service** `/etc/systemd/system/chiller.service`, enabled at boot:

  ```ini
  [Unit]
  Description=Chiller dashboard
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/home/pi/chiller
  Environment=CHILLER_IP=192.168.1.69
  Environment=PORT=80
  AmbientCapabilities=CAP_NET_BIND_SERVICE
  EnvironmentFile=-/home/pi/chiller/.env
  ExecStart=/usr/local/bin/node chiller_dashboard.js
  Restart=always
  User=pi

  [Install]
  WantedBy=multi-user.target
  ```

  `AmbientCapabilities` is what lets a non-root unit bind port 80. OctoPi's
  haproxy previously owned :80 (proxying the OctoPrint UI) — it's disabled
  (`systemctl disable --now haproxy`); re-enable it and drop the two port lines
  to get OctoPrint's UI back.
- **Deploy loop**: commit+push here, then on the Pi
  `cd ~/chiller && git pull && sudo systemctl restart chiller`
  (`npm install` first only if `package.json` changed).
- **Debugging**: `journalctl -u chiller -n 30` for crashes;
  `curl -s localhost/api | head -c 60` proves the Modbus path end-to-end.

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

**Onboard datalogger (`getlog.csv`).** The controller runs one log, `GandDLog04162024`
(id 0, defined in G&D's application via c.design; not editable from the webkit).
It samples 24 points every 5 s — glycol in/out/supply temps, suction temps, all
pressures, comp/fan states, flow — in **metric units** (°C, bar), unlike the ×10-°F
Modbus map. `getlogids.csv` lists logs; `getlog.csv?id=0&start=…&stop=…`
(`YYYY-MM-DDThh:mm:ss`) exports CSV. Quirk: rows are stamped `+00:00` but the clock
runs site-local time — the dashboard parses them as local wall-clock. The log sat
dead from a 2026-04-15 service visit (`Stop` event) until 2026-07-11: visiting the
controller's system menu (hold Alarm+Enter 3 s on the pGD or the `/pgd/index.htm`
virtual display) → LOGGER re-armed it, even though RESTART LOGS claimed "no logs to
restart". If the chart goes flat, check for a new `Stop` event and repeat that.
The controller also charts this log itself at `http://<ip>/logger.htm`.

## Register map (confirmed 2026-07-04, chiller running)

Layout: circuit 1 at 0–28, circuit 2 mirrors it at 32–56, glycol block at 68/69/132,
hour counters from 131. Full map lives in `LABELS` in `chiller_dashboard.js`:

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
make coincidences die within a few rounds. This is the one remaining Python script (a
one-off discovery tool; its result is already baked into `LABELS`). Re-run anytime with
a Python venv that has `pymodbus`:

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

### Teleport tunnel — anatomy and operation

Teleport is Ubiquiti's zero-config WireGuard VPN (WiFiman app ↔ UniFi gateway). It
NAT-traverses via UI's cloud brokering, which is why it connects through the site's
double NAT that plain WireGuard cannot (no port forward needed).

What connecting actually does on the Mac (verified by diag capture, 2026-07-04):

| Change | Detail |
|--------|--------|
| Tunnel interface | new `utunN`; client addr on `192.168.2.0/24`, tunnel gateway `192.168.2.1` |
| `0/1` + `128.0/1` routes → `utunN` | the full-tunnel mechanism: together they cover all IPv4 and are more specific than `default`, which is left untouched — `route get default` still shows en0 (this fooled the first version of the script) |
| Host route `24.3.243.191 → en0` | pins the encrypted transport to the site's public IP via the real interface; this is why deleting the half-range routes doesn't kill the tunnel itself |
| DNS | untouched — resolvers stay on the home interface |

Consequence when connected raw: every packet (including `api.anthropic.com`) is routed
into the tunnel, so Claude/most internet dies while the chiller becomes reachable.

`teleport_split.sh` (run AFTER connecting, needs sudo):
1. Finds the tunnel interface by looking up which `utunN` owns the `0/1` route —
   errors out with "No 0/1 tunnel route found" if Teleport isn't really connected.
2. `route delete 0.0.0.0/1` and `128.0.0.0/1` — internet falls back to the untouched
   `default` via the home LAN.
3. `route add 192.168.1.0/24 -interface utunN` — only the chiller site rides the tunnel.

Routine: connect Teleport in WiFiman → `./teleport_split.sh` → `ping 192.168.1.69`.
Re-run the script after **every** reconnect; WiFiman reinstalls its routes each time.

Troubleshooting:
- Script says "No 0/1 tunnel route found" → Teleport isn't actually passing traffic,
  whatever the WiFiman UI claims. Fully quit WiFiman (menu-bar item too) and reconnect;
  a reboot clears a wedged VPN network-extension.
- Everything dead mid-session → Teleport reconnected on its own and reinstalled the
  half-range routes; just run the script again.
- Check the site itself at [unifi.ui.com](https://unifi.ui.com) (cloud, works without
  VPN) — if the console is offline, nothing on this Mac will help.

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

The on-site box now exists (the Pi, above). Remaining step: `cloudflared` +
Cloudflare Access in front of it would remove the VPN requirement entirely for reads.

## Files

- `chiller_dashboard.js` — the dashboard: Modbus reads (`read`, `scale`, `LABELS`),
  web-var reads (`WEB_VARS`, `readWeb`), datalogger proxy (`readLog`), `node:http`
  routes. No framework.
- `dashboard.html` — the page (HTML/CSS/client JS), including the uPlot history
  chart; served verbatim at `/`.
- `package.json` — declares the two dependencies (`modbus-serial`, `uplot`) and
  `start`/`test`.
- `test.js` — offline self-check (scale/sign, CSV row parse, page wiring). `npm test`.
- `correlate_registers.py` — register↔variable mapper (above); the only Python left.
- `teleport_split.sh` — Teleport split-tunnel fix (above).
- `find_registers.py` — superseded single-snapshot matcher; safe to delete.
