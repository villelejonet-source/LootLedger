// node --test poller/feed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { carryOverHistory, readGzJson, fetchRetry, diffPlausible, snapshotTime, luaEscape, isHouseBlock } from "./feed.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "feed-"));

test("A1: history of houses not processed this run is carried over", async () => {
  const prev = await tmp(), out = await tmp();
  await writeFile(join(prev, "113.json.gz"), "h113");
  await writeFile(join(prev, "113.snap.json.gz"), "s113");
  await writeFile(join(prev, "114.json.gz"), "h114");
  await mkdir(join(prev, ".git")); // the cloned branch's git folder is not history
  assert.equal(await carryOverHistory(prev, out), 3);
  assert.deepEqual((await readdir(out)).sort(), ["113.json.gz", "113.snap.json.gz", "114.json.gz"]);
  assert.equal(await readFile(join(out, "113.snap.json.gz"), "utf8"), "s113");
});

test("A1: no previous history folder means nothing to carry over", async () => {
  const out = await tmp();
  assert.equal(await carryOverHistory(join(out, "missing"), out), 0);
});

test("A2: a missing file is null, a corrupt one throws", async () => {
  const dir = await tmp();
  assert.equal(await readGzJson(join(dir, "113.json.gz")), null);
  await writeFile(join(dir, "113.json.gz"), "not gzip");
  await assert.rejects(readGzJson(join(dir, "113.json.gz")));
  await writeFile(join(dir, "114.json.gz"), gzipSync(JSON.stringify({ days: {} })));
  assert.deepEqual(await readGzJson(join(dir, "114.json.gz")), { days: {} });
});

test("A7: fetchRetry retries thrown errors and bad statuses, gives up on 404", async () => {
  const real = globalThis.fetch;
  try {
    const seen = [];
    let n = 0;
    globalThis.fetch = async (url, init) => {
      seen.push(init.signal instanceof AbortSignal);
      if (n++ === 0) throw new TypeError("fetch failed");
      if (n === 2) return new Response("", { status: 503 });
      return new Response('{"ok":1}');
    };
    assert.deepEqual(await fetchRetry("http://x", {}, { delayMs: 1, read: (r) => r.json() }), { ok: 1 });
    assert.deepEqual(seen, [true, true, true]);
    n = 0;
    globalThis.fetch = async () => { n++; return new Response("", { status: 404 }); };
    await assert.rejects(fetchRetry("http://x", {}, { delayMs: 1 }), /404/);
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("A7: snapshot plausibility, time and Lua escaping", () => {
  const snap = (n) => ({ l: Array.from({ length: n }, () => []) });
  assert.equal(diffPlausible(null, snap(1)), true);
  assert.equal(diffPlausible(snap(10), snap(5)), true);
  assert.equal(diffPlausible(snap(10), snap(4)), false);
  assert.equal(snapshotTime("Mon, 23 Nov 2026 10:00:00 GMT", "Mon, 23 Nov 2026 11:00:00 GMT"), Date.parse("2026-11-23T11:00:00Z"));
  assert.equal(snapshotTime(null, "Mon, 23 Nov 2026 11:00:00 GMT"), Date.parse("2026-11-23T11:00:00Z"));
  assert.equal(luaEscape('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(luaEscape("a\nb"), "a\\nb");
});

test("security: a saved house block is reused only if it is plain data", () => {
  const ok = [
    `  [114] = { name = "${luaEscape('A "B" \\ ]] \n x')}", faction = "Alliance", updated = 1795879205, listings = 5, days = 1,\n` +
      `    items = {\n[2589]="77,77,5,0,0",\n    } },`,
    `  [114] = { name = "A", updated = 1, items = {}, steady = {\n[2589]=60,\n    },\n` +
      `    trending = { ready = false, hoursOfData = 12.5, baselineDays = 0, readyAt = 1795879205,\n` +
      `      hot = { "1,2,3", "4,5" }, cooling = {  } } },\n`,
  ];
  for (const b of ok) assert.equal(isHouseBlock(b, 114), true, b);
  const bad = [
    '  [113] = { name = "A" },',                                   // another house
    '  [114] = { name = "A" }',                                    // no comma at the end
    '  [114] = { name = "A" }, x = 1',                             // something after it
    '  [114] = { name = "A" } }, PWNED() x = { {',                 // closes the table and runs code
    '  [114] = { name = PWNED"x" },',                              // a call with a string
    '  [114] = { name = PWNED{} },',                               // a call with a table
    '  [114] = { name = NaN },',                                   // a name as a value
    '  [114] = { name = "a" .. "b" },',                            // an operator
    '  [114] = { n = 1 -2 },',
    '  [114] = { name = "A" }, -- comment',
    '  [114] = { name = [[long]] },',
    '  [114] = { ["x"] = 1 },',
    '  [114] = { end = 1 },',                                      // a keyword as a key: a syntax error
    '  [114] = { name = "a\nb" },',                               // a line break inside a string
    '  [114] = { name = "a\\x" },',                               // an escape luaEscape never writes
    '  [114] = { name = "A" ,',                                    // not closed
    '  [114] = ' + "{ a = ".repeat(20) + "1" + " }".repeat(20) + ",", // nested too deep
  ];
  for (const b of bad) assert.equal(isHouseBlock(b, 114), false, b);
});

test("isHouseBlock rejects whitespace Lua 5.1 doesn't accept (no-break space, BOM)", async () => {
  const { isHouseBlock } = await import("./feed.mjs");
  const ok = `  [114] = { name = "A", faction = "Horde", updated = 1, listings = 5, days = 1, items = {\n[2589]="1,1,1,1,1",\n    } },`;
  assert.equal(isHouseBlock(ok, 114), true);
  assert.equal(isHouseBlock(ok.replace("= {", "=\u00a0{"), 114), false);
  assert.equal(isHouseBlock("\ufeff" + ok, 114), false);
  assert.equal(isHouseBlock(ok + "\u00a0", 114), false);
});
