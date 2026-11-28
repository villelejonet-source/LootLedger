// node --test poller/trending.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, recordHour, TIME_LEFT } from "./sales.mjs";
import { trendingLists, encodeEntry, itemStats } from "./trending.mjs";

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-30T12:00:00Z");
const { SHORT, MEDIUM, LONG } = TIME_LEFT;

// ---------------------------------------------------------------------------
// Snapshot diffs
// ---------------------------------------------------------------------------
test("a listing that's gone was bought; a smaller stack was partly bought", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, LONG], [2, 100, 10, 60, LONG]] };
  const cur = { t: HOUR, l: [[2, 100, 4, 60, LONG]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 26);
  assert.equal(d.auctions, 2);
  assert.equal(d.gold, 20 * 50 + 6 * 60);
});

test("listings about to run out count as expired, not bought", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, SHORT], [2, 100, 5, 50, MEDIUM]] };
  const cur = { t: 3 * HOUR, l: [] }; // gap over 2h: MEDIUM may have expired too
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 0);
  assert.equal(d.expired, 25);
});

test("cancel + relist of the same stack size is not a sale", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, LONG]] };
  const cur = { t: HOUR, l: [[9, 100, 20, 45, LONG]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 0);
  assert.equal(d.relisted, 20);
});

test("snapshots too far apart are not compared", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, LONG]] };
  assert.equal(diffSnapshots(prev, { t: 13 * HOUR, l: [] }).size, 0);
});

// ---------------------------------------------------------------------------
// Trending lists, from synthetic history
// ---------------------------------------------------------------------------
// items: id -> { normal: units/day, today(hourIndex 0..23) -> [units, auctions], market, qty, marketThen, qtyThen }
function history(spec) {
  const h = { hours: [], sales: {}, salesHours: {} };
  for (let d = 7; d >= 2; d--) {
    const key = new Date(NOW - d * DAY).toISOString().slice(0, 10);
    h.sales[key] = {};
    h.salesHours[key] = 24;
    for (const [id, s] of Object.entries(spec)) h.sales[key][id] = [s.normal, Math.max(1, Math.round(s.normal / 3)), s.normal * s.market];
  }
  for (let i = 0; i < 24; i++) {
    const t = NOW - (23 - i) * HOUR;
    const s = {}, q = {};
    for (const [id, x] of Object.entries(spec)) {
      const [units, auctions] = x.today(i);
      if (units > 0) s[id] = [units, auctions, units * x.market];
      q[id] = i === 0 ? [x.qtyThen ?? x.qty, x.marketThen ?? x.market] : [x.qty, x.market];
    }
    h.hours.push({ t, s, q, diff: true });
  }
  return h;
}
const itemsOf = (spec) => Object.fromEntries(Object.entries(spec).map(([id, x]) => [id, { market: x.market, qty: x.qty }]));
const ids = (list) => list.map((e) => e.id);

const SPEC = {
  // A real surge: Runecloth-like, normally 200/day, today 600 spread over the day, many auctions.
  14047: { normal: 200, market: 500, qty: 3000, today: (i) => [25, 6] },
  // One buyer sweeping a page: same total, but almost all in one hour and few auctions.
  9187: { normal: 200, market: 2400, qty: 1800, today: (i) => (i === 20 ? [560, 3] : [2, 1]) },
  // Grey junk with a tiny market: 2/day normally, 10 today, worth almost nothing.
  4583: { normal: 2, market: 30, qty: 40, today: (i) => (i < 10 ? [1, 1] : [0, 0]) },
  // Normal item, nothing special.
  4304: { normal: 300, market: 700, qty: 5000, today: (i) => [12, 4] },
  // Price spike from 2 listings left (no volume behind it).
  8170: { normal: 50, market: 4000, marketThen: 1900, qty: 2, qtyThen: 40, today: (i) => [2, 1] },
  // A real price climb with volume.
  4306: { normal: 400, market: 760, marketThen: 600, qty: 2000, today: (i) => [20, 6] },
  // Cooling off: normally 300/day, today ~70.
  8171: { normal: 300, market: 2000, qty: 900, today: (i) => (i % 8 === 0 ? [23, 5] : [0, 0]) },
};

test("a real surge is 'selling fast'; a bulk buyout, grey junk and normal trade are not", () => {
  const { lists, ready } = trendingLists(history(SPEC), itemsOf(SPEC), NOW);
  assert.ok(ready);
  assert.ok(ids(lists.hot).includes(14047), "Runecloth surge should be hot");
  assert.ok(!ids(lists.hot).includes(9187), "a single-hour sweep is not hot");
  assert.ok(!ids(lists.hot).includes(4583), "grey junk is not hot");
  assert.ok(!ids(lists.hot).includes(4304), "normal trade is not hot");
});

test("price climbing needs volume: 2 listings left don't count, a broad rise does", () => {
  const { lists } = trendingLists(history(SPEC), itemsOf(SPEC), NOW);
  assert.ok(!ids(lists.climbing).includes(8170), "spike from 2 listings is ignored");
  assert.ok(ids(lists.climbing).includes(4306), "real climb is listed");
});

test("cooling off is found", () => {
  const { lists } = trendingLists(history(SPEC), itemsOf(SPEC), NOW);
  assert.ok(ids(lists.cooling).includes(8171));
  assert.ok(!ids(lists.cooling).includes(14047));
});

test("drying up: listings shrinking while people keep buying", () => {
  const spec = { 2318: { normal: 300, market: 900, qty: 400, qtyThen: 1200, today: (i) => [15, 5] } };
  const { lists } = trendingLists(history(spec), itemsOf(spec), NOW);
  assert.ok(ids(lists.drying).includes(2318));
});

test("one weird hour is not enough: the surge must still be going", () => {
  const spec = { 14047: { normal: 200, market: 500, qty: 3000, today: (i) => (i < 12 ? [50, 10] : [0, 0]) } };
  const { lists } = trendingLists(history(spec), itemsOf(spec), NOW);
  assert.ok(!ids(lists.hot).includes(14047), "surge that stopped 12 hours ago is not 'right now'");
});

test("nothing is listed until there is enough history", () => {
  const h = history(SPEC);
  h.sales = {}; h.salesHours = {};
  const r = trendingLists(h, itemsOf(SPEC), NOW);
  assert.equal(r.ready, false);
  assert.equal(r.lists.hot.length, 0);
});

test("recordHour keeps 30 hours and daily totals", () => {
  const h = {};
  for (let i = 0; i < 40; i++) {
    recordHour(h, NOW + i * HOUR, new Map([[5, { units: 2, auctions: 1, gold: 100 }]]), { 5: { qty: 10, market: 50 } });
  }
  assert.equal(h.hours.length, 30);
  const total = Object.values(h.sales).reduce((s, d) => s + (d[5]?.[0] ?? 0), 0);
  assert.equal(total, 80);
});

test("encodeEntry is compact and complete", () => {
  const s = encodeEntry({ id: 14047, sold24: 600, auctions24: 144, normal: 200, priceChange: 0.142, supplyChange: -0.3, hoursActive: 24, conf: 2 });
  assert.equal(s, "14047,600,144,200,142,-300,24,2");
});

test("commodities: a pricier stack that vanished while a cheaper one stayed was cancelled, not bought", () => {
  // [auctionId, itemId, qty, unitPrice, timeLeft, commodity]
  const prev = { t: 0, l: [[1, 100, 50, 10, LONG, 1], [2, 100, 50, 12, LONG, 1], [3, 100, 5000, 20, LONG, 1]] };
  const cur = { t: HOUR, l: [[2, 100, 50, 12, LONG, 1]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 50, "only the cheapest stack (below the one still there) counts as bought");
  assert.equal(d.cancelled, 5000, "the big pricier stack was pulled by its seller");
});

test("commodities: buying from the bottom up counts in full", () => {
  const prev = { t: 0, l: [[1, 100, 50, 10, LONG, 1], [2, 100, 50, 11, LONG, 1], [3, 100, 50, 12, LONG, 1]] };
  const cur = { t: HOUR, l: [[3, 100, 20, 12, LONG, 1]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 130);
  assert.equal(d.cancelled, 0);
});

test("commodities: a partly bought cheap stack also caps the price: pricier stacks that vanished were cancelled", () => {
  // Busy house: the cheapest stack was partly bought (so nothing is untouched), the pricey one was pulled.
  const prev = { t: 0, l: [[1, 100, 50, 10, LONG, 1], [2, 100, 5000, 30, LONG, 1]] };
  const cur = { t: HOUR, l: [[1, 100, 20, 10, LONG, 1]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 30);
  assert.equal(d.cancelled, 5000);
});

test("commodities: at one price the oldest go first, so a newer stack gone while an older one stayed was cancelled", () => {
  // Everything at 1c (ammo): stack 5 (newer) vanished, stack 3 (older) is still there.
  const prev = { t: 0, l: [[3, 100, 200, 1, LONG, 1], [5, 100, 4000, 1, LONG, 1], [1, 100, 300, 1, LONG, 1]] };
  const cur = { t: HOUR, l: [[3, 100, 200, 1, LONG, 1], [9, 100, 3800, 1, LONG, 1]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 300, "stack 1 is older than stack 3: bought");
  assert.equal(d.cancelled, 4000, "stack 5 is newer than stack 3: cancelled (and reposted as 3800)");
});

test("commodities: a whole book gone in one hour is capped by the cheapest new listing", () => {
  const prev = { t: 0, l: [[1, 100, 200, 39, LONG, 1], [2, 100, 300, 40, LONG, 1], [3, 100, 100, 4800, LONG, 1]] };
  const cur = { t: HOUR, l: [[9, 100, 450, 45, LONG, 1]] };
  const d = diffSnapshots(prev, cur).get(100);
  assert.equal(d.units, 500, "39c and 40c are under the new 45c: bought (a buyout and relist)");
  assert.equal(d.cancelled, 100, "48s each, over the new listing: pulled");
});

test("single listings: one priced over 10% above a copy that's still there was cancelled", () => {
  const prev = { t: 0, l: [[1, 200, 1, 1000, LONG], [2, 200, 1, 1050, LONG], [3, 200, 1, 1300, LONG]] };
  const cur = { t: HOUR, l: [[1, 200, 1, 1000, LONG]] };
  const d = diffSnapshots(prev, cur).get(200);
  assert.equal(d.units, 1, "5% above the cheapest copy: may differ in stats, counted as bought");
  assert.equal(d.cancelled, 1, "30% above: cancelled");
});

test("MEDIUM listings that vanish within the hour count as expired", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, MEDIUM, 1]] };
  const d = diffSnapshots(prev, { t: HOUR, l: [] }).get(100);
  assert.equal(d.units, 0);
  assert.equal(d.expired, 20);
});

// A steady 24/day item: baseline days of 24, then a 12-hour outage, then 12 normal hours.
function afterOutage({ withSpan }) {
  const h = { hours: [], sales: {}, salesHours: {} };
  for (let d = 7; d >= 2; d--) {
    const key = new Date(NOW - d * DAY).toISOString().slice(0, 10);
    h.sales[key] = { 2589: [24, 12, 24 * 500] };
    h.salesHours[key] = 24;
  }
  const rec = (t, units, span) => ({ t, s: { 2589: [units, units, units * 500] }, q: { 2589: [100, 500] }, diff: true, ...(withSpan ? { h: span } : {}) });
  h.hours.push(rec(NOW - 12 * HOUR, 12, 12)); // one diff over the 12 hours of outage
  for (let i = 11; i >= 0; i--) h.hours.push(rec(NOW - i * HOUR, 1, 1));
  return h;
}

test("A4: after an outage, sales are scaled by the hours the diffs cover, not by how many diffs there are", () => {
  const { stats, coverage } = itemStats(afterOutage({ withSpan: true }), { 2589: { market: 500, qty: 100 } }, NOW);
  assert.equal(coverage, 24);
  const s = stats.get("2589");
  assert.equal(s.sold24, 24);
  assert.ok(s.sold24 / s.normal < 1.1, `ratio ${s.sold24 / s.normal}`);
});

test("A4: hour records without a span (written before spans were kept) count as 1 hour", () => {
  const { coverage } = itemStats(afterOutage({ withSpan: false }), { 2589: { market: 500, qty: 100 } }, NOW);
  assert.equal(coverage, 13);
});

test("A4: recordHour keeps the span of each diff and adds it to the day's hours covered", () => {
  const h = {};
  const sold = new Map([[5, { units: 12, auctions: 3, gold: 600 }]]);
  recordHour(h, NOW, sold, { 5: { qty: 10, market: 50 } }, { span: 12 });
  recordHour(h, NOW + HOUR, sold, { 5: { qty: 10, market: 50 } }, { span: 1 });
  recordHour(h, NOW + 2 * HOUR, null, { 5: { qty: 10, market: 50 } });
  assert.deepEqual(h.hours.map((x) => x.h), [12, 1, undefined]);
  assert.equal(h.salesHours[new Date(NOW).toISOString().slice(0, 10)], 13);
});

test("A5: a LONG listing gone after a gap over 2 hours counts as expired, not bought", () => {
  const prev = { t: 0, l: [[1, 100, 20, 50, LONG]] };
  const d = diffSnapshots(prev, { t: 5 * HOUR, l: [] }).get(100);
  assert.equal(d.units, 0);
  assert.equal(d.expired, 20);
  // ...but within a normal hour a vanished LONG listing was bought
  assert.equal(diffSnapshots(prev, { t: HOUR, l: [] }).get(100).units, 20);
});

test("A6: baseline days with missing hours are scaled to 24 hours, like the last 24 hours are", () => {
  const h = { hours: [], sales: {}, salesHours: {} };
  for (let d = 7; d >= 2; d--) {
    const key = new Date(NOW - d * DAY).toISOString().slice(0, 10);
    h.sales[key] = { 2589: [18, 9, 18 * 500] }; // steady 1/hour, but only 18 hours of data that day
    h.salesHours[key] = 18;
  }
  for (let i = 23; i >= 0; i--) h.hours.push({ t: NOW - i * HOUR, s: { 2589: [1, 1, 500] }, q: { 2589: [100, 500] }, diff: true, h: 1 });
  const s = itemStats(h, { 2589: { market: 500, qty: 100 } }, NOW).stats.get("2589");
  assert.equal(s.sold24, 24);
  assert.ok(Math.abs(s.normal - 24) < 1e-9, `normal ${s.normal}`);
});

test("readyAt: tracking that started this morning is ready at midnight UTC two days after the second full day", async () => {
  const { readyAt } = await import("./trending.mjs");
  const now = Date.parse("2026-11-23T20:24:00Z");
  // today: 12 hours so far, can reach at most ~15.6 by midnight -> doesn't count
  assert.equal(new Date(readyAt({ salesHours: { "2026-11-23": 12.01 } }, now)).toISOString(), "2026-11-27T00:00:00.000Z");
  // today can still reach 18 hours -> it counts
  assert.equal(new Date(readyAt({ salesHours: { "2026-11-23": 17 } }, now)).toISOString(), "2026-11-26T00:00:00.000Z");
  // two complete days already: ready as soon as they are out of the 24h window
  assert.equal(new Date(readyAt({ salesHours: { "2026-11-21": 24, "2026-11-22": 20 } }, now)).toISOString(), "2026-11-24T00:00:00.000Z");
});

test("trendingLists says when it will be ready, and only while it isn't", () => {
  const h = history(SPEC);
  assert.equal(trendingLists(h, itemsOf(SPEC), NOW).readyAt, undefined);
  h.sales = {}; h.salesHours = {};
  assert.ok(trendingLists(h, itemsOf(SPEC), NOW).readyAt > NOW);
});

test("sales counted under older rules are dropped once, then kept", async () => {
  const { resetSales, SALES_RULES } = await import("./sales.mjs");
  const h = { sales: { "2026-11-27": { 100: [500, 5, 1000] } }, salesHours: { "2026-11-27": 24 }, hours: [{ t: 1, s: { 100: [5, 1, 10] }, q: {}, diff: true, h: 1 }] };
  assert.equal(resetSales(h), true);
  assert.deepEqual(h.sales, {});
  assert.deepEqual(h.hours[0].s, {});
  assert.equal(h.hours[0].diff, false);
  assert.equal(h.salesRules, SALES_RULES);
  h.sales["2026-11-28"] = { 100: [5, 1, 10] };
  assert.equal(resetSales(h), false);
  assert.ok(h.sales["2026-11-28"]);
});
