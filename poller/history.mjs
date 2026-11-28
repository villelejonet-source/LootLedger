// History storage and what the game reads from it.
//
// Stored per auction house (history/<house>.json.gz):
//   days:   { "YYYY-MM-DD": { [itemId]: [sum of hourly market, hours, lowest min, sum of hourly qty,
//                                         sum of log(hourly market), hours in that sum] } }
//           kept for KEEP_DAYS; older days are folded into...
//   months: { "YYYY-MM": { [itemId]: [sum of daily market, days] } }
//           kept forever (small: one entry per item per month)
//
// For the game: per-item series, a compact per-item history string (hist) and
// the labels for its series.
import { analyze, baseline, median, weekKey, monthKey, dayKey } from "./analysis.mjs";
import { luaEscape, toId } from "./feed.mjs";

export const HIST_OUT_DAYS = 30; // daily points sent to the game per item
export const KEEP_DAYS = 120;    // daily detail kept; older days live on as monthly averages

// History is read back from the history branch, and what is in it ends up in
// Prices.lua, which runs as code in every player's game. So keep only what has the
// expected shape: day keys YYYY-MM-DD and month keys YYYY-MM that are real dates,
// whole-number item IDs, and rows of real numbers (null where an older poller left
// one out). Anything else is dropped instead of being passed on.
const isKey = (re) => (k) => re.test(k) && Number.isFinite(Date.parse(k));
const isDay = isKey(/^\d{4}-\d{2}-\d{2}$/), isMonth = isKey(/^\d{4}-\d{2}$/);
const isRow = (e) => Array.isArray(e) && e.every((x) => x === null || Number.isFinite(x));
const isObject = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const keep = (obj, ok) => Object.fromEntries(Object.entries(isObject(obj) ? obj : {}).filter(([k, v]) => ok(k, v)));
const items = (obj) => keep(obj, (id, e) => toId(id) && isRow(e));
const byKey = (obj, isK, clean) => Object.fromEntries(Object.entries(keep(obj, isK)).map(([k, v]) => [k, clean(v)]));

export function cleanHistory(h) {
  if (!isObject(h)) h = {};
  h.days = byKey(h.days, isDay, items);
  h.months = byKey(h.months, isMonth, items);
  // Fields older history files don't have yet stay missing (the feed fills them in).
  if (h.sales !== undefined) h.sales = byKey(h.sales, isDay, items);
  if (h.salesHours !== undefined) h.salesHours = keep(h.salesHours, (k, v) => isDay(k) && Number.isFinite(v));
  if (h.hours !== undefined) {
    h.hours = (Array.isArray(h.hours) ? h.hours : [])
      .filter((x) => isObject(x) && Number.isFinite(x.t) && (x.h === undefined || Number.isFinite(x.h)))
      .map((x) => ({ ...x, s: items(x.s), q: items(x.q) }));
  }
  if (h.index !== undefined) {
    h.index = (Array.isArray(h.index) ? h.index : [])
      .filter((x) => isObject(x) && Number.isFinite(x.t) && Number.isFinite(x.v) && (x.g === undefined || Number.isFinite(x.g)));
  }
  return h;
}

// Add one hourly snapshot ({ [id]: { market, min, qty } }) to today's entry.
export function addSnapshot(history, items, now) {
  const today = dayKey(now);
  const day = (history.days[today] ??= {});
  for (const [id, s] of Object.entries(items)) {
    const e = (day[id] ??= [0, 0, s.min, 0, 0, 0]);
    e[0] += s.market;
    e[1] += 1;
    e[2] = Math.min(e[2], s.min);
    e[3] = (e[3] ?? 0) + s.qty;
    // A day begun before log sums were kept has none (dayMarket). 4 decimals are
    // plenty (0.01% of a price) and keep the file small.
    if (e[4] != null) {
      e[4] = Math.round((e[4] + Math.log(Math.max(1, s.market))) * 1e4) / 1e4;
      e[5] += 1;
    }
  }
}

// A day's market: the geometric mean of its hourly markets, so a brief spike
// can't inflate it ("normal" would then make ordinary prices look like dips).
// A day without logs for every hour (stored before they were kept, or partly by
// an older poller): its arithmetic mean times `ratio` (see geoRatio).
export function dayMarket(e, ratio = 1) {
  return e[5] === e[1] ? Math.exp(e[4] / e[5]) : ratio * e[0] / e[1];
}

// An item's median geometric / arithmetic day ratio over its days with logs, 1 if
// none. Scales its older days onto the same footing: the switch alone would
// otherwise read as a price drop (and a "falling" trend).
export function geoRatio(history, id) {
  const r = [];
  for (const day of Object.values(history.days)) {
    const e = day[id];
    if (e && e[1] > 0 && e[5] === e[1] && e[0] > 0) r.push(Math.exp(e[4] / e[5]) / (e[0] / e[1]));
  }
  return r.length ? median(r) : 1;
}

// Each item's median market over the last 3 hourly snapshots (history.hours, no
// more than 4 hours apart): a steadier "price now" than one snapshot, as a fifth
// of hourly moves are 5%+ and highs fade within hours. { [itemId]: copper }
export function recentMedians(hours) {
  const last = [];
  for (let i = hours.length - 1; i >= 0 && last.length < 3; i--) {
    if (!last.some((h) => h.t === hours[i].t)) last.push(hours[i]);  // the same snapshot twice: once
  }
  const out = {};
  if (last.length < 3 || last[0].t - last[2].t > 4 * 3600e3) return out;
  for (const id of Object.keys(last[0].q)) {
    const v = last.map((h) => h.q[id]?.[1]);
    if (v.every((x) => Number.isFinite(x) && x > 0)) out[id] = median(v);
  }
  return out;
}

// Fold days older than KEEP_DAYS into monthly averages, then drop them.
export function archiveOldDays(history, now, keepDays = KEEP_DAYS) {
  history.months ??= {};
  const oldest = dayKey(now - keepDays * 86400e3);
  const ratios = new Map();
  const ratio = (id) => ratios.get(id) ?? ratios.set(id, geoRatio(history, id)).get(id);
  for (const key of Object.keys(history.days)) {
    if (key >= oldest) continue;
    const month = (history.months[monthKey(key)] ??= {});
    for (const [id, e] of Object.entries(history.days[key])) {
      if (!(e[1] > 0)) continue;
      const m = (month[id] ??= [0, 0]);
      m[0] += dayMarket(e, ratio(id));
      m[1] += 1;
    }
    delete history.days[key];
  }
}

// The last 12 months that have any data (archived or in the daily window), oldest first.
export function monthKeys(history, days) {
  return [...new Set([...Object.keys(history.months ?? {}).filter(isMonth), ...days.map(monthKey)])].sort().slice(-12);
}

// One item's monthly averages for the given months, combining archive and daily window.
export function monthlyFor(history, days, id, keys) {
  const acc = {}, ratio = geoRatio(history, id);
  for (const [m, items] of Object.entries(history.months ?? {})) {
    const e = items[id];
    if (e) acc[m] = [e[0], e[1]];
  }
  for (const key of days) {
    const e = history.days[key]?.[id];
    if (e && e[1] > 0) {
      const a = (acc[monthKey(key)] ??= [0, 0]);
      a[0] += dayMarket(e, ratio);
      a[1] += 1;
    }
  }
  return keys.map((m) => (acc[m] && acc[m][1] ? acc[m][0] / acc[m][1] : null));
}

// Every day from the first day in history to today, oldest first.
export function allDays(history, now) {
  const keys = Object.keys(history.days).sort();
  const out = [];
  if (!keys.length) return out;
  for (let t = Date.parse(keys[0] + "T12:00:00Z"); dayKey(t) <= dayKey(now); t += 86400e3) out.push(dayKey(t));
  return out;
}

// One item's daily series: [{ key, market, qty }] with nulls on days without listings.
export function seriesFor(history, days, id) {
  const ratio = geoRatio(history, id);
  return days.map((key) => {
    const e = history.days[key]?.[id];
    const ok = e && e[1] > 0;
    return { key, market: ok ? dayMarket(e, ratio) : null, qty: ok && e[3] != null ? e[3] / e[1] : null };
  });
}

// Average of the last n days with data (including today), 0 if none.
export function average(series, n) {
  const v = series.slice(-n).map((d) => d.market).filter((x) => x != null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : 0;
}

export const b36 = (v) => (v == null || !Number.isFinite(v) ? "" : Math.round(v).toString(36));
export const int = (v) => (v == null || !Number.isFinite(v) ? "" : String(Math.round(v)));

// Compact per-item history for the game (numbers in base 36 to keep the file small):
//   d=<last 30 daily markets>;w=<12 weekly>;m=<12 monthly>
//   p=<Mon..Sun deviation in permille>,<weeks>,<consistency %>,<reliable 0/1>
//   t=<trend permille/day>,<baseline>,<volatility permille>,<usual quantity listed>
export function encodeHistory(series, monthly) {
  const a = analyze(series);
  const p = a.profile;
  const qtyUsual = baseline(series.slice(0, -1).map((d) => d.qty));
  return [
    "d=" + series.slice(-HIST_OUT_DAYS).map((d) => b36(d.market)).join(","),
    "w=" + a.weekly.values.map(b36).join(","),
    "m=" + (monthly ?? a.monthly.values).map(b36).join(","),
    "p=" + [...p.pct.map((x) => (x == null ? "" : int(x * 1000))), p.weeks, int(p.consistency * 100), p.reliable ? 1 : 0].join(","),
    "t=" + [int(a.trend == null ? null : a.trend * 1000), b36(a.baseline), int(a.volatility == null ? null : a.volatility * 1000), b36(qtyUsual)].join(","),
  ].join(";");
}

// Labels for the series above, shared by every item in a house.
export function labels(days, months) {
  const uniq = (xs) => [...new Set(xs)];
  const q = (xs) => xs.map((x) => `"${luaEscape(x)}"`).join(",");
  return `dayLabels = { ${q(days.slice(-HIST_OUT_DAYS))} }, weekLabels = { ${q(uniq(days.map(weekKey)).slice(-12))} }, monthLabels = { ${q(months ?? uniq(days.map(monthKey)).slice(-12))} }`;
}
