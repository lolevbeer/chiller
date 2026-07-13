# Chiller — G&D glycol chiller monitoring

Read-only monitoring for a G&D air-cooled glycol chiller at Lolev Beer. A small
Node.js server reads the Carel c.pCO controller over Modbus TCP and its HTTP
microwebsite, then serves a live dashboard, JSON/CSV endpoints, alarm history,
Slack alerts, and read-only Slack commands.

```text
Mac on home LAN
 │  Ubiquiti Teleport + teleport_split.sh
 ▼
site LAN 192.168.1.0/24
 ├── Raspberry Pi `chiller` — dashboard and Slack service
 └── Carel c.pCO 192.168.1.69
      ├── Modbus TCP :502 — live INPUT registers
      └── HTTP :80 — web variables, alarms, datalogger, and virtual pGD
```

The application never writes controller registers. It has no built-in
authentication; put an access-control layer such as Cloudflare Access in front
of it before exposing it beyond a trusted network.

## Contents

- [Quick start](#quick-start)
- [Production operation](#production-operation)
- [Deploying to the Pi](#deploying-to-the-pi)
- [Slack](#slack)
- [HTTP interface](#http-interface)
- [Architecture and data sources](#architecture-and-data-sources)
- [Hardware reference](#hardware-reference)
- [Register reference](#register-reference)
- [Network access and recovery](#network-access-and-recovery)
- [Repository map](#repository-map)

## Quick start

The production service runs on the on-site Pi. For local development, connect
Teleport in WiFiman and split the tunnel before starting the app:

```sh
./teleport_split.sh          # uses sudo; repeat after each Teleport reconnect
npm install                  # first run, or after package.json changes
npm start                    # http://localhost:8000
```

For live reload while editing server modules, page markup, or browser scripts:

```sh
npm run dev
```

Useful checks:

```sh
npm test
npm run typecheck
curl -s http://localhost:8000/api | head -c 80
```

Production uses Node 20.19.4. Use Node 20.12 or newer so native `fetch`,
[`process.loadEnvFile()`](https://nodejs.org/api/process.html#processloadenvfilepath),
and the current dependencies are all available. Runtime dependencies are
`@slack/bolt`, `modbus-serial`, `three`, and `uplot`; `typescript` and
`@types/node` are development-only.

### Configuration

The server loads optional `KEY=value` entries from the gitignored `.env` beside
the code. Environment variables set by the service or shell are also supported.

| Variable | Default | Purpose |
|---|---:|---|
| `CHILLER_IP` | `192.168.1.69` | Controller address |
| `CHILLER_REGS` | `162` | Number of INPUT registers to read: addresses 0–161 |
| `PORT` | `8000` | Dashboard listen port |
| `LOG_FILE` | `log_cache.csv` beside the code | Persistent seven-day datalogger cache |
| `LOG_POLL_MIN` | `5` | Datalogger tail-poll interval in minutes |
| `SLACK_WEBHOOK_URL` | unset | Enables proactive Slack alerts and the daily summary |
| `SLACK_APP_TOKEN` | unset | Slack app-level token for Socket Mode commands |
| `SLACK_BOT_TOKEN` | unset | Slack bot token for `/chiller` commands |
| `SLACK_DASHBOARD_URL` | unset | Operator-accessible dashboard link appended to Slack responses |

Slack threshold variables are listed under [Alert behavior](#alert-behavior).
`DEV=1` is set by `npm run dev` and enables only the live-reload endpoint.

## Production operation

The dashboard has run continuously on an ARMv6 Raspberry Pi since 2026-07-11.
The host is named `chiller`; `http://chiller.local` works on the site LAN, but
mDNS does not cross Teleport, so remote operators must use the Pi address or an
access-controlled public hostname.

The service file is `/etc/systemd/system/chiller.service`:

```ini
[Unit]
Description=Chiller dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/chiller
Environment=CHILLER_IP=192.168.1.69
Environment=PORT=80
EnvironmentFile=-/home/pi/chiller/.env
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/node chiller_dashboard.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

`AmbientCapabilities` lets the unprivileged `pi` user bind port 80. OctoPi's
HAProxy previously owned that port and is disabled. To restore the OctoPrint UI
on port 80, re-enable HAProxy and remove the dashboard's port-80 configuration.

Common operator commands:

```sh
sudo systemctl status chiller
journalctl -u chiller -n 100 --no-pager
curl -s localhost/api | head -c 80
sudo systemctl restart chiller
```

If the history chart stops advancing, see [Onboard datalogger](#onboard-datalogger).
If the site cannot be reached from home, see [Network access and
recovery](#network-access-and-recovery).

### Pi platform notes

- Official Node and NodeSource builds do not cover ARMv6. Production uses the
  Node 20.19.4 `linux-armv6l` tarball from
  [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/). Before
  extracting into `/usr/local`, remove the old
  `/usr/local/lib/node_modules/npm`; stale nested packages can cause errors such
  as `Class extends value undefined` or `Minipass is not a constructor`.
- Verify the tarball with `tar -tJf …` before extracting. Extraction takes
  5–10 quiet minutes on ARMv6; do not interrupt it.
- Raspbian Buster is end-of-life. If `apt` returns 404, replace
  `raspbian.raspberrypi.org` with `legacy.raspbian.org` in
  `/etc/apt/sources.list`, then run
  `sudo apt update --allow-releaseinfo-change`.

## Deploying to the Pi

Deploy committed work from a development machine, then update the existing
checkout on the Pi:

```sh
cd ~/chiller
git pull
npm install                 # only when package.json or package-lock.json changed
npm test
sudo systemctl restart chiller
sudo systemctl status chiller --no-pager
```

After deployment, verify `curl -s localhost/api | head -c 80`, load the
dashboard, and inspect recent service logs. A restart can lose the first Modbus
read while the controller releases the previous process's socket; repeated
failures are not expected.

## Slack

Slack has three independent features:

| Feature | Required configuration | Behavior |
|---|---|---|
| Proactive alerts and recoveries | `SLACK_WEBHOOK_URL` | Polls controller data and posts only state changes |
| Daily summary | `SLACK_WEBHOOK_URL` | Posts once after `SLACK_DAILY_HOUR` using statistics accumulated in memory |
| On-demand `/chiller` commands | `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` | Uses an outbound Socket Mode connection; no public request URL required |

`SLACK_DASHBOARD_URL` is optional and shared by alerts and commands. Webhook
reporting can run without Socket Mode, and Socket Mode can run without a webhook.

### Security rules for Slack secrets

Slack secrets belong only in `/home/pi/chiller/.env`, which is gitignored. Never
put a webhook URL, `xapp` token, or `xoxb` token in source, sample values, shell
history, logs, commits, pull requests, tickets, or chat. Redact them before
sharing diagnostics. If one is exposed, revoke or rotate it in Slack immediately.

### Slack app and token setup

1. At [Slack API: Your Apps](https://api.slack.com/apps), create an app **from a
   manifest** and supply `slack-manifest.yml`. For an existing app, confirm that
   [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) is
   enabled, the `/chiller` slash command exists, and the bot has the `commands`
   scope.
2. Open **Basic Information → App-Level Tokens** and generate a token with
   `connections:write`. Copy the resulting `xapp` token directly into the
   `SLACK_APP_TOKEN` entry in the Pi's `.env`.
3. Open **OAuth & Permissions**, install or reinstall the app to the workspace,
   then copy **OAuth Tokens for Your Workspace → Bot User OAuth Token**. Put the
   resulting `xoxb` token directly in `SLACK_BOT_TOKEN` in `.env`.
4. For alerts, enable [**Incoming Webhooks**](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/),
   add a webhook to the desired channel, and put its URL directly in
   `SLACK_WEBHOOK_URL` in `.env`.
5. Install dependencies, restart the service, and verify startup:

   ```sh
   cd ~/chiller
   npm install
   sudo systemctl restart chiller
   journalctl -u chiller -n 100 --no-pager
   ```

The actual `.env` values are intentionally omitted here. A healthy Socket Mode
startup logs `Slack /chiller command listening over Socket Mode`. In Slack, run
`/chiller status`, then `/chiller help`. Verify webhook delivery from Slack's
Incoming Webhooks configuration and watch the service log for delivery errors;
do not paste the webhook URL into a command line.

### Command reference

| Command | Response |
|---|---|
| `/chiller status` | Glycol loop, setpoint, demand, compressors, pumps/flow, gas sensors, and active alarms |
| `/chiller alarms` | Standing alarms and up to eight recent faults |
| `/chiller trend 6h` | Glycol minimum, maximum, average, and direction; accepts `6h`, `24h`, or `7d` |
| `/chiller circuit a` | Suction/discharge, evaporating/condensing, superheat, EEV, fan, and load for circuit A or B |
| `/chiller runtimes` | Pump, compressor, and condenser-fan hours |
| `/chiller why` | Abnormal facts visible in the current snapshot; not a root-cause diagnosis |
| `/chiller help` | Command reference; any unrecognized command also shows help |

Replies are private to the requester by default. Add `share` anywhere in the
arguments to post the response in the channel, for example `/chiller status
share`. Commands are intentionally read-only: there are no setpoint, reset,
pump, compressor, or other control actions.

### Alert behavior

The alert loop polls every `SLACK_POLL_MIN` minutes and is edge-triggered. It
posts once when a condition becomes active and once when it clears, including
the incident duration. Persistent conditions stay quiet. Failed deliveries are
kept in an ordered in-memory queue and retried on the next poll; later events do
not leapfrog them. A failed source read is treated as unknown, never as proof
that an incident recovered.

| Condition | Default threshold | Persistence before alert |
|---|---:|---:|
| Controller alarm | Any standing named fault | Immediate |
| Propane leak | `SLACK_LEL_PCT=10` percent of LEL | Immediate |
| Leak sensor missing | Point absent from a successful web-variable read | 2 polls |
| High/low pressostat trip | Mechanical switch tripped | Immediate |
| Critical glycol outlet | `SLACK_CRIT_F=45` °F | `SLACK_DWELL_MIN=5` min |
| High glycol outlet | `SLACK_HIGH_F=5` °F above setpoint | `SLACK_DWELL_MIN=5` min |
| Glycol freeze floor | Below `SLACK_FREEZE_F=20` °F | 5 min |
| No flow | Pump running while its flow switch reports no flow | 2 min |
| Not cooling | Compressor running off setpoint without a falling outlet trend | `SLACK_NOTCOOL_MIN=20` min |
| Runtime imbalance | Compressor-hour difference over `SLACK_IMBALANCE_H=100` h | Immediate |
| Controller offline | Modbus read fails | 2 polls |

Temperature alerts clear only after moving `SLACK_HYST_F=2` °F back inside the
threshold. Propane alerts clear below half their trip point. The daily summary
runs after `SLACK_DAILY_HOUR=8` in the Pi's local time and includes outlet
minimum/maximum/average, inlet average, current setpoint and reservoir
temperature, compressor hours, and alarms observed during the window. Its
accumulator resets on service restart and the message states the actual window.

### Slack troubleshooting

- **Slack says “app did not respond.”** Confirm the service is running and the
  log contains the Socket Mode listening message. Check that Socket Mode and the
  `/chiller` command are enabled in the same installed app, then verify outbound
  internet access from the Pi.
- **Tokens are missing or mismatched.** When exactly one Socket Mode token is
  present, the service logs `Slack commands disabled: set both ...`. If neither
  is present, commands are intentionally disabled without a log message. Copy
  each token again from its exact Slack location, update only `.env`, and restart.
- **The app was changed but commands still fail.** Reinstall the app to the
  workspace after manifest or OAuth-scope changes, then restart the service.
- **A stale process owns the connection or controller socket.** Run
  `pgrep -af chiller_dashboard.js` and `systemctl status chiller`. Stop any
  separately launched development copy, then restart the systemd service. Do
  not run a second production instance.
- **Webhook alerts do not arrive.** Confirm Incoming Webhooks remains enabled
  and assigned to the intended channel. Look for `slack post failed:` followed
  by an HTTP status or network error. Failed edges remain queued for retry.
- **Socket Mode disconnects.** Search the journal for `Slack Socket Mode error:`.
  Confirm the Pi has outbound DNS/HTTPS access, then restart the service.
- **More context is needed.** Use
  `journalctl -u chiller -n 200 --no-pager`; redact every secret before sharing
  output. The implementation does not intentionally log token values.

## HTTP interface

The application uses `node:http` with no web framework. API responses are
unauthenticated and are intended for trusted or access-controlled networks.

| Route | Response |
|---|---|
| `/` | Dashboard HTML: live 3D unit, safety state, glycol history, alarms, and virtual-controller entry point |
| `/api` | JSON map of raw INPUT registers 0–161: `{address: uint16}` |
| `/api/web` | JSON map of 16 filtered `getvar.csv` points in engineering units |
| `/api/all` | Combined `{"regs": ..., "web": ...}` payload used by the five-second refresh loop |
| `/api/alarms` | `{"active": [{name, since}], "recent": [{name, at, cleared}]}` |
| `/api/log?start=…&stop=…` | Cached CSV slice; timestamps must be `YYYY-MM-DDThh:mm:ss` |
| `/pgd/*` | Narrow reverse proxy to the controller's live HTML5 pGD interface |
| `/app.js`, `/unit3d.js`, `/logo.svg` | Dashboard scripts and G&D seal artwork |
| `/uplot.js`, `/uplot.css` | Locally served uPlot assets; no CDN |
| `/three.js`, `/three.core.min.js`, `/three/addons/*` | Locally served three.js module and postprocessing dependencies |
| `/reload` | Development-only server-sent event stream used by `npm run dev` |

### Dashboard behavior

The main view refreshes live data every five seconds and alarm history every 60
seconds. It shows glycol inlet/outlet/setpoint/reservoir values, demand,
refrigeration-loop readings, pumps and flow, LEL sensors, pressostats, compressor
and fan state, runtimes, and controller alarms. Circuit A is blue and circuit B
green throughout. Failed refreshes dim stale readings and mark the page offline.

The history chart offers 6 h, 24 h, and 7 d ranges. It plots glycol inlet and
outlet, the current setpoint as a reference line, compressor run strips, and
condensing temperatures derived from logged R290 discharge pressure. Because
the datalogger has no setpoint column, the setpoint line is current rather than
historical. `X-Log-Loading: 1` tells clients that the cache is still backfilling.

Clicking the modeled control box opens the live pGD through `/pgd/`. Its keys
operate the real controller. Browsing information screens is safe; use Esc to
back out, and do not change settings unless explicitly authorized.

## Architecture and data sources

### Modbus TCP

`lib/modbus.js` reads function-code 4 INPUT registers in chunks of at most 100
(the protocol limit is 125). `CHILLER_REGS=162` reads addresses 0–161. Analog
values are signed 16-bit integers scaled by ten: raw `2448` is `244.8 psi`, and
negative values wrap through `uint16`; `scale()` handles that conversion.
Statuses, percentages represented in tenths, booleans, and hour counters are
interpreted according to `LABELS` rather than blindly scaled.

HOLDING registers contain configuration, including the active cooling setpoint
at address 1. The dashboard never writes them; its live setpoint comes from the
read-only INPUT map at address 70.

### Controller web variables

The controller's `getvar.csv` contains roughly 4,000 PLC variables in
`name,id,desc,type,access,val` rows. Repeating the `name` query parameter returns
only requested variables in about 150 ms, rather than downloading the full
five-second export. `WEB_VARS` in `lib/webvars.js` selects 15 live values and
`readWeb()` returns `{label: value}` in engineering units, with no ×10 scaling.
The CSV `id` is an internal PLC variable index, not a Modbus address.

The selected points cover fan and EEV values, glycol supply pressure, pumps,
circuit flow, compressor state, propane LEL sensors, and the high/low mechanical
pressostats. `UNUSED_WEB_VARS` keeps `Modbus_FB.ResLvl` by name only: this unit
has no reservoir level sensor, so the controller's constant zero is never
fetched, displayed, or used for Slack soft alerts. Fan and EEV values also exist
in the TCP map; supply pressure and the safety points do not.

### Alarm log

Register 0 can say that the machine is off by alarm but cannot name the fault.
`lib/alarms.js` polls two undocumented endpoints used by the controller's own
`alarms.htm` page:

- `alarms.cgi?action=getActive` returns standing alarms.
- `alarms.cgi?action=getHistory` returns Start/Stop events, newest first.

The module folds events into named incidents. The controller retains only about
50 events, so an old Start whose Stop has aged out is shown with unknown duration
rather than incorrectly marked active. Timestamps include `+00:00`, but the
controller clock actually runs in site-local time.

Observed faults include high glycol temperature, freeze protection for both
circuits, compressor overload, phase monitor, low reservoir level, EEV driver
offline, and loss of flow.

### Onboard datalogger

The controller log `GandDLog04162024` (id 0) samples 24 values every five seconds
in metric units (°C and bar). `getlog.csv?id=0&start=…&stop=…` takes roughly a
minute per request, so `/api/log` never queries it synchronously. `lib/logcache.js`
keeps seven days in memory, persists them to gitignored `log_cache.csv`, backfills
six-hour chunks newest-first, then polls the tail every `LOG_POLL_MIN` minutes.

The datalogger timestamps also claim `+00:00` while representing local wall
time. The code parses their first 19 characters as local time. The controller
clock was about 25 minutes fast on 2026-07-11, so the cache queries with a
one-hour future pad.

The log stopped after a 2026-04-15 service visit and was re-armed on 2026-07-11.
If charts go flat, open the physical pGD or `/pgd/index.htm`, hold Alarm+Enter
for three seconds, enter **LOGGER**, and re-arm the log. **RESTART LOGS** may say
that no logs need restarting even when this is required. The controller's own
chart is at `http://<controller>/logger.htm`.

## Hardware reference

### Machine and glycol loop

The G&D unit is a 93.9 W × 48.2 D × 66.4 H in air-cooled packaged chiller with
two independent R290 refrigeration circuits, a glycol reservoir, chiller and
process pumps, and a Carel c.pCO PLC. The chiller never contacts beer. It cools
an inhibited propylene-glycol/water mixture circulated through fermenter and
brite-tank jackets.

Warm return glycol is inlet register 69. It collects in the reservoir (register
132 plus a web-only level), passes through the evaporators, and leaves as chilled
supply at register 68. Register 70 is the cooling setpoint. The temperature
difference, inlet minus outlet, is the heat removed from the loop. Flow switches
protect each evaporator: a compressor running without flow could freeze and
rupture it, so the controller locks the circuit out.

Per circuit, compressors raise refrigerant pressure and temperature; the rear
condenser and fans reject heat; an electronic expansion valve drops liquid to
the low side; and the evaporator boils refrigerant while absorbing glycol heat.
The valve trims suction superheat to avoid liquid slugging without starving the
evaporator. The c.pCO compares glycol supply temperature with the setpoint,
computes cooling demand, and stages the circuits. All dashboard access is
read-only.

### 3D model specification

`public/unit3d.js` contains a hand-built three.js model. Its opening **TWEAK MAP**
documents axes, landmarks, and adjustable geometry. One model unit is about
0.391 in; the 240 × 170 × 123 model matches the cabinet's 93.9 × 66.4 × 48.2 in
width, height, and depth. `+z` is front and `+x` is the control-box end.

| Part | Geometry and placement |
|---|---|
| Shell and base | Glossy white shell, black trim and 244 × 12 × 127 base rail |
| Front | Two doors with ten louvers each, center post, corner posts, and two G&D seal medallions |
| Compressors | Two 18 × 39 cylinders behind the louvers; A blue, B green; emissive while running |
| Control box | 6 × 53 × 42 box at `(122, 50, 0)`; click target for the live pGD |
| Glycol stubs | Supply above return on the left end at `(-124, -14/-37, 15)` |
| Reservoir | 70 × 154 × 110 tank at `(-75, 4, -2)` with filler cap at `(-100, 87, -45)` |
| Condensers | Two 148 × 69 rear screens spanning x = −40…108, with two animated fans each |
| Reading chips | Six HTML chips projected from `chipAnchors`; far-side chips dim, with safety/runtimes outside the model |

The unit loads front-facing with no automatic turntable; drag rotates it with
pitch clamped from −30° to 80°. The dormant 36-second tour remains behind the
`auto` flag. Fan animation is display calibration, not physics: 100% maps to
2.5 revolutions per second. `prefers-reduced-motion` keeps the same static pose.

Comparison against installation drawings and factory photos on 2026-07-12
confirmed overall proportions, louvered doors and black framing, seal badges,
right-end control box, left-end supply-over-return connections, base rail, and
visible compressors. Known deviations are the missing auxiliary port on the
blank rear third, missing forklift cutouts in the base rail, and a seal decal on
only the right end instead of both ends. Earlier finish, badge, louver, bezel,
and control-box discrepancies have been corrected.

### Device findings

- The refrigerant is R290 (propane), established from the LEL sensors and the
  exact discharge-pressure/condensing-temperature saturation relationship.
- FC3 HOLDING registers are the configuration bank. Address 1 is the active
  cooling setpoint; addresses 11–14 hold the condenser fan band; 25 and 29 hold
  superheat settings. They are read-only to this project.
- Outside-air and discharge-temperature probes are not installed. Their flat
  32 °F or approximately −86 °F values are controller sentinels, not readings.
- A second-setpoint digital input exists but the alternate 50 °F schedule is not
  engaged; the unit uses the primary setpoint.
- The TZero glycol concentration/freeze-point sensor exists in the PLC program
  but is disabled and errored. The pGD's `0.0%` mixture and `−40 °F` freeze point
  are defaults, not measurements.
- Keyboard, switch, schedule, and BMS enable interlocks are individually
  available in `getvar.csv` if register 0 does not fully explain why the unit is
  off.

## Register reference

### Confirmed INPUT map

The map was confirmed on 2026-07-04 and extended while the chiller ran on
2026-07-12. Circuit 1 occupies 0–33; circuit 2 mirrors it at about +32, with
compressor/fan points at +31. The glycol block is at 68–70 and 132, and runtime
counters begin at 129. `LABELS` in `lib/modbus.js` is the source of truth.

| Register | Circuit A / shared point | Register | Circuit B mirror |
|---:|---|---:|---|
| 0 | Chiller status enum | | |
| 1 | Cooling demand, tenths of percent | | |
| 2 | Power running A, tenths of percent | 34 | Power running B |
| 3 | Discharge pressure A, psi | 35 | Discharge pressure B |
| 4 | Condensing temperature A, °F | 36 | Condensing temperature B |
| 9 | Suction temperature A, °F | 41 | Suction temperature B |
| 10 | Suction pressure A, psi | 42 | Suction pressure B |
| 11 | Evaporating temperature A, °F | 43 | Evaporating temperature B |
| 13 | Circuit A status enum | 45 | Circuit B status enum |
| 23 | Suction superheat A | 55 | Suction superheat B |
| 24 | Discharge superheat A sentinel | 56 | Discharge superheat B sentinel |
| 26 | EEV position A, percent | 58 | EEV position B |
| 28 | EVD status A | 60 | EVD status B |
| 29 | Suction-superheat setpoint A, °F | 61 | Suction-superheat setpoint B |
| 31 | Compressor A on | 62 | Compressor B on |
| 32 | Condenser-fan setpoint A, °F | 63 | Condenser-fan setpoint B |
| 33 | Fan output A, percent | 64 | Fan output B |
| 68 / 69 | Glycol outlet / inlet, °F | 132 | Reservoir temperature, °F |
| 70 | Cooling setpoint, °F | | |
| 129 / 131 | Pump 1 / pump 2 hours | | |
| 135 / 141 | Compressor A / B hours | | |
| 158 / 160 | Condenser-fan A / B hours | | |

Registers 24 and 56 read near −86 °F because discharge-temperature probes are
not fitted; 5 and 37 are matching 32 °F placeholders. Diagnostic points include
EVD firmware at 94 and retained-memory writes at 102. A packed serial/float block
was observed at 167–171, beyond the dashboard's default 0–161 read span.

Chiller status values at register 0 are: `1` standby, `2` off by alarm, `3` off
by BMS, `4` off by schedule, `5` off by digital input, `6` off by keyboard, and
`9` running.

### How the map was discovered

Single-snapshot matching produced false labels because unrelated sensors often
share a value at one instant. `correlate_registers.py` instead samples
`getvar.csv` and Modbus repeatedly. A REAL variable matches only while
`|variable × 10 − register| ≤ 2` across every sample; integers must match exactly.
Drifting readings quickly eliminate coincidences.

Run the one-off Python tool from a virtual environment containing `pymodbus`:

```sh
./.venv/bin/python correlate_registers.py
```

`ROUNDS`, `INTERVAL`, and `CHILLER_IP` are configurable through the environment.
Fast fan and EEV signals were missed because the two requests are about two
seconds apart. A later time-series comparison through `/api/all` found fan output
at 33/64 and EEV position at 26/58. `find_registers.py` is the superseded
single-snapshot approach and remains only as historical reference.

## Network access and recovery

### Teleport split tunnel

The site is reached through Ubiquiti Teleport in WiFiman. Teleport installs
`0/1` and `128.0/1` routes, which together capture all IPv4 traffic even though
the ordinary default route remains unchanged. That full tunnel makes the site
reachable but can break normal internet access.

After Teleport connects, run:

```sh
./teleport_split.sh
ping 192.168.1.69
```

The script finds the `utunN` interface that owns `0/1`, removes both half-range
routes, and adds `192.168.1.0/24` through that tunnel. Internet traffic then uses
the home default route. WiFiman reinstalls its routes after every reconnect, so
rerun the script each time.

Observed tunnel details from 2026-07-04:

| Change | Detail |
|---|---|
| Tunnel | New `utunN`; client on `192.168.2.0/24`, gateway `192.168.2.1` |
| Full-tunnel routes | `0/1` and `128.0/1` point to `utunN` |
| Transport pin | Host route for the site's public endpoint remains on `en0`, preserving the encrypted tunnel after route removal |
| DNS | Home-interface resolvers remain unchanged |

Teleport works through the site's double NAT because UniFi brokers and
NAT-traverses the connection. Troubleshooting:

- `No 0/1 tunnel route found` means Teleport is not passing traffic despite the
  UI state. Fully quit WiFiman, including its menu-bar process, and reconnect. A
  reboot clears a wedged VPN extension.
- If internet dies during a session, Teleport probably reconnected and restored
  the half-range routes. Run `teleport_split.sh` again.
- Check [UniFi Site Manager](https://unifi.ui.com) without the VPN. If the site
  console is offline, the local Mac cannot restore reachability.

### Abandoned WireGuard path

A UniFi WireGuard server on UDP 51830 (51820 is used by Teleport) and a client
with `AllowedIPs = 192.168.1.0/24` were configured but cannot handshake. The
UniFi WAN is `10.1.10.180` behind a Comcast Business gateway at `10.1.10.1`; the
site has a public address rather than CGNAT, but the required port forward cannot
currently be added to the Comcast gateway. Revisit this only if Comcast adds the
forward or the gateway moves to bridge mode. The old client configuration in
`~/Downloads/Chiller-Tunnel-Chiller-Client.conf` contains a private key and must
never enter the repository or chat.

The remaining long-term network improvement is `cloudflared` plus Cloudflare
Access in front of the Pi, which would remove the VPN requirement for read-only
dashboard access.

## Repository map

- `chiller_dashboard.js` wires the modules into the `node:http` server and
  starts the log cache, webhook reporter, and Socket Mode listener.
- `lib/modbus.js` contains `read()`, `scale()`, and the confirmed `LABELS` map.
- `lib/webvars.js` contains `WEB_VARS` and `readWeb()`.
- `lib/alarms.js` reads and folds the controller alarm log.
- `lib/logcache.js` implements datalogger fetch, merge, persistence, and slices.
- `lib/slack.js` evaluates proactive alerts, queues webhook posts, and builds the
  daily summary.
- `lib/slack_commands.js` implements read-only `/chiller` Socket Mode commands.
- `lib/routes.js` serves APIs, static assets, development reloads, and the pGD
  proxy.
- `dashboard.html` is the page markup and CSS. `public/app.js` handles live data,
  alarms, and history; `public/unit3d.js` renders the model.
- `slack-manifest.yml` is the reproducible Slack app definition.
- `gd_seal.svg` is vendor artwork served as `/logo.svg` and used on the model.
- `test.js` is the offline test suite for parsing, cache behavior, page wiring,
  Slack condition sequences, webhook retries, summaries, and every command.
- `jsconfig.json` configures JSDoc type checking; there is no build step.
- `correlate_registers.py` is the current discovery tool;
  `find_registers.py` is its superseded predecessor.
- `teleport_split.sh` repairs the Teleport routing table after each connection.
- `CLAUDE.md` contains repository-specific assistant instructions.
