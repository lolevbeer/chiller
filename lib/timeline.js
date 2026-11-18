// Durable, local incident timeline. This module deliberately has no startup side
// effect: the dashboard chooses when to begin sampling.
const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {{at: string, type: string, source: string, message: string,
 *   supplyF?: number | null, returnF?: number | null, setpointF?: number | null,
 *   previousSetpointF?: number | null, alarm?: string, active?: boolean}} Incident
 * @typedef {{at: string, supplyF: number | null, returnF: number | null,
 *   setpointF: number | null, status: number | null}} Sample
 * @typedef {{kind: string, at?: string, event?: Incident, records?: TimelineRecord[],
 *   activeAlarms?: string[], supplyF?: number | null, returnF?: number | null,
 *   setpointF?: number | null, status?: number | null}} TimelineRecord
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
let singleton = null;

const iso = (value) => {
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch { return null; }
};
/** @param {unknown} value @returns {number | null} */
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const day = (at) => iso(at)?.slice(0, 10);
const defaultFile = () => process.env.TIMELINE_FILE || path.join(__dirname, "..", "incident_timeline.jsonl");

/** @param {unknown} value @returns {number | null} */
function scaled(value) {
  if (!Number.isFinite(value)) return null;
  const raw = Number(value);
  return (raw > 32767 ? raw - 65536 : raw) / 10;
}

/** @param {unknown} event @param {unknown} fallbackAt @returns {Incident | null} */
function cleanEvent(event, fallbackAt = undefined) {
  if (!event || typeof event !== "object") return null;
  const value = /** @type {Record<string, unknown>} */ (event);
  if (typeof value.type !== "string" || typeof value.source !== "string" || typeof value.message !== "string") return null;
  const at = iso(value.at ?? fallbackAt);
  if (!at) return null;
  /** @type {Incident} */
  const out = { at, type: value.type, source: value.source, message: value.message };
  for (const key of ["supplyF", "returnF", "setpointF"]) out[key] = finite(value[key]);
  if (typeof value.alarm === "string") out.alarm = value.alarm;
  if (typeof value.active === "boolean") out.active = value.active;
  if (typeof value.previousSetpointF === "number") out.previousSetpointF = finite(value.previousSetpointF);
  return out;
}

/**
 * A restart-safe JSONL store.
 * @param {{file?: string, now?: () => Date}} [options]
 */
function createTimeline({ file, now = () => new Date() } = {}) {
  const timelineFile = file || defaultFile();
  const tmpFile = `${timelineFile}.tmp`;
  /** @type {Sample[]} */
  let samples = [];
  /** @type {Incident[]} */
  let events = [];
  /** @type {Set<string>} */
  let activeAlarms = new Set();
  let hasAlarmState = false;
  let lastSetpoint = null;
  let loaded = false;
  let loading = null;
  let writeChain = Promise.resolve();
  let error = null;
  let lastSampleAt = null;
  let compactDay = null;
  let loadFailed = false;
  const clock = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const fail = (where, err) => {
    error = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    console.error("timeline", error);
  };
  const cutoff = () => clock().getTime() - RETENTION_MS;
  const retain = () => {
    const after = cutoff();
    samples = samples.filter((item) => Date.parse(/** @type {string} */ (item.at)) >= after);
    events = events.filter((item) => Date.parse(/** @type {string} */ (item.at)) >= after);
    lastSampleAt = samples.at(-1)?.at ?? null;
  };
  const stateRecord = (alarms = activeAlarms) => ({ kind: "state", at: iso(clock()), activeAlarms: [...alarms] });
  const rebuild = (record) => {
    if (record.kind === "batch" && Array.isArray(record.records)) {
      for (const item of record.records) rebuild(item);
    } else if (record.kind === "sample" && record.at) {
      const at = iso(record.at);
      if (!at) return;
      const sample = { at, supplyF: finite(record.supplyF),
        returnF: finite(record.returnF), setpointF: finite(record.setpointF), status: finite(record.status) };
      samples.push(sample);
      lastSampleAt = sample.at;
      if (sample.setpointF !== null) lastSetpoint = sample.setpointF;
    } else if (record.kind === "event" && record.event) {
      const event = cleanEvent(record.event);
      if (event) events.push(event);
    } else if (record.kind === "state" && Array.isArray(record.activeAlarms)) {
      activeAlarms = new Set(record.activeAlarms.filter((name) => typeof name === "string"));
      hasAlarmState = true;
    }
  };
  const serialize = () => {
    /** @type {TimelineRecord[]} */
    const records = [
      ...samples.map((sample) => ({ kind: "sample", ...sample })),
      ...events.map((event) => ({ kind: "event", event })),
    ];
    if (hasAlarmState) records.push(stateRecord());
    return records.length ? `${JSON.stringify({ kind: "batch", records })}\n` : "";
  };

  const load = async () => {
    if (loaded) return true;
    if (loadFailed) return false;
    if (loading) return loading;
    loading = (async () => {
      let exists = false;
      try {
        const text = await fs.readFile(timelineFile, "utf8");
        exists = true;
        const lines = text.split("\n");
        const complete = lines.slice(0, -1);
        if (!text.endsWith("\n")) {
          try { JSON.parse(lines.at(-1)); complete.push(lines.at(-1)); } catch {
            await fs.truncate(timelineFile, Buffer.byteLength(complete.join("\n") + (complete.length ? "\n" : "")));
          }
        }
        for (const line of complete) {
          if (!line.trim()) continue;
          try { rebuild(JSON.parse(line)); } catch { fail("ignoring malformed timeline record", "invalid JSON"); }
        }
      } catch (err) {
        if ((/** @type {NodeJS.ErrnoException} */ (err))?.code !== "ENOENT") {
          fail("load", err);
          loadFailed = true;
          return false;
        }
      }
      retain();
      compactDay = day(clock());
      if (exists) await compact();
      loaded = true; // concurrent readers/writers must await startup compaction too
      return !loadFailed;
    })();
    return loading;
  };
  const compact = async () => {
    try {
      await fs.mkdir(path.dirname(timelineFile), { recursive: true });
      await fs.writeFile(tmpFile, serialize(), "utf8");
      await fs.rename(tmpFile, timelineFile);
      error = null;
      return true;
    } catch (err) { fail("compact", err); return false; }
  };
  const append = async (record) => {
    try {
      await fs.mkdir(path.dirname(timelineFile), { recursive: true });
      await fs.appendFile(timelineFile, `${JSON.stringify(record)}\n`, "utf8");
      error = null;
      return true;
    } catch (err) {
      fail("append", err);
      loadFailed = true; // a partial append must be repaired on reload before any more writes
      loaded = false;
      return false;
    }
  };
  const enqueue = (work) => {
    const result = writeChain.then(work, work);
    writeChain = result.then(() => undefined, () => undefined);
    return result;
  };
  const maybeCompact = async () => {
    const today = day(clock());
    if (today !== compactDay) { compactDay = today; return compact(); }
    return true;
  };

  const record = async (event) => {
    const clean = cleanEvent(event, clock());
    if (!clean) return false;
    return enqueue(async () => {
      if (!await load()) return false;
      retain();
      const ok = await append({ kind: "batch", records: [{ kind: "event", event: clean }] });
      if (ok) {
        events.push(clean);
        await maybeCompact();
      }
      return ok;
    });
  };
  const sample = async ({ regs, alarms }, at = clock()) => enqueue(async () => {
    if (!await load()) return false;
    const timestamp = iso(at);
    if (!timestamp) return false;
    const entry = { at: timestamp, supplyF: null, returnF: null, setpointF: null, status: null };
    if (regs && typeof regs === "object") {
      entry.supplyF = scaled(regs[68]);
      entry.returnF = scaled(regs[69]);
      entry.setpointF = scaled(regs[70]);
      entry.status = finite(regs[0]);
    }
    /** @type {TimelineRecord[]} */
    const records = [{ kind: "sample", ...entry }];
    /** @type {Incident[]} */
    const incidentEvents = [];
    const previousSetpoint = lastSetpoint;
    const previousAlarms = activeAlarms;
    const previousAlarmState = hasAlarmState;
    let nextAlarms = activeAlarms;
    if (entry.setpointF !== null && previousSetpoint !== null && entry.setpointF !== previousSetpoint) {
      incidentEvents.push(cleanEvent({ at: entry.at, type: "setpoint", source: "controller",
        message: `Setpoint changed from ${previousSetpoint.toFixed(1)}°F to ${entry.setpointF.toFixed(1)}°F`,
        previousSetpointF: previousSetpoint, setpointF: entry.setpointF,
        supplyF: entry.supplyF, returnF: entry.returnF }));
    }
    if (alarms && Array.isArray(alarms.active)) {
      const current = new Set(alarms.active.map((alarm) => alarm?.name).filter((name) => typeof name === "string"));
      for (const name of current) if (!previousAlarms.has(name)) {
        incidentEvents.push(cleanEvent({ at: entry.at, type: "alarm", source: "controller",
          message: `${previousAlarmState ? "Alarm active" : "Observed active"}: ${name}`,
          alarm: name, active: true, supplyF: entry.supplyF, returnF: entry.returnF, setpointF: entry.setpointF }));
      }
      for (const name of previousAlarms) if (!current.has(name)) {
        incidentEvents.push(cleanEvent({ at: entry.at, type: "alarm", source: "controller",
          message: `Alarm cleared: ${name}`, alarm: name, active: false,
          supplyF: entry.supplyF, returnF: entry.returnF, setpointF: entry.setpointF }));
      }
      nextAlarms = current;
      records.push(stateRecord(current));
    }
    records.push(...incidentEvents.filter(Boolean).map((event) => ({ kind: "event", event })));
    retain();
    const ok = await append({ kind: "batch", records });
    if (ok) {
      samples.push(entry);
      events.push(...incidentEvents.filter(Boolean));
      lastSampleAt = entry.at;
      if (entry.setpointF !== null) lastSetpoint = entry.setpointF;
      if (alarms && Array.isArray(alarms.active)) {
        activeAlarms = nextAlarms;
        hasAlarmState = true;
      }
      await maybeCompact();
    }
    return ok;
  });
  const snapshot = async (hours = 6) => {
    await load();
    const after = clock().getTime() - Number(hours) * 60 * 60 * 1000;
    const matchingSamples = samples.filter((item) => Date.parse(item.at) >= after)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const matchingEvents = events.filter((item) => Date.parse(/** @type {string} */ (item.at)) >= after)
      .sort((a, b) => Date.parse(/** @type {string} */ (b.at)) - Date.parse(/** @type {string} */ (a.at)));
    return { samples: matchingSamples, events: matchingEvents.slice(0, 200), truncated: matchingEvents.length > 200,
      status: { recording: false, lastSampleAt, error } };
  };
  return { record, sample, snapshot };
}

function startTimeline() {
  if (singleton?.started) return singleton;
  const store = singleton?.store || createTimeline({ file: defaultFile() });
  singleton = { store, started: true };
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      // Lazy imports prevent the recorder from introducing a module cycle or any
      // hardware/config work merely by being required.
      const [{ read }, { readAlarms }] = [require("./modbus"), require("./alarms")];
      const [regs, alarms] = await Promise.all([read(), readAlarms()]);
      await store.sample({ regs, alarms });
    } catch (err) { console.error("timeline poll:", err instanceof Error ? err.message : err); }
    finally { polling = false; setTimeout(poll, 60000).unref(); }
  };
  // Loading/compaction is ordered ahead of the first write but never holds up startup.
  store.snapshot(6).catch(() => {});
  setTimeout(poll, 0).unref();
  return singleton;
}

async function recordIncident(event) {
  try { return singleton?.started ? await singleton.store.record(event) : false; }
  catch (err) {
    console.error("timeline incident:", err instanceof Error ? err.message : err);
    return false;
  }
}
async function timelineSnapshot(hours = 6) {
  if (!singleton) singleton = { store: createTimeline({ file: defaultFile() }), started: false };
  const snapshot = await singleton.store.snapshot(hours);
  snapshot.status.recording = singleton.started;
  return snapshot;
}

module.exports = { startTimeline, recordIncident, timelineSnapshot, createTimeline };
