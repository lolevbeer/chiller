// Shared env config. HOST is the only value read by more than one module —
// everything else stays next to its use.
try { process.loadEnvFile(); } catch {} // optional .env (gitignored) — holds SLACK_WEBHOOK_URL etc.

exports.HOST = process.env.CHILLER_IP || "192.168.1.69";
