// Web-only points from the controller's getvar.csv microwebsite endpoint —
// values that exist only in the Modbus_FB block (feeds the serial BMS port,
// not the TCP map). One filtered HTTP request (~150 ms) fetches all of these.
const { HOST } = require("./config");

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

module.exports = { WEB_VARS, ROW, readWeb };
