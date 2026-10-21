// Self-update for the Pi behind `/chiller deploy`: fast-forward this checkout
// from GitHub, reinstall dependencies only when they changed, and report
// whether the caller should exit so systemd (Restart=always) starts the new code.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const exec = promisify(execFile);

/** @param {string} cmd @param {string[]} args */
async function sh(cmd, args) {
  const { stdout } = await exec(cmd, args, { cwd: ROOT, timeout: 600e3 }); // npm ci on the armv6l Pi is slow
  return stdout.trim();
}

let busy = false;

/** @param {{run?: typeof sh}} [deps] injectable for test.js
 * @returns {Promise<{ok: boolean, restart: boolean, message: string}>} */
async function deploy({ run = sh } = {}) {
  if (busy) return { ok: false, restart: false, message: "A deploy is already running." };
  busy = true;
  try {
    // Exiting without Restart=always would leave the dashboard down until someone ssh's in.
    const restartPolicy = await run("systemctl", ["show", "-p", "Restart", "--value", "chiller"]).catch(() => "");
    if (restartPolicy !== "always") {
      return { ok: false, restart: false, message: "Refused: chiller.service is not Restart=always, so the new code could not start on its own." };
    }
    const before = await run("git", ["rev-parse", "--short", "HEAD"]);
    await run("git", ["pull", "--ff-only"]);
    const after = await run("git", ["rev-parse", "--short", "HEAD"]);
    if (before === after) return { ok: true, restart: false, message: `Already up to date at ${after}.` };
    const changed = await run("git", ["diff", "--name-only", before, after]);
    if (/^package(-lock)?\.json$/m.test(changed)) await run("npm", ["ci", "--omit=dev"]);
    const log = await run("git", ["log", "--oneline", `${before}..${after}`]);
    return { ok: true, restart: true, message: `Updated ${before} → ${after}; restarting.\n${log}` };
  } catch (e) {
    const err = /** @type {{stderr?: string, message?: string}} */ (e);
    return { ok: false, restart: false, message: `Deploy failed: ${(err.stderr || err.message || String(e)).trim()}` };
  } finally {
    busy = false;
  }
}

module.exports = { deploy };
