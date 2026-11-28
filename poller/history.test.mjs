// node --test poller/history.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSnapshot, archiveOldDays, allDays, monthKeys, monthlyFor, seriesFor, encodeHistory, labels, recentMedians, dayMarket, cleanHistory } from "./history.mjs";
import { trend } from "./analysis.mjs";

const DAY = 86400e3;
const START = Date.parse("2026-07-01T12:00:00Z");
const GEO = Math.sqrt(100 * 120); // a day of 100 and 120: geometric mean ~109.5
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);

function build(days) {
  const h = { days: {}, months: {} };
  for (let i = 0; i < days; i++) {
    const t = START + i * DAY;
    // two snapshots a day: 100 and 120 -> daily market ~109.5 (item 1)
    addSnapshot(h, { 1: { market: 100, min: 90, qty: 10 } }, t);
    addSnapshot(h, { 1: { market: 120, min: 95, qty: 30 } }, t);
  }
  return h;
}

test("addSnapshot sums hourly market, quantity and log(market), keeps the lowest min", () => {
  const h = build(1);
  assert.deepEqual(Object.values(h.days)[0][1], [220, 2, 90, 40, Math.round((Math.log(100) + Math.log(120)) * 1e4) / 1e4, 2]);
  const s = seriesFor(h, allDays(h, START), "1");
  near(s[0].market, GEO); // the day's market is the geometric mean of its hours
  assert.equal(s[0].qty, 20);
});

test("a one-hour spike barely moves the day's market (it would inflate an arithmetic mean)", () => {
  const h = { days: {}, months: {} };
  for (let i = 0; i < 24; i++) addSnapshot(h, { 1: { market: i === 12 ? 1000 : 100, min: 90, qty: 10 } }, START);
  const day = seriesFor(h, allDays(h, START), "1")[0].market;
  assert.ok(day < 111, `geometric ${day}`); // arithmetic would be 137.5
});

test("a day begun before log sums were kept stays arithmetic", () => {
  const h = { days: { "2026-07-01": { 1: [220, 2, 90, 40] } }, months: {} };
  addSnapshot(h, { 1: { market: 140, min: 95, qty: 10 } }, START);
  assert.deepEqual(h.days["2026-07-01"][1], [360, 3, 90, 50]);
  assert.equal(seriesFor(h, allDays(h, START), "1")[0].market, 120);
});

test("the switch to geometric days is no price drop: older days are scaled by the item's ratio", () => {
  // The same day every day (22 hours at 100, 2 at 300): arithmetic 116.7, geometric 109.6.
  const h = { days: {}, months: {} };
  for (let d = 0; d < 14; d++) for (let i = 0; i < 24; i++) addSnapshot(h, { 1: { market: i < 22 ? 100 : 300, min: 90, qty: 10 } }, START + d * DAY);
  for (const k of Object.keys(h.days).sort().slice(0, 9)) h.days[k][1].length = 4; // stored before log sums
  const days = allDays(h, START + 13 * DAY);
  const unscaled = days.map((k) => dayMarket(h.days[k][1]));
  assert.ok(trend(unscaled) < -0.005, `unscaled, the switch looks like a fall: ${trend(unscaled)}`);
  const series = seriesFor(h, days, "1").map((d) => d.market);
  assert.ok(series.every((v) => Math.abs(v - series[13]) < 0.01), `flat: ${series}`);
  assert.ok(Math.abs(trend(series)) < 0.001, `trend ${trend(series)}`);
});

test("a day logged for only some hours (an older poller ran meanwhile) is the scaled arithmetic mean", () => {
  const h = { days: {}, months: {} };
  addSnapshot(h, { 1: { market: 100, min: 90, qty: 10 } }, START - DAY);
  addSnapshot(h, { 1: { market: 400, min: 90, qty: 10 } }, START - DAY);  // yesterday: geo 200, arith 250
  addSnapshot(h, { 1: { market: 100, min: 90, qty: 10 } }, START);
  h.days["2026-07-01"][1][0] += 200; h.days["2026-07-01"][1][1] += 1;    // an hour at 200 without its log
  near(seriesFor(h, allDays(h, START), "1")[1].market, 0.8 * 150);
});

test("recentMedians: each item's median of the last 3 hourly markets", () => {
  const H = 3600e3;
  const hour = (t, q) => ({ t, q, s: {} });
  const hours = [
    hour(0, { 1: [5, 999] }),
    hour(1 * H, { 1: [5, 100], 2: [5, 50] }),
    hour(2 * H, { 1: [5, 130], 2: [5, 60] }),
    hour(3 * H, { 1: [5, 104] }),          // item 2 not listed this hour: no median
    hour(3 * H, { 1: [5, 104] }),          // the same snapshot again (Blizzard hadn't refreshed)
  ];
  assert.deepEqual(recentMedians(hours), { 1: 104 });
  assert.deepEqual(recentMedians(hours.slice(0, 2)), {}, "under 3 snapshots");
  assert.deepEqual(recentMedians([hour(0, { 1: [5, 1] }), hour(4 * H, { 1: [5, 2] }), hour(5 * H, { 1: [5, 3] })]), {}, "over 4 hours apart");
});

test("old days fold into monthly averages and are removed", () => {
  const h = build(200);
  const now = START + 199 * DAY;
  archiveOldDays(h, now, 120);
  assert.ok(Object.keys(h.days).length <= 121, `kept ${Object.keys(h.days).length} days`);
  assert.ok(h.months["2026-07"], "July archived");
  near(h.months["2026-07"][1][0] / 31, GEO);
  assert.equal(h.months["2026-07"][1][1], 31);
});

test("monthly series combine archive and daily window, newest 12 months", () => {
  const h = build(200);
  const now = START + 199 * DAY;
  archiveOldDays(h, now, 120);
  const days = allDays(h, now);
  const keys = monthKeys(h, days);
  assert.equal(keys[0], "2026-07");
  assert.equal(keys[keys.length - 1], "2027-01");
  const m = monthlyFor(h, days, "1", keys);
  assert.ok(m.every((v) => Math.abs(v - GEO) < 0.01), `monthly ${m}`);
});

test("encodeHistory uses the monthly series it is given", () => {
  const h = build(10);
  const now = START + 9 * DAY;
  const days = allDays(h, now);
  const keys = monthKeys(h, days);
  const enc = encodeHistory(seriesFor(h, days, "1"), monthlyFor(h, days, "1", keys));
  assert.match(enc, /;m=32;/); // 110 (109.5 rounded) in base 36
  assert.match(labels(days, keys), /monthLabels = \{ "2026-07" \}/);
});

test("security: history read back from the branch keeps only keys and numbers of the expected shape", () => {
  const evil = '" } PWNED() x = { "';
  const h = cleanHistory({
    days: { "2026-11-27": { 2589: [10, 1, 10, 1, null, 0], [evil]: [1, 1], 2318: [1, "1 PWNED()"] }, [evil]: { 2589: [1, 1] }, "2026-13-45": {} },
    months: { "2026-10": { 2589: [10, 1] }, ['2026-10" } PWNED() --']: { 2589: [10, 1] } },
    hours: [{ t: 1, s: { 2589: [1, '1" PWNED() x="', 100], 2318: [1, 1, 1] }, q: { 2589: [20, "0x7F"] }, diff: true, h: 1 }, { t: "x", s: {}, q: {} }, { t: 2, h: "1", s: {}, q: {} }],
    sales: { "2026-11-27": { 2589: [1, 1, 1], 2318: [Infinity, 1, 1] }, [evil]: {} },
    salesHours: { "2026-11-27": 24, [evil]: 24, "2026-11-28": "24" },
    index: [{ t: 1, v: 0.1 }, { t: 2, v: "0.1" }, { t: 3, v: 0.1, g: "x" }],
  });
  assert.deepEqual(h.days, { "2026-11-27": { 2589: [10, 1, 10, 1, null, 0] } });
  assert.deepEqual(h.months, { "2026-10": { 2589: [10, 1] } });
  assert.deepEqual(h.hours, [{ t: 1, s: { 2318: [1, 1, 1] }, q: {}, diff: true, h: 1 }]);
  assert.deepEqual(h.sales, { "2026-11-27": { 2589: [1, 1, 1] } });
  assert.deepEqual(h.salesHours, { "2026-11-27": 24 });
  assert.deepEqual(h.index, [{ t: 1, v: 0.1 }]);
  // Fields an older file doesn't have stay missing; something that isn't an object starts empty.
  assert.deepEqual(cleanHistory({ days: {} }), { days: {}, months: {} });
  assert.deepEqual(cleanHistory([1]), { days: {}, months: {} });
});

test("security: labels are escaped, month keys checked, and only real numbers make a 3-hour median", () => {
  const h = { days: {}, months: { "2026-10": {}, '2026-09" } PWNED() --': {} } };
  assert.deepEqual(monthKeys(h, []), ["2026-10"]);
  assert.match(labels([], ['a"b']), /monthLabels = { "a\\"b" }/);
  const t = Date.parse("2026-11-28T12:00:00Z");
  const hours = (v) => [0, 1, 2].map((i) => ({ t: t - i * 3600e3, q: { 5: [1, v] } }));
  assert.deepEqual(recentMedians(hours("0x7F")), {});
  assert.deepEqual(recentMedians(hours(Infinity)), {});
  assert.deepEqual(recentMedians(hours(7)), { 5: 7 });
});
