-- Cutpurse Ledger: advisor
-- One decision per item: SELL now, HOLD for a better price, LIST at the normal
-- price, or VENDOR it. Every decision comes with a short reason.
--
-- Rule of the house: anything white or better that can go on the AH goes on
-- the AH. Only grey junk, soulbound items, and items the AH pays LESS for than
-- a vendor are ever marked Vendor.

local ADDON, ns = ...
local A = {}
ns.Advisor = A

A.SETTINGS = {
  ahCut = 0.05,          -- AH keeps 5% of the sale price
  highVsNormal = 0.10,   -- 10% above the recent normal = sell now
  spike = 0.25,          -- 25% above = call it a spike
  lowVsNormal = -0.10,   -- 10% below normal = hold (only if not falling)
  fallingTrend = -0.01,  -- losing 1%+ a day = sell now, don't hold
  risingTrend = 0.015,   -- gaining 1.5%+ a day = wait a little (unless it's a spike)
  minListed = 10,        -- fewer units listed than this: one odd listing sets "the price", don't act on it
  minSpikeGain = 1000,   -- a spike must be worth 10 silver more per item, or it's noise on a cheap item
  -- Below normal: a dip (wait) or demand gone (sell)?
  demandDown = 0.6,      -- sold in the last 24h at 60% or less of a normal day = demand dropped
  demandSteady = 0.8,    -- 80% or more of a normal day = demand steady
  minDemandNormal = 5,   -- the item must normally sell 5+ a day for its sales to tell anything
  crashVsNormal = -0.25, -- a crash: 25%+ below normal...
  crashVsRecent = -0.15, -- ...and 15%+ below the last two days, so it happened just now
  -- Time of week (a reliable weekly pattern for the item, or for the whole house)
  waitGain = 0.05,       -- wait for a better time of the week only if it usually pays 5%+ more...
  minWaitGain = 100,     -- ...and at least 1 silver more per item
  peakNear = 0.02,       -- within 2% of the week's best = a good time now (whole-house pattern)
  -- Posting (see A.PostPlan)
  durations = { 12, 24, 48 }, -- auction lengths on this client, hours
  depositPer12h = 0.15,  -- deposit estimate: 15% of the vendor price per 12 hours, when the client can't say
  floorVsNormal = 0.85,  -- never suggest under 85% of normal (unless the price isn't coming back)
  likely = 0.75,         -- a 75%+ chance reads "likely sells"
}

A.ACTIONS = {
  SELL   = { label = "Sell now",    color = "ff4cff4c", order = 1 },
  LIST   = { label = "List",        color = "ffffd100", order = 2 },
  HOLD   = { label = "Hold",        color = "ff66b3ff", order = 3 },
  CRASH  = { label = "Crashed",     color = "ffff6b6b", order = 3.5 },  -- dropped hard, cause unknown: look first
  CHECK  = { label = "No AH price", color = "ffff9933", order = 4 },
  VENDOR = { label = "Vendor",      color = "ffbbbbbb", order = 5 },
  KEEP   = { label = "Keep",        color = "ff777777", order = 6 },
}

-- Can this item be sold on the AH (white or better, not soulbound)?
function A.IsAHItem(id)
  local item = ns.acc and ns.acc.items and ns.acc.items[id] or {}
  if item.bound then return false end
  local q = item.quality or select(3, ns.ItemInfo(id))
  return q ~= nil and q >= 1
end

local function Pct(x) return string.format("%+d%%", math.floor(x * 100 + 0.5)) end
-- "+40% vs normal", or "4x normal" once percentages get silly.
local function VsText(vs)
  if vs >= 2 then return math.floor(vs + 1) .. "x normal" end
  return Pct(vs) .. " vs normal"
end

local function Quality(id)
  local it = ns.acc and ns.acc.items and ns.acc.items[id]
  if it and it.quality then return it.quality end
  return select(3, ns.ItemInfo(id))
end

-- Is demand for an item down, steady, or unknown (nil)? From the feed: the
-- "Cooling off" list, or units bought in the last 24h against a normal day.
-- Returns "down" | "steady" | nil, plus the P.Sales record (or nil).
function A.Demand(id)
  local S = A.SETTINGS
  local s = ns.Prices.Sales and ns.Prices.Sales(id)
  local t = ns.Prices.Trending and ns.Prices.Trending()
  local tr = t and t.ready and t.byItem[id]
  if tr and tr.list == "cooling" then return "down", s end
  if s and s.normal and s.normal >= S.minDemandNormal then
    if s.sold24 <= S.demandDown * s.normal then return "down", s end
    if s.sold24 >= S.demandSteady * s.normal then return "steady", s end
  end
  return nil, s
end

-- How far the price is now below the higher of the last two days' prices
-- (-0.3 = 30% lower), or nil without daily history.
local function RecentDrop(h, ah)
  local vals, best, seen = h and h.daily and h.daily.values or {}, nil, 0
  for i = #vals, 1, -1 do
    if vals[i] then
      best, seen = math.max(best or 0, vals[i]), seen + 1
      if seen == 2 then break end
    end
  end
  return best and best > 0 and (ah / best - 1) or nil
end

local function Contains(list, x)
  for _, v in ipairs(list) do if v == x then return true end end
  return false
end

-- When in the week does this item sell best? From the item's own weekday pattern
-- (and the house's hour-of-week pattern for the time of day), or, for an item
-- without one, the whole house's hour-of-week pattern. nil without either.
-- { source = "item" | "house", now, best (price factors vs the week's average),
--   upside (best / now - 1), goodNow, at (unix time of the next good time),
--   when ("Fri 18:00" on the player's clock, or "Fri/Sat") }
function A.Timing(h, t)
  local P = ns.Prices
  t = t or time()
  local how, wd = P.HourOfWeek(t)
  local wh = P.WeekHours()
  if not (wh and wh.reliable) then wh = nil end
  local wk = P.WeekdayAdvice(h)
  if wk then
    local out = { source = "item", now = 1 + (h.weekday[wd] or 0), best = 1 + wk.bestPct, goodNow = Contains(wk.best, wd) }
    -- The next best day (today counts), and its best hour if the house pattern knows one.
    local ahead, day = 0, wd
    for k = 0, 6 do
      local d = (wd - 1 + k) % 7 + 1
      if Contains(wk.best, d) then ahead, day = k, d break end
    end
    local dayStart = t - t % 86400 + ahead * 86400
    out.at, out.when = dayStart, P.DayList(wk.best)
    if wh then
      local bestHour
      for hh = 0, 23 do
        local v = wh.pct[(day - 1) * 24 + hh]
        if v and (not bestHour or v > wh.pct[(day - 1) * 24 + bestHour]) then bestHour = hh end
      end
      -- start of the best 3 hours (the profile is smoothed around each hour)
      if bestHour then out.at = dayStart + math.max(0, bestHour - 1) * 3600; out.when = P.WhenText(out.at) end
    end
    out.upside = out.best / out.now - 1
    return out
  end
  if wh and h then
    local out = { source = "house", now = 1 + (wh.pct[how] or 0), best = 1 + wh.pct[wh.best] }
    out.upside = out.best / out.now - 1
    out.goodNow = out.upside <= ns.Advisor.SETTINGS.peakNear
    out.at = P.NextHourOfWeek((wh.best - 1) % 168, t)
    out.when = P.WhenText(out.at)
    return out
  end
  return nil
end

---------------------------------------------------------------------------
-- Posting: at what price, for how long, and how likely it sells (advice only).
-- Kept simple so every number can be explained:
--   * You post 1c under the lowest listing. Others undercut you in turn, so you
--     don't stay first: you stand behind the units already near the lowest price
--     (within 5% of it, from the feed; everything listed if the feed doesn't say).
--   * Buyers take units at the item's normal rate on this AH (bought per day,
--     else last 24h), spread evenly over the day.
--   * So the queue plus your own units clear in (queue + qty) / rate hours on
--     average, and the chance they sell within h hours is
--     P = 1 - exp(-rate * h / (queue + qty)).
--   * Sold: you get the price minus the AH cut, and the deposit back. Not sold:
--     the deposit is lost. Expected net = P * 0.95 * price - (1 - P) * deposit.
-- No sales data: no chance, valued as if it sells (as before this model).
---------------------------------------------------------------------------
local DURATION = { [12] = 1, [24] = 2, [48] = 3 }  -- the client's auction duration codes
local WHEN = { [12] = "12h", [24] = "a day", [48] = "2 days" }

-- Deposit per unit for an auction of `hours`. The client's own figure when it
-- has one (commodities, at the AH); otherwise an estimate from the vendor price,
-- rounded up.
local function Deposit(id, vendor, hours)
  local api = C_AuctionHouse and C_AuctionHouse.CalculateCommodityDeposit
  if api then
    local ok, dep = pcall(api, id, DURATION[hours], 1)
    if ok and type(dep) == "number" and dep > 0 then return dep end
  end
  return math.ceil(vendor * A.SETTINGS.depositPer12h * hours / 12)
end

local function Expected(price, chance, deposit)
  local cut = 1 - A.SETTINGS.ahCut
  if not chance then return price * cut end
  return chance * cut * price - (1 - chance) * deposit
end

-- { lowest, price (1c under the lowest), queue, qty, perDay, vendorFloor,
--   by = { { hours, chance, deposit, net } per duration }, best (one of by) }
-- chance is nil without sales data. vendorFloor: the lowest price that beats
-- the vendor with the best duration's odds.
function A.PostPlan(id, p, qty)
  local S = A.SETTINGS
  local vendor = p.vendor or 0
  local lowest = p.min or ns.Prices.AHPrice(p)
  local s = ns.Prices.Sales(id)
  local perDay = s and (s.normal or s.sold24)
  if perDay == 0 then perDay = nil end
  local plan = { lowest = lowest, price = math.max(1, lowest - 1), queue = ns.Prices.Queue(id) or p.auctions or 0,
    qty = qty, perDay = perDay, by = {} }
  for _, hours in ipairs(S.durations) do
    local chance = perDay and 1 - math.exp(-perDay / 24 * hours / (plan.queue + qty))
    local dep = Deposit(id, vendor, hours)
    local e = { hours = hours, chance = chance, deposit = dep, net = Expected(plan.price, chance, dep) }
    plan.by[#plan.by + 1] = e
    -- A longer auction must pay at least 1c more each, or a fast seller reads "sells in 2 days".
    if not plan.best or e.net >= plan.best.net + 1 then plan.best = e end
  end
  local b, chance = plan.best, plan.best.chance or 1
  plan.vendorFloor = math.ceil((vendor + (1 - chance) * b.deposit) / ((1 - S.ahCut) * chance))
  return plan
end

-- Returns { action, reason, unit (copper you'd get per item), ah, normal, vs, plan,
--   floor, and for LIST/SELL: post (suggested price), pSell (chance, or nil), hours }
-- qty: how many you'd post (default: what your characters on this AH own).
function A.Decide(id, qty)
  local S = A.SETTINGS
  local p = ns.Prices.Get(id)
  local vendor = p.vendor or 0
  local item = ns.acc and ns.acc.items and ns.acc.items[id] or {}

  if item.bound then
    if vendor > 0 then return { action = "VENDOR", reason = "Soulbound", unit = vendor } end
    return { action = "KEEP", reason = "Soulbound, no vendor price", unit = 0 }
  end
  if Quality(id) == 0 then
    return { action = "VENDOR", reason = "Junk", unit = vendor }
  end
  if not p.hasAH then
    -- White or better: never vendor blind. Check the AH first.
    return { action = "CHECK", reason = "Don't vendor: check the AH first", unit = 0 }
  end

  local ah = ns.Prices.AHPrice(p)
  local normal = ns.Prices.NormalPrice(p, id)
  local d = { ah = ah, normal = normal, unit = math.floor(ah * (1 - S.ahCut)) }
  local plan = A.PostPlan(id, p, math.max(1, qty or ns.Inventory.Total(id)))
  d.plan = plan

  -- Worth less on the AH than at the vendor, after the cut and the risk of losing the deposit.
  if math.floor(Expected(ah, plan.best.chance, plan.best.deposit)) < vendor then
    d.action, d.reason, d.unit = "VENDOR", "AH pays less than the vendor", vendor
    return d
  end

  -- Compare with the recent normal price, and look at where the price is heading.
  -- In a young economy prices drift fast, so a falling item is sold, not held.
  local h = ns.Prices.History(id)
  local trend = h and h.trend
  d.trend = trend
  -- Thin market: with only a handful listed, the "price" is whatever one seller
  -- typed in. Don't call a spike or a dip on that; tell the player to look.
  local listed = p.auctions
  local thin = (p.source == "blizzard" or p.source == "scan") and listed ~= nil and listed < S.minListed
  d.thin = thin
  -- A reliable weekly pattern: what's normal depends on the day (and hour). A usual
  -- Saturday high is not a spike, and a usual Tuesday low is not a dip.
  local timing = not thin and A.Timing(h) or nil
  d.timing = timing
  local expected = normal and normal * (timing and timing.now or 1)
  local vs = (expected and expected > 0) and (ah / expected - 1) or 0
  d.vs = vs
  local falling = trend and trend <= S.fallingTrend
  local rising = trend and trend >= S.risingTrend
  -- Order matters: a spike is always sold; a falling item is sold before it drops
  -- further; a rising item is held (the "normal" price lags a rising market, so
  -- "+12% vs normal" there is just the climb, not a peak). The trend comes from
  -- 7-day averages, so a weekly up-and-down never reads as rising or falling.
  local gain = expected and (ah - expected) or 0
  local below = vs <= S.lowVsNormal
  local demand, sales = A.Demand(id)
  local drop = RecentDrop(h, ah)
  local crash = vs <= S.crashVsNormal and drop ~= nil and drop <= S.crashVsRecent
  d.demand, d.crash = demand, crash or nil
  local gone  -- sold because the price is not coming back: undercut below normal if need be
  if thin and (vs >= S.highVsNormal or vs <= S.lowVsNormal) then
    d.action = "LIST"
    d.reason = "only " .. listed .. " listed, price uncertain: check the AH"
  elseif vs >= S.spike and gain >= S.minSpikeGain then
    d.action, d.reason = "SELL", VsText(vs) .. ", spike"
  elseif below and demand == "down" then
    -- Cheaper AND fewer buyers: the price is unlikely to come back. Don't hold.
    d.action, gone = "SELL", true
    d.reason = Pct(vs) .. " vs normal and demand dropped"
      .. ((sales and sales.normal) and (" (" .. sales.sold24 .. " sold in 24h, normally " .. math.floor(sales.normal + 0.5) .. ")") or "")
      .. ", unlikely to come back"
  elseif falling then
    d.action, d.reason, gone = "SELL", "falling " .. Pct(-trend):gsub("^%+", "") .. "/day, sell before it drops", true
  elseif rising then
    d.action, d.reason = "HOLD", "rising " .. Pct(trend) .. "/day, wait a little"
  elseif vs >= S.highVsNormal then
    d.action, d.reason = "SELL", VsText(vs)
    if gain < S.minSpikeGain then d.reason = d.reason .. ", only " .. ns.Money(gain) .. " more each" end
  elseif below and demand == "steady" then
    d.action, d.reason = "HOLD", Pct(vs) .. " vs normal, demand steady: a dip, wait"
  elseif below and crash then
    -- Dropped hard just now and no sales data says why: a dip or a collapse?
    d.action = "CRASH"
    d.reason = "dropped " .. (Pct(-drop):gsub("^%+", "")) .. " since yesterday, can't tell a dip from demand gone: check the AH before holding"
  elseif below then
    d.action, d.reason = "HOLD", Pct(vs) .. " vs normal, wait"
  else
    d.action, d.reason = "LIST", timing and "Normal price for now" or "Normal price"
  end

  -- A reliable weekly pattern: list at the good time of the week. Only for items
  -- that would be listed or held anyway: spikes, falling items and crashes keep
  -- their advice.
  if timing and (d.action == "LIST" or d.action == "HOLD") then
    local whose = timing.source == "house" and " (whole AH)" or ""
    if not timing.goodNow and timing.upside >= S.waitGain and ah * timing.upside >= S.minWaitGain then
      d.action = "HOLD"
      d.reason = d.reason .. "; list " .. timing.when .. ", usually " .. Pct(timing.upside) .. " then" .. whose
      d.waitUntil = timing.at
    elseif timing.goodNow and d.action == "LIST" and timing.best > 1 then
      d.action = "SELL"
      d.reason = "Best time of the week, usually " .. Pct(timing.best - 1) .. " vs the week" .. whose
    elseif timing.goodNow then
      d.reason = d.reason .. ", though now is usually the best time of the week" .. whose
    end
  end
  local wk = ns.Prices.WeekdayAdvice(h)
  if wk then d.bestDays = wk.best end
  -- (A chance to sell, below, says it better than "slow seller".)
  if not plan.best.chance and ((p.soldPerDay and p.soldPerDay < 10) or (not p.soldPerDay and p.saleRate and p.saleRate < 0.2)) then
    d.reason = d.reason .. ", slow seller"
  end
  -- Demand signals: trending now, or wanted for high-level quests.
  local trending = ns.Prices.Trending and ns.Prices.Trending()
  local tr = trending and trending.byItem[id]
  if tr and (tr.list == "hot" or tr.list == "drying") then d.reason = d.reason .. ", in demand right now" end
  local questLevel = ns.Quests and ns.Quests.Level(id)
  if questLevel and questLevel >= 50 then d.reason = d.reason .. ", people buy it for quests" end

  -- Listing now: at what price, and is it worth it? Never undercut below what
  -- beats the vendor, nor (unless the price isn't coming back) far below normal.
  d.floor = math.max(plan.vendorFloor, gone and 0 or math.ceil((normal or 0) * S.floorVsNormal))
  if d.action == "LIST" or d.action == "SELL" then
    local b = plan.best
    if plan.price < d.floor then
      d.action, d.reason = "HOLD", "Not worth posting now: lowest is under " .. ns.Money(d.floor)
    else
      d.post, d.pSell, d.hours, d.unit = plan.price, b.chance, b.chance and b.hours, math.floor(b.net)
      if b.chance then
        d.reason = d.reason .. "; post at " .. ns.Money(d.post) .. ", " .. (b.chance >= S.likely and "likely sells"
          or (math.floor(b.chance * 100 + 0.5) .. "% chance")) .. " in " .. WHEN[b.hours]
      end
    end
  end
  return d
end

-- Decisions for everything owned on this realm, sorted by total value.
-- Each entry: { id, name, qty, decision, total }
function A.InventoryPlan()
  local list = {}
  for id, owned in pairs(ns.Inventory.AllItems()) do
    local d = A.Decide(id, owned.total)
    local it = ns.acc.items[id] or {}
    list[#list + 1] = {
      id = id, name = it.name or ("item " .. id), qty = owned.total,
      chars = owned.chars, decision = d, total = (d.unit or 0) * owned.total,
    }
  end
  table.sort(list, function(x, y)
    if x.total ~= y.total then return x.total > y.total end
    return x.name < y.name
  end)
  return list
end

---------------------------------------------------------------------------
-- Net worth: gold on every character of the account, plus what their items
-- (bags, bank, mail as of the last visit) would bring at current prices.
---------------------------------------------------------------------------
-- What one unit would bring you at a house: the AH price after the cut, or the
-- vendor price if that pays more. Soulbound and junk: vendor price. No AH price
-- known: vendor price, and `unpriced` is true (it may be worth more).
function A.UnitWorth(id, house)
  local p = ns.Prices.Get(id, house)
  local vendor = p.vendor or 0
  local item = ns.acc and ns.acc.items and ns.acc.items[id] or {}
  if item.bound or Quality(id) == 0 then return vendor, false end
  if not p.hasAH then return vendor, true end
  return math.max(math.floor(ns.Prices.AHPrice(p) * (1 - A.SETTINGS.ahCut)), vendor), false
end

-- { gold, items, total, unpriced (item stacks without an AH price),
--   chars = { { name, label, faction, gold, items, total, house } } (richest first) }
function A.NetWorth()
  local out = { gold = 0, items = 0, total = 0, unpriced = 0, chars = {} }
  for _, ch in pairs(ns.acc.chars or {}) do
    local gold = ch == ns.db and GetMoney() or (ch.gold or 0)
    local house = ns.Prices.HouseFor(ch)
    local items = 0
    for _, place in ipairs(ns.Inventory.PLACES) do
      for id, n in pairs(ch.inv and ch.inv[place] or {}) do
        local unit, unpriced = A.UnitWorth(id, house)
        items = items + unit * n
        if unpriced then out.unpriced = out.unpriced + 1 end
      end
    end
    out.chars[#out.chars + 1] = { name = ch.name or "?", label = ch.realmLabel, faction = ch.faction,
      gold = gold, items = items, total = gold + items, house = house }
    out.gold, out.items = out.gold + gold, out.items + items
  end
  out.total = out.gold + out.items
  table.sort(out.chars, function(x, y) return x.total > y.total end)
  return out
end

function A.Tag(action)
  local a = A.ACTIONS[action]
  return "|c" .. a.color .. a.label .. "|r"
end
