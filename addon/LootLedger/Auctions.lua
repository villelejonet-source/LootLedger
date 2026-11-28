-- Cutpurse Ledger: this character's auctions
-- At the AH, read this character's own active auctions (read only: nothing is
-- posted, cancelled or bought) and keep the latest look, so the Sell tab can show
-- each one against the current lowest price, with its chance to sell before it ends.
--
-- Saved per character, replaced on every read:
--   ns.db.auctions = { t = seen, list = { { id, n, unit (your buyout per unit),
--     lo, hi (earliest / latest end, unix time) } } }
--
-- Unverified on WoW: Forever: which owned-auctions API it has (the modern
-- C_AuctionHouse one or the classic GetAuctionItemInfo("owner", i)), that the
-- modern buyoutAmount is per unit, and whether GetOwnedAuctionInfo counts from 1.

local ADDON, ns = ...
local Au = {}
ns.Auctions = Au

local H = 3600
-- Time-left bands 1..4: earliest and latest end, in seconds. Forever likely keeps
-- Classic's 24h auctions, so "very long" ends within 24h on both.
local MODERN = { { 0, H / 2 }, { H / 2, 2 * H }, { 2 * H, 12 * H }, { 12 * H, 24 * H } }
local CLASSIC = { { 0, H / 2 }, { H / 2, 2 * H }, { 2 * H, 8 * H }, { 8 * H, 24 * H } }
local SOLD = 1  -- sale status of a sold auction waiting for its mail (both APIs)

local function Add(list, now, id, n, unit, band, secs)
  if not (id and n and n > 0 and unit and unit > 0 and band) then return end
  list[#list + 1] = { id = id, n = n, unit = unit, lo = now + (secs or band[1]), hi = now + (secs or band[2]) }
end

local function ReadModern(now)
  local list = {}
  for i = 1, C_AuctionHouse.GetNumOwnedAuctions() or 0 do
    local a = C_AuctionHouse.GetOwnedAuctionInfo(i)
    if a and a.status ~= SOLD then
      Add(list, now, a.itemKey and a.itemKey.itemID, a.quantity, a.buyoutAmount, MODERN[(a.timeLeft or 3) + 1], a.timeLeftSeconds)
    end
  end
  return list
end

local function ReadClassic(now)
  local list = {}
  for i = 1, GetNumAuctionItems("owner") or 0 do
    local _, _, count, _, _, _, _, _, _, buyout, _, _, _, _, _, status, id = GetAuctionItemInfo("owner", i)
    if status ~= SOLD and count and count > 0 then
      Add(list, now, id, count, buyout and buyout / count, CLASSIC[GetAuctionItemTimeLeft and GetAuctionItemTimeLeft("owner", i) or 4])
    end
  end
  return list
end

local function Read(fn)
  if not ns.db then return end
  local now = time()
  local ok, list = pcall(fn, now)
  if not ok then return end  -- an answer in a shape we don't know: keep the last look
  ns.db.auctions = { t = now, list = list }
  ns.Refresh()
end

ns.On("OWNED_AUCTIONS_UPDATED", function()
  if C_AuctionHouse and C_AuctionHouse.GetNumOwnedAuctions and C_AuctionHouse.GetOwnedAuctionInfo then Read(ReadModern) end
end)
ns.On("AUCTION_OWNED_LIST_UPDATE", function()
  if GetNumAuctionItems and GetAuctionItemInfo then Read(ReadClassic) end
end)

-- Ask the AH for your auctions (the answer comes as one of the events above).
function Au.Query()
  if C_AuctionHouse and C_AuctionHouse.QueryOwnedAuctions then
    pcall(C_AuctionHouse.QueryOwnedAuctions, {})
  elseif GetOwnerAuctionItems then
    pcall(GetOwnerAuctionItems)
  end
end
ns.On("AUCTION_HOUSE_SHOW", Au.Query)
ns.On("AUCTION_HOUSE_AUCTION_CREATED", Au.Query)  -- modern: a post doesn't update the list by itself

-- Your auctions still running (by their latest possible end), most expected back
-- first, and when they were seen; nil without a look yet. Each:
-- { id, n, unit, lowest (nil without an AH price), above (more than 5% above the
--   lowest: sells only after the cheaper ones, no chance given), chance (to sell
--   before it ends, nil without sales data), back (expected copper back) }
-- The chance is the advice's model (Advisor.PostPlan): buyers take perDay units,
-- spread over the day, from the queue near the lowest plus all your units of the
-- item near it (unless the prices are newer than this look and count them already),
-- for the middle of the time left: 1 - exp(-perDay * days / (queue + yours)).
-- Expected back: chance x units x (price after the AH cut + the deposit back).
function Au.Live(now)
  local snap = ns.db and ns.db.auctions
  if not snap then return nil end
  now = now or time()
  local out, items = {}, {}
  for _, a in ipairs(snap.list) do
    if a.hi > now then
      local e = { id = a.id, n = a.n, unit = a.unit, days = (math.max(0, a.lo - now) + a.hi - now) / 2 / 86400 }
      local it = items[a.id]
      if not it then
        local p = ns.Prices.Get(a.id)
        it = { p = p, plan = p.hasAH and ns.Advisor.PostPlan(a.id, p, 1), n = 0 }
        items[a.id] = it
      end
      if it.plan then
        -- vs the price the advice undercuts: the lowest, or the AH price past a stray cheap listing
        e.lowest, e.above = it.plan.lowest, a.unit > (it.plan.price + 1) * 1.05
        if not e.above then it.n = it.n + a.n end
      end
      e.item = it
      out[#out + 1] = e
    end
  end
  for _, e in ipairs(out) do
    local it, plan = e.item, e.item.plan
    if plan and plan.perDay and not e.above then
      local yours = ((it.p.scanned or it.p.updated or 0) > snap.t) and 0 or it.n
      e.chance = 1 - math.exp(-plan.perDay * e.days / math.max(1, plan.queue + yours))
      e.back = e.chance * e.n * (e.unit * (1 - ns.Advisor.SETTINGS.ahCut) + plan.deposit)
    end
    e.item, e.days = nil, nil
  end
  table.sort(out, function(x, y)
    if (x.back or -1) ~= (y.back or -1) then return (x.back or -1) > (y.back or -1) end
    return x.id < y.id
  end)
  return out, snap.t
end
