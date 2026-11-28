-- Cutpurse Ledger: prices
-- One place to ask "what is this item worth?".
--
-- Sources, best first:
--   1. LootLedger_Prices: hourly snapshot of your auction house from Blizzard's
--      API (published by the GitHub Action, copied in by scripts/sync.ps1).
--   2. TSM's AuctionDB via TSM_API, if TSM and its desktop app data are present.
--   3. Vendor price only.

local ADDON, ns = ...
local P = {}
ns.Prices = P

local CACHE_SECONDS = 300
local cache = {}

---------------------------------------------------------------------------
-- 1. Blizzard snapshot (LootLedger_Prices)
---------------------------------------------------------------------------
local function Feed() return type(LootLedgerPrices) == "table" and LootLedgerPrices or nil end
-- A feed is generated, but a broken or partial one must not break the addon.
local function FeedHouses(feed) return feed and type(feed.houses) == "table" and feed.houses or {} end

-- houseID: another house (nil = this character's)
local function CurrentHouse(houseID)
  local feed = Feed()
  local id = feed and (houseID or P.House())
  return id and FeedHouses(feed)[id]
end

---------------------------------------------------------------------------
-- Purchases and trending (from the feed's sales / trending tables)
---------------------------------------------------------------------------
-- { sold24, normal (nil if not known yet), auctions24 } or nil
function P.Sales(itemID, houseID)
  local h = CurrentHouse(houseID)
  local s = h and h.sales and h.sales[itemID]
  if not s then return nil end
  local sold, normal, auctions = s:match("^(%d+),(%-?%d+),(%d+)$")
  if not sold then return nil end
  normal = tonumber(normal)
  return { sold24 = tonumber(sold), normal = normal >= 0 and normal or nil, auctions24 = tonumber(auctions) }
end

-- Units listed within 5% of the lowest price (the queue a new listing joins), or
-- nil if the feed doesn't say (older feeds; items without history).
function P.Queue(itemID, houseID)
  local h = CurrentHouse(houseID)
  local q = h and type(h.queue) == "table" and h.queue[itemID]
  return type(q) == "number" and q or nil
end

-- How often one unit posted 1c under the lowest price sold within 24 hours on this
-- house, measured by the feed (poller/fill.mjs): { p24 (0..1), n (start hours behind
-- it) }, or nil (house not archived, not enough data yet, or malformed).
function P.Fill(itemID, houseID)
  local h = CurrentHouse(houseID)
  local s = h and type(h.fill) == "table" and h.fill[itemID]
  if type(s) ~= "string" then return nil end
  local p24, n = s:match("^(%d+),(%d+)$")
  p24, n = tonumber(p24), tonumber(n)
  if not (p24 and p24 <= 1000 and n > 0) then return nil end
  return { p24 = p24 / 1000, n = n }
end

P.TREND_LISTS = { "hot", "climbing", "drying", "cooling" }

local trendCache
-- { ready, hoursOfData, baselineDays, lists = { hot = { entry... }, ... }, byItem = { [id] = { list, entry } } }
-- entry = { id, sold24, auctions24, normal, priceChange, supplyChange, hoursActive, conf }
function P.Trending()
  local h = CurrentHouse()
  local t = h and h.trending
  if not t then return nil end
  if trendCache and trendCache.src == t then return trendCache end
  local out = { src = t, ready = t.ready, hoursOfData = t.hoursOfData or 0, baselineDays = t.baselineDays or 0, readyAt = t.readyAt, lists = {}, byItem = {} }
  for _, key in ipairs(P.TREND_LISTS) do
    local list = {}
    for _, s in ipairs(t[key] or {}) do
      local f = {}
      for v in (s .. ","):gmatch("([^,]*),") do f[#f + 1] = v end
      local pm = function(v) return v ~= "" and tonumber(v) / 1000 or nil end
      local e = {
        id = tonumber(f[1]), sold24 = tonumber(f[2]), auctions24 = tonumber(f[3]), normal = tonumber(f[4]),
        priceChange = pm(f[5] or ""), supplyChange = pm(f[6] or ""), hoursActive = tonumber(f[7]), conf = tonumber(f[8]) or 0,
      }
      if e.id then
        list[#list + 1] = e
        out.byItem[e.id] = out.byItem[e.id] or { list = key, entry = e }
      end
    end
    out.lists[key] = list
  end
  trendCache = out
  return out
end

-- House IDs in the feed, biggest first.
function P.Houses()
  local feed, list = Feed(), {}
  if not feed then return list end
  for id, h in pairs(FeedHouses(feed)) do list[#list + 1] = { id = id, listings = h.listings or 0 } end
  table.sort(list, function(a, b) return a.listings > b.listings end)
  return list
end

-- The house this character reads prices from. Stored per character, because
-- alts on the other faction (or at a neutral AH) use a different house.
-- Returns id, confirmed (bool), source ("detected" | "manual" | "guess")
function P.House()
  local feed = Feed()
  if not feed then return nil end
  local db = ns.db
  local houses = FeedHouses(feed)
  local chosen = db and db.house
  if chosen and houses[chosen] then return chosen, true, db.houseSource or "manual" end
  -- Known, but missing from this feed (the feed couldn't read it): stay on it with
  -- no prices rather than quietly using another house's.
  if chosen then return chosen, true, db.houseSource or "manual" end
  -- Not known yet: guess the biggest house of the player's faction.
  local faction = UnitFactionGroup and UnitFactionGroup("player")
  local guess
  for _, h in ipairs(P.Houses()) do
    if houses[h.id].faction == faction then guess = h.id; break end
  end
  guess = guess or (P.Houses()[1] and P.Houses()[1].id)
  return guess, false, "guess"
end

-- The house a saved character reads prices from: this character's own, else the
-- one it last used (detected or set), else the biggest house of its faction.
function P.HouseFor(ch)
  if ch == ns.db then return (P.House()) end
  local houses = FeedHouses(Feed())
  if ch.house and houses[ch.house] then return ch.house end
  for _, h in ipairs(P.Houses()) do
    if ch.faction and houses[h.id].faction == ch.faction then return h.id end
  end
  return (P.House())
end

-- source: "manual" (/cl house) or "detected" (matched at the AH)
function P.SetHouse(id, source)
  ns.db.house = id
  ns.db.houseSource = source or "manual"
  P.ClearCache()
  if ns.Gathering and ns.Gathering.LockOldLoot then ns.Gathering.LockOldLoot() end
end

ns.OnInit(function()
  -- Before 3.9 the house was one setting for the whole account.
  if ns.ui.house and not ns.db.house then
    ns.db.house, ns.db.houseSource = ns.ui.house, "manual"
  end
end)

local function FromFeed(itemID, c, houseID)
  local feed = Feed()
  houseID = houseID or P.House()
  local house = houseID and FeedHouses(feed)[houseID]
  local s = house and house.items and house.items[itemID]
  if type(s) ~= "string" then return false end
  local market, min, qty, a7, a30 = s:match("^(%d+),(%d+),(%d+),(%d+),(%d+)$")
  if not market then return false end  -- a line in a format we don't know
  c.market, c.recent = tonumber(market), tonumber(market)
  c.min, c.auctions = tonumber(min), tonumber(qty)
  c.updated = house.updated
  c.avg7 = tonumber(a7) > 0 and tonumber(a7) or nil
  c.historical = tonumber(a30) > 0 and tonumber(a30) or nil
  -- The median of the last 3 hourly markets, where it differs (newer feeds): the
  -- advice decides on it, as one hour's price is often noise.
  local steady = type(house.steady) == "table" and house.steady[itemID]
  c.steady = type(steady) == "number" and steady or nil
  return true
end

-- Where prices come from right now, for display.
-- Returns { source = "blizzard"|"tsm"|"none", house, confirmed, updated, days }
function P.Status()
  local feed = Feed()
  if feed then
    local id, confirmed, how = P.House()
    local h = id and FeedHouses(feed)[id]
    local updated = h and h.updated or feed.updated
    -- A scan of this house newer than the feed: current prices are from then.
    local scan = ns.Scan and ns.Scan.Latest(id or 0)
    return { source = "blizzard", house = id, confirmed = confirmed, how = how,
      houseName = h and h.name, updated = updated,
      scanned = scan and scan.t > (updated or 0) and scan.t or nil,
      days = h and type(h.days) == "number" and h.days or 0 }
  end
  if P.HasTSM() then return { source = "tsm" } end
  return { source = "none" }
end

-- One line for the UI, e.g. "Blizzard AH, house 113 · updated 20 min ago · 3 days of history".
function P.StatusText()
  local s = P.Status()
  if s.source == "none" then
    return "No AH prices loaded. Install or update LootLedger_Prices, then restart WoW."
  elseif s.source == "tsm" then
    return "AH prices from TSM."
  end
  if not s.house then return "AH prices loaded, but they list no auction house. Update LootLedger_Prices." end
  local mins = math.floor((time() - (s.updated or 0)) / 60)
  local age = mins < 90 and (mins .. " min ago") or (mins < 2880 and (math.floor(mins / 60) .. " h ago") or (math.floor(mins / 1440) .. " days ago"))
  local which = ({ detected = " (detected at the AH)", manual = " (set by you)",
    guess = " (a guess: open the AH once to detect yours)" })[s.how] or ""
  local text = "AH prices: " .. (s.houseName or "house") .. " " .. s.house .. which
    .. "  ·  updated " .. age .. "  ·  " .. s.days .. (s.days == 1 and " day" or " days") .. " of history"
  if mins > 360 then text = text .. "  ·  update LootLedger_Prices for fresh prices" end
  return text
end

---------------------------------------------------------------------------
-- Per-item history (from the feed's hist table)
---------------------------------------------------------------------------
local histCache = {}

local function List(s, base)
  local out, n = {}, 0
  for v in (s .. ","):gmatch("([^,]*),") do
    n = n + 1
    out[n] = v ~= "" and tonumber(v, base) or false  -- false = no data that day
  end
  return out, n
end

-- History for one item, or nil if the feed has none.
-- {
--   daily   = { values, labels }  last 30 days, oldest first (false = no listings)
--   weekly  = { values, labels }  last 12 weeks (label = Monday "YYYY-MM-DD")
--   monthly = { values, labels }  last 12 months ("YYYY-MM")
--   weekday = { [1..7] = fraction vs the week's average (Mon..Sun) or false },
--   weeks, consistency (0..1), reliable (bool)  -- how much to trust the weekday pattern
--   trend      = fraction per day (-0.02 = falling 2%/day) or nil
--   baseline   = recent "normal" price (copper) or nil
--   volatility = typical day-to-day move (fraction) or nil
--   usualQty   = usual quantity listed or nil
-- }
function P.History(itemID)
  local feed = Feed()
  local houseID = P.House()
  local house = houseID and FeedHouses(feed)[houseID]
  local s = house and house.hist and house.hist[itemID]
  if not s then return nil end
  local cached = histCache[itemID]
  if cached and cached.src == s then return cached end

  local f = {}
  for k, v in s:gmatch("(%a)=([^;]*)") do f[k] = v end
  local h = { src = s }
  h.daily = { values = List(f.d or "", 36), labels = house.dayLabels or {} }
  h.weekly = { values = List(f.w or "", 36), labels = house.weekLabels or {} }
  h.monthly = { values = List(f.m or "", 36), labels = house.monthLabels or {} }

  local p = List(f.p or "", 10)
  h.weekday = {}
  for i = 1, 7 do h.weekday[i] = p[i] and p[i] / 1000 or false end
  h.weeks = p[8] or 0
  h.consistency = (p[9] or 0) / 100
  h.reliable = p[10] == 1

  local t = {}
  for v in ((f.t or "") .. ","):gmatch("([^,]*),") do t[#t + 1] = v end
  h.trend = tonumber(t[1] or "", 10) and tonumber(t[1], 10) / 1000 or nil
  h.baseline = tonumber(t[2] or "", 36)
  h.volatility = tonumber(t[3] or "", 10) and tonumber(t[3], 10) / 1000 or nil
  h.usualQty = tonumber(t[4] or "", 36)

  -- Days with any data, for "how much history is there"
  local seen = 0
  for _, v in ipairs(h.daily.values) do if v then seen = seen + 1 end end
  h.daysSeen = seen
  histCache[itemID] = h
  return h
end

local DAY_NAMES = { "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday" }
local DAY_SHORT = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" }
P.DAY_NAMES, P.DAY_SHORT = DAY_NAMES, DAY_SHORT

-- Best and worst weekdays from a history, grouping days that are close to the
-- best/worst (within 2 points). Returns nil unless the pattern is reliable.
-- { best = {idx...}, worst = {idx...}, bestPct, worstPct, spread }
function P.WeekdayAdvice(h)
  if not (h and h.reliable) then return nil end
  local hi, lo
  for i = 1, 7 do
    local v = h.weekday[i]
    if v then
      if not hi or v > h.weekday[hi] then hi = i end
      if not lo or v < h.weekday[lo] then lo = i end
    end
  end
  if not (hi and lo) then return nil end
  local best, worst = {}, {}
  for i = 1, 7 do
    local v = h.weekday[i]
    if v and h.weekday[hi] - v <= 0.02 then best[#best + 1] = i end
    if v and v - h.weekday[lo] <= 0.02 then worst[#worst + 1] = i end
  end
  return {
    best = best, worst = worst, bestPct = h.weekday[hi], worstPct = h.weekday[lo],
    spread = (1 + h.weekday[hi]) / (1 + h.weekday[lo]) - 1,
  }
end

-- "Fri/Sat", "Tuesday"
function P.DayList(idxs, long)
  local names = {}
  for _, i in ipairs(idxs) do names[#names + 1] = (long and #idxs == 1) and DAY_NAMES[i] or DAY_SHORT[i] end
  return table.concat(names, "/")
end

---------------------------------------------------------------------------
-- Time of week: the whole auction house's prices by hour of the week, from
-- the feed's `week` string (see poller/weekhours.mjs). Hours are UTC, the
-- same as the feed's days; P.WhenText shows them on the player's own clock.
---------------------------------------------------------------------------
local weekCache
-- { pct = { [0..167] = fraction vs the week, or false }, weeks, reliable, since,
--   best, worst (hour of the week, 0 = Monday 00:00 UTC) } or nil
function P.WeekHours()
  local h = CurrentHouse()
  local s = h and type(h.week) == "string" and h.week
  if not s then return nil end
  if weekCache and weekCache.src == s then return weekCache end
  local vals, weeks, rel, since = s:match("^([^;]*);(%d*);(%d*);(%d*)$")
  if not vals then return nil end
  local out = { src = s, pct = {}, weeks = tonumber(weeks) or 0, reliable = rel == "1", since = tonumber(since) }
  local i = 0
  for v in (vals .. ","):gmatch("([^,]*),") do
    if i > 167 then break end
    out.pct[i] = tonumber(v) and tonumber(v) / 1000 or false
    i = i + 1
  end
  for b = 0, 167 do
    local v = out.pct[b]
    if v then
      if not out.best or v > out.pct[out.best] then out.best = b end
      if not out.worst or v < out.pct[out.worst] then out.worst = b end
    end
  end
  if not out.best then out.reliable = false end
  weekCache = out
  return out
end

-- UTC hour of the week at time t (0 = Monday 00:00), and the UTC weekday (1 = Monday).
function P.HourOfWeek(t)
  local d = date("!*t", t or time())
  local wd = (d.wday + 5) % 7
  return wd * 24 + d.hour, wd + 1
end

-- Start of the next hour `how` (UTC hour of the week), from t on (this hour counts).
function P.NextHourOfWeek(how, t)
  t = t or time()
  return t - t % 3600 + ((how - P.HourOfWeek(t)) % 168) * 3600
end

-- "Fri 18:00" on the player's clock
function P.WhenText(t)
  local d = date("*t", t)
  return DAY_SHORT[(d.wday + 5) % 7 + 1] .. string.format(" %02d:00", d.hour)
end

---------------------------------------------------------------------------
-- 2. TSM
---------------------------------------------------------------------------
local TSM_SOURCES = {
  market = "DBMarket", min = "DBMinBuyout", recent = "DBRecent", historical = "DBHistorical",
  auctions = "DBNumAuctions", region = "DBRegionMarketAvg", saleAvg = "DBRegionSaleAvg",
  saleRate = "DBRegionSaleRate", soldPerDay = "DBRegionSoldPerDay",
}

local function TSMValue(source, itemString)
  if not (TSM_API and TSM_API.GetCustomPriceValue) then return nil end
  local ok, value = pcall(TSM_API.GetCustomPriceValue, source, itemString)
  if ok and type(value) == "number" then return value end
  return nil
end

function P.HasTSM()
  return TSM_API ~= nil and TSM_API.GetCustomPriceValue ~= nil
end

local function FromTSM(itemID, c)
  local itemString = "i:" .. itemID
  for field, source in pairs(TSM_SOURCES) do c[field] = TSMValue(source, itemString) end
  return (c.market or c.region) ~= nil
end

---------------------------------------------------------------------------
-- Lookup
---------------------------------------------------------------------------
-- Everything known about an item's price. Fields can be nil.
-- { vendor, market, min, recent, historical, avg7, auctions, soldPerDay,
--   saleRate, region, hasAH = bool, source = "blizzard"|"tsm"|"scan"|nil,
--   updated = feed time, scanned = time of the scan the current numbers come from,
--   steady = median market of the feed's last 3 hours, where it differs from market }
-- houseID: read another house's prices (e.g. for an alt on the other faction).
function P.Get(itemID, houseID)
  if not itemID then return { vendor = 0, hasAH = false } end
  if houseID == P.House() then houseID = nil end
  local key = houseID and (houseID .. ":" .. itemID) or itemID
  local c = cache[key]
  if c and GetTime() - c.at < CACHE_SECONDS then return c end

  c = { at = GetTime(), vendor = ns.SellPrice(itemID) }
  if FromFeed(itemID, c, houseID) then
    c.source = "blizzard"
  elseif FromTSM(itemID, c) then
    c.source = "tsm"
  end
  -- A scan of this house newer than the feed: market, lowest price and quantity
  -- as listed right now. Items missing from the scan keep the feed's numbers.
  local scan = ns.Scan and ns.Scan.Latest(houseID or P.House() or 0)
  if scan and scan.t > (c.updated or 0) then
    local market, min, qty = (scan.items[itemID] or ""):match("^(%d+),(%d+),(%d+)$")
    if market then
      c.market, c.recent, c.min, c.auctions = tonumber(market), tonumber(market), tonumber(min), tonumber(qty)
      c.scanned, c.steady = scan.t, nil
      c.source = c.source or "scan"
    end
  end
  local feed = Feed()
  if feed and feed.spd and feed.spd[itemID] then c.soldPerDay = c.soldPerDay or feed.spd[itemID] end
  c.hasAH = (c.market or c.region) ~= nil
  cache[key] = c
  return c
end

-- The AH price we treat as "what it sells for now".
function P.AHPrice(p)
  return p.recent or p.market or p.region
end

-- The AH price we treat as "normal" for this item: the recent baseline (last
-- few days, weighted to the newest) when there is history. In a young economy
-- a 30-day average is mostly old news.
function P.NormalPrice(p, itemID)
  local h = itemID and P.History(itemID)
  if h and h.baseline then return h.baseline end
  return p.avg7 or p.historical or p.region or p.market
end

function P.ClearCache() cache = {}; histCache = {}; trendCache = nil; weekCache = nil end
