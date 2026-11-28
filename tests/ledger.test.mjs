// Tests for the gold log (Ledger.lua): which action a money change belongs to,
// and what reaches the trade record. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { luaVM } from "./harness.mjs";

const ITEMS = `
  ITEMS[2589] = { name = "Linen Cloth", sell = 13 }
  ITEMS[2318] = { name = "Light Leather", sell = 15 }
  ITEMS[2319] = { name = "Medium Leather", sell = 25 }
  ITEMS[5000] = { name = "Quest Thing", sell = 0 }
`;
const vm = () => {
  const v = luaVM();
  v.run(ITEMS);
  return v;
};

// A sale mail for `count` of an item: money = bid - cut + deposit.
const saleMail = (item, count, bid, cut, deposit) =>
  `{ sender = "Auction House", subject = "Auction successful: ${item}", money = ${bid - cut + deposit},
     invoice = { item = "${item}", bid = ${bid}, cut = ${cut}, deposit = ${deposit}, count = ${count} } }`;

test("harness: selling one stack to a vendor is logged and recorded", () => {
  const { run, log, trade } = vm();
  run(`FIRE("MERCHANT_SHOW")
       BAGS[0] = { [1] = { id = 2318, count = 20 } }
       C_Container.UseContainerItem(0, 1)
       GAIN(300)`);
  assert.deepEqual(log(), ["vendor_sell 300 2318 x20"]);
  assert.deepEqual(trade(), ["Vendored 2318 20 300"]);
});

test("harness: one AH sale mail is logged as a sale, the deposit apart", () => {
  const { run, log, trade } = vm();
  run(`INBOX[1] = ${saleMail("Linen Cloth", 20, 1000, 50, 30)}
       TakeInboxMoney(1)
       SERVER_TAKE_MONEY(1)`);
  assert.deepEqual(log(), ["ah_sale 950 x20", "ah_deposit_back 30"]);
  assert.deepEqual(trade(), ["Sale 2589 20 950"]);
});

const expired = (item, id, count) => `{ sender = "Auction House", subject = "Auction expired: ${item}", items = { [1] = { id = ${id}, count = ${count} } } }`;

test("B1: two expired mails for the same item, opened in a row, are two returns", () => {
  const { run, trade } = vm();
  run(`INBOX[1] = ${expired("Linen Cloth", 2589, 20)}
       INBOX[2] = ${expired("Linen Cloth", 2589, 20)}
       AutoLootMailItem(1); SERVER_TAKE_ITEM(1, 1)   -- first mail emptied and removed; the second moves up
       ADVANCE(1)
       AutoLootMailItem(1); SERVER_TAKE_ITEM(1, 1)`);
  assert.deepEqual(trade(), ["Returned 2589 20", "Returned 2589 20"]);
});

test("B1: with full bags, clicking the same mail again later records nothing until the items really arrive", () => {
  const { run, trade } = vm();
  run(`INBOX[1] = ${expired("Linen Cloth", 2589, 20)}
       TakeInboxItem(1, 1); FIRE("MAIL_INBOX_UPDATE")   -- bags full: nothing moves
       ADVANCE(6)
       TakeInboxItem(1, 1); FIRE("MAIL_INBOX_UPDATE")`);
  assert.deepEqual(trade(), []);
  run(`ADVANCE(6)
       TakeInboxItem(1, 1); SERVER_TAKE_ITEM(1, 1)`);
  assert.deepEqual(trade(), ["Returned 2589 20"]);
});

test("B1: a return waiting for its mail is dropped when the mailbox closes or after a few seconds", () => {
  const { run, trade } = vm();
  run(`INBOX[1] = ${expired("Linen Cloth", 2589, 20)}
       TakeInboxItem(1, 1); FIRE("MAIL_CLOSED"); SERVER_TAKE_ITEM(1, 1)
       INBOX[1] = ${expired("Light Leather", 2318, 5)}
       TakeInboxItem(1, 1); ADVANCE(10); SERVER_TAKE_ITEM(1, 1)`);
  assert.deepEqual(trade(), []);
});

test("B1: another mail leaving doesn't count a waiting click", () => {
  const { run, trade } = vm();
  run(`INBOX[1] = { sender = "Bob", subject = "hi", money = 500 }
       INBOX[2] = ${expired("Linen Cloth", 2589, 20)}
       TakeInboxItem(2, 1)          -- bags full, nothing moves
       TakeInboxMoney(1); SERVER_TAKE_MONEY(1)`);
  assert.deepEqual(trade(), []);
});

test("B2: two sale mails taken back to back each get their own money", () => {
  const { run, log, trade } = vm();
  run(`INBOX[1] = ${saleMail("Linen Cloth", 20, 1000, 50, 30)}       -- 980 arrives
       INBOX[2] = ${saleMail("Light Leather", 10, 2000, 100, 40)}   -- 1940 arrives
       TakeInboxMoney(1); TakeInboxMoney(2)
       GAIN(980); GAIN(1940)`);
  assert.deepEqual(log(), ["ah_sale 950 x20", "ah_deposit_back 30", "ah_sale 1900 x10", "ah_deposit_back 40"]);
  assert.deepEqual(trade(), ["Sale 2589 20 950", "Sale 2318 10 1900"]);
});

test("B2: a sale mail's money is matched by its amount when it arrives out of order", () => {
  const { run, trade } = vm();
  run(`INBOX[1] = ${saleMail("Linen Cloth", 20, 1000, 50, 30)}
       INBOX[2] = ${saleMail("Light Leather", 10, 2000, 100, 40)}
       TakeInboxMoney(1); TakeInboxMoney(2)
       GAIN(1940); GAIN(980)`);
  assert.deepEqual(trade(), ["Sale 2318 10 1900", "Sale 2589 20 950"]);
});

test("B2: two posts back to back each get their own deposit", () => {
  const { run, log, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.PostItem({ id = 2589 }, 1, 20)
       C_AuctionHouse.PostItem({ id = 2318 }, 1, 10)
       GAIN(-60); GAIN(-45)`);
  assert.deepEqual(log(), ["ah_deposit -60", "ah_deposit -45"]);
  assert.deepEqual(trade(), ["Posted 2589 20 60", "Posted 2318 10 45"]);
});

test("B2: a flag of the other direction stays queued for its own money", () => {
  const { run, log, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.PostItem({ id = 2589 }, 1, 20)
       GAIN(500)     -- an outbid refund arrives first
       GAIN(-60)`);
  assert.deepEqual(log(), ["ah_refund 500", "ah_deposit -60"]);
  assert.deepEqual(trade(), ["Posted 2589 20 60"]);
});

test("B3: right-clicking an item with no sell price doesn't take the next sale's gold", () => {
  const { run, log, trade } = vm();
  run(`FIRE("MERCHANT_SHOW")
       BAGS[0] = { [1] = { id = 5000, count = 1 }, [2] = { id = 2318, count = 20 } }
       C_Container.UseContainerItem(0, 1)   -- quest item: can't be sold
       C_Container.UseContainerItem(0, 2)
       GAIN(300)`);
  assert.deepEqual(log(), ["vendor_sell 300 2318 x20"]);
  assert.deepEqual(trade(), ["Vendored 2318 20 300"]);
});

test("B3: a sale is matched by its amount; clicks before it that sold nothing are dropped", () => {
  const { run, log, trade } = vm();
  run(`FIRE("MERCHANT_SHOW")
       BAGS[0] = { [1] = { id = 2319, count = 5 }, [2] = { id = 2318, count = 20 }, [3] = { id = 2589, count = 4 } }
       C_Container.UseContainerItem(0, 1)   -- didn't sell (say, the vendor refused)
       C_Container.UseContainerItem(0, 2)
       C_Container.UseContainerItem(0, 3)
       GAIN(300)                            -- 20 x 15: the Light Leather
       GAIN(777)                            -- matches nothing queued: no item named
       GAIN(52)                             -- 4 x 13: the Linen Cloth`);
  assert.deepEqual(log(), ["vendor_sell 300 2318 x20", "vendor_sell 777", "vendor_sell 52 2589 x4"]);
  assert.deepEqual(trade(), ["Vendored 2318 20 300", "Vendored 2589 4 52"]);
});

test("B4: clicking a sale mail whose money is already taken doesn't label the next money change", () => {
  const { run, log, trade } = vm();
  run(`INBOX[1] = { sender = "Auction House", subject = "Auction successful: Linen Cloth", money = 0,
                    invoice = { item = "Linen Cloth", bid = 1000, cut = 50, deposit = 30, count = 20 } }
       INBOX[2] = { sender = "Bob", subject = "for you", money = 500 }
       AutoLootMailItem(1)
       TakeInboxMoney(2); SERVER_TAKE_MONEY(2)`);
  assert.deepEqual(log(), ["mail_in 500"]);
  assert.deepEqual(trade(), []);
});

test("security: a player's mail is never taken for the Auction House's, whatever its subject or sender name", () => {
  const { run, log, trade } = vm();
  run(`INBOX[1] = { sender = "Auctionx", subject = "Auction expired: Linen Cloth", canReply = true, items = { [1] = { id = 2589, count = 20 } } }
       AutoLootMailItem(1); SERVER_TAKE_ITEM(1, 1)
       INBOX[1] = { sender = "Auctionx", subject = "Auction cancelled: Linen Cloth", canReply = true, money = 500 }
       TakeInboxMoney(1); SERVER_TAKE_MONEY(1)`);
  assert.deepEqual(trade(), []);
  assert.deepEqual(log(), ["mail_in 500"]);
  // The same from the Auction House itself (can't be replied to): a return and a refund.
  run(`INBOX[1] = ${expired("Linen Cloth", 2589, 20)}
       AutoLootMailItem(1); SERVER_TAKE_ITEM(1, 1)
       INBOX[1] = { sender = "Auction House", subject = "Outbid on Linen Cloth", money = 300 }
       TakeInboxMoney(1); SERVER_TAKE_MONEY(1)`);
  assert.deepEqual(trade(), ["Returned 2589 20"]);
  assert.deepEqual(log(), ["mail_in 500", "ah_refund 300"]);
});

test("B5: a quest flag only takes money gained, so a purchase right after a turn-in isn't 'Quests'", () => {
  const { run, log } = vm();
  run(`FIRE("MERCHANT_SHOW")
       GetQuestReward(1); FIRE("QUEST_TURNED_IN", 100, 0, 0)
       GAIN(1200)            -- the quest's money
       BuyMerchantItem(1, 1)
       ADVANCE(1); GAIN(-500)`);
  assert.deepEqual(log(), ["quest 1200", "vendor_buy -500"]);
});

test("B5: choosing a quest reward alone sets no flag (QUEST_TURNED_IN does)", () => {
  const { run, log } = vm();
  run(`GetQuestReward(1)
       GAIN(-500)`);
  assert.deepEqual(log(), ["other -500"]);
});

// Account data from before this character logs in: a Horde and an Alliance character
// that each gathered 100 Light Leather, and one saved before factions were kept.
const SAVED_CHARS = `
  LootLedgerAccountDB = { chars = {
    ["-Horde"]    = { name = "Horde", realm = "", faction = "Horde", acts = { skinning = { items = { [2318] = 100 } } } },
    ["-Alliance"] = { name = "Alliance", realm = "", faction = "Alliance", acts = { skinning = { items = { [2318] = 100 } } } },
  } }
`;
const OLD_CHAR = `LootLedgerAccountDB.chars["-Old"] = { name = "Old", realm = "", acts = { skinning = { items = { [2318] = 100 } } } }`;

test("B6: profession credit only counts characters of the same faction", () => {
  const { run, get } = luaVM({ before: SAVED_CHARS + `FACTION = "Alliance"; UnitName = function() return "Alliance" end` });
  assert.equal(get(`ns.db.faction`), "Alliance");
  run(`ns.Trade.Sale(2318, 100, 100 * 600)`);
  assert.equal(get(`ns.Trade.Credit(2318, 100, 0).sold`), 100);
});

test("B6: characters saved before factions were kept still count, until they log in", () => {
  const { run, get } = luaVM({ before: SAVED_CHARS + OLD_CHAR + `FACTION = "Alliance"; UnitName = function() return "Alliance" end` });
  run(`ns.Trade.Sale(2318, 100, 100 * 600)`);
  assert.equal(get(`ns.Trade.Credit(2318, 100, 0).sold`), 50); // Alliance + Old gathered 200
});

test("B6: inventory lists only characters sharing the auction house", () => {
  const { get } = luaVM({
    files: ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "Inventory.lua"],
    before: SAVED_CHARS + OLD_CHAR + `FACTION = "Alliance"; UnitName = function() return "Alliance" end`,
  });
  const names = get(`(function() local t = {} for _, ch in ipairs(ns.Inventory.RealmChars()) do t[#t + 1] = ch.name end table.sort(t) return table.concat(t, ",") end)()`);
  assert.equal(names, "Alliance,Old");
});

test("B7: a post from an empty item location doesn't throw; its deposit is still logged", () => {
  const { run, log, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.PostItem({ exists = false }, 1, 20)
       GAIN(-60)`);
  assert.deepEqual(log(), ["ah_deposit -60"]);
  assert.deepEqual(trade(), []);
});

test("B7: GetItemID throwing even for an existing location doesn't break the hook", () => {
  const { run, log } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_Item.GetItemID = function() error("boom") end
       C_AuctionHouse.PostItem({ id = 2589 }, 1, 20)
       GAIN(-60)`);
  assert.deepEqual(log(), ["ah_deposit -60"]);
});

test("B8: a post whose deposit never comes is recorded with deposit 0 when its flag expires", () => {
  const { run, log, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.PostItem({ id = 2589 }, 1, 20)   -- no money moves
       ADVANCE(11)`);
  assert.deepEqual(trade(), ["Posted 2589 20 0"]);
  assert.deepEqual(log(), []);
});

test("B8: a post whose deposit did come is recorded once", () => {
  const { run, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.PostItem({ id = 2589 }, 1, 20)
       GAIN(-60)
       ADVANCE(11)`);
  assert.deepEqual(trade(), ["Posted 2589 20 60"]);
});

test("B9: a bid is logged as an AH purchase but not recorded as bought", () => {
  const { run, log, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.SendSearchQuery({ itemID = 2589 })
       C_AuctionHouse.PlaceBid(12345, 5000)
       GAIN(-5000)`);
  assert.deepEqual(log(), ["ah_buy -5000"]);
  assert.deepEqual(trade(), []);
});

test("B9: commodity purchases are still recorded as bought", () => {
  const { run, trade } = vm();
  run(`FIRE("AUCTION_HOUSE_SHOW")
       C_AuctionHouse.StartCommoditiesPurchase(2589, 20)
       C_AuctionHouse.ConfirmCommoditiesPurchase(2589, 20)
       GAIN(-1000)`);
  assert.deepEqual(trade(), ["Bought 2589 20 1000"]);
});

test("C1: LossRate is cached until a sale, return or vendor sale changes it", () => {
  const { run, get } = vm();
  run(`ns.Trade.Posted(1, 1, 100, NOW); ns.Trade.Returned(1, 1, NOW)
       ns.Trade.Sale(2, 1, 1000, NOW)`);
  assert.equal(get("ns.Trade.LossRate()"), 0.1);
  run(`ns.Trade.Item(2).sales[1].net = 500`);          // changed behind its back: still cached
  assert.equal(get("ns.Trade.LossRate()"), 0.1);
  run(`ns.Trade.Sale(2, 1, 500, NOW)`);                // 1000 earned in all now, 100 lost
  assert.equal(get("ns.Trade.LossRate()"), 0.1);
  run(`ns.Trade.Returned(1, 1, NOW); ns.Trade.Item(1).lost[2].dep = 100; ns.Trade.Vendored(3, 1, 5, NOW)`);
  assert.equal(get("ns.Trade.LossRate()"), 0.2);
});

test("C1: LossRate isn't shared between stores (another faction)", () => {
  const { run, get } = vm();
  run(`ns.Trade.Posted(1, 1, 100, NOW); ns.Trade.Returned(1, 1, NOW); ns.Trade.Sale(2, 1, 1000, NOW)`);
  assert.equal(get("ns.Trade.LossRate()"), 0.1);
  run(`FACTION = "Alliance"`);
  assert.equal(get("ns.Trade.LossRate()"), 0);
});

test("C1: the box only refreshes while it's shown, and catches up when shown", () => {
  const { run, get } = luaVM({
    files: ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua", "UI/Box.lua"],
    before: `ns.Theme = { C = { line = {}, muted = { 1, 1, 1 } }, GOLD_ICON = "",
                          Panel = function() end, Icon = function() return setmetatable({}, MAGIC) end,
                          Fill = function() return setmetatable({}, MAGIC) end, ActivityIcon = function() end }`,
  });
  run(`SUMS = 0
       local sum = ns.Ledger.Sum
       ns.Ledger.Sum = function(...) SUMS = SUMS + 1; return sum(...) end
       ns.box:Hide()
       ns.Refresh(); ns.Refresh()`);
  assert.equal(get("SUMS"), 0);
  run(`ns.box:Show()`);
  assert.equal(get("SUMS"), 1);
  run(`ns.Refresh()`);
  assert.equal(get("SUMS"), 2);
});

// Corpse coins: the "You loot ..." line can come before or after the money.
test("B9: corpse coins first, then the loot line: a quest reward a second later is still a quest reward", () => {
  const v = vm();
  v.run(`FIRE("LOOT_OPENED"); GAIN(50); FIRE("CHAT_MSG_MONEY", "You loot 50 Copper"); FIRE("LOOT_CLOSED")`);
  v.run(`ADVANCE(1); FIRE("QUEST_TURNED_IN"); GAIN(5000)`);
  assert.deepEqual(v.log(), ["loot 50", "quest 5000"]);
});

test("B9: pickpocket coins, then mail money 2 seconds later: the mail isn't called loot", () => {
  const v = vm();
  v.run(`FIRE("UNIT_SPELLCAST_SUCCEEDED", "player", nil, 921); FIRE("LOOT_READY"); GAIN(50); FIRE("CHAT_MSG_MONEY", "You loot 50 Copper"); FIRE("LOOT_CLOSED")`);
  v.run(`ADVANCE(2); FIRE("MAIL_SHOW"); GAIN(10000)`);
  assert.deepEqual(v.log(), ["pickpocket 50", "mail_in 10000"]);
});

test("B9: the loot line before the money still labels it, and money first with no window is relabelled", () => {
  const v = vm();
  v.run(`FIRE("CHAT_MSG_MONEY", "You loot 30 Copper"); GAIN(30)`);
  assert.deepEqual(v.log(), ["loot 30"]);
  const w = vm();
  w.run(`GAIN(40); FIRE("CHAT_MSG_MONEY", "You loot 40 Copper")`);
  assert.deepEqual(w.log(), ["loot 40"]);
});

test("B9: two corpses: the second loot line isn't matched to the first corpse's coins", () => {
  const v = vm();
  v.run(`GAIN(40); FIRE("CHAT_MSG_MONEY", "You loot 40 Copper")`);
  v.run(`FIRE("CHAT_MSG_MONEY", "You loot 25 Copper"); GAIN(25)`);
  assert.deepEqual(v.log(), ["loot 40", "loot 25"]);
});

test("B10: an item bought with honor (no gold) doesn't shift the name on the next gold purchase", () => {
  const v = vm();
  v.run(`MERCHANT = { 2589, 2318 }
    GetMerchantItemInfo = function(i) return "x", nil, i == 1 and 0 or 15 end
    FIRE("MERCHANT_SHOW")
    BuyMerchantItem(1, 1)
    BuyMerchantItem(2, 1); GAIN(-15)`);
  assert.deepEqual(v.log(), ["vendor_buy -15 2318"]);
});
