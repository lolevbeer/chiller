// Controller discovery is read-only. Importing this module loads configuration,
// but never reads the address cache or starts network discovery.
const { CONFIGURED_HOST } = require("./config");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { execFile } = require("node:child_process");

const FINGERPRINT_POINTS = [
  "Modbus_FB.FanSpA", "Modbus_FB.CompStatA", "Modbus_FB.GlySupPres", "PctLEL_A", "PctLEL_B",
];
const MAX_RESPONSE_BYTES = 64 * 1024;
const COOLDOWN_MS = 60_000;
const errorMessage = (failure) => failure instanceof Error ? failure.message : String(failure);

function ipv4Number(address) {
  if (typeof address !== "string" || !net.isIPv4(address)) throw new Error(`Invalid IPv4 address: ${address}`);
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function privateAddress(value) {
  return (value >= 0x0a000000 && value <= 0x0affffff) ||
    (value >= 0xac100000 && value <= 0xac1fffff) ||
    (value >= 0xc0a80000 && value <= 0xc0a8ffff);
}

function addressString(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function parseCidr(cidr) {
  if (typeof cidr !== "string" || !/^[^/]+\/\d+$/.test(cidr)) throw new Error("Discovery CIDR must be private IPv4 /22 through /32");
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  if (prefix < 22 || prefix > 32) throw new Error("Discovery CIDR must contain at most 1024 addresses (/22 through /32)");
  const count = 2 ** (32 - prefix);
  const start = Math.floor(ipv4Number(address) / count) * count;
  if (!privateAddress(start) || !privateAddress(start + count - 1)) throw new Error("Discovery CIDR must be entirely within private IPv4 space");
  // Do not send discovery traffic to a subnet's network or broadcast address.
  const first = count > 2 ? start + 1 : start;
  const end = count > 2 ? start + count - 2 : start + count - 1;
  return { cidr: `${addressString(start)}/${prefix}`, first, end };
}

function normalizeMac(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid controller MAC address");
  const compact = value.replace(/[:-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(compact) || /^(000000000000|ffffffffffff)$/.test(compact)) throw new Error(`Invalid controller MAC address: ${value}`);
  return compact.match(/../g).join(":");
}

function parseCsvRow(line) {
  const fields = [];
  let index = 0;
  while (index < line.length) {
    let value = "";
    if (line[index] === '"') {
      index++;
      let closed = false;
      while (index < line.length) {
        if (line[index] !== '"') { value += line[index++]; continue; }
        if (line[index + 1] === '"') { value += '"'; index += 2; continue; }
        index++;
        closed = true;
        break;
      }
      if (!closed) return null;
    } else {
      while (index < line.length && line[index] !== ",") value += line[index++];
      if (value.includes('"')) return null;
    }
    fields.push(value);
    if (index === line.length) break;
    if (line[index++] !== ",") return null;
    if (index === line.length) fields.push("");
  }
  return fields;
}

function hasChillerFingerprint(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > MAX_RESPONSE_BYTES) return false;
  const found = new Set();
  let firstRow = true;
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (firstRow) {
      firstRow = false;
      if (line === "name,id,desc,type,access,val") continue;
    }
    const fields = parseCsvRow(line);
    if (!fields || fields.length !== 6 || !/^\d+$/.test(fields[1])) return false;
    const [name, , , , , value] = fields;
    if (!FINGERPRINT_POINTS.includes(name)) continue;
    if (found.has(name) || !value.trim() || !Number.isFinite(Number(value))) return false;
    found.add(name);
  }
  return found.size === FINGERPRINT_POINTS.length;
}

function modbusOpen(host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 502 });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}

function readFingerprint(host) {
  return new Promise((resolve) => {
    const query = FINGERPRINT_POINTS.map((name) => `name=${encodeURIComponent(name)}`).join("&");
    let finished = false;
    let response;
    const request = http.get({ hostname: host, port: 80, path: `/getvar.csv?${query}`, agent: false }, (incoming) => {
      response = incoming;
      if (incoming.statusCode !== 200) { finish(false); return; }
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { finish(false); return; }
        chunks.push(chunk);
      });
      incoming.once("end", () => finish(hasChillerFingerprint(Buffer.concat(chunks).toString("utf8"))));
      incoming.once("error", () => finish(false));
      incoming.once("aborted", () => finish(false));
    });
    const timer = setTimeout(() => finish(false), 2000);
    function finish(valid) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (response) response.destroy();
      request.destroy();
      resolve(valid);
    }
    request.once("error", () => finish(false));
  });
}

async function lookupMac(host) {
  // ARP entries are keyed by the target IP, never by the route's gateway.
  if (process.platform === "linux") {
    let arp;
    try { arp = await fs.readFile("/proc/net/arp", "utf8"); } catch { return null; }
    for (const line of arp.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === host && (Number(fields[2]) & 2)) {
        try { return normalizeMac(fields[3]); } catch { return null; }
      }
    }
    return null;
  }
  if (process.platform !== "darwin") return null;
  return new Promise((resolve) => {
    execFile("/usr/sbin/arp", ["-n", host], { timeout: 1000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const match = stdout.match(/\(([^)]+)\) at ([0-9a-f:]+) on /i);
      if (!match || match[1] !== host) { resolve(null); return; }
      // macOS may omit leading zeroes in individual octets.
      const octets = match[2].split(":");
      if (octets.length !== 6 || octets.some((part) => !/^[0-9a-f]{1,2}$/i.test(part))) { resolve(null); return; }
      try { resolve(normalizeMac(octets.map((part) => part.padStart(2, "0")).join(":"))); } catch { resolve(null); }
    });
  });
}

/** @returns {Promise<{fingerprint: boolean, mac?: string | null}>} */
async function probeController(host) {
  if (!await modbusOpen(host) || !await readFingerprint(host)) return { fingerprint: false, mac: null };
  return { fingerprint: true, mac: await lookupMac(host) };
}

/**
 * probe(host) returns Promise<{fingerprint: boolean, mac?: string|null}>.
 * Injected probes must verify the application fingerprint, not just an open port.
 * now() returns epoch milliseconds. cacheFile:null disables disk persistence.
 * Factory instances never consult environment variables.
 */
function createControllerLocator({ host, cidr = "192.168.4.0/22", mac = null, cacheFile = null, probe = probeController, now = Date.now, discovery = true, concurrency = 8 }) {
  if (!privateAddress(ipv4Number(host))) throw new Error("Configured controller must be a private IPv4 address");
  const subnet = parseCidr(cidr);
  const explicitMac = normalizeMac(mac);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Discovery concurrency must be between 1 and 8");
  let trustedMac = explicitMac;
  let cachedHost = null;
  let selected = null;
  let error = null;
  let candidates = [];
  let lastScanAt = null;
  let lastScanFinished = null;
  let scanPromise = null;
  let preferredPromise = null;
  let preferredDone = false;
  let lastPreferredCheck = null;
  let cachePromise = null;

  function controllerStatus() {
    return {
      host: selected ? selected.host : null, configuredHost: host, cidr: subnet.cidr,
      scanning: scanPromise !== null, writeAllowed: !!selected && selected.writeAllowed,
      mac: trustedMac, error, candidates: [...candidates], lastScanAt,
    };
  }

  async function loadCache() {
    if (!cacheFile) return;
    let raw;
    try { raw = await fs.readFile(cacheFile, "utf8"); } catch (failure) {
      if ((/** @type {NodeJS.ErrnoException} */ (failure))?.code === "ENOENT") return;
      throw new Error(`Cannot read controller address cache: ${errorMessage(failure)}`);
    }
    let cached;
    try { cached = JSON.parse(raw); } catch { throw new Error("Invalid controller address cache JSON"); }
    if (!cached || typeof cached !== "object" || !privateAddress(ipv4Number(cached.host))) throw new Error("Invalid controller address cache host");
    const cachedMac = normalizeMac(cached.mac);
    if (explicitMac && cachedMac && explicitMac !== cachedMac) throw new Error("Controller address cache MAC conflicts with CHILLER_MAC; refusing to replace identity");
    trustedMac = explicitMac || cachedMac;
    cachedHost = cached.host;
  }

  async function persist(candidate) {
    if (!cacheFile) return;
    const temporary = `${cacheFile}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ host: candidate.host, mac: trustedMac }, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(temporary, cacheFile);
    } catch (failure) {
      try { await fs.unlink(temporary); } catch {}
      throw new Error(`Cannot save controller address cache: ${errorMessage(failure)}`);
    }
  }

  async function inspect(address) {
    let result;
    try { result = await probe(address); } catch (failure) {
      return { candidate: null, reason: `Controller probe failed for ${address}: ${errorMessage(failure)}` };
    }
    if (!result || result.fingerprint !== true) return { candidate: null, reason: `No verified chiller response from ${address}` };
    let candidateMac;
    try { candidateMac = normalizeMac(result.mac); } catch (failure) { return { candidate: null, reason: errorMessage(failure) }; }
    if (trustedMac && candidateMac && trustedMac !== candidateMac) return { candidate: null, reason: `Controller MAC mismatch at ${address}: expected ${trustedMac}, received ${candidateMac}` };
    const writeAllowed = trustedMac ? candidateMac === trustedMac : address === host;
    return { candidate: { host: address, mac: candidateMac, writeAllowed }, reason: null };
  }

  async function select(candidate) {
    // Only a verified operator-configured seed may teach us a hardware identity.
    const previousMac = trustedMac;
    if (trustedMac && candidate.mac && trustedMac !== candidate.mac) throw new Error(`Controller MAC mismatch at ${candidate.host}; refusing to replace trusted identity`);
    if (candidate.host === host && candidate.mac && !trustedMac) trustedMac = candidate.mac;
    try { await persist(candidate); } catch (failure) { trustedMac = previousMac; throw failure; }
    cachedHost = candidate.host;
    selected = candidate;
    error = candidate.writeAllowed ? null : "Monitoring only: controller has no matching trusted MAC; writes blocked. MAC lookup may be unavailable over a routed VPN.";
  }

  async function verifyPreferred() {
    if (preferredDone && (selected || scanPromise || now() - lastPreferredCheck < COOLDOWN_MS)) return;
    if (preferredPromise) return preferredPromise;
    preferredPromise = (async () => {
      if (!cachePromise) cachePromise = loadCache();
      await cachePromise;
      for (const address of new Set([cachedHost, host].filter(Boolean))) {
        const result = await inspect(address);
        if (result.candidate) { await select(result.candidate); break; }
        error = result.reason;
      }
      preferredDone = true;
      lastPreferredCheck = now();
    })();
    try { await preferredPromise; } catch (failure) { error = errorMessage(failure); throw failure; }
    finally { preferredPromise = null; }
  }

  function startScan() {
    if (scanPromise) return scanPromise;
    if (!discovery) {
      error = "Controller unreachable; subnet discovery is disabled (CHILLER_DISCOVERY=0)";
      return Promise.reject(new Error(error));
    }
    if (lastScanFinished !== null && now() - lastScanFinished < COOLDOWN_MS) return Promise.reject(new Error("Controller discovery cooldown is 60 seconds"));
    lastScanAt = new Date(now()).toISOString();
    candidates = [];
    scanPromise = (async () => {
      let next = subnet.first;
      const matches = [];
      let mismatch = null;
      async function worker() {
        while (next <= subnet.end) {
          const address = addressString(next++);
          const result = await inspect(address);
          if (result.candidate) matches.push(result.candidate);
          else if (result.reason.includes("MAC mismatch")) mismatch = result.reason;
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      matches.sort((a, b) => ipv4Number(a.host) - ipv4Number(b.host));
      candidates = matches.map((candidate) => candidate.host);
      if (matches.length > 1) throw new Error(`Ambiguous controller discovery: ${candidates.join(", ")}; configure CHILLER_IP/CHILLER_MAC explicitly`);
      if (!matches.length) throw new Error(mismatch || `No verified chiller found in ${subnet.cidr}. Check the site/VPN route; an overlapping home subnet may route traffic locally.`);
      await select(matches[0]);
      return controllerStatus();
    })().catch((failure) => { error = errorMessage(failure); throw failure; }).finally(() => {
      lastScanFinished = now();
      scanPromise = null;
    });
    return scanPromise;
  }

  function controllerFailed(address) {
    if (!selected || selected.host !== address) return;
    selected = null;
    preferredDone = false;
    error = `Selected controller ${address} failed; rediscovery required`;
  }

  async function getControllerHost({ write = false } = {}) {
    await verifyPreferred();
    if (!selected) {
      // Dashboard reads do not wait for an entire LAN scan. The CLI does.
      startScan().catch(() => {}); // actual scan failures already populate diagnostic status
      throw new Error(error || "Controller discovery is running");
    }
    if (!write) return selected.host;
    const original = selected;
    const result = await inspect(original.host);
    if (selected !== original) throw new Error("Controller changed during write validation; write refused");
    if (!result.candidate) {
      controllerFailed(original.host);
      error = result.reason;
      throw new Error(error);
    }
    if (original.mac && result.candidate.mac && original.mac !== result.candidate.mac) {
      controllerFailed(original.host);
      error = "Controller hardware identity changed; write refused";
      throw new Error(error);
    }
    if (!result.candidate.writeAllowed) {
      selected = result.candidate;
      error = "Writes blocked: controller has no matching trusted MAC. Configure CHILLER_MAC or verify the configured seed; routed VPNs may not expose MAC addresses.";
      throw new Error(error);
    }
    if (!trustedMac && result.candidate.mac && result.candidate.host === host) {
      await select(result.candidate);
    } else {
      selected = result.candidate;
      error = null;
    }
    return result.candidate.host;
  }

  async function discoverController() {
    await verifyPreferred();
    if (!selected) await startScan();
    return controllerStatus();
  }

  return { getControllerHost, controllerFailed, discoverController, controllerStatus };
}

let locator;
function defaultLocator() {
  if (!locator) locator = createControllerLocator({
    host: CONFIGURED_HOST,
    cidr: process.env.CHILLER_DISCOVERY_CIDR || "192.168.4.0/22",
    mac: process.env.CHILLER_MAC || null,
    cacheFile: process.env.CHILLER_ADDRESS_FILE || path.join(__dirname, "..", "chiller_address.json"),
    discovery: process.env.CHILLER_DISCOVERY !== "0",
  });
  return locator;
}

module.exports = {
  createControllerLocator, hasChillerFingerprint,
  getControllerHost: async (options) => defaultLocator().getControllerHost(options),
  controllerFailed: (host) => defaultLocator().controllerFailed(host),
  discoverController: async () => defaultLocator().discoverController(),
  controllerStatus: () => {
    try { return defaultLocator().controllerStatus(); } catch (failure) {
      return {
        host: null, configuredHost: CONFIGURED_HOST, cidr: process.env.CHILLER_DISCOVERY_CIDR || "192.168.4.0/22",
        scanning: false, writeAllowed: false, mac: null, error: errorMessage(failure), candidates: [], lastScanAt: null,
      };
    }
  },
};
