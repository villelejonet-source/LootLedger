-- Cutpurse Ledger: Market tab. Price history and trend for one item:
-- how it moves day to day / week to week / month to month, which weekdays it
-- is cheapest and most expensive, and what to do about it.
--
-- Open it: Alt+click an item in your bags, click an item row in any tab, or
-- /cl market <item link or name>.

local ADDON, ns = ...
local T = ns.Theme
local C = T.C
local P = ns.Prices

local VIEWS = {
  { key = "day",   label = "Last 30 days" },
  { key = "week",  label = "12 weeks" },
  { key = "month", label = "12 months" },
}
local RECENT_MAX = 8

local function Pct(x, digits)
  return string.format(digits and "%+.1f%%" or "%+d%%", digits and x * 100 or math.floor(x * 100 + 0.5))
end

local function DateTime(key)
  local y, m, d = key:match("(%d+)-(%d+)-?(%d*)")
  return time({ year = tonumber(y), month = tonumber(m), day = tonumber(d) or 15, hour = 12 })
end

local LABEL = {
  day = function(k) return ns.ShortDate(DateTime(k)) end,
  week = function(k) return "w/c " .. ns.ShortDate(DateTime(k)) end,
  month = function(k) return date("%b %Y", DateTime(k)) end,
}

local function ItemName(id)
  local name, _, quality = ns.ItemInfo(id)
  local it = ns.acc.items and ns.acc.items[id]
  return name or (it and it.name) or ("item " .. id), quality or (it and it.quality)
end

-- Remember the item and open the tab.
function ns.OpenMarket(itemID)
  if not itemID then return end
  ns.ui.marketItem = itemID
  local recent = ns.ui.marketRecent or {}
  for i = #recent, 1, -1 do if recent[i] == itemID then table.remove(recent, i) end end
  table.insert(recent, 1, itemID)
  while #recent > RECENT_MAX do table.remove(recent) end
  ns.ui.marketRecent = recent
  ns.OpenTab("market", "item")
end

-- Change from the previous value with data, for "this week vs last week".
local function LastChange(values)
  local last, prev
  for i = #values, 1, -1 do
    if values[i] then
      if not last then last = values[i] elseif not prev then prev = values[i]; break end
    end
  end
  return last and prev and (last / prev - 1) or nil
end

local SupplyRows, TimeOfWeekRows, PostRows  -- defined below Render

local function Empty()
  local rows = {
    { kind = "title", icon = T.GOLD_ICON, text = "Market", sub = "price history for one item" },
    { kind = "note", text = "Alt+click an item in your bags, click any item row in this window, or type /cl market and shift-click an item into the chat line." },
  }
  local recent = ns.ui.marketRecent or {}
  if #recent > 0 then
    rows[#rows + 1] = { kind = "section", text = "Recently viewed" }
    for _, id in ipairs(recent) do
      local name, q = ItemName(id)
      local p = P.Get(id)
      rows[#rows + 1] = { kind = "row", icon = T.ItemIcon(id), itemID = id, label = T.QualityText(name, q),
        value = p.hasAH and ns.Money(P.AHPrice(p)) or T.Color("no AH price", C.muted) }
    end
  end
  return rows
end

-- Market price from your own scans, last scan of each day (newest first).
local function ScanRows(rows, id)
  local days = ns.acc.scanDays and ns.acc.scanDays[P.House() or 0]
  if not days then return end
  local list = {}
  for day, items in pairs(days) do
    if items[id] then list[#list + 1] = { day = day, v = items[id] } end
  end
  if #list < 2 then return end  -- one day is already the price above
  table.sort(list, function(a, b) return a.day > b.day end)
  rows[#rows + 1] = { kind = "section", text = "Your scans", right = T.Color("market price, last scan of the day", C.muted) }
  for i = 1, math.min(7, #list) do
    rows[#rows + 1] = { kind = "row", label = list[i].day, value = ns.Money(list[i].v) }
  end
end

local function Render(view)
  local id = ns.ui.marketItem
  if not id then return Empty() end

  local name, quality = ItemName(id)
  local p = P.Get(id)
  local h = P.History(id)
  local d = ns.Advisor.Decide(id)
  local status = P.Status()
  local ah = p.hasAH and P.AHPrice(p) or nil
  local normal = p.hasAH and P.NormalPrice(p, id) or nil

  local rows = {
    { kind = "title", icon = T.ItemIcon(id), text = T.QualityText(name, quality),
      sub = status.house and ("house " .. status.house) or "" },
  }

  -- Now / vs normal / trend
  local vs = ah and normal and normal > 0 and (ah / normal - 1) or nil
  local trend = h and h.trend
  rows[#rows + 1] = { kind = "tiles", tiles = {
    { label = "AH price now", value = ah and ns.Money(ah) or "-" },
    { label = "vs recent normal", value = vs and T.Color(Pct(vs), vs >= 0 and C.green or C.red) or "-",
      color = vs and (vs >= 0 and C.green or C.red) or C.muted },
    { label = "Trend", value = trend and T.Color(Pct(trend, true) .. " / day", trend >= 0 and C.green or C.red) or "-",
      color = trend and (trend >= 0 and C.green or C.red) or C.muted },
  } }

  if p.scanned then
    rows[#rows + 1] = { kind = "note", text = "AH price from your scan " .. ns.Ago(time() - p.scanned)
      .. " (" .. (p.auctions or 0) .. " listed). The chart and averages come from the hourly feed." }
  end
  if ah and d.ah and d.ah ~= ah then
    rows[#rows + 1] = { kind = "note", text = "The advice goes by " .. ns.Money(d.ah)
      .. ", the middle of the last 3 hourly prices: one hour's price is often noise." }
  end
  ScanRows(rows, id)

  local badgeColors = { SELL = C.green, LIST = C.gold, HOLD = C.blue, CRASH = C.red, CHECK = { 1, 0.6, 0.2, 1 },
    VENDOR = { 0.75, 0.75, 0.75, 1 }, KEEP = C.muted }
  rows[#rows + 1] = { kind = "row", badge = { text = ns.Advisor.ACTIONS[d.action].label, color = badgeColors[d.action] },
    label = d.reason, value = d.unit and d.unit > 0 and (ns.Money(d.unit) .. T.Color(" each", C.muted)) or "" }
  PostRows(rows, d)

  if not h then
    rows[#rows + 1] = { kind = "note", text = p.hasAH
      and "No history for this item yet: it trades too rarely on your AH to track (under 5 sold a day and under 20 listed)."
      or "This item isn't listed on your AH right now." }
    return SupplyRows(rows, id, p, nil)
  end

  -- Price chart
  local series = view == "week" and h.weekly or (view == "month" and h.monthly or h.daily)
  local labels = {}
  for i, k in ipairs(series.labels) do labels[i] = LABEL[view](k) end
  rows[#rows + 1] = { kind = "section", text = "Price",
    right = T.Color(view == "week" and "weekly average" or (view == "month" and "monthly average" or "daily average"), C.muted) }
  rows[#rows + 1] = { kind = "chart", values = series.values, labels = labels, height = 150,
    empty = view == "day" and "Needs at least 2 days of history" or ("Needs at least 2 " .. (view == "week" and "weeks" or "months") .. " of history") }

  -- Movement
  local dayMove = LastChange(h.daily.values)
  local weekMove = LastChange(h.weekly.values)
  local monthMove = LastChange(h.monthly.values)
  if dayMove then rows[#rows + 1] = { kind = "row", label = "Since yesterday", value = T.Color(Pct(dayMove, true), dayMove >= 0 and C.green or C.red) } end
  if weekMove then rows[#rows + 1] = { kind = "row", label = "This week vs last week", note = "this week so far", value = T.Color(Pct(weekMove, true), weekMove >= 0 and C.green or C.red) } end
  if monthMove then rows[#rows + 1] = { kind = "row", label = "This month vs last month", note = "this month so far", value = T.Color(Pct(monthMove, true), monthMove >= 0 and C.green or C.red) } end
  if h.volatility then
    rows[#rows + 1] = { kind = "row", label = "Typical day-to-day move", note = h.volatility > 0.1 and "jumpy item" or nil,
      value = "±" .. string.format("%.1f%%", h.volatility * 100) }
  end
  if not (dayMove or weekMove or monthMove) then
    rows[#rows + 1] = { kind = "note", text = "History started " .. (h.daily.labels[1] and LABEL.day(h.daily.labels[1]) or "today") .. ". Movement shows up from the second day." }
  end

  -- Weekly pattern
  local wk = P.WeekdayAdvice(h)
  rows[#rows + 1] = { kind = "section", text = "Weekly pattern",
    right = T.Color(h.weeks .. (h.weeks == 1 and " week" or " weeks") .. " of data", C.muted) }
  local bars = {}
  for i = 1, 7 do
    local v = h.weekday[i]
    local color = { 0.55, 0.55, 0.6, 1 }
    if wk then
      for _, b in ipairs(wk.best) do if b == i then color = C.green end end
      for _, w in ipairs(wk.worst) do if w == i then color = C.red end end
    end
    bars[i] = { label = P.DAY_SHORT[i], value = v or nil, text = v and Pct(v, true) or nil, color = color }
  end
  rows[#rows + 1] = { kind = "bars", bars = bars, height = 120 }

  if wk then
    local base = normal or ah
    local afterCut = (1 + wk.spread) * (1 - ns.Advisor.SETTINGS.ahCut) - 1
    rows[#rows + 1] = { kind = "row", badge = { text = "Buy", color = C.blue },
      label = "Cheapest: " .. P.DayList(wk.worst, true), note = Pct(wk.worstPct, true) .. " vs the week",
      value = base and ("~" .. ns.Money(base * (1 + wk.worstPct))) or "" }
    rows[#rows + 1] = { kind = "row", badge = { text = "Sell", color = C.green },
      label = "Most expensive: " .. P.DayList(wk.best, true), note = Pct(wk.bestPct, true) .. " vs the week",
      value = base and ("~" .. ns.Money(base * (1 + wk.bestPct))) or "" }
    if afterCut >= 0.05 then
      rows[#rows + 1] = { kind = "note", text = ("Recommend: buy %s, sell %s. Spread %s, %s after the 5%% AH cut. Pattern held in %d%% of the last %d weeks.")
        :format(P.DayList(wk.worst, true), P.DayList(wk.best, true), Pct(wk.spread), Pct(afterCut), math.floor(h.consistency * 100 + 0.5), h.weeks) }
    else
      rows[#rows + 1] = { kind = "note", text = ("Recommend: sell on %s. The spread (%s) is too small to buy and resell after the 5%% AH cut.")
        :format(P.DayList(wk.best, true), Pct(wk.spread)) }
    end
  elseif h.weeks < 2 then
    rows[#rows + 1] = { kind = "note", text = ("No weekly pattern yet: needs at least 2 full weeks of prices (has %d). Prices are collected every hour, so this fills in by itself.")
      :format(h.weeks) }
  else
    rows[#rows + 1] = { kind = "note", text = "No reliable weekly pattern: the weekday differences are within normal day-to-day noise, or they change from week to week. Sell whenever the advice above says so." }
  end

  TimeOfWeekRows(rows)
  return SupplyRows(rows, id, p, h)
end

-- Posting it: the suggested price, the floor, the queue you would join, and the
-- chance to sell in a 24h auction with its deposit and what a unit is worth
-- relisted until it sells (Advisor.PostPlan).
function PostRows(rows, d)
  local pl = d.plan
  if not pl then return end
  rows[#rows + 1] = { kind = "section", text = "Posting", right = T.Color("you post it yourself", C.muted) }
  rows[#rows + 1] = { kind = "row", label = "Suggested price", value = d.post and ns.Money(d.post) or T.Color("not now", C.muted),
    note = pl.price + 1 == pl.lowest and ("1c under the lowest listing, " .. ns.Money(pl.lowest))
      or ("1c under the AH price: the lowest, " .. ns.Money(pl.lowest) .. ", looks like a stray") }
  rows[#rows + 1] = { kind = "row", label = "Floor", value = ns.Money(pl.vendorFloor),
    note = "the least that beats vendoring, after the cut and relisting" }
  rows[#rows + 1] = { kind = "row", label = "Queue you would join", value = pl.queue .. " + your " .. pl.qty,
    note = "units within 5% of the lowest; " .. (pl.perDay and ("buyers take ~" .. math.floor(pl.perDay + 0.5) .. " a day") or "no sales data yet") }
  rows[#rows + 1] = { kind = "row", label = "24h auction",
    note = "deposit " .. ns.Money(pl.deposit) .. (pl.estimated and " (estimate)" or "") .. ", lost each time it comes back unsold",
    value = (pl.chance and (math.floor(pl.chance * 100 + 0.5) .. "% sells, ") or "") .. "worth ~" .. ns.Money(d.unit or 0) .. T.Color(" each", C.muted) }
end

-- The whole auction house by hour of the week: when do items list highest and lowest?
function TimeOfWeekRows(rows)
  local wh = P.WeekHours()
  if not wh then return end
  rows[#rows + 1] = { kind = "section", text = "Time of week (whole auction house)",
    right = T.Color(wh.weeks .. (wh.weeks == 1 and " week" or " weeks") .. " of data", C.muted) }
  if wh.reliable then
    local function Window(b)
      local at = P.NextHourOfWeek((b - 1) % 168)
      return P.WhenText(at) .. "-" .. date("%H:00", at + 3 * 3600)
    end
    -- One bar per day: that day's average across its hours.
    local bars = {}
    for d = 1, 7 do
      local sum, n = 0, 0
      for hh = 0, 23 do local v = wh.pct[(d - 1) * 24 + hh]; if v then sum, n = sum + v, n + 1 end end
      local v = n > 0 and sum / n or nil
      bars[d] = { label = P.DAY_SHORT[d], value = v, text = v and Pct(v, true) or nil, color = { 0.55, 0.55, 0.6, 1 } }
    end
    rows[#rows + 1] = { kind = "bars", bars = bars, height = 90 }
    rows[#rows + 1] = { kind = "row", badge = { text = "Sell", color = C.green }, label = "Highest: " .. Window(wh.best),
      note = "items list " .. Pct(wh.pct[wh.best]) .. " vs the week", value = "" }
    rows[#rows + 1] = { kind = "row", badge = { text = "Buy", color = C.blue }, label = "Lowest: " .. Window(wh.worst),
      note = "items list " .. Pct(wh.pct[wh.worst]) .. " vs the week", value = "" }
    rows[#rows + 1] = { kind = "note", text = "Your clock. Items with their own weekly pattern follow theirs; the rest use this when the advice says when to list." }
  else
    local since = wh.since and (" since " .. ns.ShortDate(wh.since)) or ""
    rows[#rows + 1] = { kind = "note", text = ("Collecting%s: the house's prices are recorded every hour. Needs 2 full weeks to tell whether some hours of the week (say Friday evening) are dearer than others, and how much.")
      :format(since) }
  end
end

-- Supply, purchases, trending and quests: shown even for items without price history.
function SupplyRows(rows, id, p, h)
  rows[#rows + 1] = { kind = "section", text = "Supply" }
  if p.auctions then
    local note = h and h.usualQty and h.usualQty > 0 and ("usually ~" .. math.floor(h.usualQty + 0.5)) or nil
    if note and p.auctions > h.usualQty * 1.5 then note = note .. ", flooded" elseif note and p.auctions < h.usualQty * 0.6 then note = note .. ", scarce" end
    rows[#rows + 1] = { kind = "row", label = "Listed now", note = note, value = tostring(p.auctions) }
  end
  if p.min then rows[#rows + 1] = { kind = "row", label = "Lowest listing", value = ns.Money(p.min) } end
  local sales = P.Sales(id)
  if sales then
    local note = sales.normal and ("normal ~" .. sales.normal .. "/day") or "normal not known yet"
    note = note .. ", " .. sales.auctions24 .. " separate auctions"
    local hot = sales.normal and sales.normal > 0 and sales.sold24 >= 1.8 * sales.normal
    rows[#rows + 1] = { kind = "row", label = "Bought on your AH, last 24h", note = note,
      value = hot and T.Color(tostring(sales.sold24), C.green) or tostring(sales.sold24) }
  end
  local trend = P.Trending()
  local tr = trend and trend.byItem[id]
  if tr then
    local names = { hot = "Selling fast", climbing = "Price climbing", drying = "Drying up", cooling = "Cooling off" }
    rows[#rows + 1] = { kind = "row", badge = { text = "Trending", color = C.green }, label = names[tr.list] or tr.list,
      note = "see the Trending tab" }
  end
  local quests = ns.Quests.For(id)
  if quests then
    rows[#rows + 1] = { kind = "section", text = "Needed for quests", right = T.Color("via Questie", C.muted) }
    for i = 1, math.min(5, #quests) do
      local q = quests[i]
      rows[#rows + 1] = { kind = "row", badge = { text = "Lvl " .. q.level, color = C.gold }, label = q.name }
    end
    if #quests > 5 then rows[#rows + 1] = { kind = "note", text = "...and " .. (#quests - 5) .. " more." } end
  end
  if p.soldPerDay then rows[#rows + 1] = { kind = "row", label = "Sold per day (EU)", note = "Saddlebag Exchange", value = tostring(p.soldPerDay) } end
  rows[#rows + 1] = { kind = "note", text = P.StatusText() }
  return rows
end

-- Market tab: "Item" (one item's history) plus the trending lists.
local subtabs = { { key = "item", label = "Item" } }
for _, l in ipairs(ns.Views.trendingLists) do subtabs[#subtabs + 1] = { key = l.key, label = l.label } end
ns.RegisterTab({
  key = "market", label = "Market", order = 4, subtabs = subtabs,
  choices = function(sub)
    if sub == "item" then return ns.ui.marketItem and VIEWS or nil, "range" end
    local t = P.Trending()
    if not (t and t.ready) then return nil end  -- nothing to filter yet
    return ns.Views.trendingFilters, "filter"
  end,
  render = function(sub, period, choice)
    if sub == "item" then
      local rows = Render(choice or "day")
      -- Other recently viewed items, to hop between them.
      local others = {}
      for _, id in ipairs(ns.ui.marketRecent or {}) do if id ~= ns.ui.marketItem then others[#others + 1] = id end end
      if ns.ui.marketItem and #others > 0 then
        rows[#rows + 1] = { kind = "section", text = "Recently viewed" }
        for i = 1, math.min(5, #others) do
          local id = others[i]
          local name, q = ItemName(id)
          local p = P.Get(id)
          rows[#rows + 1] = { kind = "row", icon = T.ItemIcon(id), itemID = id, label = T.QualityText(name, q),
            value = p.hasAH and ns.Money(P.AHPrice(p)) or T.Color("no AH price", C.muted) }
        end
      end
      return rows
    end
    return ns.Views.trending(sub, period, choice or "all")
  end,
})

-- Alt+click an item anywhere (bags, chat links, ...) to open its history.
ns.Hook("HandleModifiedItemClick", function(link)
  if link and IsAltKeyDown and IsAltKeyDown() and not (IsShiftKeyDown() or IsControlKeyDown()) then
    local id = tonumber(link:match("item:(%d+)"))
    if id then ns.OpenMarket(id) end
  end
end)
