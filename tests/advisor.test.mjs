// Tests for the advisor's sell/hold advice (Advisor.Decide): a real dip (20%+ below
// normal, demand steady, not falling) is held for a target until a deadline, then
// sold; smaller dips are listed; a drop with demand gone is sold; a sudden crash with
// no sales data says "check the AH"; "it's high, sell" only on fresh prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { luaVM } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];
const ID = 2318;
const NORMAL = 1000; // recent normal price (the history's baseline), copper

// One house in the feed with Light Leather at `market` now, 300 listed, `trend` (per mille
// a day), daily prices `daily` (oldest first), and optionally sales / a cooling list, the
// 3-hour median `steady`, the house's `drift`, the feed's `age` (seconds), `owned` units
// and saved `holds` (Lua table fields).
function feed({ market, daily = [1000, 1000, 1000, 1000, 1000], sales, cooling = false, trend = 0, steady, drift, age = 0, owned = 0, holds = "" }) {
  const hist = `d=${daily.map((v) => v.toString(36)).join(",")};t=${trend},${NORMAL.toString(36)},,`;
  const trending = cooling
    ? `trending = { ready = true, hoursOfData = 24, baselineDays = 5, cooling = { "${ID},20,10,100,,,6,1" } },`
    : "";
  return `
    LootLedgerPrices = { updated = NOW, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW - ${age}, listings = 900, dayLabels = {},
                ${drift != null ? `drift = ${drift},` : ""}
                items = { [${ID}] = "${market},${market},300,0,0" },
                ${steady != null ? `steady = { [${ID}] = ${steady} },` : ""}
                hist = { [${ID}] = "${hist}" },
                sales = { ${sales ? `[${ID}] = "${sales}"` : ""} },
                ${trending} },
    } }
    ITEMS[${ID}] = { name = "Light Leather", sell = 5 }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } }, holds = { ${holds} },
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113, inv = { bank = { [${ID}] = ${owned} } } } } }
  `;
}
const plain = (s) => s.replace(/\|c\w{8}|\|r|\|T[^|]*\|t/g, "");
const decide = (opts) => {
  const { get } = luaVM({ files: FILES, before: feed(opts) });
  return { action: get(`ns.Advisor.Decide(${ID}).action`), reason: plain(get(`ns.Advisor.Decide(${ID}).reason`)) };
};

test("price down and sales down: sell, demand dropped (not 'wait')", () => {
  const d = decide({ market: 600, sales: "10,100,5" }); // 10 bought in 24h, normally 100
  assert.equal(d.action, "SELL");
  assert.match(d.reason, /demand dropped \(10 sold in 24h, normally 100\)/);
});

test("price down and on the Cooling off list: sell", () => {
  const d = decide({ market: 600, cooling: true });
  assert.equal(d.action, "SELL");
  assert.match(d.reason, /demand dropped/);
});

test("a small dip (15% below) with demand steady: list, it rarely comes back", () => {
  // Was HOLD "a dip, wait" before holds needed 20%+ below normal.
  const d = decide({ market: 850, sales: "95,100,30" });
  assert.equal(d.action, "LIST");
  assert.match(d.reason, /^-15% vs normal, dips rarely come back/);
});

test("a real dip (30% below) with demand steady: hold up to 2 days for halfway back, then sell", () => {
  const d = decide({ market: 700, sales: "95,100,30" });
  assert.equal(d.action, "HOLD");
  assert.equal(d.reason, "-30% vs normal, demand steady: hold up to 2 days for 8 50+, then sell");
});

test("a real dip that is falling is sold, not held", () => {
  const d = decide({ market: 700, sales: "95,100,30", trend: -20 });
  assert.equal(d.action, "SELL");
  assert.match(d.reason, /^falling 2%\/day, sell before it drops/);
});

test("a sudden crash without sales data: check the AH, don't wait", () => {
  const d = decide({ market: 600 }); // 40% below normal, and below the last two days
  assert.equal(d.action, "CRASH");
  assert.match(d.reason, /dropped 40% since yesterday/);
});

test("steady demand wins over a crash: still a dip", () => {
  const d = decide({ market: 600, sales: "100,100,40" });
  assert.equal(d.action, "HOLD");
});

test("below normal for days already (not a crash today), no sales data: list, not hold", () => {
  // Was HOLD "vs normal, wait": without steady demand a dip isn't held any more.
  const d = decide({ market: 750, daily: [1000, 1000, 1000, 760, 750] });
  assert.equal(d.action, "LIST");
  assert.match(d.reason, /^-25% vs normal, dips rarely come back/);
});

test("too few normal sales to tell: demand unknown, not held", () => {
  const d = decide({ market: 850, sales: "0,3,0" }); // normally 3 a day: not enough to judge
  assert.equal(d.action, "LIST");
  assert.match(d.reason, /^-15% vs normal, dips rarely come back/);
});

// ---------------------------------------------------------------------------
// Holds end: remembered per owned item on the account, sold after 48 hours
// ---------------------------------------------------------------------------
test("a hold is remembered for an item you own, counts down, and after 48h turns into sell", () => {
  const { run, get } = luaVM({ files: FILES, before: feed({ market: 700, sales: "95,100,30", owned: 20 }) });
  const decide = () => { run(`D = ns.Advisor.Decide(${ID})`); return { action: get("D.action"), reason: plain(get("D.reason")) }; };
  assert.equal(decide().action, "HOLD");
  assert.equal(get(`ns.acc.holds[${ID}]`), get("NOW"), "the hold started now");
  run("NOW = NOW + 30 * 3600");
  assert.match(decide().reason, /: hold up to 18h for 8 50\+, then sell$/);
  run("NOW = NOW + 18 * 3600");
  const ended = decide();
  assert.equal(ended.action, "SELL");
  assert.match(ended.reason, /^hold ended: sell now \(-30% vs normal, demand steady\)/);
  run("NOW = NOW + 25 * 3600"); // a day after it ended: forgotten, a new hold starts
  assert.equal(decide().action, "HOLD");
  assert.equal(get(`ns.acc.holds[${ID}]`), get("NOW"));
});

test("holds are not remembered for items you don't own; ended ones are pruned at login", () => {
  const { get } = luaVM({ files: FILES, before: feed({ market: 700, sales: "95,100,30",
    holds: "[4306] = NOW - 100 * 3600, [2589] = NOW - 3600" }) });
  assert.equal(get(`ns.Advisor.Decide(${ID}).action`), "HOLD");
  assert.equal(get(`ns.acc.holds[${ID}]`), null);
  assert.equal(get("ns.acc.holds[4306]"), null, "ended over a day ago: pruned");
  assert.equal(get("ns.acc.holds[2589]"), get("NOW - 3600"));
});

// ---------------------------------------------------------------------------
// Steadier price now, house drift, fresh prices
// ---------------------------------------------------------------------------
test("the advice decides on the 3-hour median: a one-hour spike isn't 'sell now'", () => {
  assert.equal(decide({ market: 1400 }).action, "SELL");
  const d = decide({ market: 1400, steady: 1000 });
  assert.equal(d.action, "LIST");
  assert.equal(d.reason, "Normal price");
});

test("falling with the whole market: the reason says so", () => {
  assert.equal(decide({ market: 1000, trend: -20, drift: -15 }).reason, "falling 2%/day, whole market falling, sell before it drops");
  assert.equal(decide({ market: 1000, trend: -40, drift: -15 }).reason, "falling 4%/day, sell before it drops", "mostly the item itself");
  assert.equal(decide({ market: 1000, trend: -20 }).reason, "falling 2%/day, sell before it drops", "older feeds: no drift");
});

test("'high, sell now' only on prices under 2 hours old; older: check the AH first", () => {
  // +30% vs normal (3s more each: not a spike on its own)
  assert.equal(decide({ market: 1300, age: 3600 }).action, "SELL");
  const d = decide({ market: 1300, age: 3 * 3600 });
  assert.equal(d.action, "LIST");
  assert.equal(d.reason, "+30% vs normal 3 h ago: check the AH first");
  const spike = decide({ market: 3000, age: 5 * 3600 });
  assert.equal(spike.action, "LIST");
  assert.match(spike.reason, /^3x normal 5 h ago: check the AH first/);
  // Dips don't go stale the same way: still advised on an old feed.
  assert.equal(decide({ market: 700, sales: "95,100,30", age: 5 * 3600 }).action, "HOLD");
});

test("a scan of yours newer than the feed makes old feed prices fresh again", () => {
  const { run, get } = luaVM({ files: FILES, before: feed({ market: 1000, age: 5 * 3600, steady: 1000 }) });
  run(`ns.Scan = { Latest = function() return { t = NOW - 600, items = { [${ID}] = "1300,1300,300" } } end }; ns.Prices.ClearCache()`);
  assert.equal(get(`ns.Prices.Get(${ID}).steady`), null, "the scan is the price now");
  assert.equal(get(`ns.Advisor.Decide(${ID}).action`), "SELL");
});

// ---------------------------------------------------------------------------
// Time of week: an item's weekday pattern, or the whole house's hour-of-week pattern
// ---------------------------------------------------------------------------
const TUE = Date.parse("2026-12-01T10:30:00Z") / 1000; // a Tuesday
const SAT = Date.parse("2026-12-05T10:30:00Z") / 1000;
// Mon..Sun vs the week: Tuesday -8%, Saturday +10%. 3 weeks, 100% consistent, reliable.
const WEEKDAYS = "p=-60,-80,-40,0,50,100,30,3,100,1";
// Whole house: Friday 18:00-20:59 UTC +15%, everything else 0.
const FRIDAY = Array.from({ length: 168 }, (_, b) => (b >= 4 * 24 + 18 && b <= 4 * 24 + 20 ? 150 : 0)).join(",");

function timed({ market, now, weekdays = false, house = false, trend = 0 }) {
  const hist = `d=${[1000, 1000, 1000, 1000, 1000].map((v) => v.toString(36)).join(",")};` +
    (weekdays ? WEEKDAYS + ";" : "") + `t=${trend},${NORMAL.toString(36)},,`;
  const before = `
    NOW = ${now}
    LootLedgerPrices = { updated = NOW, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW, listings = 900, dayLabels = {},
                ${house ? `week = "${FRIDAY};3;1;1790000000",` : `week = "${",".repeat(167)};0;0;",`}
                items = { [${ID}] = "${market},${market},300,0,0" },
                hist = { [${ID}] = "${hist}" }, sales = {} },
    } }
    ITEMS[${ID}] = { name = "Light Leather", sell = 5 }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } },
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113 } } }
  `;
  const { get } = luaVM({ files: FILES, before });
  return { action: get(`ns.Advisor.Decide(${ID}).action`), reason: get(`ns.Advisor.Decide(${ID}).reason`) };
}

test("weekly pattern: a normal Tuesday price is held for Saturday, not listed now", () => {
  const d = timed({ market: 920, now: TUE, weekdays: true }); // Tuesday's usual price
  assert.equal(d.action, "HOLD");
  assert.equal(d.reason, "Normal price for now; list Sat, usually +20% then");
});

test("weekly pattern: Saturday at Saturday's usual price is the time to sell (not a spike)", () => {
  const d = timed({ market: 1100, now: SAT, weekdays: true });
  assert.equal(d.action, "SELL");
  assert.equal(d.reason, "Best time of the week, usually +10% vs the week");
});

test("weekly pattern: a Tuesday low is not called a dip, a real spike on Tuesday is still sold", () => {
  assert.doesNotMatch(timed({ market: 920, now: TUE, weekdays: true }).reason, /vs normal, wait/);
  const d = timed({ market: 1300, now: TUE, weekdays: true }); // +41% vs a usual Tuesday
  assert.equal(d.action, "SELL");
  assert.match(d.reason, /^\+41% vs normal/);
});

test("weekly pattern: a falling item is still sold on Tuesday", () => {
  const d = timed({ market: 920, now: TUE, weekdays: true, trend: -20 });
  assert.equal(d.action, "SELL");
  assert.match(d.reason, /^falling 2%\/day/);
});

test("without any weekly pattern the advice is as before", () => {
  assert.equal(timed({ market: 1000, now: TUE }).reason, "Normal price");
  assert.equal(timed({ market: 1100, now: SAT }).action, "SELL"); // +10% vs normal
});

test("whole-house pattern: an item without its own waits for Friday evening", () => {
  const d = timed({ market: 1000, now: TUE, house: true });
  assert.equal(d.action, "HOLD");
  assert.match(d.reason, /^Normal price for now; list Fri \d\d:00, usually \+15% then \(whole AH\)$/);
});

test("whole-house pattern: too little to gain on a cheap item, list now", () => {
  const d = timed({ market: 500, now: TUE, house: true }); // 15% of 5 silver is under 1 silver
  assert.notEqual(d.action, "HOLD");
});

test("item pattern plus house pattern: the item's best day at the house's best hour", () => {
  // The house's best hours are on Friday, not Saturday: Saturday's best hour is just its first.
  const d = timed({ market: 920, now: TUE, weekdays: true, house: true });
  assert.match(d.reason, /list Sat \d\d:00, usually \+20% then$/);
});
