const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createControllerLocator, hasChillerFingerprint } = require("./lib/controller");

const SEED = "192.168.6.86";
const FOUND = "192.168.4.2";
const MAC = "00:11:22:33:44:55";
const OTHER_MAC = "aa:bb:cc:dd:ee:ff";
const MATCH = { fingerprint: true, mac: null };
const MISS = { fingerprint: false };

function locator(options = {}) {
  return createControllerLocator({ host: SEED, cidr: "192.168.4.0/30", probe: async () => MISS, ...options });
}

async function cachePath(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chiller-locator-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "address.json");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fingerprint(value = "0") {
  return ["Modbus_FB.FanSpA", "Modbus_FB.CompStatA", "Modbus_FB.GlySupPres", "PctLEL_A", "PctLEL_B"]
    .map((name, index) => `"${name}",${index},"description, with ""quotes""",REAL,RW,"${value}"`).join("\r\n");
}

test("raw CSV requires every named, finite chiller point and valid rows", () => {
  assert.equal(hasChillerFingerprint(fingerprint()), true);
  assert.equal(hasChillerFingerprint("name,id,desc,type,access,val\r\n" + fingerprint()), true);
  assert.equal(hasChillerFingerprint(fingerprint("-1.25e2")), true);
  assert.equal(hasChillerFingerprint(fingerprint("NaN")), false);
  assert.equal(hasChillerFingerprint(fingerprint("Infinity")), false);
  assert.equal(hasChillerFingerprint(fingerprint("12junk")), false);
  assert.equal(hasChillerFingerprint(fingerprint("")), false);
  assert.equal(hasChillerFingerprint(fingerprint().split("\r\n").slice(1).join("\n")), false);
  assert.equal(hasChillerFingerprint(fingerprint() + "\n" + fingerprint().split("\r\n")[0]), false);
  assert.equal(hasChillerFingerprint(fingerprint().replace(",0,", ",oops,extra,")), false);
  assert.equal(hasChillerFingerprint(fingerprint() + "\n<html>Carel c.pCO</html>"), false);
  assert.equal(hasChillerFingerprint("x".repeat(65_537)), false);
  assert.equal(hasChillerFingerprint("Carel c.pCO"), false);
});

test("factory construction performs no probing or cache reads", async (t) => {
  const cacheFile = await cachePath(t);
  await fs.writeFile(cacheFile, "corrupted");
  let probes = 0;
  const controller = locator({ cacheFile, probe: async () => { probes++; return MATCH; } });
  assert.equal(controller.controllerStatus().host, null);
  assert.equal(controller.controllerStatus().lastScanAt, null);
  assert.equal(probes, 0);
  await assert.rejects(controller.getControllerHost(), /cache JSON/);
  assert.equal(probes, 0);
  assert.match(controller.controllerStatus().error, /cache JSON/);
});

test("old address down locates unique fingerprint and permits monitoring only", async () => {
  const visited = [];
  const controller = locator({ probe: async (host) => { visited.push(host); return host === FOUND ? MATCH : MISS; } });
  const status = await controller.discoverController();
  assert.equal(status.host, FOUND);
  assert.equal(status.scanning, false);
  assert.equal(status.writeAllowed, false);
  assert.match(status.error, /Monitoring only/);
  assert.deepEqual(visited, [SEED, "192.168.4.1", FOUND]);
  assert.equal(await controller.getControllerHost(), FOUND);
  await assert.rejects(controller.getControllerHost({ write: true }), /Writes blocked/);
});

test("all subnet responses settle before unique candidate is adopted", async () => {
  const gate = deferred();
  const started = deferred();
  const controller = locator({ probe: async (host) => {
    if (host === "192.168.4.1") return MATCH;
    if (host === FOUND) { started.resolve(); await gate.promise; }
    return MISS;
  } });
  const discovery = controller.discoverController();
  await started.promise;
  assert.equal(controller.controllerStatus().host, null);
  gate.resolve();
  assert.equal((await discovery).host, "192.168.4.1");
});

test("multiple fingerprints refuse selection and expose all candidates", async () => {
  const controller = locator({ probe: async (host) => host === SEED ? MISS : MATCH });
  await assert.rejects(controller.discoverController(), /Ambiguous/);
  assert.equal(controller.controllerStatus().host, null);
  assert.deepEqual(controller.controllerStatus().candidates, ["192.168.4.1", FOUND]);
  await assert.rejects(controller.getControllerHost(), /Ambiguous/);
});

test("an open Modbus port without application fingerprint is not a controller", async () => {
  const controller = locator({ probe: async () => ({ fingerprint: false, mac: MAC, portOpen: true }) });
  await assert.rejects(controller.discoverController(), /No verified chiller/);
  assert.equal(controller.controllerStatus().host, null);
});

test("concurrent dashboard callers fail fast behind one shared scan", async () => {
  const gate = deferred();
  const started = deferred();
  const calls = [];
  const controller = locator({ probe: async (host) => {
    calls.push(host);
    if (host === SEED) return MISS;
    started.resolve();
    await gate.promise;
    return host === FOUND ? MATCH : MISS;
  } });
  const requests = Array.from({ length: 12 }, () => controller.getControllerHost());
  const outcomes = await Promise.allSettled(requests);
  await started.promise;
  assert.equal(outcomes.every((result) => result.status === "rejected"), true);
  assert.equal(controller.controllerStatus().scanning, true);
  assert.equal(calls.filter((host) => host === SEED).length, 1);
  const discovery = controller.discoverController();
  gate.resolve();
  assert.equal((await discovery).host, FOUND);
  assert.equal(calls.length, 3);
});

test("failed scans pause traffic, then recover when the controller appears after cooldown", async () => {
  let time = 1_000_000, available = false, calls = 0;
  const controller = locator({ now: () => time, probe: async (host) => {
    calls++;
    return available && host === FOUND ? MATCH : MISS;
  } });
  await assert.rejects(controller.discoverController(), /No verified chiller/);
  const afterFirst = calls;
  available = true;
  await assert.rejects(controller.discoverController(), /cooldown/);
  assert.equal(calls, afterFirst);
  time += 59_999;
  await assert.rejects(controller.discoverController(), /cooldown/);
  assert.equal(calls, afterFirst);
  time++;
  assert.equal((await controller.discoverController()).host, FOUND);
});

test("cache survives restart but cached address must be revalidated", async (t) => {
  const cacheFile = await cachePath(t);
  const first = locator({ cacheFile, probe: async (host) => host === FOUND ? MATCH : MISS });
  await first.discoverController();
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: FOUND, mac: null });
  const calls = [];
  const second = locator({ cacheFile, discovery: false, probe: async (host) => { calls.push(host); return MISS; } });
  assert.equal(second.controllerStatus().host, null);
  await assert.rejects(second.discoverController(), /disabled/);
  assert.deepEqual(calls, [FOUND, SEED]);
  assert.equal(second.controllerStatus().host, null);
});

test("configured seed recovers without restart when subnet discovery is disabled", async () => {
  let time = 1_000_000, online = false;
  const controller = locator({ discovery: false, now: () => time, probe: async (host) =>
    online && host === SEED ? MATCH : MISS });
  await assert.rejects(controller.discoverController(), /disabled/);
  online = true;
  time += 60_000;
  assert.equal(await controller.getControllerHost(), SEED);
  controller.controllerFailed(SEED);
  assert.equal(await controller.getControllerHost(), SEED);
});

test("verified configured seed learns a trusted MAC across address changes", async (t) => {
  const cacheFile = await cachePath(t);
  const first = locator({ cacheFile, probe: async () => ({ fingerprint: true, mac: "00-11-22-33-44-55" }) });
  assert.equal(await first.getControllerHost(), SEED);
  assert.equal(first.controllerStatus().writeAllowed, true);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: SEED, mac: MAC });
  const moved = locator({ cacheFile, probe: async (host) => host === FOUND ? { fingerprint: true, mac: MAC } : MISS });
  assert.equal((await moved.discoverController()).host, FOUND);
  assert.equal(await moved.getControllerHost({ write: true }), FOUND);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: FOUND, mac: MAC });
});

test("untrusted discovered MAC is never automatically pinned", async (t) => {
  const cacheFile = await cachePath(t);
  const controller = locator({ cacheFile, probe: async (host) => host === FOUND ? { fingerprint: true, mac: MAC } : MISS });
  assert.equal((await controller.discoverController()).mac, null);
  assert.equal(controller.controllerStatus().writeAllowed, false);
  await assert.rejects(controller.getControllerHost({ write: true }), /Writes blocked/);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: FOUND, mac: null });
});

test("trusted pin is preserved when routed discovery cannot obtain a MAC", async (t) => {
  const cacheFile = await cachePath(t);
  await fs.writeFile(cacheFile, JSON.stringify({ host: SEED, mac: MAC }));
  const controller = locator({ cacheFile, probe: async (host) => host === FOUND ? MATCH : MISS });
  await controller.discoverController();
  await assert.rejects(controller.getControllerHost({ write: true }), /Writes blocked/);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: FOUND, mac: MAC });
});

test("explicit trusted pin permits moved controller but rejects known mismatches", async () => {
  const controller = locator({ mac: MAC, probe: async (host) => ({ fingerprint: true, mac: host === FOUND ? MAC : OTHER_MAC }) });
  assert.equal((await controller.discoverController()).host, FOUND);
  assert.equal(await controller.getControllerHost({ write: true }), FOUND);
  const mismatch = locator({ mac: MAC, probe: async () => ({ fingerprint: true, mac: OTHER_MAC }) });
  await assert.rejects(mismatch.discoverController(), /MAC mismatch/);
  assert.equal(mismatch.controllerStatus().host, null);
});

test("explicit MAC cannot silently overwrite a conflicting cached identity", async (t) => {
  const cacheFile = await cachePath(t);
  const original = JSON.stringify({ host: SEED, mac: OTHER_MAC });
  await fs.writeFile(cacheFile, original);
  let calls = 0;
  const controller = locator({ mac: MAC, cacheFile, probe: async () => { calls++; return MATCH; } });
  await assert.rejects(controller.discoverController(), /conflicts/);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(cacheFile, "utf8"), original);
});

test("configured seed is operator-trusted even when routed MAC lookup is unavailable", async () => {
  let calls = 0;
  const controller = locator({ probe: async () => { calls++; return MATCH; } });
  assert.equal(await controller.getControllerHost({ write: true }), SEED);
  assert.equal(calls, 2); // Preferred verification plus immediate write verification.
  assert.equal(controller.controllerStatus().writeAllowed, true);
});

test("configured seed with an existing pin cannot authorize writes without MAC evidence", async () => {
  const controller = locator({ mac: MAC, probe: async () => MATCH });
  assert.equal(await controller.getControllerHost(), SEED);
  assert.equal(controller.controllerStatus().mac, MAC);
  assert.equal(controller.controllerStatus().writeAllowed, false);
  await assert.rejects(controller.getControllerHost({ write: true }), /Writes blocked/);
});

test("losing MAC evidence during immediate write revalidation blocks the write", async () => {
  let observedMac = MAC;
  const controller = locator({ probe: async () => ({ fingerprint: true, mac: observedMac }) });
  await controller.getControllerHost();
  observedMac = null;
  await assert.rejects(controller.getControllerHost({ write: true }), /Writes blocked/);
  assert.equal(controller.controllerStatus().host, SEED);
  assert.equal(controller.controllerStatus().mac, MAC);
  assert.equal(controller.controllerStatus().writeAllowed, false);
});

test("each write revalidates hardware and never retries after failure", async () => {
  const calls = [];
  let currentMac = MAC;
  const controller = locator({ probe: async (host) => { calls.push(host); return { fingerprint: true, mac: currentMac }; } });
  await controller.getControllerHost();
  currentMac = OTHER_MAC;
  await assert.rejects(controller.getControllerHost({ write: true }), /MAC mismatch/);
  assert.deepEqual(calls, [SEED, SEED]);
  assert.equal(controller.controllerStatus().host, null);
  assert.equal(controller.controllerStatus().writeAllowed, false);
});

test("only a failure at the currently selected address invalidates it", async () => {
  const controller = locator({ probe: async () => MATCH });
  await controller.getControllerHost();
  controller.controllerFailed(FOUND);
  assert.equal(controller.controllerStatus().host, SEED);
  controller.controllerFailed(SEED);
  assert.equal(controller.controllerStatus().host, null);
});

test("cache errors surface without accepting or replacing corrupt identity", async (t) => {
  const cacheFile = await cachePath(t);
  for (const content of ["no json", "null", JSON.stringify({ host: "8.8.8.8", mac: MAC }), JSON.stringify({ host: SEED, mac: "not a mac" })]) {
    await fs.writeFile(cacheFile, content);
    const controller = locator({ cacheFile, probe: async () => MATCH });
    await assert.rejects(controller.getControllerHost());
    assert.equal(controller.controllerStatus().host, null);
    assert.equal(await fs.readFile(cacheFile, "utf8"), content);
    assert.ok(controller.controllerStatus().error);
  }
});

test("cache write failures are visible and never select an unpersisted target", async (t) => {
  const cacheFile = await cachePath(t);
  const controller = locator({ cacheFile: path.join(cacheFile, "missing", "address.json"), probe: async () => MATCH });
  await assert.rejects(controller.getControllerHost(), /save controller address cache/);
  assert.equal(controller.controllerStatus().host, null);
  assert.match(controller.controllerStatus().error, /cache/);
});

test("disabling discovery still verifies configured and cached hosts", async () => {
  const visited = [];
  const controller = locator({ discovery: false, probe: async (host) => { visited.push(host); return MISS; } });
  await assert.rejects(controller.discoverController(), /disabled/);
  assert.deepEqual(visited, [SEED]);
  const seed = locator({ discovery: false, probe: async () => MATCH });
  assert.equal(await seed.getControllerHost(), SEED);
});

test("factory rejects malformed, public, IPv6 and oversized discovery boundaries", () => {
  for (const cidr of ["", "192.168.4.0", "192.168.4.0/21", "192.168.4.0/33", "192.168.4.0/NaN", "8.8.8.0/24", "172.15.255.0/24", "10.0.0.0/-1", "127.0.0.0/24", "::1/32", "10.0.0.999/24"]) {
    assert.throws(() => locator({ cidr }), undefined, cidr);
  }
  for (const host of ["8.8.8.8", "127.0.0.1", "localhost", "192.168.1.1/path", "::1"]) assert.throws(() => locator({ host }));
  assert.throws(() => locator({ mac: "invalid" }), /MAC/);
  assert.throws(() => locator({ concurrency: 9 }), /concurrency/);
  assert.equal(locator({ cidr: "192.168.6.123/22" }).controllerStatus().cidr, "192.168.4.0/22");
});

test("normalized /32 scan never probes outside its private address", async () => {
  const visited = [];
  const controller = locator({ cidr: `${FOUND}/32`, probe: async (host) => { visited.push(host); return host === FOUND ? MATCH : MISS; } });
  await controller.discoverController();
  assert.deepEqual(visited, [SEED, FOUND]);
});

test("largest permitted subnet is bounded and never exceeds eight workers", async () => {
  let active = 0;
  let peak = 0;
  const visited = [];
  const controller = locator({ host: "10.1.1.1", cidr: "192.168.6.123/22", probe: async (host) => {
    if (host === "10.1.1.1") return MISS;
    visited.push(host);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return MISS;
  } });
  await assert.rejects(controller.discoverController(), /No verified chiller/);
  assert.equal(visited.length, 1022);
  assert.equal(new Set(visited).size, 1022);
  assert.ok(peak <= 8);
  assert.ok(peak > 1);
  assert.equal(visited[0], "192.168.4.1");
  assert.equal(visited[visited.length - 1], "192.168.7.254");
});

test("reassigned configured address cannot replace the learned cache pin", async (t) => {
  const cacheFile = await cachePath(t);
  const original = JSON.stringify({ host: SEED, mac: MAC });
  await fs.writeFile(cacheFile, original);
  const controller = locator({ cacheFile, probe: async () => ({ fingerprint: true, mac: OTHER_MAC }) });
  await assert.rejects(controller.discoverController(), /MAC mismatch/);
  assert.equal(controller.controllerStatus().mac, MAC);
  assert.equal(controller.controllerStatus().writeAllowed, false);
  assert.equal(await fs.readFile(cacheFile, "utf8"), original);
});

test("MAC learned during fresh seed write validation is persisted", async (t) => {
  const cacheFile = await cachePath(t);
  let observedMac = null;
  const controller = locator({ cacheFile, probe: async () => ({ fingerprint: true, mac: observedMac }) });
  assert.equal(await controller.getControllerHost(), SEED);
  observedMac = MAC;
  assert.equal(await controller.getControllerHost({ write: true }), SEED);
  assert.equal(controller.controllerStatus().mac, MAC);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, "utf8")), { host: SEED, mac: MAC });
});
