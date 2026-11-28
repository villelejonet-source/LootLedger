-- Cutpurse Ledger: gold log
-- Every change in your money is recorded and labelled by what you were doing at
-- that moment: the window you had open (vendor, mailbox, AH, trainer, ...) or the
-- action you just took (Repair All, taking money from a mail, ...).

local ADDON, ns = ...
local L = {}
ns.Ledger = L

L.SOURCE_LABELS = {
  loot = "Mob loot", quest = "Quests",
  vendor_sell = "Vendor sales", vendor_buy = "Vendor purchases", repair = "Repairs",
  ah_sale = "AH sales", ah_refund = "AH outbid refunds", ah_deposit = "AH deposits", ah_buy = "AH purchases",
  ah_deposit_back = "AH deposits returned",
  mail_in = "Mail received", mail_out = "Mail sent & postage", trade = "Trades",
  training = "Training", flight = "Flights", bank = "Bank slots", other = "Other",
}
for _, a in ipairs(ns.Gathering.ACTIVITIES) do L.SOURCE_LABELS[a.key] = a.label end

-- Which way the money must move for an action flag to apply (+1 gain, -1 loss).
local FLAG_SIGN = {
  repair = -1, ah_deposit = -1, ah_buy = -1, flight = -1, training = -1, bank = -1,
  ah_sale = 1, ah_refund = 1, mail_in = 1, loot = 1, quest = 1,
}

local lastMoney = 0
local open, closedAt = {}, {}       -- which windows are open / when they closed
local flags = {}                    -- actions waiting for their money change, oldest first
local sellQueue, buyQueue = {}, {}  -- items handed to / bought from the vendor, oldest first

function L.SyncMoney() lastMoney = GetMoney() end
function L.IsOpen(ctx) return open[ctx] end

---------------------------------------------------------------------------
-- Recording
---------------------------------------------------------------------------
-- Money moved since the session started, by source (not saved).
local session
local function ResetSession() session = { inc = 0, exp = 0, bySrc = {} } end
ResetSession()
ns.OnSessionReset(ResetSession)

local function AddTo(bySrc, s, inc, exp)
  local t = bySrc[s]
  if not t then t = { inc = 0, exp = 0 }; bySrc[s] = t end
  t.inc, t.exp = t.inc + inc, t.exp + exp
end

function L.Record(source, amount, item, qty)
  local ledger = ns.db.ledger
  local k = ns.DayKey()
  local day = ledger.days[k]
  if not day then day = {}; ledger.days[k] = day end
  local e = day[source]
  if not e then e = { inc = 0, exp = 0 }; day[source] = e end
  if amount > 0 then e.inc = e.inc + amount else e.exp = e.exp - amount end
  if amount > 0 then
    session.inc = session.inc + amount
    AddTo(session.bySrc, source, amount, 0)
  else
    session.exp = session.exp - amount
    AddTo(session.bySrc, source, 0, -amount)
  end

  local entry = { t = time(), a = amount, s = source }
  if item then
    entry.n = item:match("%[(.-)%]") or item
    entry.id = tonumber(item:match("item:(%d+)"))
    if qty and qty > 1 then entry.q = qty end
  end
  table.insert(ledger.recent, 1, entry)
  if #ledger.recent > ns.RECENT_MAX then table.remove(ledger.recent) end
end

-- Move an already recorded gain to another source (day totals, session and entry).
local function Relabel(entry, source)
  local day = ns.db.ledger.days[date("%Y-%m-%d", entry.t)]
  local old = day and day[entry.s]
  if old then
    old.inc = old.inc - entry.a
    if old.inc <= 0 and old.exp <= 0 then day[entry.s] = nil end
    AddTo(day, source, entry.a, 0)
  end
  if entry.t >= ns.sessionStartTime then
    local s = session.bySrc[entry.s]
    if s then s.inc = s.inc - entry.a end
    AddTo(session.bySrc, source, entry.a, 0)
  end
  entry.s = source
end
L.Relabel = Relabel

-- Income/expense for a list of day keys, total and by source.
local function SumDayKeys(keys)
  local inc, exp, bySrc = 0, 0, {}
  for _, k in ipairs(keys) do
    local day = ns.db.ledger.days[k]
    if day then
      for s, e in pairs(day) do
        AddTo(bySrc, s, e.inc, e.exp)
        inc, exp = inc + e.inc, exp + e.exp
      end
    end
  end
  return inc, exp, bySrc
end

-- Income/expense over the last n days (1 = today), total and by source.
function L.SumDays(n)
  local keys = {}
  for d = 0, n - 1 do keys[#keys + 1] = ns.DayKey(d) end
  return SumDayKeys(keys)
end

-- Income/expense for a period ("session", "today", "week", "month", "all").
function L.Sum(period)
  if period == "session" then return session.inc, session.exp, session.bySrc end
  local days = ns.PeriodDays(period)
  if days then return L.SumDays(days) end
  local keys = {}
  for k in pairs(ns.db.ledger.days) do keys[#keys + 1] = k end
  return SumDayKeys(keys)
end

-- Earliest day with any record, as a short date (for "All time · since ...").
function L.FirstDay()
  local first
  for k in pairs(ns.db.ledger.days) do if not first or k < first then first = k end end
  for _, b in pairs(ns.db.acts) do
    for k in pairs(b.days or {}) do if not first or k < first then first = k end end
  end
  if not first then return nil end
  local y, m, d = first:match("(%d+)-(%d+)-(%d+)")
  return ns.ShortDate(time({ year = tonumber(y), month = tonumber(m), day = tonumber(d), hour = 12 }))
end

-- data: extra details for the trade record (see Trade.lua), e.g. { sale = itemID, n, net, deposit }.
-- ttl: how long to wait for the money (AH actions can take a few seconds).
-- Flags queue up, so actions taken back to back (two sale mails, two posts) each
-- get their own money change.
-- A post whose deposit never came was (probably) free: when its flag expires, it
-- is still recorded, with deposit 0, so its sale or return can be matched later.
local function DropExpiredFlags()
  for i = #flags, 1, -1 do
    local f = flags[i]
    if GetTime() >= f.expires then
      table.remove(flags, i)
      if f.source == "ah_deposit" and f.data and f.data.post then ns.Trade.Posted(f.data.post, f.data.n, 0) end
    end
  end
end

function L.Flag(source, item, qty, data, ttl)
  ttl = ttl or ns.FLAG_TTL
  flags[#flags + 1] = { source = source, item = item, qty = qty, data = data, expires = GetTime() + ttl }
  if data and data.post and C_Timer then C_Timer.After(ttl + 0.1, DropExpiredFlags) end
end

-- The flag a money change belongs to: the oldest one whose direction matches, except
-- that a sale mail whose expected amount (bid - AH cut + deposit) is exactly the
-- change wins. Flags of the other direction stay queued for their own change.
local function TakeFlag(delta)
  DropExpiredFlags()
  local first
  for i, f in ipairs(flags) do
    local sign = FLAG_SIGN[f.source]
    if not sign or (sign > 0) == (delta > 0) then
      if f.source == "ah_sale" and f.data and (f.data.net or 0) + (f.data.deposit or 0) == delta then
        return table.remove(flags, i)
      end
      first = first or i
    end
  end
  return first and table.remove(flags, first)
end

local function Active(ctx)
  return open[ctx] or (closedAt[ctx] and GetTime() - closedAt[ctx] < ns.CONTEXT_GRACE)
end

-- Work out where a money change came from.
local function Classify(delta)
  local f = TakeFlag(delta)
  if f then return f.source, f.item, f.qty, f.data end
  if Active("trade") then return "trade" end
  if Active("merchant") then
    if delta < 0 then
      local item = table.remove(buyQueue, 1)
      return "vendor_buy", item and item.link, item and item.qty
    end
    -- A sale: the first queued item whose sell price matches the money. Items queued
    -- before it never sold (the click did nothing); with no match, no item is named.
    for i, item in ipairs(sellQueue) do
      if item.price * item.qty == delta then
        for _ = 1, i do table.remove(sellQueue, 1) end
        return "vendor_sell", item.link, item.qty
      end
    end
    return "vendor_sell"
  end
  if Active("mail") then return delta > 0 and "mail_in" or "mail_out" end
  if Active("auction") then return delta > 0 and "ah_refund" or "ah_buy" end
  if Active("trainer") then return "training" end
  if Active("taxi") then return "flight" end
  if Active("bank") then return "bank" end
  if Active("loot") then return "loot" end
  return "other"
end

---------------------------------------------------------------------------
-- Hooks: actions that tell us what the next money change is for
---------------------------------------------------------------------------
local Flag, Hook = L.Flag, ns.Hook

local function OnUseContainerItem(bag, slot)
  if InRepairMode and InRepairMode() then Flag("repair"); return end
  if open.merchant then
    local link, count, noValue = ns.ContainerItem(bag, slot)
    local price = link and not noValue and ns.SellPrice(link) or 0
    if price > 0 then sellQueue[#sellQueue + 1] = { link = link, qty = count or 1, price = price } end
  end
end
if C_Container and type(C_Container.UseContainerItem) == "function" then
  hooksecurefunc(C_Container, "UseContainerItem", OnUseContainerItem)
else
  Hook("UseContainerItem", OnUseContainerItem)
end

Hook("PickupInventoryItem", function() if InRepairMode and InRepairMode() then Flag("repair") end end)
Hook("RepairAllItems", function() Flag("repair") end)
Hook("BuyMerchantItem", function(index, qty)
  -- Items paid with honor or tokens cost no gold: queuing them would shift the
  -- names on the next gold purchases.
  local price = GetMerchantItemInfo and select(3, GetMerchantItemInfo(index))
  if price == 0 then return end
  buyQueue[#buyQueue + 1] = { link = GetMerchantItemLink(index), qty = qty or 1 }
end)
Hook("BuybackItem", function(index)
  buyQueue[#buyQueue + 1] = { link = GetBuybackItemLink and GetBuybackItemLink(index), qty = 1 }
end)
Hook("TakeTaxiNode", function() Flag("flight") end)
Hook("BuyTrainerService", function() Flag("training") end)
Hook("PurchaseSlot", function() Flag("bank") end)
local AH_TTL = 10

-- Classic-style auction house
Hook("PostAuction", function(_, _, _, stackSize, numStacks)
  local name = GetAuctionSellItemInfo and GetAuctionSellItemInfo()
  local id = name and ns.Trade.ItemIDByName(name)
  Flag("ah_deposit", nil, nil, id and { post = id, n = (stackSize or 1) * (numStacks or 1) }, AH_TTL)
end)
Hook("StartAuction", function() Flag("ah_deposit", nil, nil, nil, AH_TTL) end)
Hook("PlaceAuctionBid", function(listType, index)
  Flag("ah_buy", GetAuctionItemLink and GetAuctionItemLink(listType, index), nil, nil, AH_TTL)
end)

-- Modern auction house (WoW: Forever runs the modern client)
if C_AuctionHouse then
  -- GetItemID may throw for a location that holds nothing (unverified): check first,
  -- and never let it break the hook.
  local function ItemIDAt(location)
    if not (location and C_Item and C_Item.GetItemID) then return nil end
    if C_Item.DoesItemExist and not C_Item.DoesItemExist(location) then return nil end
    local ok, id = pcall(C_Item.GetItemID, location)
    return ok and id or nil
  end
  local function OnPost(location, _, quantity)
    local id = ItemIDAt(location)
    Flag("ah_deposit", nil, nil, id and { post = id, n = quantity or 1 }, AH_TTL)
  end
  local commodity
  local function HookAH(name, fn)
    if type(C_AuctionHouse[name]) == "function" then hooksecurefunc(C_AuctionHouse, name, fn) end
  end
  HookAH("PostItem", OnPost)
  HookAH("PostCommodity", OnPost)
  HookAH("StartCommoditiesPurchase", function(itemID, quantity) commodity = { id = itemID, n = quantity } end)
  HookAH("ConfirmCommoditiesPurchase", function(itemID, quantity)
    local n = quantity or (commodity and commodity.id == itemID and commodity.n) or nil
    Flag("ah_buy", nil, n, { buy = itemID, n = n }, AH_TTL)
  end)
  -- A bid (or buyout) on an item auction: logged as an AH purchase, but not added
  -- to the trade record. A bid can be outbid and refunded, and the item last
  -- searched for isn't reliably the one bid on.
  HookAH("PlaceBid", function() Flag("ah_buy", nil, nil, nil, AH_TTL) end)
end

-- Mail: AH sale money (with the sale details), expired/cancelled auctions, other mail.
local returnPatterns = {}
for _, g in ipairs({ "AUCTION_EXPIRED_MAIL_SUBJECT", "AUCTION_REMOVED_MAIL_SUBJECT" }) do
  if type(_G[g]) == "string" then returnPatterns[#returnPatterns + 1] = ns.ToPattern(_G[g]) end
end
-- Only mail from the game itself counts: any player can send a mail titled "Auction
-- expired: Linen Cloth". A player's mail can be replied to (canReply), the Auction
-- House's can't, in every language.
local function IsReturnedAuction(index)
  local _, _, _, subject, _, _, _, _, _, _, _, canReply = GetInboxHeaderInfo(index)
  if not subject or canReply then return false end
  for _, pat in ipairs(returnPatterns) do if subject:match(pat) then return true end end
  return false
end

-- Sale details from an AH sale mail, or nil.
-- GetInboxInvoiceInfo: type, item, buyer, bid, buyout, deposit, consignment (the AH cut), ..., count
function L.Invoice(index)
  if not GetInboxInvoiceInfo then return nil end
  local invoiceType, itemName, _, bid, _, deposit, consignment, _, _, _, count = GetInboxInvoiceInfo(index)
  if invoiceType ~= "seller" then return nil end
  return { name = itemName, sale = ns.Trade.ItemIDByName(itemName), n = count,
    net = (bid or 0) - (consignment or 0), deposit = deposit or 0 }
end

-- Items from an expired/cancelled auction count as returned only once they have
-- really left the mailbox (full bags: nothing happens). A click remembers what it
-- was for (item and stack size); when the number of such attachments in returned-
-- auction mails drops, that many clicks are recorded, oldest first. Counting rather
-- than looking at the clicked index survives mails shifting up when one is removed,
-- and two identical mails ("Auction expired: Linen Cloth" twice) count twice.
local RETURN_WAIT = 5     -- seconds a click waits for its attachment to leave
local pendingReturns = {} -- "id:count" -> { id, count, base = attachments like it when clicked, clicks = { { index, a, at } } }

local function AttachmentID(index, a)
  local name, itemID, _, count = GetInboxItem(index, a)
  if not name then return nil end
  return itemID or ns.Trade.ItemIDByName(name), count or 1
end

-- How many attachments of this item and stack size are in returned-auction mails.
local function CountReturned(id, count)
  local n = 0
  for i = 1, (GetInboxNumItems and GetInboxNumItems() or 0) do
    if IsReturnedAuction(i) then
      for a = 1, (ATTACHMENTS_MAX_RECEIVE or 16) do
        local aid, acount = AttachmentID(i, a)
        if aid == id and acount == count then n = n + 1 end
      end
    end
  end
  return n
end

local function CheckReturns()
  for key, r in pairs(pendingReturns) do
    for i = #r.clicks, 1, -1 do
      if GetTime() - r.clicks[i].at > RETURN_WAIT then table.remove(r.clicks, i) end
    end
    if #r.clicks > 0 then
      local left = r.base - CountReturned(r.id, r.count)
      while left > 0 and #r.clicks > 0 do
        table.remove(r.clicks, 1)
        r.base, left = r.base - 1, left - 1
        ns.Trade.Returned(r.id, r.count)
      end
    end
    if #r.clicks == 0 then pendingReturns[key] = nil end
  end
end

local function OnMailItems(index, attachment)
  if not (GetInboxHeaderInfo and GetInboxItem) then return end
  if not IsReturnedAuction(index) then return end
  CheckReturns()  -- settle earlier clicks first: what's still pending hasn't left yet
  local first, last = attachment or 1, attachment or (ATTACHMENTS_MAX_RECEIVE or 16)
  for a = first, last do
    local id, count = AttachmentID(index, a)
    if id then
      local key = id .. ":" .. count
      local r = pendingReturns[key]
      if not r then
        r = { id = id, count = count, base = CountReturned(id, count), clicks = {} }
        pendingReturns[key] = r
      end
      local again  -- the same attachment clicked again, nothing left since: one click
      for _, c in ipairs(r.clicks) do
        if c.index == index and c.a == a then again = c end
      end
      if again then again.at = GetTime()
      else r.clicks[#r.clicks + 1] = { index = index, a = a, at = GetTime() } end
    end
  end
end
ns.On("MAIL_INBOX_UPDATE", CheckReturns)
ns.On("MAIL_CLOSED", function() pendingReturns = {} end)

local function OnMailTake(index)
  -- No money on the mail (already taken, or an item-only mail): no money change is
  -- coming, so a flag would only mislabel the next one.
  local money = GetInboxHeaderInfo and select(5, GetInboxHeaderInfo(index))
  if not money or money <= 0 then return end
  local inv = L.Invoice(index)
  if inv then Flag("ah_sale", inv.name, inv.n, inv); return end
  local _, _, sender, _, _, _, _, _, _, _, _, canReply = GetInboxHeaderInfo(index)
  -- English clients only: other locales name the AH sender differently, and their
  -- refunds are logged as "Mail received". A player's mail (one that can be replied
  -- to) is never a refund, even from a character called "Auctionx".
  if sender and not canReply and sender:find("Auction", 1, true) then Flag("ah_refund") else Flag("mail_in") end
end
Hook("TakeInboxMoney", OnMailTake)
Hook("AutoLootMailItem", function(index) OnMailItems(index); OnMailTake(index) end)
Hook("TakeInboxItem", function(index, attachment) OnMailItems(index, attachment) end)

---------------------------------------------------------------------------
-- Events
---------------------------------------------------------------------------
-- Window open/close events -> context name
local CONTEXT_EVENTS = {
  MERCHANT_SHOW = { "merchant", true },        MERCHANT_CLOSED = { "merchant", false },
  MAIL_SHOW = { "mail", true },                MAIL_CLOSED = { "mail", false },
  AUCTION_HOUSE_SHOW = { "auction", true },    AUCTION_HOUSE_CLOSED = { "auction", false },
  TRAINER_SHOW = { "trainer", true },          TRAINER_CLOSED = { "trainer", false },
  TAXIMAP_OPENED = { "taxi", true },           TAXIMAP_CLOSED = { "taxi", false },
  TRADE_SHOW = { "trade", true },              TRADE_CLOSED = { "trade", false },
  BANKFRAME_OPENED = { "bank", true },         BANKFRAME_CLOSED = { "bank", false },
  LOOT_OPENED = { "loot", true },              LOOT_CLOSED = { "loot", false },
}
for event, ctx in pairs(CONTEXT_EVENTS) do
  ns.On(event, function()
    open[ctx[1]] = ctx[2]
    if not ctx[2] then closedAt[ctx[1]] = GetTime() end
    if event == "MERCHANT_SHOW" then sellQueue, buyQueue = {}, {} end
  end)
end

ns.OnInit(L.SyncMoney)

ns.On("QUEST_TURNED_IN", function() Flag("quest") end)  -- the only quest flag (not GetQuestReward too)

-- Ledger entries a loot chat line has already been matched to (not saved).
local chatSeen = setmetatable({}, { __mode = "k" })

-- "You loot 5 Silver, 20 Copper": money from a corpse, whether or not we saw
-- its loot window. The chat line can arrive before or after the money change.
ns.On("CHAT_MSG_MONEY", function()
  if not ns.db then return end
  local last = ns.db.ledger.recent[1]
  local recent = last and time() - last.t <= 3 and last.a > 0 and not chatSeen[last]
  if recent and last.s == "other" then
    Relabel(last, "loot")      -- money came first and was unlabelled
    chatSeen[last] = true
    ns.Refresh()
  elseif recent and (last.s == "loot" or (ns.Gathering.IsActivity and ns.Gathering.IsActivity(last.s))) then
    -- Money came first and is already filed (as loot, or under pickpocketing or a
    -- gathering activity). Nothing to wait for: a "loot" flag here would label the
    -- next unrelated income (a quest reward, mail) as loot.
    chatSeen[last] = true
  else
    Flag("loot")               -- money hasn't arrived yet
  end
end)

ns.On("PLAYER_MONEY", function()
  local now = GetMoney()
  local delta = now - lastMoney
  lastMoney = now
  if not ns.db or delta == 0 then return end
  ns.db.gold, ns.db.lastSeen = now, time()
  local activity = ns.Gathering.Current()
  if activity and delta > 0 and ns.Gathering.ClaimMoney(delta) then
    ns.Gathering.AddMoney(delta)
    L.Record(activity, delta)
  else
    local source, item, qty, data = Classify(delta)
    if source == "ah_sale" and data then
      -- Sale money = sale price - AH cut + your deposit back. Only the first part is income.
      local back = math.min(math.max(data.deposit or 0, 0), delta)
      local net = delta - back
      L.Record("ah_sale", net, item, qty)
      if back > 0 then L.Record("ah_deposit_back", back) end
      if data.sale then ns.Trade.Sale(data.sale, data.n, net) else ns.Trade.Unmatched(data.name, data.n, net) end
    else
      L.Record(source, delta, item, qty)
      if data and source == "ah_deposit" and data.post then ns.Trade.Posted(data.post, data.n, -delta) end
      if data and source == "ah_buy" and data.buy then ns.Trade.Bought(data.buy, data.n, -delta) end
      if source == "vendor_sell" and item then
        local id = tonumber(tostring(item):match("item:(%d+)"))
        if id then ns.Trade.Vendored(id, qty or 1, delta) end
      end
    end
  end
  ns.Refresh()
end)
