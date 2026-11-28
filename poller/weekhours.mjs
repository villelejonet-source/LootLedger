// Time of week: is the whole auction house dearer at some hours of the week
// (say Friday evening) and cheaper at others?
//
// Every hour records one number per house, the market index: the median over
// liquid items of how far each item's price is from its own average of the
// previous days. 0 = a normal hour, +0.08 = items list about 8% above their
// average. Kept for INDEX_DAYS in history.index as [{ t, v, g }]
// (t = snapshot time, v = index, g = copper bought per hour, when known).
//
// From that, a profile over the 168 hours of the week (UTC, Monday 00:00 = 0),
// measured like the weekday pattern in analysis.mjs: each hour against the
// centered 7-day average around it, so a market that rises or falls all week
// can't look like a time-of-week effect. Recent weeks weigh more.

import { dayKey } from "./analysis.mjs";
import { dayMarket, geoRatio } from "./history.mjs";

const HOUR = 3600e3, DAY = 24 * HOUR, WEEK = 7 * DAY;

export const SETTINGS = {
  minListed: 20,        // an item counts toward the index with 20+ units listed...
  refDays: 7,           // ...against its average over up to 7 previous days
  minItems: 30,         // no index from fewer than 30 items
  keepDays: 70,         // ten weeks of hourly index
  halfLife: 14,         // days: recent weeks count more
  windowCover: 0.7,     // the 7-day average around an hour needs 70% of its hours
  minHours: 150,        // the profile needs 150 of the 168 hours of the week seen...
  minWeeks: 2,          // ...most of them in 2+ different weeks
  minConsistency: 0.66, // the best 3 hours beat the worst 3 hours in 2 of 3 weeks
  minSpread: 0.03,      // ignore differences under 3%
  sigK: 5,              // and the gap must clearly exceed hour-to-hour noise (about 1% false
                        // alarms on random prices that drift hour to hour like real ones)
};

// 0 = Monday 00:00-00:59 UTC ... 167 = Sunday 23:00-23:59 UTC
export function hourOfWeek(t) {
  const d = new Date(t);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

// The market index for one snapshot ({ [id]: { market, qty } }), or null.
export function marketIndex(history, items, t, S = SETTINGS) {
  const today = dayKey(t);
  const keys = Object.keys(history.days ?? {}).filter((k) => k < today).sort().slice(-S.refDays);
  if (!keys.length) return null;
  const devs = [];
  for (const [id, s] of Object.entries(items)) {
    if (!(s.qty >= S.minListed && s.market > 0)) continue;
    let sum = 0, n = 0, ratio;
    for (const k of keys) {
      const e = history.days[k]?.[id];
      if (e && e[1] > 0 && e[0] > 0) { sum += Math.log(dayMarket(e, (ratio ??= geoRatio(history, id)))); n++; }
    }
    if (n) devs.push(Math.log(s.market) - sum / n);
  }
  if (devs.length < S.minItems) return null;
  devs.sort((a, b) => a - b);
  const m = devs.length >> 1;
  return devs.length % 2 ? devs[m] : (devs[m - 1] + devs[m]) / 2;
}

// Add this hour's index (skipped if this snapshot is already recorded).
export function recordIndex(history, t, v, gold, S = SETTINGS) {
  history.index ??= [];
  const last = history.index[history.index.length - 1];
  if (v == null || (last && last.t >= t)) return;
  const e = { t, v: Math.round(v * 10000) / 10000 };
  if (gold != null) e.g = Math.round(gold);
  history.index.push(e);
  history.index = history.index.filter((x) => x.t > t - S.keepDays * DAY);
}

// Build the index from the hourly records already kept (history.hours, the last
// ~30 hours: { t, q: { id: [qtyListed, market] }, s: { id: [units, auctions, gold] }, diff, h }).
export function backfillIndex(history, S = SETTINGS) {
  history.index ??= [];
  for (const h of [...(history.hours ?? [])].sort((a, b) => a.t - b.t)) {
    if (!h.q) continue;
    const items = {};
    for (const [id, q] of Object.entries(h.q)) items[id] = { qty: q[0], market: q[1] };
    const gold = h.diff && h.h > 0 ? Object.values(h.s ?? {}).reduce((a, e) => a + e[2], 0) / h.h : null;
    recordIndex(history, h.t, marketIndex(history, items, h.t, S), gold, S);
  }
}

// { pct: [168] smoothed (3-hour) fractions vs the week (null = unseen), weeks,
//   best, worst (hour of week at the centre of the best / worst 3 hours),
//   spread, consistency, reliable, since (first recorded time) }
export function hourProfile(index, S = SETTINGS) {
  const pts = (index ?? []).filter((x) => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  const out = { pct: Array(168).fill(null), weeks: 0, best: -1, worst: -1, spread: 0, consistency: 0, reliable: false, since: pts[0]?.t ?? null };
  if (!pts.length) return out;
  const newest = pts[pts.length - 1].t;

  // Each hour against the centered 7-day average around it.
  const prefix = [0];
  for (const p of pts) prefix.push(prefix[prefix.length - 1] + p.v);
  // Weeks count from the first hour that has a full week around it, so each
  // "week" holds every hour of the week once, whatever day the data started.
  const dev = []; // { b, week, r, w }
  let first = null;
  let lo = 0, hi = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = pts[i].t;
    while (pts[lo].t < t - WEEK / 2) lo++;
    while (hi < pts.length && pts[hi].t <= t + WEEK / 2) hi++;
    if (t - WEEK / 2 < pts[0].t || t + WEEK / 2 > newest) continue; // no full week around it yet
    const n = hi - lo;
    if (n < S.windowCover * 168) continue;
    const r = pts[i].v - (prefix[hi] - prefix[lo]) / n;
    first ??= t;
    dev.push({ b: hourOfWeek(t), week: Math.floor((t - first) / WEEK), r, w: Math.pow(0.5, (newest - t) / DAY / S.halfLife) });
  }

  const sums = Array(168).fill(0), wts = Array(168).fill(0), seen = Array.from({ length: 168 }, () => new Set());
  for (const d of dev) { sums[d.b] += d.r * d.w; wts[d.b] += d.w; seen[d.b].add(d.week); }
  const raw = sums.map((s, b) => (wts[b] ? s / wts[b] : null));
  const known = raw.filter((x) => x != null);
  if (!known.length) return out;
  const mean = known.reduce((s, x) => s + x, 0) / known.length;
  // 3-hour smoothing around each hour (wrapping round the week)
  const smooth = raw.map((_, b) => {
    const xs = [raw[(b + 167) % 168], raw[b], raw[(b + 1) % 168]].filter((x) => x != null);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length - mean : null;
  });
  out.pct = smooth.map((x) => (x == null ? null : Math.exp(x) - 1));
  // Weeks of data: what 3 in 4 of the hours seen have (a few missed runs don't reset it).
  const sizes = seen.filter((x) => x.size).map((x) => x.size).sort((x, y) => x - y);
  out.weeks = sizes[Math.floor(sizes.length * 0.25)];

  smooth.forEach((x, b) => {
    if (x == null) return;
    if (out.best < 0 || x > smooth[out.best]) out.best = b;
    if (out.worst < 0 || x < smooth[out.worst]) out.worst = b;
  });
  out.spread = Math.exp(smooth[out.best] - smooth[out.worst]) - 1;

  // Week by week: did the best 3 hours beat the worst 3 hours?
  const near = (b, c) => Math.min((b - c + 168) % 168, (c - b + 168) % 168) <= 1;
  const byWeek = new Map();
  for (const d of dev) {
    const side = near(d.b, out.best) ? "hi" : near(d.b, out.worst) ? "lo" : null;
    if (!side) continue;
    const e = byWeek.get(d.week) ?? { hi: [], lo: [] };
    e[side].push(d.r);
    byWeek.set(d.week, e);
  }
  let wins = 0, total = 0;
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  for (const e of byWeek.values()) if (e.hi.length && e.lo.length) { total++; if (avg(e.hi) > avg(e.lo)) wins++; }
  out.consistency = total ? wins / total : 0;

  // Is the gap bigger than ordinary hour-to-hour noise?
  let ss = 0, cnt = 0;
  for (const d of dev) if (raw[d.b] != null) { ss += (d.r - raw[d.b]) ** 2; cnt++; }
  const noise = cnt > 168 ? Math.sqrt(ss / (cnt - known.length)) : Infinity;
  const gap = smooth[out.best] - smooth[out.worst];
  // Counted per hour, not per 3 hours: neighbouring hours move together, and the
  // best and worst are the extremes of 168 hours, so this is kept strict.
  const significant = gap > S.sigK * noise * Math.sqrt(2 / Math.max(1, out.weeks));

  out.reliable = known.length >= S.minHours && out.weeks >= S.minWeeks && total >= S.minWeeks &&
    out.consistency >= S.minConsistency && out.spread >= S.minSpread && significant;
  return out;
}

// For Prices.lua: "<168 permille values>;<weeks>;<reliable 0/1>;<since, unix seconds>"
export function encodeWeekHours(p) {
  return [
    p.pct.map((x) => (x == null ? "" : String(Math.round(x * 1000)))).join(","),
    p.weeks,
    p.reliable ? 1 : 0,
    p.since == null ? "" : Math.floor(p.since / 1000),
  ].join(";");
}
