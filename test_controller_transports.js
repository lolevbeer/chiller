// Offline controller cutover tests: no sockets, hardware, or webhook calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { PassThrough } = require("node:stream");

function load(filename, dependencies, globals = {}) {
  const file = path.join(__dirname, filename);
  const localRequire = createRequire(file);
  const injectedRequire = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name);
  injectedRequire.resolve = localRequire.resolve;
  const context = { module: { exports: {} }, require: injectedRequire, __dirname: path.dirname(file),
    process: { env: {} }, console, Buffer, URL, AbortSignal, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return /** @type {any} */ (context.module.exports);
}

test("setpoint write and readback stay on the same verified connection after discovery changes", async () => {
  let selected = "192.168.6.90";
  const operations = [];
  const resolutions = [];
  class Client {
    setTimeout() {}
    setID() {}
    async connectTCP(host) { this.host = host; operations.push(["connect", host]); }
    async writeRegister(register, value) {
      this.value = value;
      operations.push(["write", this.host, register, value]);
      selected = "192.168.6.91";
    }
    async readInputRegisters() { operations.push(["readback", this.host]); return { data: [this.value] }; }
    destroy() {}
  }
  const modbus = load("lib/modbus.js", {
    "modbus-serial": Client,
    "./controller": { getControllerHost: async (options) => { resolutions.push(options.write); return selected; }, controllerFailed() {} },
  });
  const result = await modbus.writeSetpoint(29);
  assert.equal(result.ok, true);
  assert.equal(result.readback, 29);
  assert.deepEqual(resolutions, [true]);
  assert.deepEqual(operations, [["connect", "192.168.6.90"], ["write", "192.168.6.90", 1, 290], ["readback", "192.168.6.90"]]);
});

test("untrusted discovered target cannot receive a setpoint connection or a replay", async () => {
  let connections = 0;
  class Client {
    connectTCP() { connections++; throw new Error("must not connect"); }
    destroy() {}
  }
  const modbus = load("lib/modbus.js", {
    "modbus-serial": Client,
    "./controller": { getControllerHost: async () => { throw new Error("hardware identity unverified"); }, controllerFailed() {} },
  }, { console: { error() {} } });
  const result = await modbus.writeSetpoint(29);
  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.equal(connections, 0);
});

test("HTTP readers follow discovery after import and invalidate the failed address, not the new one", async () => {
  let selected = "192.168.6.90";
  let fail = false;
  const requested = [], invalidated = [];
  const reader = load("lib/webvars.js", {
    "./controller": { getControllerHost: async () => selected, controllerFailed: (host) => invalidated.push(host) },
  }, { fetch: async (url) => {
    requested.push(new URL(url).hostname);
    if (fail) { selected = "192.168.6.92"; throw new Error("connection lost"); }
    return { ok: true, text: async () => '"Modbus_FB.FanSpA",1,"fan",REAL,RO,"68.0"\n' };
  } });
  assert.equal((await reader.readWeb())["Fan speed A %"], 68);
  selected = "192.168.6.91";
  assert.equal((await reader.readWeb())["Fan speed A %"], 68);
  fail = true;
  assert.equal(await reader.readWeb(), null);
  assert.deepEqual(requested, ["192.168.6.90", "192.168.6.91", "192.168.6.91"]);
  assert.deepEqual(invalidated, ["192.168.6.91"]);
});

test("keypad rejects old sessions after cutover, then allows explicit reload on a trusted target", async () => {
  let selected = "192.168.6.90", trusted = true;
  const upstream = [];
  const routes = load("lib/routes.js", {
    "http": { request: (options, response) => {
      upstream.push({ host: options.hostname, path: options.path });
      const request = Object.assign(new PassThrough(), { setTimeout: () => request });
      queueMicrotask(() => response({ statusCode: 200, headers: {}, pipe: (res) => res.end("controller response") }));
      return request;
    } },
    "./controller": {
      getControllerHost: async ({ write = false } = {}) => {
        if (write && !trusted) throw new Error("hardware identity unverified");
        return selected;
      },
      controllerFailed() {}, controllerStatus: () => ({ host: selected, writeAllowed: trusted }),
    },
    "./modbus": { read: async () => ({}), writeSetpoint: async () => { throw new Error("unexpected write"); } },
    "./webvars": { readWeb: async () => ({}) }, "./alarms": { readAlarms: async () => ({ active: [] }) },
    "./boost": { TRIP_F: 18, boostStatus: () => ({}) },
    "./logcache": { TSTAMP: /^$/, logSlice: () => "", logLoading: () => false },
    "./pgd": { rearmLogger: async () => { throw new Error("unexpected keypad action"); } },
    "./timeline": { recordIncident: async () => false, timelineSnapshot: async () => ({}) },
  });
  async function request(url, cookie = "") {
    const req = Object.assign(new PassThrough(), { url, method: "GET", headers: { cookie } });
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const res = { code: 0, headers: {}, body: "", headersSent: false,
      writeHead(code, headers = {}) { this.code = code; this.headers = headers; this.headersSent = true; },
      end(body) { this.body = body; finish(); } };
    const handling = routes.handle(req, res);
    req.end();
    await handling;
    await done;
    return res;
  }
  const opened = await request("/pgd/webpgd.htm");
  assert.equal(opened.code, 200);
  const oldCookie = opened.headers["set-cookie"][0].split(";")[0];
  selected = "192.168.6.91";
  trusted = false;
  assert.equal((await request("/pgd/pgd/pLanKey.cgi?keycode=13", oldCookie)).code, 403);
  assert.equal((await request("/pgd/pgd/pLanWeb.cgi?sessionid=1", oldCookie)).code, 409);
  assert.equal(upstream.length, 1);
  const reopened = await request("/pgd/webpgd.htm", oldCookie);
  assert.equal(reopened.code, 200);
  const newCookie = reopened.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(newCookie, oldCookie);
  assert.equal((await request("/pgd/pgd/pLanKey.cgi?keycode=13", newCookie)).code, 403);
  trusted = true;
  assert.equal((await request("/pgd/pgd/pLanKey.cgi?keycode=13", newCookie)).code, 200);
  assert.deepEqual(upstream.map((entry) => entry.host), ["192.168.6.90", "192.168.6.91", "192.168.6.91"]);
  // Restart/expiry can lose the server-side map while the browser retains its cookie.
  const restarted = await request("/pgd/webpgd.htm", "chiller_pgd=00000000-0000-0000-0000-000000000000");
  assert.equal(restarted.code, 200);
});
