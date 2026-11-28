// Tests for the posting advice (Advisor.PostPlan and its use in Advisor.Decide):
// the suggested price (1c under the lowest, or under the AH price when the lowest
// is a stray cheap listing), the chance to sell in a 24h auction, and one value
// per unit (relisted until it sells) used by the advice, the Sell tab, net worth,
// the tooltip and the vendor guard alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { luaVM } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];
const ID = 2318;
const NORMAL = 1000; // recent normal price (the history's baseline), copper

// Light Leather on house 113: `market`/`min` now, `listed` units, normal 1000 with
// `trend` (per mille a day), vendor price `vendor`, optional sales line and queue
// (units within 5% of the lowest), `owned` in the bank.
function vm({ market = 1000, min = market, listed = 300, vendor = 5, trend = 0, sales, queue, owned = 0, before = "", files = FILES }) {
  const hist = `d=${[1000, 1000, 1000, 1000, 1000].map((v) => v.toString(36)).join(",")};t=${trend},${NORMAL.toString(36)},,`;
  return luaVM({ files, before: `
    LootLedgerPrices = { updated = NOW, spd = {}, houses = {
      [113] = { name = "Horde", faction = "Horde", updated = NOW, listings = 900, dayLabels = {},
                items = { [${ID}] = "${market},${min},${listed},0,0" },
                hist = { [${ID}] = "${hist}" },
                ${queue != null ? `queue = { [${ID}] = ${queue} },` : ""}
                sales = { ${sales ? `[${ID}] = "${sales}"` : ""} } },
    } }
    ITEMS[${ID}] = { name = "Light Leather", sell = ${vendor} }
    LootLedgerAccountDB = { items = { [${ID}] = { name = "Light Leather", quality = 1 } },
      chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113, inv = { bank = { [${ID}] = ${owned} } } } } }
    ${before}
  ` });
}
const decide = (opts, qty = "nil") => {
  const { get, run } = vm(opts);
  run(`D = ns.Advisor.Decide(${ID}, ${qty})`);
  return { get, run, d: (k) => get(`D.${k}`) };
};
const plain = (s) => s.replace(/\|c\w{8}|\|r|\|T[^|]*\|t/g, "");
// One unit relisted until it sells: 0.95 * price - deposit * (1 - P) / P
const value = (price, p, dep) => Math.floor(0.95 * price - dep * (1 - p) / p);

test("the chance to sell in a 24h auction: 1 - exp(-perDay / (queue + yours))", () => {
  const { get } = decide({ sales: "200,240,50", queue: 29 }, 1);
  assert.ok(Math.abs(get("D.plan.chance") - (1 - Math.exp(-8))) < 1e-9);
  assert.equal(get("D.plan.queue"), 29);
  assert.equal(get("D.plan.perDay"), 240);
});

test("a normal-price item with sales data: post 1c under the lowest, the line says it likely sells in a day", () => {
  const { d } = decide({ sales: "200,240,50", queue: 29 });
  assert.equal(d("action"), "LIST");
  assert.equal(d("post"), 999);
  assert.equal(plain(d("reason")), "Normal price; post at 9 99, likely sells in a day");
  // 24h deposit estimate: 15% of the 5c vendor price per 12h, rounded up = 2c
  assert.equal(d("plan.deposit"), 2);
  assert.equal(d("unit"), value(999, 1 - Math.exp(-8), 2));
});

test("a slow item: the line gives the odds for a day", () => {
  // 12 a day, 60 in the queue + 1: 1 - exp(-12/61) = 18%
  const { d } = decide({ sales: "10,12,8", queue: 60 });
  assert.equal(plain(d("reason")), "Normal price; post at 9 99, about 18% chance a day");
});

test("a large stack (200) joins the queue: lower chance, still worth posting", () => {
  const one = decide({ sales: "200,240,50", queue: 29 }, 1).d;
  const many = decide({ sales: "200,240,50", queue: 29 }, 200).d;
  const p = 1 - Math.exp(-240 / 229);
  assert.ok(Math.abs(many("pSell") - p) < 1e-9);
  assert.ok(many("pSell") < one("pSell"));
  assert.equal(many("action"), "LIST");
  assert.match(plain(many("reason")), /about 65% chance a day$/);
  assert.equal(many("unit"), value(999, p, 2));
});

test("no sales data: no chance, the line is as before, worth 0.95 x the suggested price", () => {
  const { d } = decide({ queue: 29 });
  assert.equal(d("pSell"), null);
  assert.equal(d("post"), 999);
  assert.equal(d("reason"), "Normal price");
  assert.equal(d("unit"), Math.floor(999 * 0.95));
});

test("no queue in the feed (older feed or item without history): everything listed counts as ahead", () => {
  assert.equal(decide({ sales: "200,240,50", listed: 300 }).get("D.plan.queue"), 300);
});

test("thin market: keeps its original reason, the Market tab still gets a price", () => {
  const { d } = decide({ market: 1300, listed: 5, sales: "20,24,10", queue: 3 });
  assert.equal(d("action"), "LIST");
  assert.equal(d("reason"), "only 5 listed, price uncertain: check the AH");
  assert.equal(d("post"), 1299);
});

test("a stray cheap lowest listing (under 90% of the AH price) doesn't set the price", () => {
  const stray = decide({ market: 1000, min: 800, sales: "200,240,50", queue: 29 }).d;
  assert.equal(stray("action"), "LIST", "not held: there is no 85%-of-normal floor");
  assert.equal(stray("post"), 999, "1c under the AH price");
  assert.equal(decide({ market: 1000, min: 950, sales: "200,240,50", queue: 29 }).d("post"), 949, "a near lowest is undercut");
});

test("not worth posting now only when the lowest is under the vendor floor", () => {
  // Vendor 9s: posting must make 9s48c (9s / 0.95). AH 10s still beats the vendor, the lowest 9s40c doesn't.
  const { d, get } = decide({ market: 1000, min: 940, vendor: 900 });
  assert.equal(get("D.plan.vendorFloor"), 948);
  assert.equal(d("action"), "HOLD");
  assert.equal(plain(d("reason")), "Not worth posting now: lowest is under 9 48");
  assert.equal(d("unit"), 900, "worth the vendor price for now");
});

test("relisting: an item the AH pays 5x the vendor for, with a 25% chance a day, is NOT vendored", () => {
  // 23 a day, 79 ahead + 1: P = 1 - exp(-23/80) = 25%. Deposit 24h: 30% of 2s = 60c, lost ~3 times.
  const { d } = decide({ market: 1000, vendor: 200, sales: "23,23,10", queue: 79 }, 1);
  const p = 1 - Math.exp(-23 / 80);
  assert.ok(Math.abs(p - 0.25) < 0.01);
  assert.notEqual(d("action"), "VENDOR");
  assert.equal(d("unit"), value(999, p, 60));
  assert.ok(d("unit") > 700);
});

test("vendor better after relist costs: a slow seller behind a long queue is vendored", () => {
  // 7s on the AH, 5s at the vendor; 2 sold a day behind 200 others: ~100 relists at 1s50c deposit each.
  const slow = decide({ market: 700, vendor: 500, sales: "2,2,2", queue: 200 }).d;
  assert.equal(slow("action"), "VENDOR");
  assert.equal(slow("unit"), 500);
  assert.notEqual(decide({ market: 700, vendor: 500, sales: "200,240,50", queue: 20 }).d("action"), "VENDOR");
  assert.notEqual(decide({ market: 700, vendor: 500 }).d("action"), "VENDOR", "no sales data: 6s65 after the cut beats 5s");
});

test("one value: the same unit for HOLD and LIST, and in the Sell tab and net worth", () => {
  const list = decide({ sales: "200,240,50", queue: 29, owned: 20 });
  const hold = decide({ sales: "200,240,50", queue: 29, owned: 20, trend: 20 }); // rising 2%/day
  assert.equal(list.d("action"), "LIST");
  assert.equal(hold.d("action"), "HOLD");
  assert.equal(hold.d("unit"), list.d("unit"));
  const { get } = list;
  assert.equal(get(`ns.Advisor.UnitWorth(${ID})`), list.d("unit"));
  assert.equal(get("ns.Advisor.InventoryPlan()[1].total"), list.d("unit") * 20);
  assert.equal(list.d("plan.qty"), 20, "defaults to what you own");
});

test("deposit: the client's figure when it gives one, else 30% of the vendor price for 24h (rounded up)", () => {
  const dep = (api) => decide({ vendor: 33, sales: "200,240,50", queue: 29,
    before: api ? `C_AuctionHouse.CalculateCommodityDeposit = ${api}` : "" });
  assert.equal(dep().d("plan.deposit"), 10);
  assert.equal(dep().d("plan.estimated"), true);
  const real = dep("function(id, duration, n) return duration * 7 * n end");
  assert.equal(real.d("plan.deposit"), 14);
  assert.equal(real.d("plan.estimated"), false);
  assert.equal(dep("function() return nil end").d("plan.deposit"), 10);
  assert.equal(dep("function() return 0 end").d("plan.deposit"), 10);
  assert.equal(dep("function() error('AH closed') end").d("plan.deposit"), 10);
});

// ---------------------------------------------------------------------------
// Vendor guard: following Vendor advice never says "Sold below AH value"
// ---------------------------------------------------------------------------
const MERCHANT = `
  BUYBACK = {}
  GetNumBuybackItems = function() return #BUYBACK end
  GetBuybackItemLink = function(i) return BUYBACK[i] and LINK(BUYBACK[i].id) end
  GetBuybackItemInfo = function(i) local b = BUYBACK[i]; return "x", nil, b.price, b.qty end
  StaticPopupDialogs = {}
  POPUPS = 0
  StaticPopup_Show = function() POPUPS = POPUPS + 1 end
`;
function sellToVendor(opts, qty) {
  const { run, get } = vm({ ...opts, before: MERCHANT, files: [...FILES, "VendorGuard.lua"] });
  run(`FIRE("MERCHANT_SHOW")`);
  run(`BUYBACK[1] = { id = ${ID}, qty = ${qty}, price = ${qty} * ITEMS[${ID}].sell }; FIRE("MERCHANT_UPDATE")`);
  return { popups: get("POPUPS"), action: get(`ns.Advisor.Decide(${ID}, ${qty}).action`) };
}

test("vendor guard agrees with the advice: vendoring a Vendor item is quiet, a List item still warns", () => {
  // Old rule: 7s x 0.95 = 6s65 > 5s x 1.1, so this popped up although the advice said Vendor.
  const vendored = sellToVendor({ market: 700, vendor: 500, sales: "2,2,2", queue: 200 }, 5);
  assert.equal(vendored.action, "VENDOR");
  assert.equal(vendored.popups, 0);
  const listed = sellToVendor({ sales: "200,240,50", queue: 29 }, 5);
  assert.equal(listed.action, "LIST");
  assert.equal(listed.popups, 1);
});

// ---------------------------------------------------------------------------
// Tooltip: one advice line carries the price; no new rows
// ---------------------------------------------------------------------------
test("tooltip: the advice line has the price and chance, the tooltip got shorter, worth matches the advice", () => {
  const before = `
    Enum = { TooltipDataType = { Item = 0 } }
    TooltipDataProcessor = { AddTooltipPostCall = function(_, fn) TT_HOOK = fn end }
    TT = {}
    GameTooltip = {
      AddLine = function(_, s) TT[#TT + 1] = s end,
      AddDoubleLine = function(_, a, b) TT[#TT + 1] = a .. " | " .. b end,
    }
  `;
  const { run, get } = vm({ sales: "200,240,50", queue: 29, owned: 20, before, files: [...FILES, "Tooltip.lua"] });
  run(`TT_HOOK(GameTooltip, { id = ${ID} })`);
  const lines = [];
  for (let i = 1; i <= get("#TT"); i++) lines.push(plain(get(`TT[${i}]`)));
  // Before: advice, AH price, Listed, Normal price, Trend, Bought last 24h, Your 20 on the AH, You own, Alt+click = 9
  assert.equal(lines.length, 7, lines.join("\n"));
  assert.equal(lines[0], "Cutpurse Ledger: List | Normal price; post at 9 99, likely sells in a day");
  assert.match(lines[1], /AH price \| 10 each  \(300 listed\)/);
  assert.ok(!lines.some((l) => /Lowest listed|on the AH/.test(l)), lines.join("\n"));
  const total = get(`ns.Advisor.Decide(${ID}).unit`) * 20;
  assert.equal(total, get(`ns.Advisor.UnitWorth(${ID})`) * 20);
  const money = plain(get(`ns.Money(${total})`));
  assert.ok(lines.includes(`  You own 20  (Vanish 20), worth ~${money}`), lines.join("\n"));
});
