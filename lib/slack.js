// Optional Slack reporter: set SLACK_WEBHOOK_URL (an Incoming Webhook) and the
// glycol temps post every SLACK_EVERY_MIN minutes (default 10), plus once at
// startup — if that first read succeeds — so a bad webhook shows up quickly.
const { scale, read } = require("./modbus");

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_EVERY_MIN = Number(process.env.SLACK_EVERY_MIN || 10);

// Glycol-out drives the message's color bar: green below 30 °F, red above 40 °F
// (Slack's legacy "good"/"danger" attachment colors), plain in between.
/** @param {Record<number, number>} regs raw registers
 * @returns {{text?: string, attachments?: {color: string, text: string}[]}} webhook body */
const slackPayload = (regs) => {
  const out = scale(regs[68]);
  const text = `Glycol ${scale(regs[69])}°F in → ${out}°F out · setpoint ${scale(regs[70])}°F · reservoir ${scale(regs[132])}°F`;
  const color = out < 30 ? "good" : out > 40 ? "danger" : null;
  return color ? { attachments: [{ color, text }] } : { text };
};

// One failure warning per outage, not one per tick. Starts true so the startup
// tick can't post a spurious warning: right after a service restart the chiller
// often still holds the dead process's Modbus socket, so the first read loses
// that race. Cost: an outage already in progress at boot isn't announced until
// after the first successful read.
let slackDown = true;
async function slackReport() {
  const regs = await read();
  if (!regs && slackDown) return;
  slackDown = !regs;
  const body = regs ? slackPayload(regs)
    : { text: "⚠️ Chiller Modbus read failed — temps resume when it recovers" };
  await fetch(SLACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => console.error("slack post failed:", e.message));
}

const startSlack = () => { // no-op unless SLACK_WEBHOOK_URL is set
  if (!SLACK_URL) return;
  slackReport();
  setInterval(slackReport, SLACK_EVERY_MIN * 60 * 1000);
};

module.exports = { slackPayload, startSlack };
