// Read-only address discovery. This command never starts the dashboard or writes hardware.
const { discoverController, controllerStatus } = require("./lib/controller");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log([
      "Usage: npm run discover -- [--json]",
      "",
      "Locate the chiller using read-only probes of CHILLER_DISCOVERY_CIDR.",
      "CHILLER_IP is the configured starting address; a verified cached address is also tried.",
      "CHILLER_MAC optionally pins the controller's hardware identity.",
      "Discovery never sends Modbus writes or virtual-keypad inputs.",
    ].join("\n"));
    return;
  }
  if (args.some((arg) => arg !== "--json")) throw new Error("Unknown argument; use --help");

  let failure = null;
  try { await discoverController(); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const state = controllerStatus();
  const status = { ...state, error: state.error || failure };
  if (args.includes("--json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log([
      `Controller: ${status.host || "not found"}`,
      `Configured starting address: ${status.configuredHost}`,
      `Search network: ${status.cidr}`,
      `Trusted hardware MAC pin: ${status.mac || "not established"}`,
      `Controller controls: ${status.writeAllowed ? "target trusted (SETPOINT_WRITE still required for setpoint writes)" : "blocked"}`,
      ...(status.candidates.length > 1 ? [`Matching candidates: ${status.candidates.join(", ")}`] : []),
      ...(status.error ? [`Status: ${status.error}`] : []),
    ].join("\n"));
  }
  if (failure || !status.host) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
