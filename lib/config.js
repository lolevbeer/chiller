// Shared env config. HOST is the only value read by more than one module —
// everything else stays next to its use.
// Load .env by absolute path, not cwd-relative: under systemd the working
// directory isn't the repo, and a cwd-relative lookup silently finds nothing —
// every SLACK_* token and CHILLER_IP override then vanishes with no diagnostics.
try { process.loadEnvFile(require("path").join(__dirname, "..", ".env")); } catch {} // optional .env (gitignored) — holds SLACK_WEBHOOK_URL etc.

exports.HOST = process.env.CHILLER_IP || "192.168.1.69";
