-- Cutpurse Ledger: item tooltips get the advice, the AH prices behind it, and how
-- many you own.

local ADDON, ns = ...
local Grey = function(s) return "|cff999999" .. s .. "|r" end

local function Row(tooltip, label, value)
  tooltip:AddDoubleLine("  " .. label, value, 0.75, 0.75, 0.75, 1, 1, 1)
end

local function AddLines(tooltip, id, needsShow)
  if not (ns.db and id) then return end
  local total, parts = ns.Inventory.Total(id)
  local d = ns.Advisor.Decide(id, total)
  tooltip:AddDoubleLine("Cutpurse Ledger: " .. ns.Advisor.Tag(d.action), d.reason, 1, 0.82, 0, 1, 1, 1)

  -- Prices
  local p = ns.Prices.Get(id)
  if p.hasAH then
    local ah = d.ah or ns.Prices.AHPrice(p)  -- the price the advice went by (the last 3 hours' median)
    Row(tooltip, "AH price", ns.Money(ah) .. Grey(" each" .. (p.auctions and ("  (" .. p.auctions .. " listed)") or "")))
    local h = ns.Prices.History(id)
    local status = ns.Prices.Status()
    if h and h.baseline then
      -- The same % the advice line uses (against what is normal for today when there is a weekly pattern)
      local vs = d.vs and string.format("  (%+d%%)", math.floor(d.vs * 100 + 0.5)) or ""
      Row(tooltip, "Normal price", ns.Money(h.baseline) .. Grey(vs .. "  last few days"))
    elseif status.source == "blizzard" then
      Row(tooltip, "Normal price", Grey("building history (" .. (status.days or 0) .. (status.days == 1 and " day)" or " days)")))
    end
    if h and h.trend then
      local up = h.trend >= 0
      Row(tooltip, "Trend", (up and "|cff5cdc75" or "|cffff6b6b") .. string.format("%+.1f%%", h.trend * 100) .. "|r" .. Grey(" per day"))
    end
    local tm = d.timing
    if tm then
      Row(tooltip, tm.source == "house" and "Best time to list (whole AH)" or "Best time to list",
        (tm.goodNow and "now" or tm.when) .. Grey(string.format("  (%+d%% vs the week)", math.floor((tm.best - 1) * 100 + 0.5))))
    end
    if p.soldPerDay then Row(tooltip, "Sells per day (EU)", tostring(p.soldPerDay)) end
    local sales = ns.Prices.Sales(id)
    if sales and sales.sold24 > 0 then
      Row(tooltip, "Bought last 24h", sales.sold24 .. (sales.normal and Grey("  (normal ~" .. sales.normal .. ")") or ""))
    end
    local trend = ns.Prices.Trending()
    local tr = trend and trend.byItem[id]
    if tr then
      local names = { hot = "selling fast", climbing = "price climbing", drying = "drying up", cooling = "cooling off" }
      Row(tooltip, "Trending", "|cff5cdc75" .. (names[tr.list] or tr.list) .. "|r")
    end
  end

  -- Quests that need it (via Questie)
  local quests = ns.Quests and ns.Quests.For(id)
  if quests then
    local q = quests[1]
    Row(tooltip, "Quest item", q.name .. Grey(" (" .. q.level .. ")" .. (#quests > 1 and (" +" .. (#quests - 1) .. " more") or "")))
  end

  -- What you own, and what it would bring in following the advice
  if total > 0 then
    tooltip:AddLine("  You own " .. total .. "  (" .. table.concat(parts, ", ") .. ")"
      .. ((d.unit or 0) > 0 and (", worth ~" .. ns.Money(d.unit * total)) or ""), 0.6, 0.6, 0.6)
  end
  if p.hasAH then tooltip:AddLine("  Alt+click: price history", 0.45, 0.45, 0.45) end
  if needsShow then tooltip:Show() end  -- older clients need a resize
end

local function IdFromLink(link)
  return link and tonumber(link:match("item:(%d+)"))
end

if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType then
  TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip, data)
    if tooltip ~= GameTooltip and tooltip ~= ItemRefTooltip then return end
    local id = data and data.id
    if not id and tooltip.GetItem then id = IdFromLink(select(2, tooltip:GetItem())) end
    AddLines(tooltip, id)
  end)
else
  for _, tt in ipairs({ GameTooltip, ItemRefTooltip }) do
    if tt and tt.HookScript then
      tt:HookScript("OnTooltipSetItem", function(self)
        AddLines(self, IdFromLink(select(2, self:GetItem())), true)
      end)
    end
  end
end
