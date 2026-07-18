// Web view of the G&D glycol chiller (c.pCO) over Modbus TCP + HTTP. Read-only
// except one opt-in path: the automatic setpoint boost (lib/boost.js) writes
// the cooling setpoint to dodge the firmware's setpoint+18°F shutdown, and
// only when SETPOINT_WRITE=1.
// Cloudflare Access sits in front for auth; this app has no login of its own by design.
// Run:  npm install
//       CHILLER_IP=192.168.1.69 node chiller_dashboard.js   (PORT defaults to 8000)
//
// Entry point only — the pieces live in lib/ (modbus, webvars, logcache, slack,
// routes); this file wires them together and re-exports the test surface.
const http = require("http");
const { HOST } = require("./lib/config"); // also loads .env before anything reads process.env
const { scale, read, LABELS } = require("./lib/modbus");
const { readWeb, WEB_VARS, UNUSED_WEB_VARS, ROW } = require("./lib/webvars");
const { readLog, TSTAMP, logInsert, logSlice, logLoop } = require("./lib/logcache");
const { step, startSlack } = require("./lib/slack");
const { startBoost } = require("./lib/boost");
const { startSlackCommands } = require("./lib/slack_commands");
const { handle, PAGE } = require("./lib/routes");

// modbus-serial can leak an async socket error (e.g. connect ETIMEDOUT when the
// chiller is unreachable) outside the connectTCP promise, which would kill the
// process as an unhandled rejection. This dashboard must stay up: log and keep
// serving — the page shows "offline" until reads succeed again. Log the full
// error (stack included) so an unexpected rejection is diagnosable; logLoop()
// separately fails fast (below) so it can't zombie.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));

const PORT = Number(process.env.PORT || 8000);

if (require.main === module) {
  http.createServer(handle).listen(PORT, "0.0.0.0", () =>
    console.log(`chiller dashboard on http://0.0.0.0:${PORT}  (chiller ${HOST})`)
  );
  startSlack(); // no-op unless SLACK_WEBHOOK_URL is set
  startBoost(); // automatic setpoint boost — no-op unless SETPOINT_WRITE=1 (see lib/boost.js)
  startSlackCommands().catch((e) => console.error("Slack commands failed to start:", e));
  // datalogger cache: 7 d backfill, then tail polling. Fail fast if the loop
  // ever escapes its own error handling — systemd restarts clean; the
  // alternative is a zombie serving silently frozen history.
  logLoop().catch((e) => { console.error("log loop crashed:", e); process.exit(1); });
}

module.exports = { scale, read, readWeb, readLog, TSTAMP, LABELS, WEB_VARS, UNUSED_WEB_VARS, ROW, PAGE, step, logInsert, logSlice };
