// Shared human-facing date/time rendering for both Node and the dashboard.
//
// Display convention:
//   moment         Jul 13, 2026 at 4:56 AM
//   same-day range Jul 13, 2026 · 4:56–10:54 AM
//   cross-day      Jul 12, 2026 at 11:00 PM → Jul 13, 2026 at 1:00 AM
//   duration       6 hr 55 min (at most two units by default)
//
// Controller timestamps need special handling: many claim +00:00 even though
// their fields are site-local wall time. We therefore preserve the clock fields
// exactly for display. A real offset, when present, is used only to calculate
// elapsed time. Machine-facing API/CSV formats deliberately live elsewhere.
(function initDateTime(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChillerDateTime = api;
})(typeof globalThis === "object" ? globalThis : this, function dateTimeFactory() {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad2 = (n) => String(n).padStart(2, "0");

  /** @param {number} hour @param {string | number} minute @param {string | number} second @param {boolean} withSeconds */
  function clockParts(hour, minute, second, withSeconds) {
    const h = hour % 12 || 12;
    return `${h}:${pad2(minute)}${withSeconds ? `:${pad2(second)}` : ""} ${hour < 12 ? "AM" : "PM"}`;
  }

  /** Parse an ISO-like controller timestamp without converting its displayed wall clock. @param {unknown} value */
  function parse(value) {
    const source = String(value ?? "").trim();
    const match = source.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!match) return null;
    const [, y, month, day, hour, minute, second = "00", zone = ""] = match;
    const parts = [y, month, day, hour, minute, second].map(Number);
    const wall = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (wall.getUTCFullYear() !== parts[0] || wall.getUTCMonth() !== parts[1] - 1 ||
        wall.getUTCDate() !== parts[2] || wall.getUTCHours() !== parts[3] ||
        wall.getUTCMinutes() !== parts[4] || wall.getUTCSeconds() !== parts[5]) return null;
    const normalizedZone = zone && zone !== "Z" && !zone.includes(":")
      ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
    const epoch = zone ? Date.parse(`${y}-${month}-${day}T${hour}:${minute}:${second}${normalizedZone}`)
      : wall.getTime();
    if (!Number.isFinite(epoch)) return null;
    return {
      epoch,
      dateKey: `${y}-${month}-${day}`,
      date: `${MONTHS[parts[1] - 1]} ${parts[2]}, ${parts[0]}`,
      clock: clockParts(parts[3], minute, second, false),
    };
  }

  /** @param {unknown} value */
  function moment(value) {
    const parsed = parse(value);
    return parsed ? `${parsed.date} at ${parsed.clock}` : String(value ?? "");
  }

  /** @param {unknown} startValue @param {unknown} stopValue */
  function range(startValue, stopValue) {
    const start = parse(startValue), stop = parse(stopValue);
    if (!start || !stop) return `${String(startValue ?? "")} → ${String(stopValue ?? "")}`;
    if (start.dateKey !== stop.dateKey) {
      return `${start.date} at ${start.clock} → ${stop.date} at ${stop.clock}`;
    }
    if (start.clock === stop.clock) return `${start.date} at ${start.clock}`;
    const [startTime, startPeriod] = start.clock.split(" ");
    const [stopTime, stopPeriod] = stop.clock.split(" ");
    const clocks = startPeriod === stopPeriod
      ? `${startTime}–${stopTime} ${startPeriod}` : `${start.clock}–${stop.clock}`;
    return `${start.date} · ${clocks}`;
  }

  /** @param {unknown} startValue @param {unknown} stopValue @returns {number | null} */
  function elapsed(startValue, stopValue) {
    const start = parse(startValue), stop = parse(stopValue);
    if (!start || !stop || stop.epoch < start.epoch) return null;
    return stop.epoch - start.epoch;
  }

  /** @param {number} ms @param {number} [maxParts] @returns {string | null} */
  function duration(ms, maxParts = 2) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    let seconds = Math.round(ms / 1000);
    if (seconds === 0) return "0 sec";
    /** @type {Array<[number, string]>} */
    const units = [[86400, "day"], [3600, "hr"], [60, "min"], [1, "sec"]];
    const parts = [];
    for (const [size, label] of units) {
      const n = Math.floor(seconds / size);
      if (!n) continue;
      parts.push(`${n} ${label}${label === "day" && n !== 1 ? "s" : ""}`);
      seconds %= size;
      if (parts.length >= Math.max(1, maxParts)) break;
    }
    return parts.join(" ");
  }

  /** Format a real Date in its local timezone. @param {Date | number} value @param {boolean} [withSeconds] */
  function clock(value, withSeconds = false) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime())
      ? clockParts(date.getHours(), date.getMinutes(), date.getSeconds(), withSeconds) : "—";
  }

  return { parse, moment, range, elapsed, duration, clock };
});
