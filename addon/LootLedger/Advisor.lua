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
  lowVsNormal = -0.10,   -- 10% below normal = below normal (sold now if demand dropped)
  holdVsNormal = -0.20,  -- hold only a dip 20%+ below normal, with demand steady and not falling:
                         -- smaller dips rarely come back (a day 10-25% below: median -0.6% the next)
  holdHours = 48,        -- a hold lasts up to 48h from when it was first advised, then sell
  freshHours = 2,        -- "high, sell now" only on prices under 2h old: highs fade within hours
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
  depositPer12h = 0.15,  -- deposit estimate (see A.PostPlan): 15% of the vendor price per 12 hours
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
-- Posting: at what price, how likely it sells, and what that is worth (advice only).
-- Kept simple so every number can be explained:
--   * You post 1c under the lowest listing, or under the AH price when the
--     lowest is a stray cheap listing (more than 10% under it).
--   * Others undercut you in turn, so you don't stay first: you stand behind the
--     units already near the lowest price (within 5% of it, from the feed;
--     everything listed if the feed doesn't say).
--   * Buyers take units at the item's normal rate on this AH (bought per day,
--     else last 24h), spread evenly over the day. So the chance your units sell
--     in one 24h auction is P = 1 - exp(-perDay / (queue + qty)).
--   * An unsold auction comes back and is relisted until it sells, losing its
--     deposit each time: on average (1 - P) / P times. So one unit is worth
--     0.95 * price - deposit * (1 - P) / P.
-- No sales data: no chance, worth 0.95 * price (as before this model).
---------------------------------------------------------------------------
-- Deposit per unit for a 24h auction, and whether it's our estimate. The client's
-- own figure when it has one (commodities, at the AH); otherwise 15% of the
-- vendor price per 12 hours, rounded up.
local function Deposit(id, vendor)
  local api = C_AuctionHouse and C_AuctionHouse.CalculateCommodityDeposit
  if api then
    local ok, dep = pcall(api, id, 2, 1)  -- 2 = the client's code for 24h
    if ok and type(dep) == "number" and dep > 0 then return dep, false end
  end
  return math.ceil(vendor * A.SETTINGS.depositPer12h * 2), true
end

-- What one unit brings at `price`, relisted until it sells (see above).
local function Value(price, plan)
  local net = price * (1 - A.SETTINGS.ahCut)
  if not plan.chance then return net end
  return net - plan.deposit * (1 - plan.chance) / plan.chance
end

-- { lowest, price (suggested), queue, qty, perDay, chance (nil without sales data),
--   fillDays (chance measured on this AH over that many days; nil = the formula's estimate),
--   deposit, estimated (deposit is our estimate), vendorFloor (the least that beats vendoring) }
-- house: another house's prices (nil = this character's).
function A.PostPlan(id, p, qty, house)
  local P, vendor, ah = ns.Prices, p.vendor or 0, ns.Prices.AHPrice(p)
  local s = P.Sales(id, house)
  local perDay = s and (s.normal or s.sold24)
  if perDay == 0 then perDay = nil end
  local lowest = p.min or ah
  local stray = lowest < 0.9 * ah  -- a stray cheap listing doesn't set the price...
  local plan = { lowest = lowest, price = math.max(1, (stray and ah or lowest) - 1), qty = qty, perDay = perDay,
    queue = (not stray and P.Queue(id, house)) or p.auctions or 0 }  -- ...nor its 5% band the queue
  plan.chance = perDay and 1 - math.exp(-perDay / (plan.queue + qty))
  -- Measured on this AH when the feed has it (P.Fill): p24 is how often one unit
  -- posted 1c under the lowest sold within 24h, undercuts included. qty units: the
  -- formula discounted by what it got wrong for one unit, formula(qty) * p24 / formula(1);
  -- no sales data: p24. Not when we post at the AH price over a stray (p24 was measured
  -- at the lowest), nor a measured 0 (the replay is cautious; it would mean endless relists).
  local fill = P.Fill(id, house)
  if fill and not stray and fill.p24 > 0 then
    plan.chance = perDay and math.min(1, plan.chance * fill.p24 / (1 - math.exp(-perDay / (plan.queue + 1)))) or fill.p24
    plan.fillDays = math.floor(fill.n / 24 + 0.5)  -- days of this AH behind it
  end
  plan.deposit, plan.estimated = Deposit(id, vendor)
  -- Only the client's own deposit may make the AH lose to the vendor: the estimate
  -- is unverified (and neutral houses charge far more), so it only shows.
  local relists = plan.chance and not plan.estimated and (1 - plan.chance) / plan.chance or 0
  plan.vendorFloor = math.ceil((vendor + plan.deposit * relists) / (1 - A.SETTINGS.ahCut))
  return plan
end

-- One unit's worth by the plan: the AH (posted as suggested, relisted until it
-- sells) or the vendor, whichever pays more.
local function Worth(plan, vendor)
  return math.max(vendor, math.floor(Value(plan.price, plan)))
end

-- "5h", "1 day", "2 days"
local function Span(s)
  local h = math.ceil(s / 3600)
  if h < 24 then return h .. "h" end
  local days = math.floor(h / 24 + 0.5)
  return days == 1 and "1 day" or (days .. " days")
end

-- Holds end. Each lasts up to holdHours from when it was first advised for an item
-- you own, then the advice is to sell (for as long as the same hold would apply).
-- Remembered on the account: ns.acc.holds[id] = { start, kind ("dip"|"rising"),
-- seen (last advised) }; forgotten a day after it was last advised or ended,
-- whichever is later, so a later dip gets its own.
local function HoldKept(h) return time() - math.max(h.seen, h.start + A.SETTINGS.holdHours * 3600) <= 24 * 3600 end

ns.OnInit(function()
  for id, h in pairs(ns.acc.holds or {}) do
    if not HoldKept(h) then ns.acc.holds[id] = nil end
  end
end)

-- HOLD for `target` or more until the hold ends, then SELL.
local function Hold(d, id, kind, why, target)
  local holds, now = ns.acc and ns.acc.holds, time()
  local h = holds and holds[id]
  if not (h and h.kind == kind and HoldKept(h)) then
    h = { start = now, kind = kind }
    if ns.acc and ns.Inventory.Total(id) > 0 then
      ns.acc.holds = holds or {}
      ns.acc.holds[id] = h
    end
  end
  h.seen = now
  local ends = h.start + A.SETTINGS.holdHours * 3600
  if now >= ends then
    d.action, d.reason = "SELL", "hold ended: sell now (" .. why .. ")"
  else
    d.action, d.target, d.holdUntil = "HOLD", math.ceil(target), ends
    d.reason = why .. ": hold up to " .. Span(ends - time()) .. " for " .. ns.Money(d.target) .. "+, then sell"
  end
end

-- Returns { action, reason, unit (copper you'd get per item), ah, normal, vs, plan,
--   and for LIST/SELL: post (suggested price), pSell (chance in 24h, or nil),
--   and for a HOLD: target (price to hold for), holdUntil (when to sell anyway) }
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

  -- Decide on the median of the feed's last 3 hours when it has one: one hour's
  -- price is often noise (a fifth of hourly moves are 5%+).
  local ah = p.steady or ns.Prices.AHPrice(p)
  local normal = ns.Prices.NormalPrice(p, id)
  local plan = A.PostPlan(id, p, math.max(1, qty or ns.Inventory.Total(id)))
  local d = { ah = ah, normal = normal, plan = plan, unit = Worth(plan, vendor) }

  -- Worth less on the AH than at the vendor, after the cut and the deposits lost
  -- relisting (only when the client gave the deposit: see A.PostPlan).
  if vendor > 0 and (plan.estimated and ah * (1 - S.ahCut) or Value(ah, plan)) < vendor then  -- no vendor price: never Vendor
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
  -- "High, sell now" goes stale fast (an hour 10%+ above normal is typically 14%
  -- lower 6 hours later): on prices freshHours old or more (from the feed, or your
  -- newer scan), a spike says how old it is, a smaller high says look first. Such
  -- lines (d.stale) suggest no post price.
  local asOf = p.scanned or p.updated
  d.asOf = asOf  -- when the price is from (the track record files the advice under its day)
  local age = asOf and time() - asOf or 0
  local stale = age >= S.freshHours * 3600
  if thin and (vs >= S.highVsNormal or vs <= S.lowVsNormal) then
    d.action = "LIST"
    d.reason = "only " .. listed .. " listed, price uncertain: check the AH"
  elseif vs >= S.spike and gain >= S.minSpikeGain then
    d.action, d.reason = "SELL", VsText(vs) .. (stale and (" " .. ns.Ago(age) .. ", spike: sell if still up") or ", spike")
    d.stale = stale or nil
  elseif below and demand == "down" then
    -- Cheaper AND fewer buyers: the price is unlikely to come back. Don't hold.
    d.action = "SELL"
    d.reason = Pct(vs) .. " vs normal and demand dropped"
      .. ((sales and sales.normal) and (" (" .. sales.sold24 .. " sold in 24h, normally " .. math.floor(sales.normal + 0.5) .. ")") or "")
      .. ", unlikely to come back"
  elseif falling then
    d.action, d.reason = "SELL", "falling " .. Pct(-trend):gsub("^%+", "") .. "/day, sell before it drops"
  elseif rising then
    Hold(d, id, "rising", "rising " .. Pct(trend) .. "/day", ah * (1 + trend) ^ (S.holdHours / 24))
  elseif vs >= S.highVsNormal and stale then
    d.action, d.reason, d.stale = "LIST", VsText(vs) .. " " .. ns.Ago(age) .. ": check the AH first", true
  elseif vs >= S.highVsNormal then
    d.action, d.reason = "SELL", VsText(vs)
    if gain < S.minSpikeGain then d.reason = d.reason .. ", only " .. ns.Money(gain) .. " more each" end
  elseif vs <= S.holdVsNormal and demand == "steady" then
    -- A real dip with buyers still there: worth a bounded wait for a third of the
    -- way back (most dips never get halfway).
    Hold(d, id, "dip", Pct(vs) .. " vs normal, demand steady", ah + (expected - ah) / 3)
  elseif below and crash then
    -- Dropped hard just now and no sales data says why: a dip or a collapse?
    d.action = "CRASH"
    d.reason = "dropped " .. (Pct(-drop):gsub("^%+", "")) .. " since yesterday, can't tell a dip from demand gone: check the AH before holding"
  elseif below then
    d.action, d.reason = "LIST", Pct(vs) .. " vs normal, dips rarely come back"
  else
    d.action, d.reason = "LIST", timing and "Normal price for now" or "Normal price"
  end

  -- A reliable weekly pattern: list at the good time of the week. Only for items
  -- that would be listed anyway: spikes, falling items, crashes and holds (which
  -- have their own deadline) keep their advice.
  if timing and d.action == "LIST" and not d.stale then
    local whose = timing.source == "house" and " (whole AH)" or ""
    if not timing.goodNow and timing.upside >= S.waitGain and ah * timing.upside >= S.minWaitGain then
      d.action = "HOLD"
      d.reason = d.reason .. "; list " .. timing.when .. ", usually " .. Pct(timing.upside) .. " then" .. whose
      d.waitUntil = timing.at
    elseif timing.goodNow and timing.best > 1 then
      d.action = "SELL"
      d.reason = "Best time of the week, usually " .. Pct(timing.best - 1) .. " vs the week" .. whose
    end
  end
  local wk = ns.Prices.WeekdayAdvice(h)
  if wk then d.bestDays = wk.best end
  -- (A chance to sell, below, says it better than "slow seller".)
  if not plan.chance and ((p.soldPerDay and p.soldPerDay < 10) or (not p.soldPerDay and p.saleRate and p.saleRate < 0.2)) then
    d.reason = d.reason .. ", slow seller"
  end
  -- Demand signals: trending now, or wanted for high-level quests.
  local trending = ns.Prices.Trending and ns.Prices.Trending()
  local tr = trending and trending.byItem[id]
  if tr and (tr.list == "hot" or tr.list == "drying") then d.reason = d.reason .. ", in demand right now" end
  local questLevel = ns.Quests and ns.Quests.Level(id)
  if questLevel and questLevel >= 50 then d.reason = d.reason .. ", people buy it for quests" end

  -- Listing now: at what price, and how likely it sells. Never under what beats
  -- the vendor. A thin market keeps its "check the AH" (one seller sets the price).
  if d.action == "LIST" or d.action == "SELL" then
    if plan.price < plan.vendorFloor then
      if not thin then d.action, d.reason = "HOLD", "Not worth posting now: lowest is under " .. ns.Money(plan.vendorFloor) end
    else
      d.post, d.pSell = plan.price, plan.chance
      if plan.chance and not (thin or d.stale) then
        d.reason = d.reason .. "; post at " .. ns.Money(d.post) .. ", " .. (plan.chance >= 0.75 and "likely sells in a day"
          or ("about " .. math.floor(plan.chance * 100 + 0.5) .. "% chance a day"))
      end
    end
  end
  return d
end

---------------------------------------------------------------------------
-- Track record: how well did the advice do?
-- InventoryPlan remembers the advice for each item you own on this AH, once a day,
-- for 30 days, if the item has a price history to judge it by and the advice isn't
-- "look first" (stale or thin prices):
--   ns.acc.advice[house][id][day] = "S" (SELL) | "L" (LIST) | "H,<target>,<ends>" (HOLD)
-- day is the UTC date of the price (as the feed labels its daily prices); prices
-- over 6 hours old aren't remembered. Holds without a target (a better time of the
-- week, "not worth posting now") aren't either.
-- Judged on the feed's daily prices, against the advice day's own price (v), once
-- the days needed are over:
--   * SELL was right if the price 2 days later was no higher than v.
--   * LIST was right if v was at least the average of the next 2 days.
--   * HOLD was right if a day after it, up to its deadline, reached the target (or v).
-- A run of the same advice on an item counts once, from its first day. Each figure
-- comes with the same rule's rate on any day of those items ("any day"): the advice
-- is only worth something if it beats that.
---------------------------------------------------------------------------
local TRACK_DAYS, SCORE_MIN, MAX_AGE = 30, 5, 6 * 3600

local function UTCDay(t)
  local u = date("!*t", t)
  return string.format("%04d-%02d-%02d", u.year, u.month, u.day)
end

ns.OnInit(function()
  local oldest = UTCDay(time() - TRACK_DAYS * 86400)
  for house, items in pairs(ns.acc.advice or {}) do
    for id, days in pairs(items) do
      for day in pairs(days) do if day < oldest then days[day] = nil end end
      if not next(days) then items[id] = nil end
    end
    if not next(items) then ns.acc.advice[house] = nil end
  end
end)

local CODE = { SELL = "S", LIST = "L", HOLD = "H" }

-- Remember one decision (InventoryPlan). day: UTCDay(d.asOf), worked out by the caller.
local function Remember(house, id, d, day)
  local code = CODE[d.action]
  if not code or d.stale or d.thin or not d.asOf or time() - d.asOf > MAX_AGE then return end
  if code == "H" then
    if not d.target then return end
    code = "H," .. d.target .. "," .. d.holdUntil
  end
  local all = ns.acc.advice or {}
  local items = all[house] or {}
  local days = items[id] or {}
  if days[day] or not ns.Prices.History(id) then return end
  ns.acc.advice, all[house], items[id], days[day] = all, items, days, code
end

-- Would advice `kind` ("S", "L", "H") on day i have been right? nil until the days
-- it needs are over (the newest, `last`, is still running) or without prices.
-- HOLD: some day of the next `span` reaches q times day i's price.
local function Right(kind, v, i, last, q, span)
  local function V(k) return k >= 1 and k < last and v[k] or nil end
  local now = V(i)
  if not now then return nil end
  if kind == "S" then
    local later = V(i + 2)
    if later then return later <= now end
  elseif kind == "L" then
    local a, b = V(i + 1), V(i + 2)
    if a and b then return now >= (a + b) / 2 end
  elseif span >= 1 and i + span < last then
    for k = i + 1, i + span do if (V(k) or 0) >= now * q then return true end end
    return false
  end
  return nil
end

-- How the advice did on this AH: { S = { n, right, base }, L = ..., H = ... }, base
-- = how many the same rule would have got right on any day of those items.
function A.Score()
  local out = { S = { n = 0, right = 0, base = 0 }, L = { n = 0, right = 0, base = 0 }, H = { n = 0, right = 0, base = 0 } }
  local house = ns.Prices.House()
  local labels, at
  for id, days in pairs(house and ns.acc.advice and ns.acc.advice[house] or {}) do
    local h = ns.Prices.History(id)
    if h then
      if h.daily.labels ~= labels then
        labels, at = h.daily.labels, {}
        for i, k in ipairs(labels) do at[k] = i end
      end
      local v, last, keys, prev = h.daily.values, #labels, {}, nil
      for day in pairs(days) do keys[#keys + 1] = day end
      table.sort(keys)
      for _, day in ipairs(keys) do
        local r, i = days[day], at[day]
        local run = r:gsub("^H,[^,]*", "H")  -- a hold keeps its deadline while its target moves
        if run ~= prev and i then
          local kind, target, ends = r:match("^(%a),?(%d*),?(%d*)$")
          local q, span = 1, 0  -- HOLD: the target (at least the day's price), days to the deadline
          if kind == "H" then q, span = v[i] and math.max(1, target / v[i]) or 1, (at[UTCDay(tonumber(ends))] or 0) - i end
          local right = Right(kind, v, i, last, q, span)
          if right ~= nil then
            local c, yes, all = out[kind], 0, 0
            c.n, c.right = c.n + 1, c.right + (right and 1 or 0)
            for j = 1, last - 1 do
              local any = Right(kind, v, j, last, q, span)
              if any ~= nil then yes, all = yes + (any and 1 or 0), all + 1 end
            end
            c.base = c.base + yes / all
          end
        end
        prev = run
      end
    end
  end
  return out
end

local SCORED = { { "H", "holds reached target" }, { "S", "sells beat waiting 2 days" }, { "L", "lists beat the next 2 days" } }
local function Pct100(x) return math.floor(x * 100 + 0.5) .. "%" end

-- One line for the Sell tab, or nil until some kind of advice has SCORE_MIN judged.
function A.ScoreText()
  local s, parts = A.Score(), {}
  for _, k in ipairs(SCORED) do
    local c = s[k[1]]
    if c.n >= SCORE_MIN then
      parts[#parts + 1] = k[2] .. " " .. Pct100(c.right / c.n) .. " (any day " .. Pct100(c.base / c.n) .. ", n=" .. c.n .. ")"
    end
  end
  return #parts > 0 and ("Advice, last " .. TRACK_DAYS .. " days: " .. table.concat(parts, "; ")) or nil
end

-- Decisions for everything owned on this realm, sorted by total value.
-- Each entry: { id, name, qty, decision, total }
function A.InventoryPlan()
  local list, house, asOf, day = {}, ns.Prices.House(), nil, nil
  for id, owned in pairs(ns.Inventory.AllItems()) do
    local d = A.Decide(id, owned.total)
    if house and d.asOf then
      if d.asOf ~= asOf then asOf, day = d.asOf, UTCDay(d.asOf) end
      Remember(house, id, d, day)
    end
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
-- What one unit would bring you at a house: posted as the advice suggests and
-- relisted until it sells (the same value as the advice's), or the vendor price
-- if that pays more. Soulbound and junk: vendor price. No AH price known: vendor
-- price, and `unpriced` is true (it may be worth more).
function A.UnitWorth(id, house)
  local p = ns.Prices.Get(id, house)
  local vendor = p.vendor or 0
  local item = ns.acc and ns.acc.items and ns.acc.items[id] or {}
  if item.bound or Quality(id) == 0 then return vendor, false end
  if not p.hasAH then return vendor, true end
  return Worth(A.PostPlan(id, p, math.max(1, (ns.Inventory.Total(id))), house), vendor), false
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
