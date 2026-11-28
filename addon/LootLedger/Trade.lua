-- Cutpurse Ledger: trade record
-- Every AH sale, posting, expired/cancelled auction, AH purchase and vendor sale,
-- per item, shared by all your characters on the same realm and faction (they
-- share an auction house). From this we know what YOU really get for an item:
--
--   your net price per unit = (sale price - AH cut - deposits lost on failed
--                              listings) / units sold
--
-- over the last 30 days, recent sales counting more. Gathering uses it to value
-- what you skinned, mined, picked and pickpocketed (see Gathering.lua), and to
-- split real sales between professions.

local ADDON, ns = ...
local Tr = {}
ns.Trade = Tr

Tr.SETTINGS = {
  windowDays = 30,    -- sales older than this don't count towards your price
  halfLifeDays = 14,  -- a sale this old counts half as much as one today
  minSales = 5,       -- fewer sales than this (and fewer units than minUnits):
  minUnits = 20,      --   blend your price with the fallback
  keepDays = 120,     -- individual sales kept this long (totals are kept forever)
  keepPostDays = 40,  -- open postings kept this long (expired mail can wait 30 days)
}
local DAY = 86400

---------------------------------------------------------------------------
-- Storage: ns.acc.trade[realm|faction].items[itemID] = {
--   sales = { { t, n, net } },  lost = { { t, n, dep } },  posts = { { t, n, dep } },
--   tot = { soldN, soldNet, lostDep, boughtN, boughtCost, vendN, vendNet, ahN } }
---------------------------------------------------------------------------
local function StoreKey()
  local faction = UnitFactionGroup and UnitFactionGroup("player") or ""
  return (ns.db and ns.db.realm or "") .. "|" .. (faction or "")
end

function Tr.Store()
  ns.acc.trade = ns.acc.trade or {}
  local key = StoreKey()
  local s = ns.acc.trade[key]
  if not s then
    s = { items = {}, unmatched = {}, since = time() }
    ns.acc.trade[key] = s
  end
  return s
end

local lossCache  -- Tr.LossRate result { key, day, rate }; cleared when sales or losses change

local function NewTotals()
  return { soldN = 0, soldNet = 0, lostDep = 0, boughtN = 0, boughtCost = 0, vendN = 0, vendNet = 0, ahN = 0 }
end

function Tr.Item(id, create)
  local items = Tr.Store().items
  local e = items[id]
  if not e and create then
    e = { sales = {}, lost = {}, posts = {}, tot = NewTotals() }
    items[id] = e
  end
  return e
end

local function Trim(list, oldest)
  local i = 1
  while list[i] and list[i].t < oldest do i = i + 1 end
  if i > 1 then
    for _ = 1, i - 1 do table.remove(list, 1) end
  end
end

local function Tidy(e, now)
  Trim(e.sales, now - Tr.SETTINGS.keepDays * DAY)
  Trim(e.lost, now - Tr.SETTINGS.keepDays * DAY)
  Trim(e.posts, now - Tr.SETTINGS.keepPostDays * DAY)
end

---------------------------------------------------------------------------
-- Recording
---------------------------------------------------------------------------
-- An auction posted: n units, deposit paid (copper).
function Tr.Posted(id, n, deposit, now)
  if not id or not n or n <= 0 then return end
  now = now or time()
  local e = Tr.Item(id, true)
  e.posts[#e.posts + 1] = { t = now, n = n, dep = math.max(0, deposit or 0) }
  Tidy(e, now)
end

-- Take n units off the oldest open postings. Returns the deposit attached to them.
local function ClosePosts(e, n)
  local dep = 0
  while n > 0 and e.posts[1] do
    local p = e.posts[1]
    local take = math.min(n, p.n)
    local share = p.n > 0 and p.dep * take / p.n or 0
    p.n, p.dep, n, dep = p.n - take, p.dep - share, n - take, dep + share
    if p.n <= 0 then table.remove(e.posts, 1) end
  end
  return dep
end

-- An AH sale, from the sale mail: n units, net = sale price - AH cut.
-- n may be nil if the client doesn't report the count; the gold still counts
-- towards "sold", but the sale can't set a price per unit.
function Tr.Sale(id, n, net, now)
  if not id then return end
  lossCache = nil
  now = now or time()
  local e = Tr.Item(id, true)
  if n and n > 0 then
    e.sales[#e.sales + 1] = { t = now, n = n, net = net }
    e.tot.soldN = e.tot.soldN + n
    e.tot.ahN = e.tot.ahN + n
    e.tot.soldNet = e.tot.soldNet + net
    ClosePosts(e, n)  -- the deposit came back with the money: nothing lost
  else
    e.tot.unknownNet = (e.tot.unknownNet or 0) + net  -- count unknown: kept apart
  end
  Tidy(e, now)
end

-- Items back from an expired or cancelled auction: that listing's deposit is lost.
function Tr.Returned(id, n, now)
  if not id or not n or n <= 0 then return end
  lossCache = nil
  now = now or time()
  local e = Tr.Item(id, true)
  local dep = ClosePosts(e, n)
  e.lost[#e.lost + 1] = { t = now, n = n, dep = dep }
  e.tot.lostDep = e.tot.lostDep + dep
  Tidy(e, now)
end

function Tr.Bought(id, n, cost)
  if not id or not n or n <= 0 then return end
  local e = Tr.Item(id, true)
  e.tot.boughtN, e.tot.boughtCost = e.tot.boughtN + n, e.tot.boughtCost + (cost or 0)
end

-- Sold to a vendor: counts as sold, at the vendor's price.
function Tr.Vendored(id, n, net, now)
  if not id or not n or n <= 0 then return end
  lossCache = nil
  now = now or time()
  local e = Tr.Item(id, true)
  e.sales[#e.sales + 1] = { t = now, n = n, net = net, vendor = true }
  e.tot.soldN, e.tot.soldNet = e.tot.soldN + n, e.tot.soldNet + net
  e.tot.vendN, e.tot.vendNet = e.tot.vendN + n, e.tot.vendNet + net
  Tidy(e, now)
end

-- A sale mail for an item we couldn't identify: kept so it can be checked.
function Tr.Unmatched(name, n, net)
  local u = Tr.Store().unmatched
  u[#u + 1] = { t = time(), name = name, n = n, net = net }
  while #u > 50 do table.remove(u, 1) end
end

---------------------------------------------------------------------------
-- Item names -> IDs (sale mails only give the name)
---------------------------------------------------------------------------
function Tr.ItemIDByName(name)
  if not name or name == "" then return nil end
  local _, link = ns.ItemInfo(name)
  local id = link and tonumber(link:match("item:(%d+)"))
  if id then return id end
  for itemID, it in pairs(ns.acc.items or {}) do
    if it.name == name then return itemID end
  end
  for _, ch in pairs(ns.acc.chars or {}) do
    for _, b in pairs(ch.acts or {}) do
      for itemID, n in pairs(b.names or {}) do
        if n == name then return itemID end
      end
    end
  end
end

---------------------------------------------------------------------------
-- Prices
---------------------------------------------------------------------------
-- What you really got per unit lately, after the AH cut and lost deposits.
-- Returns unit (copper), number of sales, units sold; or nil without sales.
function Tr.Realized(id, now)
  local e = Tr.Item(id)
  if not e then return nil end
  now = now or time()
  local S = Tr.SETTINGS
  local oldest = now - S.windowDays * DAY
  local function W(t) return 0.5 ^ ((now - t) / (S.halfLifeDays * DAY)) end
  local wN, wNet, count, units = 0, 0, 0, 0
  for _, s in ipairs(e.sales) do
    if s.t >= oldest then
      local w = W(s.t)
      wN, wNet = wN + w * s.n, wNet + w * s.net
      count, units = count + 1, units + s.n
    end
  end
  if wN <= 0 then return nil end
  local wLost = 0
  for _, l in ipairs(e.lost) do
    if l.t >= oldest then wLost = wLost + W(l.t) * l.dep end
  end
  return math.max(0, (wNet - wLost) / wN), count, units
end

-- Your AH results for an item over the last 30 days (Market tab), or nil without any:
-- { sales, sold (units sold on the AH), back (units that came back unsold),
--   unit (per unit sold, after the AH cut and deposits lost; nil without sales) }
-- Vendor sales don't count.
function Tr.Results(id, now)
  local e = Tr.Item(id)
  if not e then return nil end
  local oldest = (now or time()) - Tr.SETTINGS.windowDays * DAY
  local out, net, lost = { sales = 0, sold = 0, back = 0 }, 0, 0
  for _, s in ipairs(e.sales) do
    if s.t >= oldest and not s.vendor then out.sales, out.sold, net = out.sales + 1, out.sold + s.n, net + s.net end
  end
  for _, l in ipairs(e.lost) do
    if l.t >= oldest then out.back, lost = out.back + l.n, lost + l.dep end
  end
  if out.sold + out.back == 0 then return nil end
  out.unit = out.sold > 0 and math.max(0, (net - lost) / out.sold) or nil
  return out
end

-- Share of AH income eaten by failed listings lately, across all items (0..0.5).
-- Used to make prices from listings (not your own sales) a bit more realistic.
-- It loops over every sale, and UnitValue asks for it per item valued: cached per
-- store and day, cleared by Sale, Returned and Vendored.
function Tr.LossRate(now)
  now = now or time()
  local key, day = StoreKey(), math.floor(now / DAY)
  if lossCache and lossCache.key == key and lossCache.day == day then return lossCache.rate end
  local oldest = now - Tr.SETTINGS.windowDays * DAY
  local net, lost = 0, 0
  for _, e in pairs(Tr.Store().items) do
    for _, s in ipairs(e.sales) do if s.t >= oldest and not s.vendor then net = net + s.net end end
    for _, l in ipairs(e.lost) do if l.t >= oldest then lost = lost + l.dep end end
  end
  local rate = net > 0 and math.min(0.5, lost / net) or 0
  lossCache = { key = key, day = day, rate = rate }
  return rate
end

-- Value per unit for an item, as close to what you'd really get as we can tell.
-- fallback = a per-unit value from listings (AH price when looted, after the cut).
-- Returns value (or nil), info = { source = "sales"|"blend"|"listing", sales, units }
function Tr.UnitValue(id, fallback, now)
  local S = Tr.SETTINGS
  local fb = fallback and fallback * (1 - Tr.LossRate(now)) or nil
  local r, count, units = Tr.Realized(id, now)
  if r then
    local k = math.max(count / S.minSales, units / S.minUnits)
    if k >= 1 or not fb then return r, { source = "sales", sales = count, units = units } end
    return k * r + (1 - k) * fb, { source = "blend", sales = count, units = units }
  end
  if fb then return fb, { source = "listing" } end
  return nil, { source = "none" }
end

---------------------------------------------------------------------------
-- Which profession gets the credit for a sale
---------------------------------------------------------------------------
-- Does a saved character share this character's auction house (same realm and
-- faction)? Characters saved before factions were kept (no ch.faction) count as
-- matching until they next log in.
-- Forever returns "" for every realm name, so when both characters have an
-- auction house set (detected at the AH or chosen), that decides it.
function Tr.SameAH(ch)
  if ch == ns.db then return true end
  if ch.house and ns.db.house then return ch.house == ns.db.house end
  if ch.realm ~= ns.db.realm then return false end
  return not ch.faction or not ns.db.faction or ch.faction == ns.db.faction
end

-- How much of an item was gathered, by everyone on this realm and faction, all time.
local function GatheredTotal(id)
  local total = 0
  for _, ch in pairs(ns.acc.chars or {}) do
    if Tr.SameAH(ch) then
      for _, b in pairs(ch.acts or {}) do total = total + (b.items and b.items[id] or 0) end
    end
  end
  return total
end

-- For an item this character gathered `mine` of with one activity:
-- { sold = units credited, soldNet = their real gold, held = units still owned,
--   gathered = realm total gathered }
-- Sales count as gathered only up to the amount gathered (the rest was bought
-- or came from somewhere else), and are split by each source's share.
function Tr.Credit(id, mine, owned)
  local total = GatheredTotal(id)
  if total <= 0 or mine <= 0 then return { sold = 0, soldNet = 0, held = 0, gathered = total } end
  local share = mine / total
  local e = Tr.Item(id)
  local soldN, soldNet = e and e.tot.soldN or 0, e and e.tot.soldNet or 0
  local credited = math.min(soldN, total)
  local perUnit = soldN > 0 and (soldNet - (e.tot.lostDep or 0)) / soldN or 0
  local held = math.min(owned or 0, total - credited)
  return {
    sold = credited * share,
    soldNet = credited * share * perUnit,
    held = held * share,
    gathered = total,
  }
end
