// Tests for the posting advice (Advisor.PostPlan and its use in Advisor.Decide):
// the suggested price (1c under the lowest, never under the floor), the chance to
// sell per auction length, expected net after the cut and deposit risk, and the
// tooltip that carries it on its one advice line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { luaVM } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];
const ID = 2318;
const NORMAL = 1000; // recent normal price (the history's baseline), copper

// Light Leather on house 113: `market`/`min` now, `listed` units, normal 1000 with a flat
// trend, vendor price `vendor`, optional sales line and queue (units within 5% of the lowest).
function vm({ market = 1000, min = market, listed = 300, vendor = 5, sales, queue, owned = 0, before = "", files = FILES }) {
  const hist = `d=${[1000, 1000, 1000, 1000, 1000].map((v) => v.toString(36)).join(",")};t=0,${NORMAL.toString(36)},,`;
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
  return { get, d: (k) => get(`D.${k}`) };
};
const plain = (s) => s.replace(/\|c\w{8}|\|r|\|T[^|]*\|t/g, "");

test("the chance to sell: 1 - exp(-rate * hours / (queue + yours)), from normal sales and the queue", () => {
  // 240 bought a normal day = 10 an hour; 29 in the queue + 1 of yours
  const { get } = decide({ sales: "200,240,50", queue: 29 });
  assert.ok(Math.abs(get("D.plan.by[1].chance") - (1 - Math.exp(-4))) < 1e-9);  // 12h
  assert.ok(Math.abs(get("D.plan.by[2].chance") - (1 - Math.exp(-8))) < 1e-9);  // 24h
  assert.equal(get("D.plan.queue"), 29);
  assert.equal(get("D.plan.perDay"), 240);
});

test("a normal-price item with sales data: post 1c under the lowest, the line says how likely it sells", () => {
  // 10 an hour, 9 in the queue + 1 of yours: gone within 12h
  const { d } = decide({ sales: "200,240,50", queue: 9 });
  assert.equal(d("action"), "LIST");
  assert.equal(d("post"), 999);
  assert.equal(d("hours"), 12, "sells fast and the deposit is small: no need for a longer auction");
  assert.equal(plain(d("reason")), "Normal price; post at 9 99, likely sells in 12h");
  // expected net = P * 0.95 * 999 - (1 - P) * deposit (12h: 15% of the 5c vendor price, rounded up = 1c)
  const p = 1 - Math.exp(-12);
  assert.equal(d("unit"), Math.floor(p * 0.95 * 999 - (1 - p) * 1));
});

test("a slow item: the line gives the odds, and the longer auction is picked when it pays more", () => {
  // 12 a day, 60 in the queue + 1: 12h 9%, 24h 18%, 48h 33%
  const { d, get } = decide({ sales: "10,12,8", queue: 60 });
  assert.equal(d("hours"), 48);
  assert.equal(plain(d("reason")), "Normal price; post at 9 99, 33% chance in 2 days");
  assert.ok(get("D.plan.by[3].net") > get("D.plan.by[1].net"));
});

test("your stack joins the queue: more of them, lower chance", () => {
  const one = decide({ sales: "200,240,50", queue: 29 }, 1).d("pSell");
  const many = decide({ sales: "200,240,50", queue: 29 }, 200).d("pSell");
  assert.ok(many < one, `${many} < ${one}`);
});

test("no sales data: no chance and the line is as before, valued at the suggested price after the cut", () => {
  const { d } = decide({ queue: 29 });
  assert.equal(d("pSell"), null);
  assert.equal(d("hours"), null);
  assert.equal(d("post"), 999);
  assert.equal(d("reason"), "Normal price");
  assert.equal(d("unit"), Math.floor(999 * 0.95));
});

test("no queue in the feed (older feed or item without history): everything listed counts as ahead", () => {
  const { get } = decide({ sales: "200,240,50", listed: 300 });
  assert.equal(get("D.plan.queue"), 300);
});

test("thin market: still a price and a chance, and the 'check the AH' warning stays", () => {
  const { d } = decide({ market: 1300, listed: 5, sales: "20,24,10", queue: 3 });
  assert.equal(d("action"), "LIST");
  assert.equal(d("post"), 1299);
  assert.match(plain(d("reason")), /^only 5 listed, price uncertain: check the AH; post at 12 99, likely sells in/);
});

test("lowest listing under the floor (85% of normal): not worth posting now, hold", () => {
  // The cheapest 15% average 1000 (normal), but one seller lists at 8s
  const { d } = decide({ market: 1000, min: 800, sales: "200,240,50", queue: 29 });
  assert.equal(d("action"), "HOLD");
  assert.equal(d("floor"), 850);
  assert.equal(d("post"), null);
  assert.equal(plain(d("reason")), "Not worth posting now: lowest is under 8 50");
});

test("demand gone: sold under 85% of normal anyway (the price isn't coming back)", () => {
  const { d } = decide({ market: 600, sales: "10,100,5", queue: 40 });
  assert.equal(d("action"), "SELL");
  assert.equal(d("post"), 599);
  assert.match(plain(d("reason")), /demand dropped .*unlikely to come back; post at 5 99, /);
});

test("vendor better once the deposit risk counts: a slow seller behind a long queue is vendored", () => {
  // 7s on the AH, 5s at the vendor: worth more on the AH by the old rule (6s65 after the cut),
  // but 2 sold a day behind 200 others: it almost surely expires and the deposit is lost.
  const slow = decide({ market: 700, vendor: 500, sales: "2,2,2", queue: 200 }).d;
  assert.equal(slow("action"), "VENDOR");
  assert.equal(slow("unit"), 500);
  // The same item when it sells: the AH.
  assert.notEqual(decide({ market: 700, vendor: 500, sales: "200,240,50", queue: 20 }).d("action"), "VENDOR");
  // No sales data: as before (6s65 after the cut beats 5s).
  assert.notEqual(decide({ market: 700, vendor: 500 }).d("action"), "VENDOR");
});

test("the floor never lets a post lose to the vendor", () => {
  // Normal 1000, vendor 900: posting must make at least 9s after the cut and deposit risk.
  const { d, get } = decide({ market: 1000, vendor: 900, sales: "200,240,50", queue: 29 });
  assert.ok(get("D.plan.vendorFloor") > 900 / 0.95, String(get("D.plan.vendorFloor")));
  assert.equal(d("floor"), get("D.plan.vendorFloor"));
  assert.equal(d("action"), "LIST");
  assert.ok(d("unit") >= 900);
});

test("deposit: the client's figure when it has one, else 15% of the vendor price per 12h (rounded up)", () => {
  const est = decide({ vendor: 33, sales: "200,240,50", queue: 29 }).get;
  assert.deepEqual([1, 2, 3].map((i) => est(`D.plan.by[${i}].deposit`)), [5, 10, 20]);
  const api = decide({ vendor: 33, sales: "200,240,50", queue: 29,
    before: "C_AuctionHouse.CalculateCommodityDeposit = function(id, duration, n) return duration * 7 * n end" }).get;
  assert.deepEqual([1, 2, 3].map((i) => api(`D.plan.by[${i}].deposit`)), [7, 14, 21]);
  const broken = decide({ vendor: 33, sales: "200,240,50", queue: 29,
    before: "C_AuctionHouse.CalculateCommodityDeposit = function() error('AH closed') end" }).get;
  assert.equal(broken("D.plan.by[1].deposit"), 5);
});

test("the Sell tab values a listed item at its expected net, for what you own", () => {
  const { get } = vm({ sales: "200,240,50", queue: 29, owned: 20 });
  const unit = get(`ns.Advisor.Decide(${ID}, 20).unit`);
  assert.ok(unit < 949, "less than the old 95% of market");
  assert.equal(get("ns.Advisor.InventoryPlan()[1].total"), unit * 20);
  assert.equal(get(`ns.Advisor.Decide(${ID}).plan.qty`), 20, "defaults to what you own");
});

// ---------------------------------------------------------------------------
// Tooltip: one advice line carries the price; no new rows
// ---------------------------------------------------------------------------
test("tooltip: the advice line has the price and chance, and the tooltip got shorter, not longer", () => {
  const before = `
    Enum = { TooltipDataType = { Item = 0 } }
    TooltipDataProcessor = { AddTooltipPostCall = function(_, fn) TT_HOOK = fn end }
    TT = {}
    GameTooltip = {
      AddLine = function(_, s) TT[#TT + 1] = s end,
      AddDoubleLine = function(_, a, b) TT[#TT + 1] = a .. " | " .. b end,
    }
  `;
  const { run, get } = vm({ sales: "200,240,50", queue: 9, owned: 1, before, files: [...FILES, "Tooltip.lua"] });
  run(`TT_HOOK(GameTooltip, { id = ${ID} })`);
  const lines = [];
  for (let i = 1; i <= get("#TT"); i++) lines.push(plain(get(`TT[${i}]`)));
  // Before: advice, AH price, Listed, Normal price, Trend, Bought last 24h, Your 1 on the AH, You own, Alt+click = 9
  assert.equal(lines.length, 7, lines.join("\n"));
  assert.match(lines[0], /^Cutpurse Ledger: List \| Normal price; post at 9 99, likely sells in 12h$/);
  assert.match(lines[1], /AH price \| 10 each  \(300 listed\)/);
  assert.ok(!lines.some((l) => /Lowest listed|on the AH/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("  You own 1  (Vanish 1), worth ~9 49"), lines.join("\n"));
});
