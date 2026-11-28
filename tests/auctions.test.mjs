// Tests for your auctions (Auctions.lua): reading your own auctions at the AH with
// the modern or the classic API, the saved look (replaced on each read, finished
// auctions dropped), and the "Your auctions" section of the Sell tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { luaVM, ADDON } from "./harness.mjs";

const FILES = fs.readFileSync(path.join(ADDON, "LootLedger.toc"), "utf8")
  .split(/\r?\n/).filter((l) => l.endsWith(".lua")).map((l) => l.replace(/\\/g, "/"));
const H = 3600;

// Light Leather (2318) on house 113: lowest 10s, 300 listed, 29 within 5% of the
// lowest, 240 bought on a normal day, vendor 5c. Linen Cloth (2589): no AH price.
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

// The modern API, answering with OWNED (base = the index of the first auction).
const MODERN = (base = 1) => `
  QUERIES = 0
  OWNED = {
    { auctionID = 11, itemKey = { itemID = 2318 }, quantity = 20, buyoutAmount = 1003, timeLeft = 3, status = 0 },
    { auctionID = 12, itemKey = { itemID = 2589 }, quantity = 5, buyoutAmount = 50, timeLeft = 1, timeLeftSeconds = 3600, status = 0 },
    { auctionID = 13, itemKey = { itemID = 2318 }, quantity = 1, buyoutAmount = 990, timeLeft = 2, status = 1 },  -- sold
  }
  C_AuctionHouse.QueryOwnedAuctions = function() QUERIES = QUERIES + 1 end
  C_AuctionHouse.GetNumOwnedAuctions = function() return #OWNED end
  C_AuctionHouse.GetOwnedAuctionInfo = function(i)
    if i < ${base} then error("bad index") end
    return OWNED[i - ${base} + 1]
  end
`;

// The classic API: GetAuctionItemInfo("owner", i), buyout for the whole stack.
const CLASSIC = `
  QUERIES = 0
  OWNER = { { id = 2318, count = 20, buyout = 20100, left = 2 }, { id = 2589, count = 4, buyout = 400, left = 4, sold = true } }
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
const sellRows = `(function() local out = {} for _, r in ipairs(ns.GetTab("sell").render("SELL")) do
  out[#out + 1] = (r.kind or "") .. ":" .. tostring(r.text or r.label or "") .. "|" .. tostring(r.note or "") .. "|" .. tostring(r.value or r.right or "") end
  return table.concat(out, string.char(10)) end)()`;

test("modern API: asks for your auctions when the AH opens, keeps the active ones", () => {
  const { run, get } = vm(MODERN());
  run(`FIRE("AUCTION_HOUSE_SHOW")`);
  assert.equal(get("QUERIES"), 1);
  run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  const a = "ns.db.auctions";
  assert.equal(get(`${a}.t`), get("NOW"));
  assert.equal(get(`#${a}.list`), 2, "the sold one is left out");
  assert.equal(get(`${a}.list[1].id`), 2318);
  assert.equal(get(`${a}.list[1].n`), 20);
  assert.equal(get(`${a}.list[1].unit`), 1003);
  assert.equal(get(`${a}.list[1].left`), 4);
  assert.equal(get(`${a}.list[1].lo - NOW`), 12 * H, "very long band: 12 to 48h");
  assert.equal(get(`${a}.list[1].hi - NOW`), 48 * H);
  assert.equal(get(`${a}.list[2].lo - NOW`), H, "exact seconds left when the client gives them");
  assert.equal(get(`${a}.list[2].hi - NOW`), H);
  run(`FIRE("AUCTION_HOUSE_AUCTION_CREATED", 99)`);
  assert.equal(get("QUERIES"), 2, "a new post asks again");
});

test("modern API counting from 0: the same auctions, none twice", () => {
  const { run, get } = vm(MODERN(0));
  run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(get("#ns.db.auctions.list"), 2);
});

test("classic API: unit price from the stack's buyout, classic time bands", () => {
  const { run, get } = vm(CLASSIC);
  run(`FIRE("AUCTION_HOUSE_SHOW")`);
  assert.equal(get("QUERIES"), 1);
  run(`FIRE("AUCTION_OWNED_LIST_UPDATE")`);
  assert.equal(get("#ns.db.auctions.list"), 1, "the sold one is left out");
  assert.equal(get("ns.db.auctions.list[1].unit"), 1005);
  assert.equal(get("ns.db.auctions.list[1].n"), 20);
  assert.equal(get("ns.db.auctions.list[1].lo - NOW"), H / 2, "medium: 30 min to 2h");
  assert.equal(get("ns.db.auctions.list[1].hi - NOW"), 2 * H);
});

test("each read replaces the last; auctions past their latest end drop out", () => {
  const { run, get } = vm(MODERN());
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
  assert.doesNotMatch(get(sellRows), /Your auctions/, "no section without auctions");
});

test("Sell tab: one row per auction against the lowest, its chance before it ends, and what to expect back", () => {
  const { run, get } = vm();
  // Seen 2h ago. A: 20 at 10s3c (3c above the lowest, within 5%: the 29 near the
  // lowest are ahead), 10 to 46h left. B: 5 at 12s (20% above: all 300 listed are
  // ahead), 1h left. C: no AH price. Deposit paid: 30c for 10 = 3c each.
  run(`
    ns.Trade.Posted(2318, 10, 30)
    ns.db.auctions = { t = NOW - 2 * 3600, list = {
      { id = 2318, n = 20, unit = 1003, left = 4, lo = NOW + 10 * 3600, hi = NOW + 46 * 3600 },
      { id = 2318, n = 5, unit = 1200, left = 2, lo = NOW + 3600, hi = NOW + 3600 },
      { id = 2589, n = 4, unit = 100, left = 3, lo = NOW, hi = NOW + 8 * 3600 },
    } }`);
  // The advice's chance for 24h at the lowest, 1 - exp(-perDay / (queue + qty)), for the time left.
  const pA = 1 - Math.exp(-240 / (29 + 20) * (28 / 24));
  const pB = 1 - Math.exp(-240 / (300 + 5) * (1 / 24));
  const backA = pA * 20 * (1003 * 0.95 + 3), backB = pB * 5 * (1200 * 0.95 + 3);
  run(`L = ns.Auctions.Live()`);
  assert.ok(Math.abs(get("L[1].chance") - pA) < 1e-9);
  assert.ok(Math.abs(get("L[1].back") - backA) < 1e-6);
  assert.ok(Math.abs(get("L[2].chance") - pB) < 1e-9);
  assert.ok(Math.abs(get("L[2].back") - backB) < 1e-6);
  assert.equal(get("L[3].chance"), null);
  assert.equal(get("L[3].back"), null);

  const text = plain(get(sellRows));
  const money = (c) => plain(get(`ns.Money(${c})`));
  assert.match(text, new RegExp(`section:Your auctions  \\(3\\)\\|\\|~${money(backA + backB)}`));
  assert.match(text, new RegExp(`As of 2 h ago, at the AH\\. Expected back ~${money(backA + backB)}`));
  assert.match(text, new RegExp(`row:Light Leather x20\\|10 3 each, 3 above the lowest, ${Math.round(pA * 100)}% chance it sells before it ends\\|${money(backA)}`));
  assert.match(text, new RegExp(`row:Light Leather x5\\|12 each, 2 above the lowest, ${Math.round(pB * 100)}% chance it sells before it ends\\|${money(backB)}`));
  assert.match(text, /row:Linen Cloth x4\|1 each, no AH price\|\?/);
});

test("at the lowest (or under it): 'lowest'", () => {
  const { run, get } = vm();
  run(`ns.db.auctions = { t = NOW, list = { { id = 2318, n = 1, unit = 999, left = 4, lo = NOW, hi = NOW + 24 * 3600 } } }`);
  assert.match(plain(get(sellRows)), /row:Light Leather x1\|9 99 each, lowest, \d+% chance/);
});

test("no owned-auctions API (or one that fails): nothing saved, nothing breaks, no section", () => {
  const { run, get } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW"); FIRE("OWNED_AUCTIONS_UPDATED"); FIRE("AUCTION_OWNED_LIST_UPDATE")`);
  assert.equal(get("ns.db.auctions"), null);
  assert.equal(get("ns.Auctions.Live()"), null);
  assert.doesNotMatch(get(sellRows), /Your auctions/);

  const broken = vm(MODERN());
  broken.run(`FIRE("OWNED_AUCTIONS_UPDATED")`);
  broken.run(`C_AuctionHouse.GetNumOwnedAuctions = function() error("not now") end; FIRE("OWNED_AUCTIONS_UPDATED")`);
  assert.equal(broken.get("#ns.db.auctions.list"), 2, "the last look is kept");
});
