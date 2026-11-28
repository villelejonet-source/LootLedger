-- Cutpurse Ledger: your auctions
-- At the AH, read this character's own active auctions (read only: nothing is
-- posted, cancelled or bought) and keep the latest look, so the Sell tab can show
-- each one against the current lowest price, with its chance to sell before it ends.
--
-- Saved per character, replaced on every read:
--   ns.db.auctions = { t = seen, list = { { id, n, unit (your buyout per unit),
--     left (time-left band 1..4), lo, hi (earliest / latest end, unix time) } } }
--
-- Unverified on WoW: Forever: which owned-auctions API it has. The modern one
-- (C_AuctionHouse.QueryOwnedAuctions, OWNED_AUCTIONS_UPDATED, GetNumOwnedAuctions,
-- GetOwnedAuctionInfo) is used when present, else the classic one
-- (GetOwnerAuctionItems, AUCTION_OWNED_LIST_UPDATE, GetAuctionItemInfo("owner", i)).
-- Also unverified: that the modern buyoutAmount is per unit (as for commodities),
-- and whether GetOwnedAuctionInfo counts from 0 or 1 (both are read).

local ADDON, ns = ...
local Au = {}
ns.Auctions = Au

local H = 3600
-- Time-left bands: earliest and latest end, in seconds. Modern client: 12/24/48h
-- auctions; classic: 2/8/24h.
local MODERN = { { 0, H / 2 }, { H / 2, 2 * H }, { 2 * H, 12 * H }, { 12 * H, 48 * H } }
local CLASSIC = { { 0, H / 2 }, { H / 2, 2 * H }, { 2 * H, 8 * H }, { 8 * H, 24 * H } }
local SOLD = 1  -- sale status of a sold auction waiting for its mail (both APIs)

local function Add(list, now, id, n, unit, left, secs, bands)
  if not (id and n and n > 0 and unit and unit > 0) then return end
  local b = bands[left] or bands[#bands]
  local lo, hi = now + b[1], now + b[2]
  if secs then lo, hi = now + secs, now + secs end
  list[#list + 1] = { id = id, n = n, unit = unit, left = left, lo = lo, hi = hi }
end

local function Modern()
  return C_AuctionHouse and C_AuctionHouse.GetNumOwnedAuctions and C_AuctionHouse.GetOwnedAuctionInfo and true
end

local function ReadModern(now)
  local list, seen, total = {}, {}, C_AuctionHouse.GetNumOwnedAuctions() or 0
  for i = 0, total do
    local ok, a = pcall(C_AuctionHouse.GetOwnedAuctionInfo, i)
    local key = ok and type(a) == "table" and (a.auctionID or i)
    if key and not seen[key] then
      seen[key] = true
      if a.status ~= SOLD then
        Add(list, now, a.itemKey and a.itemKey.itemID, a.quantity, a.buyoutAmount,
          (a.timeLeft or 3) + 1, a.timeLeftSeconds, MODERN)
      end
    end
  end
  return list
end

local function ReadClassic(now)
  local list = {}
  for i = 1, GetNumAuctionItems("owner") or 0 do
    local _, _, count, _, _, _, _, _, _, buyout, _, _, _, _, _, status, id = GetAuctionItemInfo("owner", i)
    local link = not id and GetAuctionItemLink and GetAuctionItemLink("owner", i)
    id = id or (link and tonumber(link:match("item:(%d+)")))
    if status ~= SOLD and count and count > 0 then
      Add(list, now, id, count, buyout and buyout / count,
        GetAuctionItemTimeLeft and GetAuctionItemTimeLeft("owner", i) or 4, nil, CLASSIC)
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

ns.On("OWNED_AUCTIONS_UPDATED", function() if Modern() then Read(ReadModern) end end)
ns.On("AUCTION_OWNED_LIST_UPDATE", function()
  if not Modern() and GetNumAuctionItems and GetAuctionItemInfo then Read(ReadClassic) end
end)

-- Ask the AH for your auctions (the answer comes as one of the events above).
function Au.Query()
  if Modern() and C_AuctionHouse.QueryOwnedAuctions then
    pcall(C_AuctionHouse.QueryOwnedAuctions, {})
  elseif GetOwnerAuctionItems then
    pcall(GetOwnerAuctionItems)
  end
end
ns.On("AUCTION_HOUSE_SHOW", Au.Query)
ns.On("AUCTION_HOUSE_AUCTION_CREATED", Au.Query)  -- modern: a post doesn't update the list by itself

-- Deposit per unit you get back when it sells: what you paid on your open
-- postings (Trade.lua), else the advice's 24h deposit.
local function Deposit(id, plan)
  local e = ns.Trade.Item(id)
  local n, dep = 0, 0
  for _, p in ipairs(e and e.posts or {}) do n, dep = n + p.n, dep + p.dep end
  return n > 0 and dep / n or plan.deposit
end

-- Your auctions still running (by their latest possible end), most expected back
-- first, and when they were seen; nil without a look yet. Each:
-- { id, n, unit, lowest (nil without an AH price), chance (to sell before it ends,
--   nil without sales data), back (expected copper back: chance x (price after
--   the AH cut + deposit), nil without a chance) }
-- The chance is the advice's (Advisor.PostPlan: a 24h auction at the lowest, for
-- your quantity), for the time left (the middle of what's possible), and behind
-- everything listed when you're more than 5% above the lowest.
function Au.Live(now)
  local snap = ns.db and ns.db.auctions
  if not snap then return nil end
  now = now or time()
  local out = {}
  for _, a in ipairs(snap.list) do
    if a.hi > now then
      local e = { id = a.id, n = a.n, unit = a.unit }
      local p = ns.Prices.Get(a.id)
      if p.hasAH then
        local plan = ns.Advisor.PostPlan(a.id, p, a.n)
        e.lowest = plan.lowest
        if plan.chance then
          local ahead = a.unit > plan.lowest * 1.05 and math.max(plan.queue, p.auctions or 0) or plan.queue
          local days = (math.max(0, a.lo - now) + a.hi - now) / 2 / 86400
          e.chance = 1 - (1 - plan.chance) ^ (days * (plan.queue + a.n) / (ahead + a.n))
          e.back = e.chance * a.n * (a.unit * (1 - ns.Advisor.SETTINGS.ahCut) + Deposit(a.id, plan))
        end
      end
      out[#out + 1] = e
    end
  end
  table.sort(out, function(x, y)
    if (x.back or -1) ~= (y.back or -1) then return (x.back or -1) > (y.back or -1) end
    return x.id < y.id
  end)
  return out, snap.t
end
