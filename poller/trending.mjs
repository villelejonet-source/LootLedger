// "Trending right now": which items are selling unusually fast, getting pricier,
// drying up or cooling off on one auction house, with guardrails so that odd
// cases don't make the lists (grey junk, one person sweeping a page, sellers
// reposting, tiny markets, one weird hour).
//
// Input: history.hours (last ~30 hourly records), history.sales (daily totals),
// history.salesHours (hours of data per day), and the current items { id: { market, qty } }.

import { baseline } from "./analysis.mjs";
import { int } from "./history.mjs";
import { toId } from "./feed.mjs";

const HOUR = 3600e3;
const GOLD = 10000; // copper

export const TREND = {
  minHoursOfData: 12,        // need at least 12 hours covered by comparisons in the last 24 hours
  minBaselineDays: 2,        // ...and 2 complete earlier days to know what "normal" is
  completeDayHours: 18,      // a day counts as complete with 18+ hours of data
  baselineDays: 7,           // "normal" = recent-weighted average of the last 7 complete days

  minGold24: 20 * GOLD,      // at least 20g changed hands in the last 24 hours
  minNormalUnits: 5,         // the item normally sells 5+ a day
  minAuctions24: 8,          // bought across 8+ separate auctions (not one buyer, one page)
  minHoursActive: 4,         // bought in 4+ different hours of the day
  maxHourShare: 0.6,         // no single hour may hold 60%+ of the day's purchases (bulk buyout)
  persistHours: 2,           // still selling above normal in 2 of the last 3 hours

  hotRatio: 1.8,             // selling fast: 1.8x the normal daily amount
  climbPct: 0.15,            // price climbing: +15% in 24 hours...
  minListed: 20,             // ...with 20+ units listed (no 2-item price spikes)
  dryRatio: 0.6,             // drying up: listings down to 60% or less of 24h ago, with demand
  coolRatio: 0.5,            // cooling off: selling at half the normal rate or less...
  coolMinNormalGold: 40 * GOLD, // ...of an item that normally moves 40g+ a day

  topN: 50,                  // entries per list
};

function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }

// Per-item numbers the lists are built from.
export function itemStats(history, items, now, S = TREND) {
  const hours = (history.hours ?? []).filter((h) => h.t > now - 24 * HOUR - 5 * 60e3);
  const diffHours = hours.filter((h) => h.diff);
  // Hours of trading the diffs cover (a diff after an outage spans several hours).
  const coverage = Math.round(diffHours.reduce((a, h) => a + (h.h ?? 1), 0) * 100) / 100;
  const oldest = hours[0];

  // Complete days before the 24h window, newest last
  const windowStart = dayKey(now - 24 * HOUR);
  const days = Object.keys(history.sales ?? {})
    .filter((d) => d < windowStart && (history.salesHours?.[d] ?? 0) >= S.completeDayHours)
    .sort()
    .slice(-S.baselineDays);

  const ids = new Set(Object.keys(items));
  // Only whole-number IDs: they go into Prices.lua as table keys.
  for (const h of hours) for (const id of Object.keys(h.s)) if (toId(id)) ids.add(id);

  const stats = new Map();
  for (const id of ids) {
    let units = 0, auctions = 0, gold = 0, active = 0, maxHour = 0;
    for (const h of diffHours) {
      const v = h.s[id];
      if (!v) continue;
      units += v[0]; auctions += v[1]; gold += v[2];
      active += 1;
      maxHour = Math.max(maxHour, v[0]);
    }
    // Scale to a full day by the hours the diffs cover
    const scale = coverage > 0 ? 24 / coverage : 0;
    // Each baseline day scaled to 24 hours by the hours its diffs cover, like sold24
    const normalSeries = days.map((d) => ((history.sales[d]?.[id]?.[0] ?? 0) * 24) / history.salesHours[d]);
    const normal = days.length >= S.minBaselineDays ? baseline(normalSeries, 3) : null;

    const it = items[id];
    const market = it?.market ?? null;
    const old = oldest?.q?.[id];
    const recent = diffHours.slice(-3).filter((h) => (h.s[id]?.[0] ?? 0) >= Math.max(1, ((normal ?? 0) / 24) * 1.5)).length;
    stats.set(id, {
      id: Number(id),
      sold24: Math.round(units * scale),
      auctions24: auctions,
      gold24: Math.round(gold * scale),
      hoursActive: active,
      maxHourShare: units > 0 ? maxHour / units : 0,
      recentActive: recent,
      normal,
      baselineDays: days.length,
      market,
      marketThen: old ? old[1] : null,
      qty: it?.qty ?? 0,
      qtyThen: old ? old[0] : null,
    });
  }
  return { stats, coverage, baselineDays: days.length };
}

function confidence(s, S) {
  const strongData = s.baselineDays >= 5;
  const wellAbove = s.auctions24 >= 2 * S.minAuctions24 && s.hoursActive >= 2 * S.minHoursActive;
  if (strongData && wellAbove) return 2;
  if (s.baselineDays >= 3) return 1;
  return 0;
}

// The four lists. Each entry: the item's stats plus `score` and `conf` (0 early, 1 moderate, 2 strong).
export function trendingLists(history, items, now, S = TREND) {
  const { stats, coverage, baselineDays } = itemStats(history, items, now, S);
  const lists = { hot: [], climbing: [], drying: [], cooling: [] };
  if (coverage < S.minHoursOfData || baselineDays < S.minBaselineDays) {
    return { lists, stats, coverage, baselineDays, ready: false, readyAt: readyAt(history, now, S) };
  }

  for (const s of stats.values()) {
    if (s.normal == null || s.normal < S.minNormalUnits || !s.market) continue;
    const spreadOk = s.auctions24 >= S.minAuctions24 && s.hoursActive >= S.minHoursActive && s.maxHourShare < S.maxHourShare;
    const conf = confidence(s, S);
    const priceChange = s.marketThen ? s.market / s.marketThen - 1 : null;
    const supplyChange = s.qtyThen ? s.qty / s.qtyThen - 1 : null;
    const e = { ...s, priceChange, supplyChange, conf };

    // Selling fast: well above normal, real money, many separate buys, spread out, still going.
    if (s.sold24 >= S.hotRatio * s.normal && s.gold24 >= S.minGold24 && spreadOk && s.recentActive >= S.persistHours) {
      lists.hot.push({ ...e, score: (s.sold24 - s.normal) * s.market });
    }
    // Price climbing: a real rise with real volume behind it.
    if (priceChange != null && priceChange >= S.climbPct && s.qty >= S.minListed && s.gold24 >= S.minGold24 && spreadOk) {
      lists.climbing.push({ ...e, score: priceChange * s.gold24 });
    }
    // Drying up: listings shrinking while people keep buying.
    if (supplyChange != null && s.qty <= S.dryRatio * s.qtyThen && s.sold24 >= s.normal && s.gold24 >= S.minGold24 && spreadOk) {
      lists.drying.push({ ...e, score: -supplyChange * s.gold24 });
    }
    // Cooling off: an item with a real market that suddenly sells much less.
    if (s.sold24 <= S.coolRatio * s.normal && s.normal * s.market >= S.coolMinNormalGold) {
      lists.cooling.push({ ...e, score: (s.normal - s.sold24) * s.market });
    }
  }
  for (const k of Object.keys(lists)) lists[k] = lists[k].sort((a, b) => b.score - a.score).slice(0, S.topN);
  return { lists, stats, coverage, baselineDays, ready: true };
}

// When the lists should first be ready (ms), if hourly data keeps coming: the
// minBaselineDays-th complete day (18+ hours) counts once it is wholly before the
// last 24 hours, i.e. from midnight UTC two days after it. Today counts if it can
// still reach completeDayHours by midnight.
export function readyAt(history, now, S = TREND) {
  const hours = history.salesHours ?? {};
  const today = dayKey(now);
  const midnight = (key) => Date.parse(key + "T00:00:00Z");
  const days = Object.keys(hours).filter((d) => d < today && hours[d] >= S.completeDayHours).sort();
  const todayCan = (hours[today] ?? 0) + (midnight(today) + 24 * HOUR - now) / HOUR;
  if (todayCan >= S.completeDayHours) days.push(today);
  for (let t = midnight(today) + 24 * HOUR; days.length < S.minBaselineDays; t += 24 * HOUR) days.push(dayKey(t));
  return Math.max(now, midnight(days[S.minBaselineDays - 1]) + 48 * HOUR);
}

// Compact form for the game: "id,sold24,auctions24,normal,pricePermille,supplyPermille,hoursActive,conf"
// Every field is made a whole number here: the entry is written into Prices.lua.
export function encodeEntry(e) {
  const pm = (x) => (x == null || !Number.isFinite(x) ? "" : String(Math.round(x * 1000)));
  return [int(e.id), int(e.sold24), int(e.auctions24), int(e.normal ?? 0), pm(e.priceChange), pm(e.supplyChange), int(e.hoursActive), int(e.conf)].join(",");
}
