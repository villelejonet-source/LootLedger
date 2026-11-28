// node --test poller/archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { depth, archiveHour, pruneArchive, readArchive } from "./archive.mjs";

const T = Date.parse("2026-11-28T10:23:00Z");
const items = {
  2589: { min: 50, market: 50, qty: 35, n: 3, depth: [25, 25, 35] },
  2318: { min: 300, market: 300, qty: 2, n: 1, depth: [2, 2, 2] },
  2319: { min: 900, market: 950, qty: 3, n: 2, depth: [1, 3, 3] },
};

test("depth: units listed within 5/10/25% of the lowest price", () => {
  assert.deepEqual(depth([[52, 5], [50, 20], [62, 10], [70, 4]]), [25, 25, 35]); // 70 is 40% above
  assert.deepEqual(depth([]), [0, 0, 0]);
});

test("archiveHour keeps items bought 3+ a day lately, once per snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arch-"));
  // two full days of sales data: Linen 40 and Medium Leather 8 bought (4 a day), Light Leather 2 (1 a day)
  const history = {
    sales: { "2026-11-25": { 2589: [20, 5, 1000], 2319: [4, 2, 3600], 2318: [1, 1, 300] }, "2026-11-26": { 2589: [20, 5, 1000], 2319: [4, 2, 3600], 2318: [1, 1, 300] } },
    salesHours: { "2026-11-25": 24, "2026-11-26": 24 },
  };
  const sold = new Map([[2589, { units: 4, gold: 200 }]]);
  assert.equal((await archiveHour(dir, 114, T, items, sold, 1, history)).added, 2);
  assert.equal((await archiveHour(dir, 114, T, items, sold, 1, history)).added, 0, "same snapshot twice");
  await archiveHour(dir, 114, T + 3600e3, items, null, 0, history);
  const back = await readArchive(dir, 114);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0].d[2589], { min: 50, market: 50, qty: 35, n: 3, q5: 25, q10: 25, q25: 35, sold: 4, gold: 200, span: 1 });
  assert.equal(back[0].d[2319].sold, 0);
  assert.equal(back[0].d[2318], undefined);
  assert.equal(back[1].d[2589].span, 0, "no comparison that hour");
  assert.equal(back[0].rules, 2);
});

test("pruneArchive removes days older than 35, only for that house", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arch-"));
  const empty = gzipSync(JSON.stringify({ v: 1, fields: [], hours: [] }));
  for (const f of ["114.hours.2026-10-23.json.gz", "114.hours.2026-10-25.json.gz", "113.hours.2026-10-01.json.gz", "114.json.gz"]) {
    await writeFile(join(dir, f), empty);
  }
  assert.equal(await pruneArchive(dir, 114, T), 1); // 28 Nov - 35 days: keeps 25 Oct onwards
  assert.deepEqual((await readdir(dir)).sort(), ["113.hours.2026-10-01.json.gz", "114.hours.2026-10-25.json.gz", "114.json.gz"]);
});
