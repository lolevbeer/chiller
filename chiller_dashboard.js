// Read-only web view of the G&D glycol chiller (c.pCO) over Modbus TCP + HTTP.
// Cloudflare Access sits in front for auth; this app has no login of its own by design.
// Run:  npm install
//       CHILLER_IP=192.168.1.69 node chiller_dashboard.js   (PORT defaults to 8000)
const http = require("http");
const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");

const HOST = process.env.CHILLER_IP || "192.168.1.69";
const PORT = Number(process.env.PORT || 8000);
const COUNT = Number(process.env.CHILLER_REGS || 160); // confirmed map spans 0..158

// INPUT-register labels confirmed by time-series correlation against the
// controller's own getvar.csv (see correlate_registers.py): a register earns a
// label only by tracking that variable across every sample while running.
// Circuit 1 occupies 0..28, circuit 2 mirrors it at 32..56. Integer regs
// (status/counts) are NOT x10; only analog temps/pressures are. Fan speed, EEV
// position, and glycol supply pressure are NOT on the Modbus TCP map at all
// (they exist only in the Modbus_FB block for the serial BMS port).
const LABELS = {
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
};

// CAREL analog values are signed int16, stored x10 (one decimal). Handle negatives.
const scale = (v) => (v > 32767 ? v - 65536 : v) / 10;

async function read() {
  // INPUT registers (FC4) hold the live sensor feed; HOLDING (FC3) are setpoints.
  const c = new ModbusRTU();
  c.setTimeout(3000);
  try {
    await c.connectTCP(HOST, { port: 502 });
    c.setID(1);
    const out = {}; // addr -> raw uint16; chunked: Modbus allows max 125 regs/read
    for (let base = 0; base < COUNT; base += 100) {
      const rr = await c.readInputRegisters(base, Math.min(100, COUNT - base));
      rr.data.forEach((v, i) => { out[base + i] = v; });
    }
    return out;
  } catch {
    return null;
  } finally {
    try { c.close(); } catch {}
  }
}

// Points that exist only in the Modbus_FB block (feeds the serial BMS port, not
// the TCP map). The controller's getvar.csv endpoint accepts repeated ?name=
// params, so one filtered HTTP request (~150 ms) fetches all of these live.
const WEB_VARS = {
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
};

// getvar.csv row: "name",id,"desc",type,access,"val" — desc may hold commas, so
// anchor the last quoted field as val and the first as name (all fields we read
// are ASCII, so fetch's default UTF-8 decode is fine here).
const ROW = /^"([^"]*)",\d+,.*,"([^"]*)"\s*$/;

async function readWeb() {
  // {label: value} from getvar.csv, already in engineering units (no x10); null on failure.
  const qs = Object.keys(WEB_VARS).map((n) => "name=" + encodeURIComponent(n)).join("&");
  try {
    const res = await fetch(`http://${HOST}/getvar.csv?${qs}`, { signal: AbortSignal.timeout(5000) });
    const out = {};
    for (const line of (await res.text()).split("\n")) {
      const m = line.match(ROW);
      if (m && WEB_VARS[m[1]]) out[WEB_VARS[m[1]]] = parseFloat(m[2]);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

const PAGE = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");

async function handle(req, res) {
  const url = req.url.split("?")[0];
  const json = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (url === "/api") return json((await read()) || { error: "modbus read failed" });
  if (url === "/api/web") return json((await readWeb()) || { error: "getvar.csv fetch failed" });
  if (url === "/api/all") {
    // One call for the page's refresh loop: raw regs + web vars in one payload.
    const [regs, web] = await Promise.all([read(), readWeb()]);
    return json({ regs, web });
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, "0.0.0.0", () =>
    console.log(`chiller dashboard on http://0.0.0.0:${PORT}  (chiller ${HOST})`)
  );
}

module.exports = { scale, read, readWeb, LABELS, WEB_VARS, ROW, PAGE };
