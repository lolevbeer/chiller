// Read-only web view of the G&D glycol chiller (c.pCO) over Modbus TCP + HTTP.
// Cloudflare Access sits in front for auth; this app has no login of its own by design.
// Run:  npm install
//       CHILLER_IP=192.168.1.69 node chiller_dashboard.js   (PORT defaults to 8000)
//
// Entry point only — the pieces live in lib/ (modbus, webvars, logcache, slack,
// routes); this file wires them together and re-exports the test surface.
const http = require("http");
const { HOST } = require("./lib/config"); // also loads .env before anything reads process.env
const { scale, read, LABELS } = require("./lib/modbus");
const { readWeb, WEB_VARS, ROW } = require("./lib/webvars");
const { readLog, TSTAMP, logInsert, logSlice, logLoop } = require("./lib/logcache");
const { slackPayload, step, startSlack } = require("./lib/slack");
const { handle, PAGE } = require("./lib/routes");

// modbus-serial can leak an async socket error (e.g. connect ETIMEDOUT when the
// chiller is unreachable) outside the connectTCP promise, which would kill the
// process as an unhandled rejection. This is a read-only dashboard: log and keep
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
  // datalogger cache: 7 d backfill, then tail polling. Fail fast if the loop
  // ever escapes its own error handling — systemd restarts clean; the
  // alternative is a zombie serving silently frozen history.
  logLoop().catch((e) => { console.error("log loop crashed:", e); process.exit(1); });
}

module.exports = { scale, read, readWeb, readLog, TSTAMP, LABELS, WEB_VARS, ROW, PAGE, slackPayload, step, logInsert, logSlice };
