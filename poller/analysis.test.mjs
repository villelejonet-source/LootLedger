// node --test poller/
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, weekdayProfile, trend, baseline, weekday, dayKey } from "./analysis.mjs";

const START = Date.parse("2026-10-05T12:00:00Z"); // a Monday
const DAY = 86400e3;

// Build n days of prices from a function of (day index, weekday 0=Mon).
function series(n, price) {
  return Array.from({ length: n }, (_, i) => {
    const key = dayKey(START + i * DAY);
    return { key, market: Math.round(price(i, weekday(key))) };
  });
}

// Deterministic pseudo-random noise in [-1, 1] (mulberry32)
function prng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}
const rnd = prng(42);
const NOISE = Array.from({ length: 400 }, rnd);
function noise(i) { return NOISE[i % NOISE.length]; }

const PATTERN = [0, -0.08, -0.02, 0.01, 0.06, 0.09, 0.03]; // Tue cheapest, Sat most expensive

test("weekday() is Monday-based", () => {
  assert.equal(weekday("2026-10-05"), 0); // Monday
  assert.equal(weekday("2026-10-11"), 6); // Sunday
});

test("finds a Tue-low / Sat-high pattern in a flat market", () => {
  const s = series(28, (i, wd) => 40000 * (1 + PATTERN[wd]) * (1 + 0.01 * noise(i)));
  const p = weekdayProfile(s);
  assert.equal(p.best, 5, "Saturday most expensive");
  assert.equal(p.worst, 1, "Tuesday cheapest");
  assert.ok(p.reliable, "pattern should be reliable after 4 weeks");
  assert.ok(p.spread > 0.12 && p.spread < 0.22, `spread ${p.spread}`);
});

test("finds the same pattern while the whole market falls 3% a day", () => {
  const s = series(28, (i, wd) => 40000 * Math.pow(0.97, i) * (1 + PATTERN[wd]) * (1 + 0.01 * noise(i)));
  const p = weekdayProfile(s);
  assert.equal(p.best, 5);
  assert.equal(p.worst, 1);
  assert.ok(p.reliable);
});

test("a pure trend does not invent a weekday pattern", () => {
  const s = series(28, (i) => 40000 * Math.pow(0.97, i) * (1 + 0.01 * noise(i)));
  const p = weekdayProfile(s);
  assert.ok(!p.reliable, `no pattern expected, spread ${p.spread}, consistency ${p.consistency}`);
});

test("random noise rarely counts as a pattern (under 5% of 200 random series)", () => {
  let flagged = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = prng(seed);
    const s = series(28, () => 40000 * (1 + 0.05 * r()));
    if (weekdayProfile(s).reliable) flagged++;
  }
  assert.ok(flagged < 10, `${flagged} of 200 random series flagged`);
});

test("a pattern that changed recently follows the recent weeks", () => {
  // first 4 weeks: Saturday high; last 3 weeks: Monday high
  const late = [0.09, -0.04, -0.02, 0, 0.01, -0.05, 0.01];
  const s = series(49, (i, wd) => 40000 * (1 + (i < 28 ? PATTERN[wd] : late[wd])));
  assert.equal(weekdayProfile(s).best, 0);
});

test("one week of data is never reliable", () => {
  const s = series(7, (i, wd) => 40000 * (1 + PATTERN[wd]));
  assert.ok(!weekdayProfile(s).reliable);
});

test("trend reads a falling market", () => {
  const values = Array.from({ length: 16 }, (_, i) => 40000 * Math.pow(0.97, i));
  assert.ok(Math.abs(trend(values) - -0.03) < 0.002);
  assert.equal(trend(values.slice(0, 8)), null, "needs 9 days (three 7-day averages)");
  assert.ok(Math.abs(trend(values.slice(0, 9)) - -0.03) < 0.002);
});

test("a weekly up-and-down is not a trend on any day of the week", () => {
  // Saturday +15%, Tuesday -12% around a flat market: the old daily fit said
  // "falling" around Tuesday and "rising" before Saturday.
  const swing = [-0.09, -0.12, -0.06, 0, 0.08, 0.15, 0.04];
  const s = series(35, (i, wd) => 40000 * (1 + swing[wd]));
  for (let end = 21; end <= 35; end++) {
    const t = trend(s.slice(0, end).map((d) => d.market));
    assert.ok(Math.abs(t) < 0.005, `day ${end}: trend ${t}`);
  }
});

test("a weekly swing on top of a real fall still reads as the fall", () => {
  const swing = [-0.09, -0.12, -0.06, 0, 0.08, 0.15, 0.04];
  const s = series(28, (i, wd) => 40000 * Math.pow(0.98, i) * (1 + swing[wd]));
  for (let end = 16; end <= 28; end++) {
    const t = trend(s.slice(0, end).map((d) => d.market));
    assert.ok(Math.abs(t - -0.02) < 0.004, `day ${end}: trend ${t}`);
  }
});

test("baseline leans on recent days", () => {
  const b = baseline([10000, 10000, 10000, 20000, 20000]);
  assert.ok(b > 15000, `baseline ${b}`);
});

test("analyze puts it together", () => {
  const s = series(35, (i, wd) => 40000 * (1 + PATTERN[wd])); // 5 Oct - 8 Nov
  const a = analyze(s, 42000);
  assert.ok(a.baseline > 0);
  assert.equal(a.weekly.values.length, 5);
  assert.equal(a.monthly.values.length, 2); // October + November
});
