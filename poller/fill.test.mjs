// node --test poller/fill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTime, fillChances, MIN_STARTS } from "./fill.mjs";

const HOUR = 3600e3;
const T0 = Date.parse("2026-11-01T00:23:00Z");
// An archived row: lowest price, units within 5/10/25% of it, units bought since the last snapshot.
const row = (min, sold = 0, q5 = 10, q10 = q5, q25 = q10) => ({ min, q5, q10, q25, sold });
// Hourly snapshots of one item from a list of rows (undefined = not archived that hour).
const series = (rows) => [rows.map((_, k) => T0 + k * HOUR), rows];
// Archive hours of one item: soldAt(k) units bought in hour k.
const hours = (n, soldAt, rules = 2) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * HOUR, rules, d: { 2589: row(100, soldAt(k)) } }));

test("bought while at the front: filled that hour", () => {
  assert.equal(fillTime(...series([row(100), row(100), row(100, 1)]), 0), 2);
  assert.equal(fillTime(...series([row(100), row(99, 1)]), 0), 1, "a listing at our price is newer: ours goes first");
});

test("undercut: filled only once more is bought than is listed below us", () => {
  // we list at 99; 95 undercuts with 5 units within 5% of it
  assert.equal(fillTime(...series([row(100), row(95, 0, 5), row(95, 8, 5), row(95, 11, 5)]), 0), 3, "8 <= 5 before + 5 still there; 11 > 10");
  // undercut, then the cheaper units are gone (bought or cancelled): at the front again
  assert.equal(fillTime(...series([row(100), row(95, 0, 5), row(100, 0), row(100, 1)]), 0), 3);
  // further below: the 10% band holds the queue ahead of us
  assert.equal(fillTime(...series([row(100), row(91, 0, 2, 30), row(91, 20, 2, 30)]), 0), Infinity);
  // exactly 5% above the new lowest price (we list at 105, min 100): still the 5% band
  assert.equal(fillTime(...series([row(106), row(100, 3, 2, 50)]), 0), 1);
});

test("a stray cheap listing, or an unknown band, costs one hour: then q25 is ahead", () => {
  assert.equal(fillTime(...series([row(100), row(70, 1000, 1, 1, 3), row(100, 4)]), 0), 2, "nobody reaches us at 70; next hour 4 > 3");
  assert.equal(fillTime(...series([row(100), row(95, 1000, null, null, 4), row(100, 5)]), 0), 2, "q5 unknown");
  assert.equal(fillTime(...series([row(100), row(70, 0, 1, 1, null), row(100, 1000)]), 0), Infinity, "q25 unknown too");
});

test("undercut and never bought: not filled; an hour without the item or without a comparison counts as nothing bought", () => {
  assert.equal(fillTime(...series([row(100), row(95, 0, 5), ...Array(50).fill(row(95, 3, 5))]), 0), Infinity);
  assert.equal(fillTime(...series([row(100), undefined, row(100, 1)]), 0), 2);
  assert.equal(fillTime(...series([row(100), { ...row(100), span: 0 }, row(100, 1)]), 0), 2);
});

test("snapshot times wander: a fill up to half an hour past the 24 hours still counts", () => {
  const rows = [row(100), ...Array(24).fill(row(100)), row(100, 1)];
  const at = (last) => [rows.map((_, k) => T0 + (k === 25 ? last : k * HOUR)), rows];
  assert.equal(fillTime(...at(24.4 * HOUR), 0), 24.4);
  assert.equal(fillTime(...at(24.6 * HOUR), 0), Infinity);
  // snapshots 61 minutes apart, bought every 24th: every start fills within 24.4 hours
  const late = Array.from({ length: 230 }, (_, k) => ({ t: T0 + k * 61 * 60e3, rules: 2, d: { 2589: row(100, k % 24 ? 0 : 1) } }));
  assert.equal(fillChances(late)[2589].p, 1);
});

test("start hours: a full 24 hours after them, enough of them, new sales rules only", () => {
  // bought every hour: every start fills within the hour; starts near the end
  // (24 hours not over yet) must not count as unsold
  assert.deepEqual(fillChances(hours(MIN_STARTS + 24, () => 1)), { 2589: { p: 1, n: MIN_STARTS } });
  assert.deepEqual(fillChances(hours(MIN_STARTS + 23, () => 1)), {}, "too few start hours: nothing");
  // bought every 30th hour: starts 6-29 hours into the cycle fill within 24 hours (132 of the 168)
  assert.deepEqual(fillChances(hours(MIN_STARTS + 24, (k) => (k % 30 ? 0 : 1))), { 2589: { p: 132 / 168, n: MIN_STARTS } });
  // hours counted under the old sales rules are ignored entirely
  const old = hours(60, () => 5, 1).map((h) => ({ ...h, t: h.t - 60 * HOUR }));
  assert.deepEqual(fillChances([...old, ...hours(MIN_STARTS + 24, () => 0)]), { 2589: { p: 0, n: MIN_STARTS } });
  assert.deepEqual(fillChances([...old, ...hours(MIN_STARTS + 23, () => 1)]), {});
});
