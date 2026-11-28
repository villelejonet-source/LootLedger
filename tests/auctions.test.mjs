// Tests for this character's auctions (Auctions.lua): reading your own auctions at
// the AH with the modern or the classic API, the saved look (replaced on each read,
// finished auctions dropped), and their section in the Sell tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { luaVM, ADDON } from "./harness.mjs";

const FILES = fs.readFileSync(path.join(ADDON, "LootLedger.toc"), "utf8")
  .split(/\r?\n/).filter((l) => l.endsWith(".lua")).map((l) => l.replace(/\\/g, "/"));
const H = 3600;

// Light Leather (2318) on house 113, prices as of NOW: lowest 10s, 300 listed, 29
// within 5% of the lowest, 240 bought on a normal day, vendor 5c. Linen Cloth
// (2589): no AH price.
const WORLD = `
  LootLedgerPrices = { updated = NOW, spd = {}, houses = {
    [113] = { name = "Horde", faction = "Horde", updated = NOW, listings = 900, dayLabels = {},
              items = { [2318] = "1000,1000,300,0,0" }, queue = { [2318] = 29 },
              sales = { [2318] = "200,240,50" } },
  } }
  ITEMS[2318] = { name = "Light Leather", sell = 5 }
  ITEMS[2589] = { name = "Linen Cloth", sell = 13 }
  LootLedgerAccountDB = { items = { [2318] = { name = "Light Leather", quality = 1 } },
    chars = { ["-Vanish"] = { name = "Vanish", realm = "", house = 113 } } }
  SlashCmdList = {}
  StaticPopupDialogs = {}
  StaticPopup_Show = function() end
  tinsert, tremove = table.insert, table.remove
  wipe = function(t) for k in pairs(t) do t[k] = nil end return t end
  strsplit = function(sep, s) local out = {} for p in (s .. sep):gmatch("(.-)" .. sep) do out[#out + 1] = p end return unpack(out) end
  UISpecialFrames = {}
  IsShiftKeyDown, IsControlKeyDown, IsAltKeyDown = function() return false end, function() return false end, function() return false end
`;

// The modern API, answering with OWNED.
const MODERN = `
  QUERIES = 0
  OWNED = {
    { auctionID = 11, itemKey = { itemID = 2318 }, quantity = 20, buyoutAmount = 1003, timeLeft = 3, status = 0 },
    { auctionID = 12, itemKey = { itemID = 2589 }, quantity = 5, buyoutAmount = 50, timeLeft = 1, timeLeftSeconds = 3600, status = 0 },
    { auctionID = 13, itemKey = { itemID = 2318 }, quantity = 1, buyoutAmount = 990, timeLeft = 2, status = 1 },  -- sold
  }
  C_AuctionHouse.QueryOwnedAuctions = function() QUERIES = QUERIES + 1 end
  C_AuctionHouse.GetNumOwnedAuctions = function() return #OWNED end
  C_AuctionHouse.GetOwnedAuctionInfo = function(i) return OWNED[i] end
`;

// The classic API: GetAuctionItemInfo("owner", i), buyout for the whole stack.
const CLASSIC = `
  QUERIES = 0
  OWNER = { { id = 2318, count = 20, buyout = 20100, left = 2 }, { id = 2589, count = 4, buyout = 400, left = 4, sold = true },
            { id = 2589, count = 2, buyout = 0, left = 4 } }  -- bid only
  GetOwnerAuctionItems = function() QUERIES = QUERIES + 1 end
  GetNumAuctionItems = function(list) return list == "owner" and #OWNER or 0, #OWNER end
  GetAuctionItemInfo = function(list, i)
    local a = OWNER[i]
    return "name", 0, a.count, 1, true, 1, "", 1, 1, a.buyout, 0, false, nil, "Vanish", nil, a.sold and 1 or 0, a.id, true
  end
  GetAuctionItemTimeLeft = function(list, i) return OWNER[i].left end
`;

const vm = (before = "") => luaVM({ files: FILES, before: WORLD + before });
const plain = (s) => s.replace(/\|c\w{8}|\|r|\|T[^|]*\|t/g, "");
const sellRows = (filter = "ALL") => `(function() local out = {} for _, r in ipairs(ns.GetTab("sell").render("${filter}")) do
  out[#out + 1] = (r.kind or "") .. ":" .. tostring(r.text or r.label or "") .. "|" .. tostring(r.note) .. "|" .. tostring(r.value or r.right) end
  return table.concat(out, string.char(10)) end)()`;
// A look taken `ago` seconds before the prices (NOW), auctions { n, unit, lo, hi (hours from now) }.
const look = (list, ago = 0) => `ns.db.auctions = { t = NOW - ${ago}, list = { ${list.map((a) =>
  `{ id = ${a.id || 2318}, n = ${a.n}, unit = ${a.unit}, lo = NOW + ${a.lo} * 3600, hi = NOW + ${a.hi} * 3600 }`).join(", ")} } }`;
// The advice's model: 240 bought a day from the 29 near the lowest plus `yours`.
const chance = (days, yours) => 1 - Math.exp(-240 * days / (29 + yours));
const DEPOSIT = 2;  // the advice's 24h deposit estimate for a 5c vendor price
const back = (p, n, unit) => p * n * (unit * 0.95 + DEPOSIT);

test("modern API: asks for your auctions when the AH opens, keeps the active ones", () => {
  const { run, get } = vm(MODERN);
  run(`FIRE("AUCTION_HOUSE_SHOW")`);
  assert.equal(get("QUERIES"), 1);
  run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  const a = "ns.db.auctions";
  assert.equal(get(`${a}.t`), get("NOW"));
  assert.equal(get(`#${a}.list`), 2, "the sold one is left out");
  assert.equal(get(`${a}.list[1].id`), 2318);
  assert.equal(get(`${a}.list[1].n`), 20);
  assert.equal(get(`${a}.list[1].unit`), 1003);
  assert.equal(get(`${a}.list[1].lo - NOW`), 12 * H, "very long: 12 to 24h");
  assert.equal(get(`${a}.list[1].hi - NOW`), 24 * H);
  assert.equal(get(`${a}.list[2].lo - NOW`), H, "exact seconds left when the client gives them");
  assert.equal(get(`${a}.list[2].hi - NOW`), H);
  run(`FIRE("AUCTION_HOUSE_AUCTION_CREATED", 99)`);
  assert.equal(get("QUERIES"), 2, "a new post asks again");
});

test("classic API: unit price from the stack's buyout, classic time bands, bid-only skipped", () => {
  const { run, get } = vm(CLASSIC);
  run(`FIRE("AUCTION_HOUSE_SHOW")`);
  assert.equal(get("QUERIES"), 1);
  run(`FIRE("AUCTION_OWNED_LIST_UPDATE")`);
  assert.equal(get("#ns.db.auctions.list"), 1, "the sold one and the one without a buyout are left out");
  assert.equal(get("ns.db.auctions.list[1].unit"), 1005);
  assert.equal(get("ns.db.auctions.list[1].n"), 20);
  assert.equal(get("ns.db.auctions.list[1].lo - NOW"), H / 2, "medium: 30 min to 2h");
  assert.equal(get("ns.db.auctions.list[1].hi - NOW"), 2 * H);
});

test("each read replaces the last; auctions past their latest end drop out", () => {
  const { run, get } = vm(MODERN);
  run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(get("#ns.Auctions.Live()"), 2);
  run(`NOW = NOW + 2 * 3600`);
  assert.equal(get("#ns.Auctions.Live()"), 1, "the 1h auction has ended");
  assert.equal(get("ns.Auctions.Live()[1].id"), 2318);
  run(`table.remove(OWNED, 1); FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(get("#ns.db.auctions.list"), 1);
  assert.equal(get("ns.db.auctions.list[1].id"), 2589);
  assert.equal(get("ns.db.auctions.t"), get("NOW"));
  run(`OWNED = {}; FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(get("#ns.db.auctions.list"), 0);
  assert.doesNotMatch(get(sellRows()), /auctions/, "no section without auctions");
});

test("Sell tab (All): a row per auction against the lowest, its chance before it ends, the total expected back", () => {
  const { run, get } = vm();
  // Seen 2h before the prices (which so count your units already). A: 20 at 10s3c,
  // 10 to 22h left. B: 5 at 12s, 20% above the lowest. C: no AH price.
  run(look([{ n: 20, unit: 1003, lo: 10, hi: 22 }, { n: 5, unit: 1200, lo: 1, hi: 1 }, { id: 2589, n: 4, unit: 100, lo: 0, hi: 8 }], 2 * H));
  const pA = chance(16 / 24, 0), backA = back(pA, 20, 1003);
  run(`L = ns.Auctions.Live()`);
  assert.ok(Math.abs(get("L[1].chance") - pA) < 1e-9);
  assert.ok(Math.abs(get("L[1].back") - backA) < 1e-6);
  const text = plain(get(sellRows()));
  const money = (c) => plain(get(`ns.Money(${c})`));
  assert.match(text, new RegExp(`section:This character's auctions  \\(3\\)\\|nil\\|~${money(backA)}`));
  assert.match(text, /note:As of 2 h ago, at the AH\. Expected back: the chance to sell before it ends/);
  assert.match(text, new RegExp(`row:Light Leather x20\\|10 3 each, 3 above the lowest, ${Math.round(pA * 100)}% chance it sells before it ends\\|${money(backA)}`));
  assert.match(text, /row:Light Leather x5\|12 each, 2 above the lowest: sells only after cheaper ones\|\?/);
  assert.match(text, /row:Linen Cloth x4\|1 each, no AH price\|\?/);
});

test("the section shows under All only", () => {
  const { run, get } = vm();
  run(look([{ n: 1, unit: 999, lo: 2, hi: 12 }]));
  assert.match(get(sellRows("ALL")), /This character's auctions/);
  for (const f of ["SELL", "LIST", "HOLD", "CRASH", "VENDOR", "CHECK"]) assert.doesNotMatch(get(sellRows(f)), /auctions/, f);
});

test("at (or under) the lowest: 'lowest'", () => {
  const { run, get } = vm();
  run(look([{ n: 1, unit: 999, lo: 0, hi: 24 }]));
  assert.match(plain(get(sellRows())), /row:Light Leather x1\|9 99 each, lowest, \d+% chance/);
});

test("priced well above the lowest: no chance and nothing expected back, however high the price", () => {
  const { run, get } = vm();
  for (const mult of [1.06, 2, 20, 200]) {
    run(look([{ n: 20, unit: 1000 * mult, lo: 12, hi: 24 }]));
    run(`L = ns.Auctions.Live()`);
    assert.equal(get("L[1].above"), true, `${mult}x`);
    assert.equal(get("L[1].chance"), null, `${mult}x`);
    assert.equal(get("L[1].back"), null, `${mult}x`);
  }
  // Within 5%: the same chance as at the lowest.
  run(look([{ n: 20, unit: 1040, lo: 12, hi: 24 }]));
  assert.ok(Math.abs(get("ns.Auctions.Live()[1].chance") - chance(18 / 24, 20)) < 1e-9);
  // Nothing with a chance: no total in the header (not "~0").
  run(look([{ n: 20, unit: 5000, lo: 12, hi: 24 }]));
  assert.match(plain(get(sellRows())), /section:This character's auctions  \(1\)\|nil\|nil/);
});

test("several auctions of one item: one queue for all your units, the same as one big auction", () => {
  const { run, get } = vm();
  // Seen with the prices (not after): your 40 units join the 29 near the lowest.
  run(look([{ n: 20, unit: 1000, lo: 12, hi: 24 }, { n: 20, unit: 1000, lo: 12, hi: 24 }]));
  const p = chance(18 / 24, 40);
  run(`L = ns.Auctions.Live()`);
  assert.ok(Math.abs(get("L[1].chance") - p) < 1e-9);
  assert.ok(Math.abs(get("L[2].chance") - p) < 1e-9);
  const twoBacks = get("L[1].back + L[2].back");
  assert.ok(Math.abs(twoBacks - back(p, 40, 1000)) < 1e-6);
  run(look([{ n: 40, unit: 1000, lo: 12, hi: 24 }]));
  assert.ok(Math.abs(get("ns.Auctions.Live()[1].back") - twoBacks) < 1e-6);
  // A third auction far above the lowest doesn't join the queue.
  run(look([{ n: 20, unit: 1000, lo: 12, hi: 24 }, { n: 20, unit: 1000, lo: 12, hi: 24 }, { n: 50, unit: 3000, lo: 12, hi: 24 }]));
  assert.ok(Math.abs(get("ns.Auctions.Live()[1].chance") - p) < 1e-9);
});

test("prices newer than the look already count your units: not added to the queue again", () => {
  const { run, get } = vm();
  run(look([{ n: 20, unit: 1000, lo: 12, hi: 24 }], 60));
  assert.ok(Math.abs(get("ns.Auctions.Live()[1].chance") - chance(18 / 24, 0)) < 1e-9);
});

test("no owned-auctions API (or one that fails): nothing saved, nothing breaks, no section", () => {
  const { run, get } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW"); FIRE("OWNED_AUCTIONS_UPDATED"); FIRE("AUCTION_OWNED_LIST_UPDATE")`);
  assert.equal(get("ns.db.auctions"), null);
  assert.equal(get("ns.Auctions.Live()"), null);
  assert.doesNotMatch(get(sellRows()), /auctions/);

  const broken = vm(MODERN);
  broken.run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  broken.run(`C_AuctionHouse.GetNumOwnedAuctions = function() error("not now") end; FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(broken.get("#ns.db.auctions.list"), 2, "the last look is kept");
});
