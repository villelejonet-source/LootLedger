// Tests for the advice's track record (Advisor.lua): the advice for each owned item
// is remembered once a day under the day of its price (not "look first" advice, not
// old prices), judged against that day's own daily price, a run of the same advice
// counting once, and summed up with the rate on any day in one line in the Sell tab
// (All only); plus your own AH results per item (Trade.Results) for the Market tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { luaVM, ADDON } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];
// Every file in .toc order, for the tabs.
const ALL_FILES = fs.readFileSync(path.join(ADDON, "LootLedger.toc"), "utf8")
  .split(/\r?\n/).filter((l) => l.endsWith(".lua")).map((l) => l.replace(/\\/g, "/"));
const WOW = `SlashCmdList = {}; StaticPopupDialogs = {}; StaticPopup_Show = function() end
  tinsert, tremove = table.insert, table.remove; UISpecialFrames = {}
  wipe = function(t) for k in pairs(t) do t[k] = nil end return t end
  IsShiftKeyDown, IsControlKeyDown, IsAltKeyDown = function() return false end, function() return false end, function() return false end`;
const ID = 2318;
const BASE = 1800000000; // the harness's time(): 08:00 UTC
const DAY = 86400;
const utc = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const D = (k, now = BASE) => utc(now - k * DAY); // the UTC day k days ago

// One house with Light Leather at `market` (`listed` units), prices `age` seconds old,
// daily prices `daily` (oldest first, null = no listings, the newest = today; null
// daily = no history), more items `extra` = { id: daily } with the same labels,
// `owned` units and saved `advice` (a Lua table). now: the clock (default BASE).
function vm({ market = 1000, listed = 300, age = 0, daily = [1000, 1000, 1000, 1000, 1000], extra = {}, owned = 10,
  advice = "{}", feed = true, now = BASE, files = FILES } = {}) {
  const enc = (vals) => `d=${vals.map((v) => (v == null ? "" : v.toString(36))).join(",")};t=0,${(1000).toString(36)},,`;
  const hist = { ...(daily ? { [ID]: daily } : {}), ...extra };
  const n = (daily || Object.values(extra)[0] || []).length;
  const before = `${WOW}
    NOW = ${now}
    ${feed ? `LootLedgerPrices = { updated = NOW - ${age}, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW - ${age}, listings = 900,
                dayLabels = { ${Array.from({ length: n }, (_, i) => `"${D(n - 1 - i, now)}"`).join(",")} },
                items = { [${ID}] = "${market},${market},${listed},0,0" },
                hist = { ${Object.entries(hist).map(([id, v]) => `[${id}] = "${enc(v)}"`).join(", ")} }, sales = {} },
    } }` : ""}
    ITEMS[${ID}] = { name = "Light Leather", sell = 5 }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } }, advice = ${advice},
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113, inv = { bank = { [${ID}] = ${owned} } } } } }
  `;
  return luaVM({ files, before });
}
const days = (get, id = ID) => get(`(function() local t = {} for k, v in pairs(ns.acc.advice and ns.acc.advice[113] and ns.acc.advice[113][${id}] or {}) do t[#t + 1] = k .. "=" .. v end table.sort(t) return table.concat(t, " ") end)()`);

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------
test("the advice for an owned item is remembered once a day, as one short string: the day's first counts", () => {
  const { run, get } = vm({ market: 1000 });
  run("ns.Advisor.InventoryPlan()");
  assert.equal(days(get), `${D(0)}=L`);
  // Later the same day the price jumps: still the morning's LIST.
  run(`LootLedgerPrices.houses[113].items[${ID}] = "1300,1300,300,0,0"; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(days(get), `${D(0)}=L`);
  // Next day, fresh prices: a new record.
  run(`NOW = NOW + ${DAY}; LootLedgerPrices.houses[113].updated = NOW; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(days(get), `${D(0)}=L ${D(-1)}=S`);
});

test("a hold is remembered with its target and deadline, and stays small", () => {
  const { run, get } = vm({ market: 700 });
  run(`LootLedgerPrices.houses[113].sales[${ID}] = "95,100,30"; ns.Prices.ClearCache(); ns.Advisor.InventoryPlan()`);
  assert.equal(days(get), `${D(0)}=H,800,${BASE + 48 * 3600}`);
  assert.ok(get(`#ns.acc.advice[113][${ID}]["${D(0)}"]`) <= 20);
});

test("not remembered: no history, no auction house, vendor advice, 'look first' (stale or thin) advice", () => {
  const none = (opts, extra = "") => { const x = vm(opts); x.run(`${extra} ns.Advisor.InventoryPlan()`); return days(x.get); };
  assert.equal(none({ daily: null }), "");
  assert.equal(none({ feed: false }), "");
  assert.equal(none({}, `ns.acc.items[${ID}].quality = 0;`), ""); // junk: Vendor
  // +30% on prices 3 hours old: "check the AH first" (stale)
  assert.equal(vm({ market: 1300, age: 3 * 3600 }).get(`ns.Advisor.Decide(${ID}).stale`), true);
  assert.equal(none({ market: 1300, age: 3 * 3600 }), "");
  // only 5 listed and 30% above: "price uncertain" (thin)
  assert.equal(vm({ market: 1300, listed: 5 }).get(`ns.Advisor.Decide(${ID}).thin`), true);
  assert.equal(none({ market: 1300, listed: 5 }), "");
});

test("filed under the day of the price; prices over 6 hours old aren't remembered", () => {
  const night = BASE - 6 * 3600; // 02:00 UTC
  let x = vm({ now: night, age: 4 * 3600 }); // the price is from 22:00 yesterday
  x.run("ns.Advisor.InventoryPlan()");
  assert.equal(days(x.get), `${D(1, night)}=L`);
  x = vm({ age: 7 * 3600 });
  x.run("ns.Advisor.InventoryPlan()");
  assert.equal(days(x.get), "");
});

test("advice older than 30 days is forgotten at login, and empty items and houses with it", () => {
  const old = D(31), recent = D(3);
  const { get } = vm({ advice: `{ [113] = { [${ID}] = { ["${old}"] = "S", ["${recent}"] = "L" }, [999] = { ["${old}"] = "S" } },
    [114] = { [7] = { ["${old}"] = "L" } } }` });
  assert.equal(days(get), `${recent}=L`);
  assert.equal(get("ns.acc.advice[113][999]"), null);
  assert.equal(get("ns.acc.advice[114]"), null);
});

// ---------------------------------------------------------------------------
// Judging, against the advice day's own daily price
// ---------------------------------------------------------------------------
function score(daily, advice, extra = {}) {
  const { get } = vm({ daily, extra, advice: `{ [113] = { ${advice} } }` });
  const s = (k) => `${get(`ns.Advisor.Score().${k}.right`)}/${get(`ns.Advisor.Score().${k}.n`)}`;
  return { S: s("S"), L: s("L"), H: s("H"), text: get("ns.Advisor.ScoreText()") };
}
const one = (records) => `[${ID}] = { ${records} }`;

test("SELL is right if the price 2 days later was no higher than that day's", () => {
  //             5d    4d    3d    2d    1d   today (running)
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  assert.equal(score(daily, one(`["${D(5)}"] = "S"`)).S, "1/1"); // 1000 -> 950
  assert.equal(score(daily, one(`["${D(4)}"] = "S"`)).S, "0/1"); // 1000 -> 1100
  assert.equal(score(daily, one(`["${D(3)}"] = "S"`)).S, "0/1"); // 950 -> 1000
  assert.equal(score(daily, one(`["${D(2)}"] = "S"`)).S, "0/0"); // 2 days later is today: not over
  assert.equal(score(daily, one(`["${D(40)}"] = "S"`)).S, "0/0"); // before the feed's days
});

test("LIST is right if that day's price was at least the next 2 days' average; a day without prices waits", () => {
  const daily = [1000, 1000, 1100, 900, null, 1000];
  assert.equal(score(daily, one(`["${D(5)}"] = "L"`)).L, "0/1"); // 1000 vs 1050
  assert.equal(score(daily, one(`["${D(4)}"] = "L"`)).L, "1/1"); // 1000 vs 1000
  assert.equal(score(daily, one(`["${D(3)}"] = "L"`)).L, "0/0"); // next: 900, no prices
});

test("HOLD is right if a day up to its deadline reached the target or that day's price", () => {
  const daily = [700, 720, 760, 820, 900, 900];
  const hold = (k, target, after) => `["${D(k)}"] = "H,${target},${BASE - k * DAY + after * DAY}"`;
  assert.equal(score(daily, one(hold(5, 750, 2))).H, "1/1");  // 760 within 2 days
  assert.equal(score(daily, one(hold(5, 800, 2))).H, "0/1");  // 820 only after the deadline
  assert.equal(score(daily, one(hold(5, 600, 2))).H, "1/1");  // target under the day's 700: needs 700, 720 does
  assert.equal(score([700, 650, 690, 900], one(hold(3, 600, 2))).H, "0/1"); // ...and 650, 690 don't
  assert.equal(score(daily, one(hold(2, 850, 2))).H, "0/0");  // deadline today: not over yet
  assert.equal(score(daily, one(hold(5, 750, 0))).H, "0/0");  // deadline on the advice day: nothing to judge, no error
});

test("a run of the same advice counts once, from its first day; a hold once per deadline", () => {
  const daily = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  assert.equal(score(daily, one(`["${D(7)}"] = "S", ["${D(6)}"] = "S", ["${D(5)}"] = "S"`)).S, "1/1");
  assert.equal(score(daily, one(`["${D(7)}"] = "S", ["${D(6)}"] = "L", ["${D(5)}"] = "S"`)).S, "2/2");
  // A gap breaks a run: two separate spells of SELL count twice.
  assert.equal(score(daily, one(`["${D(7)}"] = "S", ["${D(6)}"] = "S", ["${D(4)}"] = "S"`)).S, "2/2");
  // A hold is one hold by its deadline, even with a day missing in between.
  const ends = BASE - 4 * DAY;
  assert.equal(score(daily, one(`["${D(7)}"] = "H,1000,${ends}", ["${D(6)}"] = "H,1010,${ends}"`)).H, "1/1");
  assert.equal(score(daily, one(`["${D(7)}"] = "H,1000,${ends}", ["${D(5)}"] = "H,1010,${ends}"`)).H, "1/1");
});

test("a run whose first day has no price, or is before the feed's days, is judged from its first day with one", () => {
  //             7d    6d    5d   4d   3d   2d   1d  today
  const daily = [1000, null, 1000, 900, 900, 900, 900, 900];
  assert.equal(score(daily, one(`["${D(6)}"] = "S", ["${D(5)}"] = "S", ["${D(4)}"] = "S"`)).S, "1/1"); // from 5d: 1000 -> 900
  assert.equal(score(daily, one(`["${D(9)}"] = "S", ["${D(8)}"] = "S", ["${D(7)}"] = "S"`)).S, "1/1"); // 9d, 8d: before the labels
});

test("any day: the same rule's rate on every judgeable day of the item", () => {
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  const { get } = vm({ daily, advice: `{ [113] = { ${one(`["${D(5)}"] = "S", ["${D(4)}"] = "L"`)} } }` });
  // SELL any day: 1000 -> 950 yes, 1000 -> 1100 no, 950 -> 1000 no: 1 in 3.
  assert.equal(get("ns.Advisor.Score().S.base"), 1 / 3);
  // LIST any day: 1000 vs 975 yes, 1000 vs 1025 no, 950 vs 1050 no: 1 in 3.
  assert.equal(get("ns.Advisor.Score().L.base"), 1 / 3);
});

test("old table-format records are dropped at login, not crashed on", () => {
  const { get } = vm({ advice: `{ [113] = { [${ID}] = { ["${D(5)}"] = { a = "SELL", ah = 1000 }, ["${D(4)}"] = "S" } } }` });
  assert.equal(days(get), `${D(4)}=S`);
  assert.equal(get("ns.Advisor.ScoreText()"), null);
});

test("several items, one without a history any more: only the others are judged", () => {
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  const s = score(daily, `${one(`["${D(5)}"] = "S"`)}, [7] = { ["${D(5)}"] = "S" }, [8] = { ["${D(5)}"] = "S" }`, { 8: daily });
  assert.equal(s.S, "2/2");
});

// ---------------------------------------------------------------------------
// The Sell tab's line
// ---------------------------------------------------------------------------
test("summary: no line until a kind of advice has 5 judged; then the share right next to any day's", () => {
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  // Any day: 1000 -> 950 yes, 1000 -> 1100 no, 950 -> 1000 no: 1 in 3.
  const items = [ID, 11, 12, 13, 14];
  const extra = Object.fromEntries(items.slice(1).map((id) => [id, daily]));
  const sells = (ids) => ids.map((id) => `[${id}] = { ["${D(5)}"] = "S" }`).join(", ");
  assert.equal(score(daily, sells(items.slice(0, 4)), extra).text, null);
  const s = score(daily, sells(items), extra);
  assert.equal(s.S, "5/5");
  assert.equal(s.text, "Advice, last 30 days: sells beat waiting 2 days 100% (any day 33%, n=5)");
  assert.equal(vm({ feed: false }).get("ns.Advisor.ScoreText()"), null);
});

// ---------------------------------------------------------------------------
// Your AH results per item (Trade.Results)
// ---------------------------------------------------------------------------
test("results: per unit after the cut and lost deposits, share sold before expiring; vendor sales don't count", () => {
  const { run, get } = vm();
  assert.equal(get(`ns.Trade.Results(${ID})`), null); // nothing traded
  run(`ns.Trade.Vendored(${ID}, 20, 100, NOW)`);
  assert.equal(get(`ns.Trade.Results(${ID})`), null); // vendor sales only
  run(`
    ns.Trade.Posted(${ID}, 5, 50, NOW - 30 * 3600)
    ns.Trade.Posted(${ID}, 5, 50, NOW - 20 * 3600)
    ns.Trade.Sale(${ID}, 5, 4750, NOW - 10 * 3600)
    ns.Trade.Returned(${ID}, 5, NOW - 2 * 3600)   -- deposit 50 lost
    ns.Trade.Sale(${ID}, 5, 4750, NOW)
  `);
  assert.equal(get(`ns.Trade.Results(${ID}).sales`), 2);
  assert.equal(get(`ns.Trade.Results(${ID}).sold`), 10);
  assert.equal(get(`ns.Trade.Results(${ID}).back`), 5);
  assert.equal(get(`ns.Trade.Results(${ID}).unit`), 945); // (9500 - 50) / 10
});

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------
const plain = (s) => s.replace(/\|c\w{8}|\|r/g, "");
const texts = (get, tab, sub) => {
  const n = get(`(function() ROWS = ns.GetTab("${tab}").render("${sub}", nil, nil) return #ROWS end)()`);
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(plain([get(`ROWS[${i}].text`), get(`ROWS[${i}].label`), get(`ROWS[${i}].note`), get(`ROWS[${i}].value`)]
      .filter((x) => typeof x === "string").join(" | ")));
  }
  return out;
};

test("Sell tab: the score line in All only; Market tab: your results only with data", () => {
  const daily = [1000, 1000, 950, 1100, 1000, 500];
  const ids = [ID, 11, 12, 13, 14];
  const advice = `{ [113] = { ${ids.map((id) => `[${id}] = { ["${D(5)}"] = "S" }`).join(", ")} } }`;
  const x = vm({ daily, advice, files: ALL_FILES, extra: Object.fromEntries(ids.slice(1).map((id) => [id, daily])) });
  const line = "Advice, last 30 days: sells beat waiting 2 days 100% (any day 33%, n=5)";
  assert.ok(texts(x.get, "sell", "ALL").includes(line));
  assert.ok(!texts(x.get, "sell", "SELL").some((t) => /^Advice/.test(t)));

  x.run(`ns.ui.marketItem = ${ID}`);
  assert.ok(!texts(x.get, "market", "item").some((t) => /Your results/.test(t)));
  x.run(`ns.Trade.Posted(${ID}, 5, 50, NOW - 7200); ns.Trade.Sale(${ID}, 5, 4750, NOW)`);
  const m = texts(x.get, "market", "item");
  assert.ok(m.some((t) => /^Your results/.test(t)), m.join("\n"));
  assert.ok(m.some((t) => /^You got \| after the AH cut and lost deposits, 1 sale \| /.test(t)), m.join("\n"));
  assert.ok(m.includes("Sold before it expired | 5 sold, 0 came back unsold | 100%"), m.join("\n"));
});
