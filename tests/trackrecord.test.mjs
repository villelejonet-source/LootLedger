// Tests for the advice's track record (Advisor.lua): the day's first advice for each
// owned item is remembered (once a day, 30 days), judged against the feed's daily
// prices, and summed up in one line for the Sell tab; plus your own results per item
// (Trade.Results) for the Market tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { luaVM, ADDON } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];
const ID = 2318;
const NOW = 1800000000; // the harness's time()
const DAY = 86400;
const utc = (t) => new Date(t * 1000).toISOString().slice(0, 10);
// The feed's day labels: the last n UTC days, oldest first, the newest (today) still running.
const labels = (n) => Array.from({ length: n }, (_, i) => utc(NOW - (n - 1 - i) * DAY));

// One house with Light Leather at `market`, daily prices `daily` (oldest first, null = no
// listings, aligned with the last daily.length day labels; none = no history), `owned`
// units and saved `advice` (a Lua table).
function vm({ market = 1000, daily = [1000, 1000, 1000, 1000, 1000], owned = 10, advice = "{}", feed = true } = {}) {
  const hist = daily && `d=${daily.map((v) => (v == null ? "" : v.toString(36))).join(",")};t=0,${(1000).toString(36)},,`;
  const before = `
    ${feed ? `LootLedgerPrices = { updated = NOW, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW, listings = 900,
                dayLabels = { ${daily ? labels(daily.length).map((k) => `"${k}"`).join(",") : ""} },
                items = { [${ID}] = "${market},${market},300,0,0" },
                hist = { ${hist ? `[${ID}] = "${hist}"` : ""} }, sales = {} },
    } }` : ""}
    ITEMS[${ID}] = { name = "Light Leather", sell = 5 }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } }, advice = ${advice},
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113, inv = { bank = { [${ID}] = ${owned} } } } } }
  `;
  return luaVM({ files: FILES, before });
}
const recs = (get) => get(`(function() local n = 0 for _ in pairs(ns.acc.advice[113] and ns.acc.advice[113][${ID}] or {}) do n = n + 1 end return n end)()`);
const rec = (get, day, field) => get(`ns.acc.advice[113][${ID}]["${day}"].${field}`);

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------
test("the advice for an owned item is remembered once a day: the day's first counts", () => {
  const { run, get } = vm({ market: 1000 });
  run("ns.Advisor.InventoryPlan()");
  assert.equal(recs(get), 1);
  assert.equal(rec(get, utc(NOW), "a"), "LIST");
  assert.equal(rec(get, utc(NOW), "ah"), 1000);
  assert.ok(rec(get, utc(NOW), "unit") > 0);
  // Later the same day the price jumps: still the morning's LIST.
  run(`LootLedgerPrices.houses[113].items[${ID}] = "1300,1300,300,0,0"; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(recs(get), 1);
  assert.equal(rec(get, utc(NOW), "a"), "LIST");
  // Next day: a new record.
  run(`NOW = NOW + ${DAY}; LootLedgerPrices.houses[113].updated = NOW; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(recs(get), 2);
  assert.equal(rec(get, utc(NOW + DAY), "a"), "SELL");
  assert.equal(rec(get, utc(NOW + DAY), "ah"), 1300);
});

test("a hold is remembered with its target and deadline", () => {
  const { run, get } = vm({ market: 700 });
  run(`LootLedgerPrices.houses[113].sales[${ID}] = "95,100,30"; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(rec(get, utc(NOW), "a"), "HOLD");
  assert.equal(rec(get, utc(NOW), "target"), 800);
  assert.equal(rec(get, utc(NOW), "ends"), NOW + 48 * 3600);
});

test("nothing is remembered without a price history, an auction house, or for vendor / no-price advice", () => {
  let x = vm({ daily: null });
  x.run("ns.Advisor.InventoryPlan()");
  assert.equal(x.get("ns.acc.advice[113]"), null);
  x = vm({ feed: false });
  x.run("ns.Advisor.InventoryPlan()");
  assert.equal(x.get("next(ns.acc.advice)"), null);
  x = vm();
  x.run(`ns.acc.items[${ID}].quality = 0; ns.Advisor.InventoryPlan()`); // junk: Vendor
  assert.equal(x.get("ns.acc.advice[113]"), null);
});

test("advice older than 30 days is forgotten at login, and empty items and houses with it", () => {
  const old = utc(NOW - 31 * DAY), recent = utc(NOW - 3 * DAY);
  const { get } = vm({ advice: `{ [113] = { [${ID}] = { ["${old}"] = { a = "SELL", ah = 1 }, ["${recent}"] = { a = "LIST", ah = 1 } },
    [999] = { ["${old}"] = { a = "SELL", ah = 1 } } }, [114] = { [7] = { ["${old}"] = { a = "LIST", ah = 1 } } } }` });
  assert.equal(get(`ns.acc.advice[113][${ID}]["${old}"]`), null);
  assert.equal(get(`ns.acc.advice[113][${ID}]["${recent}"].a`), "LIST");
  assert.equal(get("ns.acc.advice[113][999]"), null);
  assert.equal(get("ns.acc.advice[114]"), null);
});

// ---------------------------------------------------------------------------
// Judging: daily prices for the last 6 days, d0 (5 days ago) .. today (running)
// ---------------------------------------------------------------------------
const D = (k) => utc(NOW - k * DAY); // k days ago
function score(daily, advice) {
  const { get } = vm({ daily, advice: `{ [113] = { [${ID}] = { ${advice} } } }` });
  const s = (k) => `${get(`ns.Advisor.Score(${ID}).${k}.right`)}/${get(`ns.Advisor.Score(${ID}).${k}.n`)}`;
  return { SELL: s("SELL"), LIST: s("LIST"), HOLD: s("HOLD"), days: get(`ns.Advisor.Score(${ID}).days`) };
}

test("SELL is right if its price was at least the price 2 days later", () => {
  //            5d    4d    3d    2d    1d   today
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  assert.equal(score(daily, `["${D(5)}"] = { a = "SELL", ah = 1000 }`).SELL, "1/1"); // 3d ago: 950
  assert.equal(score(daily, `["${D(4)}"] = { a = "SELL", ah = 1000 }`).SELL, "0/1"); // 2d ago: 1100
  // 2 days later is today, still running: not judged yet. Neither is a day before the labels.
  assert.equal(score(daily, `["${D(2)}"] = { a = "SELL", ah = 1000 }`).SELL, "0/0");
  assert.equal(score(daily, `["${D(40)}"] = { a = "SELL", ah = 1000 }`).SELL, "0/0");
});

test("LIST is right if its price was at least the average of the next 2 days; a day without prices waits", () => {
  const daily = [1000, 1000, 1100, 900, null, 1000];
  assert.equal(score(daily, `["${D(5)}"] = { a = "LIST", ah = 1000 }`).LIST, "0/1"); // next: 1000, 1100 -> 1050
  assert.equal(score(daily, `["${D(4)}"] = { a = "LIST", ah = 1000 }`).LIST, "1/1"); // next: 1100, 900 -> 1000
  assert.equal(score(daily, `["${D(3)}"] = { a = "LIST", ah = 1000 }`).LIST, "0/0"); // next: 900, no prices
});

test("HOLD is right if a day up to its deadline reached the target; judged once per hold", () => {
  const daily = [700, 720, 760, 820, 900, 900];
  const hold = (k, target, endsDaysLater) => `["${D(k)}"] = { a = "HOLD", ah = 700, target = ${target}, ends = ${NOW - k * DAY + endsDaysLater * DAY} }`;
  assert.equal(score(daily, hold(5, 750, 2)).HOLD, "1/1");  // 760 on day 2
  assert.equal(score(daily, hold(5, 800, 2)).HOLD, "0/1");  // 820 only after the deadline
  assert.equal(score(daily, hold(2, 850, 2)).HOLD, "0/0");  // deadline is today: not over yet
  // The same hold advised on 2 days counts once, from its first day.
  const ends = NOW - 5 * DAY + 2 * DAY;
  const s = score(daily, `["${D(5)}"] = { a = "HOLD", ah = 700, target = 750, ends = ${ends} },
    ["${D(4)}"] = { a = "HOLD", ah = 720, target = 790, ends = ${ends} }`);
  assert.equal(s.HOLD, "1/1");
  assert.equal(s.days, 2);
});

// ---------------------------------------------------------------------------
// The Sell tab's line
// ---------------------------------------------------------------------------
const plain = (s) => s.replace(/\|c\w{8}|\|r/g, "");

test("summary: collecting until a kind of advice has 5 judged", () => {
  let x = vm();
  assert.equal(x.get("ns.Advisor.ScoreText()"), "Advice score: collecting (0 days)");
  x = vm({ advice: `{ [113] = { [${ID}] = { ["${D(5)}"] = { a = "SELL", ah = 1000 }, ["${D(4)}"] = { a = "SELL", ah = 1000 } } } }` });
  assert.equal(x.get("ns.Advisor.ScoreText()"), "Advice score: collecting (2 days)");
  assert.equal(vm({ feed: false }).get("ns.Advisor.ScoreText()"), null); // no auction house: no line
});

test("summary: only kinds with enough judged advice, as a share right with n", () => {
  // 7 days of prices; SELL on 5 days (3 right), LIST on 1 (too few to show).
  const daily = [1000, 1000, 1000, 900, 1100, 900, 1000, 1000];
  const advice = [7, 6, 5, 4, 3].map((k) => `["${D(k)}"] = { a = "SELL", ah = 1000 }`);
  const { get } = vm({ daily, advice: `{ [113] = { [${ID}] = { ${advice.join(",")} }, [99] = { ["${D(7)}"] = { a = "LIST", ah = 1 } } } }` });
  // 2 days later: 1000 (right), 900 (right), 1100 (wrong), 900 (right), 1000 (right)
  assert.equal(plain(get("ns.Advisor.ScoreText()")), "Advice, last 30 days: sells beat waiting 2 days 80% (n=5)");
});

// ---------------------------------------------------------------------------
// Your results per item (Trade.Results)
// ---------------------------------------------------------------------------
test("results: per-unit price, share sold before expiring, typical time to sell", () => {
  const { run, get } = vm();
  assert.equal(get(`ns.Trade.Results(${ID})`), null); // nothing traded: nothing to show
  run(`
    ns.Trade.Posted(${ID}, 5, 50, NOW - 30 * 3600)
    ns.Trade.Posted(${ID}, 5, 50, NOW - 20 * 3600)
    ns.Trade.Sale(${ID}, 5, 4750, NOW - 10 * 3600)   -- 20h after its post
    ns.Trade.Returned(${ID}, 5, NOW - 2 * 3600)      -- the second came back
    ns.Trade.Posted(${ID}, 5, 50, NOW - 3600)
    ns.Trade.Sale(${ID}, 5, 4750, NOW)               -- 1h after its post
    ns.Trade.Sale(${ID}, 5, 4750, NOW)               -- no open post left: time unknown
  `);
  assert.equal(get(`ns.Trade.Results(${ID}).sold`), 15);
  assert.equal(get(`ns.Trade.Results(${ID}).back`), 5);
  assert.equal(get(`ns.Trade.Results(${ID}).sales`), 3);
  assert.ok(get(`ns.Trade.Results(${ID}).unit`) < 950); // after the lost deposit
  assert.equal(get(`ns.Trade.Results(${ID}).wait`), 3600); // median of 20h and 1h (lower middle)
});

test("no errors without history or trade data: empty score, no results", () => {
  const { get } = vm({ daily: null });
  assert.equal(get(`ns.Advisor.Score(${ID}).days`), 0);
  assert.equal(get(`ns.Advisor.Score(${ID}).SELL.n`), 0);
  assert.equal(get(`ns.Trade.Results(${ID})`), null);
  // Advice remembered, then the item's history went away: kept, not judged.
  const x = vm({ daily: null, advice: `{ [113] = { [${ID}] = { ["${D(5)}"] = { a = "SELL", ah = 1000 } } } }` });
  assert.equal(x.get(`ns.Advisor.Score(${ID}).SELL.n`), 0);
  assert.equal(x.get("ns.Advisor.ScoreText()"), "Advice score: collecting (1 day)");
});

// ---------------------------------------------------------------------------
// The rows: one line in the Sell tab, a short "Your results" block in the Market tab
// ---------------------------------------------------------------------------
test("Sell tab shows the score line; Market tab shows your results and the item's advice, only with data", () => {
  // Every file in .toc order, so the tabs are real.
  const files = fs.readFileSync(path.join(ADDON, "LootLedger.toc"), "utf8")
    .split(/\r?\n/).filter((l) => l.endsWith(".lua")).map((l) => l.replace(/\\/g, "/"));
  const wow = `SlashCmdList = {}; StaticPopupDialogs = {}; StaticPopup_Show = function() end
    tinsert, tremove = table.insert, table.remove; UISpecialFrames = {}
    wipe = function(t) for k in pairs(t) do t[k] = nil end return t end
    IsShiftKeyDown, IsControlKeyDown, IsAltKeyDown = function() return false end, function() return false end, function() return false end`;
  const daily = [1000, 1000, 950, 1100, 1000, 1000];
  const hist = `d=${daily.map((v) => v.toString(36)).join(",")};t=0,${(1000).toString(36)},,`;
  const make = (advice) => luaVM({ files, before: `${wow}
    LootLedgerPrices = { updated = NOW, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW, listings = 900,
                dayLabels = { ${labels(daily.length).map((k) => `"${k}"`).join(",")} },
                items = { [${ID}] = "1000,1000,300,0,0" }, hist = { [${ID}] = "${hist}" }, sales = {} } } }
    ITEMS[${ID}] = { name = "Light Leather", sell = 5 }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } }, advice = ${advice},
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113, inv = { bank = { [${ID}] = 10 } } } } }` });
  const texts = (get, tab, sub) => {
    const n = get(`(function() ROWS = ns.GetTab("${tab}").render("${sub}", nil, nil) return #ROWS end)()`);
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push(plain([get(`ROWS[${i}].text`), get(`ROWS[${i}].label`), get(`ROWS[${i}].note`), get(`ROWS[${i}].value`)]
        .filter((x) => typeof x === "string").join(" | ")));
    }
    return out;
  };

  // No trade, no advice yet: no results block in Market.
  let x = make("{}");
  x.run(`ns.ui.marketItem = ${ID}`);
  assert.ok(!texts(x.get, "market", "item").some((t) => /Your results/.test(t)));
  assert.ok(texts(x.get, "sell", "ALL").includes("Advice score: collecting (1 day)")); // the render remembered today's advice

  x = make(`{ [113] = { [${ID}] = { ["${D(5)}"] = { a = "SELL", ah = 1000 }, ["${D(4)}"] = { a = "LIST", ah = 1000 } } } }`);
  x.run(`ns.Trade.Posted(${ID}, 5, 50, NOW - 7200); ns.Trade.Sale(${ID}, 5, 4750, NOW); ns.ui.marketItem = ${ID}`);
  const m = texts(x.get, "market", "item");
  assert.ok(m.some((t) => /^Your results/.test(t)), m.join("\n"));
  assert.ok(m.some((t) => /^You got \| after the AH cut and lost deposits, 1 sale/.test(t)), m.join("\n"));
  assert.ok(m.includes("Sold before it expired | 5 sold, 0 came back unsold | 100%"), m.join("\n"));
  assert.ok(m.includes("Typical time to sell | from posting to taking the gold | 2h"), m.join("\n"));
  assert.ok(m.includes("Advice for it | right: sell now 1 of 1, list 0 of 1 | 2 days"), m.join("\n"));
});
