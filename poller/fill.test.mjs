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
  // more than 25% above the lowest price: never bought
  assert.equal(fillTime(...series([row(100), row(70, 0, 1), row(70, 1000, 1)]), 0), Infinity);
});

test("undercut and never bought: not filled; an hour without the item counts as nothing bought", () => {
  assert.equal(fillTime(...series([row(100), row(95, 0, 5), ...Array(50).fill(row(95, 3, 5))]), 0), Infinity);
  assert.equal(fillTime(...series([row(100), undefined, row(100, 1)]), 0), 2);
});

test("only starts with a full window count, and the 48h window decides the minimum", () => {
  // bought every hour: every start fills within the hour; starts near the end
  // (no full window yet) must not count as unsold
  const hours = (n, rules = 2, sold = 1) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * HOUR, rules, d: { 2589: row(100, sold) } }));
  assert.deepEqual(fillChances(hours(MIN_STARTS + 48)), { 2589: { p: [1, 1, 1], n: MIN_STARTS } });
  assert.deepEqual(fillChances(hours(MIN_STARTS + 47)), {}, "too few start hours: nothing");
  // hours counted under the old sales rules are ignored entirely
  const old = hours(60, 1, 5).map((h) => ({ ...h, t: h.t - 60 * HOUR }));
  assert.deepEqual(fillChances([...old, ...hours(MIN_STARTS + 48, 2, 0)]), { 2589: { p: [0, 0, 0], n: MIN_STARTS } });
  assert.deepEqual(fillChances([...old, ...hours(MIN_STARTS + 47)]), {});
});
