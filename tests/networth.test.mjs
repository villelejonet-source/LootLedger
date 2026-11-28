// Tests for net worth (Advisor.NetWorth): gold on every character plus their
// items at current prices, each character at its own auction house.
import { test } from "node:test";
import assert from "node:assert/strict";
import { luaVM } from "./harness.mjs";

const FILES = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Prices.lua", "Inventory.lua", "Advisor.lua"];

// Horde house 113 pays 10s for Light Leather, Alliance house 114 pays 20s.
// Vanish (Horde, logged in) has 10 gold, 10 leather, 5 grey junk, 3 of an item with
// no AH price. Alt (Alliance) has 5 gold and 10 leather in the bank.
const SETUP = `
  LootLedgerPrices = { updated = 1800000000, spd = {}, houses = {
    [113] = { name = "Horde", faction = "Horde", listings = 900, items = { [2318] = "1000,900,50,0,0" } },
    [114] = { name = "Alliance", faction = "Alliance", listings = 100, items = { [2318] = "2000,1900,50,0,0" } },
  } }
  ITEMS[2318] = { name = "Light Leather", sell = 15 }
  ITEMS[4000] = { name = "Grey Junk", sell = 13 }
  ITEMS[5000] = { name = "Odd Thing", sell = 40 }
  MONEY = 100000
  LootLedgerAccountDB = {
    items = { [2318] = { name = "Light Leather", quality = 1 }, [4000] = { name = "Grey Junk", quality = 0 },
              [5000] = { name = "Odd Thing", quality = 2 } },
    chars = {
      ["-Vanish"] = { name = "Vanish", realm = "" },
      ["-Alt"] = { name = "Alt", realm = "", faction = "Alliance", gold = 50000, inv = { bags = {}, bank = { [2318] = 10 }, mail = {} } },
    },
  }
`;

// After login (which rescans the logged-in character's bags).
const VANISH_BAGS = `ns.db.inv.bags = { [2318] = 10, [4000] = 5, [5000] = 3 }`;

test("net worth: gold on every character plus items, each at its own auction house", () => {
  const { run, get } = luaVM({ files: FILES, before: SETUP });
  run(VANISH_BAGS);
  const w = "ns.Advisor.NetWorth()";
  assert.equal(get(`${w}.gold`), 150000);
  // Vanish: 10 x 854 (posted 1c under the lowest, 8s99c, after the cut) + 5 x 13 (junk, vendor)
  //   + 3 x 40 (no AH price: vendor)
  // Alt: 10 x 1804 at the Alliance house (18s99c after the cut)
  assert.equal(get(`${w}.items`), 8540 + 65 + 120 + 18040);
  assert.equal(get(`${w}.total`), 150000 + 8540 + 65 + 120 + 18040);
  assert.equal(get(`${w}.unpriced`), 1);
  assert.equal(get(`${w}.chars[1].name`), "Vanish"); // richest first
  assert.equal(get(`${w}.chars[2].total`), 50000 + 18040);
});

test("net worth: an item the AH pays less for than a vendor counts at the vendor price", () => {
  const { run, get } = luaVM({ files: FILES, before: SETUP });
  run(`ITEMS[2318].sell = 1200`);
  assert.equal(get("ns.Advisor.UnitWorth(2318)"), 1200);
});
