// node --test poller/ah.test.mjs
// Runs the whole feed (poller/ah.mjs) against a fake Blizzard API (fake-bnet.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

// Run ah.mjs; `history` = { file: object } written gzipped into HISTORY_DIR first (null = no folder).
async function runFeed(spec, history = {}, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ah-"));
  const hist = join(dir, "history"), out = join(dir, "out");
  if (history) {
    await mkdir(hist);
    for (const [f, v] of Object.entries(history)) {
      await writeFile(join(hist, f), typeof v === "string" ? v : gzipSync(JSON.stringify(v)));
    }
  }
  const specFile = join(dir, "spec.json");
  await writeFile(specFile, JSON.stringify(spec));
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(HERE, "fake-bnet.mjs")).href, join(HERE, "ah.mjs")], {
    env: { ...process.env, FAKE_BNET: specFile, BNET_CLIENT_ID: "x", BNET_CLIENT_SECRET: "y", HISTORY_DIR: hist, OUT_DIR: out, RETRY_DELAY_MS: "1", ...extraEnv },
    encoding: "utf8",
  });
  const read = async (f) => JSON.parse(gunzipSync(await readFile(join(out, "history", f))).toString());
  const lua = async () => readFile(join(out, "LootLedger_Prices", "Prices.lua"), "utf8");
  const log = async () => readFile(specFile + ".log", "utf8").catch(() => "");
  return { code: r.status, out: r.stdout + r.stderr, outHistory: () => readdir(join(out, "history")), read, lua, log };
}

const listing = (id, item, qty, price, tl = "LONG") => ({ id, item: { id: item }, quantity: qty, buyout: qty * price, time_left: tl });
const HOUSES = [{ id: 113, name: "Horde Thunderstrike" }, { id: 114, name: "Alliance Thunderstrike" }];

test("A1: a house that fails this run keeps its history and snapshot", async () => {
  const oldHist = { days: { "2026-11-01": {} }, months: {} };
  const oldSnap = { t: 1, l: [] };
  const r = await runFeed(
    { houses: HOUSES, data: { 113: { auctions: [listing(1, 2589, 20, 50)] }, 114: { status: 500 } } },
    { "114.json.gz": oldHist, "114.snap.json.gz": oldSnap },
  );
  assert.equal(r.code, 0, r.out);
  assert.deepEqual((await r.outHistory()).sort(), ["113.block.lua", "113.json.gz", "113.snap.json.gz", "114.json.gz", "114.snap.json.gz"]);
  assert.deepEqual(await r.read("114.json.gz"), oldHist);
  assert.deepEqual(await r.read("114.snap.json.gz"), oldSnap);
});

test("A2: a corrupt history file stops the run instead of starting that house over", async () => {
  const r = await runFeed(
    { houses: HOUSES.slice(0, 1), data: { 113: { auctions: [listing(1, 2589, 20, 50)] } } },
    { "113.json.gz": "not gzip" },
  );
  assert.notEqual(r.code, 0, r.out);
});

test("A7a: every request has a timeout, and network errors are retried (token included)", async () => {
  const r = await runFeed({
    tokenFailures: 1,
    houses: HOUSES,
    data: { 113: { auctions: [listing(1, 2589, 20, 50)] }, 114: { throws: true } },
  });
  assert.equal(r.code, 0, r.out);
  const log = (await r.log()).trim().split("\n");
  assert.ok(log.every((l) => l.endsWith("signal=true")), log.join("\n"));
  assert.equal(log.filter((l) => l.startsWith("oauth.battle.net")).length, 2);
  assert.equal(log.filter((l) => l.endsWith("/auctions/114 signal=true")).length, 3, "the failing house was tried 3 times");
  assert.match(r.out, /house 114 .*fetch failed/);
});

test("A7b: a listing count that fell by more than half saves the snapshot but skips the sales diff", async () => {
  const prevSnap = { t: Date.parse("2026-11-23T10:23:00Z"), l: Array.from({ length: 10 }, (_, i) => [i + 1, 2589, 5, 50, 2, 0]) };
  const r = await runFeed(
    { houses: HOUSES.slice(0, 1), data: { 113: { auctions: [listing(1, 2589, 5, 50), listing(2, 2589, 5, 50)], lm: "Mon, 23 Nov 2026 11:23:00 GMT" } } },
    { "113.snap.json.gz": prevSnap },
  );
  assert.equal(r.code, 0, r.out);
  const hist = await r.read("113.json.gz");
  assert.equal(hist.hours.at(-1).diff, false, "nothing counted as bought");
  assert.equal((await r.read("113.snap.json.gz")).l.length, 2, "new snapshot saved");
  assert.match(r.out, /listings fell from 10 to 2, sales diff skipped/);
});

test("A7c: the snapshot time is the newer of the auctions and commodities Last-Modified", async () => {
  const r = await runFeed({
    houses: HOUSES.slice(0, 1),
    data: { 113: { auctions: [listing(1, 2589, 5, 50)], lm: "Mon, 23 Nov 2026 10:23:00 GMT", clm: "Mon, 23 Nov 2026 11:24:00 GMT" } },
  });
  assert.equal(r.code, 0, r.out);
  assert.equal((await r.read("113.snap.json.gz")).t, Date.parse("2026-11-23T11:24:00Z"));
});

test("A7d: quotes and backslashes in house names don't break Prices.lua", async () => {
  // No Lua parser here: the feed workflow runs these tests without npm packages.
  const name = 'Horde "Old" Realm\\X';
  const r = await runFeed({ houses: [{ id: 113, name }], data: { 113: { auctions: [listing(1, 2589, 5, 50)] } } });
  assert.equal(r.code, 0, r.out);
  const lua = await r.lua();
  assert.ok(lua.includes('name = "Horde \\"Old\\" Realm\\\\X", faction = "Horde",'), lua.slice(0, 600));
});

test("security: hostile IDs and numbers from Saddlebag or Blizzard never reach Prices.lua", async () => {
  const evil = '1]=1 RunScript("x") t={[2';
  const r = await runFeed({
    houses: [{ id: 113, name: "Horde" }, { id: evil, name: "Bad house" }],
    data: { 113: { auctions: [
      listing(1, 2589, 5, 50),
      { id: 2, item: { id: evil }, quantity: 5, buyout: 250, time_left: "LONG" },
      { id: 3, item: { id: 2318 }, quantity: "5 RunScript", buyout: 250, time_left: "LONG" },
    ] } },
    saddlebag: [
      { itemID: 2589, salesPerDay: 12.4 },
      { itemID: "2318", salesPerDay: "7" },
      { itemID: evil, salesPerDay: 5 },
      { itemID: 4306, salesPerDay: '9 RunScript("y")' },
    ],
  });
  assert.equal(r.code, 0, r.out);
  const lua = await r.lua();
  assert.ok(!lua.includes("RunScript"), "no injected code");
  assert.ok(!lua.includes("Bad house"), "a house without a numeric ID is dropped");
  assert.match(lua, /\[2589\]=12,/);
  assert.match(lua, /\[2318\]=7,/);
  assert.doesNotMatch(lua, /\[4306\]=/);
  assert.match(lua, /\[2589\]="50,50,5,/);
});

test("A8: time of week: the hourly market index is kept, and each house gets its week profile", async () => {
  // 40 items with a price yesterday; today they list 10% higher.
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const day = {};
  const auctions = [];
  for (let i = 0; i < 40; i++) {
    day[3000 + i] = [1000 * 24, 24, 1000, 50 * 24];
    auctions.push(listing(i + 1, 3000 + i, 50, 1100));
  }
  const r = await runFeed(
    { houses: HOUSES.slice(0, 1), data: { 113: { auctions } } },
    { "113.json.gz": { days: { [yesterday]: day }, months: {}, index: [] } },
  );
  assert.equal(r.code, 0, r.out);
  const h = await r.read("113.json.gz");
  assert.equal(h.index.length, 1);
  assert.ok(Math.abs(h.index[0].v - Math.log(1.1)) < 0.001, `index ${h.index[0].v}`);
  assert.match(await r.lua(), /week = "(-?\d*,){167}-?\d*;\d+;[01];\d*",/);
  assert.match(r.out, /time of week not ready \(1 hours, /);
});

test("A9: a house that fails keeps its last good prices in the feed (up to 2 days), so players aren't switched to another house", async () => {
  const block = (updated) => `  [114] = { name = "Alliance Thunderstrike", faction = "Alliance", updated = ${updated}, listings = 5, days = 1,\n    items = {\n[2589]="77,77,5,0,0",\n    } },`;
  const spec = { houses: HOUSES, data: { 113: { auctions: [listing(1, 2589, 20, 50)] }, 114: { status: 500 } } };
  const fresh = await runFeed(spec, { "114.block.lua": block(Math.floor(Date.now() / 1000) - 3600) });
  assert.equal(fresh.code, 0, fresh.out);
  const lua = await fresh.lua();
  assert.match(lua, /\[114\] = \{ name = "Alliance Thunderstrike"/);
  assert.match(lua, /\[2589\]="77,77,5,0,0"/);
  assert.match(fresh.out, /house 114 .*kept its last good prices/);
  assert.deepEqual((await fresh.outHistory()).filter((f) => f.endsWith(".block.lua")).sort(), ["113.block.lua", "114.block.lua"]);

  const old = await runFeed(spec, { "114.block.lua": block(Math.floor(Date.now() / 1000) - 3 * 86400) });
  assert.equal(old.code, 0, old.out);
  assert.doesNotMatch(await old.lua(), /\[114\] = \{/);
});

test("A10: every house failing still fails the run (old prices alone are not a new release)", async () => {
  const block = `  [114] = { name = "A", faction = "Alliance", updated = ${Math.floor(Date.now() / 1000)}, listings = 5, days = 1, items = {} },`;
  const r = await runFeed({ houses: HOUSES.slice(1), data: { 114: { status: 500 } } }, { "114.block.lua": block });
  assert.notEqual(r.code, 0);
});

test("A11: hourly archive: only the chosen houses and items that trade 3+ a day", async () => {
  const auctions = [listing(1, 2589, 20, 50), listing(2, 2589, 5, 52), listing(3, 2589, 10, 62), listing(4, 2318, 2, 300)];
  const spec = { houses: HOUSES, data: { 113: { auctions }, 114: { auctions } } };
  const today = new Date().toISOString().slice(0, 10);
  const sales = { sales: { [today]: { 2589: [50, 20, 2500] } }, salesHours: { [today]: 24 }, salesRules: 2, days: {}, months: {} };
  const r = await runFeed(spec, { "113.json.gz": sales }, { ARCHIVE_HOUSES: "113" });
  assert.equal(r.code, 0, r.out);
  const files = await r.outHistory();
  const day = files.filter((f) => f.startsWith("113.hours."));
  assert.equal(day.length, 1);
  assert.ok(!files.some((f) => f.startsWith("114.hours.")), "114 isn't archived");
  const a = await r.read(day[0]);
  assert.deepEqual(a.fields, ["min", "market", "qty", "n", "q5", "q10", "q25", "sold", "gold", "span"]);
  assert.equal(a.hours.length, 1);
  // Linen: 35 listed at 50/52/62: 25 within 5%, 25 within 10%, 35 within 25%; no comparison yet
  assert.deepEqual(a.hours[0].d[2589], [50, 50, 35, 3, 25, 25, 35, 0, 0, 0]);
  assert.equal(a.hours[0].d[2318], undefined, "never bought: not archived");
  assert.match(r.out, /house 113: hourly archive \+1 items/);
});

test("A12: the first run with new sales rules drops the old counts and says so", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = { sales: { [today]: { 2589: [5000, 20, 2500] } }, salesHours: { [today]: 24 }, days: {}, months: {} };
  const r = await runFeed({ houses: HOUSES.slice(0, 1), data: { 113: { auctions: [listing(1, 2589, 20, 50)] } } }, { "113.json.gz": old });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /house 113: sales counted under older rules dropped/);
  const h = await r.read("113.json.gz");
  assert.equal(h.salesRules, 2);
  assert.equal(h.sales[today], undefined);
});

test("A13: queue depth ships as a new table for items with history; existing line formats are unchanged", async () => {
  // Linen: 35 listed at 50/52/62 (25 within 5% of the lowest), enough listed for history.
  // Light Leather: 2 listed, no history, so no queue line either.
  const auctions = [listing(1, 2589, 20, 50), listing(2, 2589, 5, 52), listing(3, 2589, 10, 62), listing(4, 2318, 2, 300)];
  // An hour ago 30 Linen were in listing 1: 10 were bought since, so there is a sales line.
  const now = Date.now();
  const prevSnap = { t: now - 3600e3, l: [[1, 2589, 30, 50, 2, 1], [2, 2589, 5, 52, 2, 1], [3, 2589, 10, 62, 2, 1], [4, 2318, 2, 300, 2, 0]] };
  const lm = new Date(now).toUTCString();
  const r = await runFeed({ houses: HOUSES.slice(0, 1), data: { 113: { auctions, lm, clm: lm } } }, { "113.snap.json.gz": prevSnap });
  assert.equal(r.code, 0, r.out);
  const lua = await r.lua();
  const queue = lua.match(/\n    queue = \{\n([^}]*)\n    \},\n/);
  assert.ok(queue, lua.slice(0, 1500));
  assert.deepEqual(queue[1].split("\n"), ["[2589]=25,"]);
  // What older addon versions parse with strict patterns: items "market,min,qty,avg7,avg30", sales "sold24,normal,auctions24".
  const block = (name) => lua.match(new RegExp(`\n    ${name} = \{\n([^}]*)\n    \},`))[1].split("\n");
  assert.deepEqual(block("items").sort(), ['[2318]="300,300,2,300,300",', '[2589]="50,50,35,50,50",']);
  const salesLines = block("sales");
  assert.ok(salesLines.length > 0);
  for (const l of salesLines) assert.match(l, /^\[\d+\]="\d+,-?\d+,\d+",$/);
});

test("A14: the median of the last 3 hours ships as `steady` for items with history, where it is 3%+ off", async () => {
  const now = Date.now(), H = 3600e3;
  // Linen at 50 now, 70 and 60 the hours before (median 60); Wool at 100 now, 102 and 99 (median 100);
  // Light Leather (2 listed, no history) at 300 now, 400 and 350 before.
  const auctions = [listing(1, 2589, 20, 50), listing(2, 2592, 20, 100), listing(3, 2318, 2, 300)];
  const q = (l, w, ll) => ({ 2589: [20, l], 2592: [20, w], 2318: [2, ll] });
  const hours = [{ t: now - 2 * H, s: {}, q: q(70, 102, 400), diff: false }, { t: now - H, s: {}, q: q(60, 99, 350), diff: false }];
  const lm = new Date(now).toUTCString();
  const r = await runFeed({ houses: HOUSES.slice(0, 1), data: { 113: { auctions, lm, clm: lm } } },
    { "113.json.gz": { days: {}, months: {}, hours, sales: {}, salesHours: {}, salesRules: 2 } });
  assert.equal(r.code, 0, r.out);
  assert.match(await r.lua(), /\n    steady = \{\n\[2589\]=60,\n    \},\n/, "Wool within 3%, Light Leather without history: not shipped");
});
