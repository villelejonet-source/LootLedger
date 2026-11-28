-- Cutpurse Ledger: vendor guard
-- If you sell something white or better to a vendor while the AH would pay
-- more, a popup tells you what you'd get on the AH and offers to buy it back.
--
-- Sales are detected from the vendor's buyback list (only changes when an
-- item is really sold), so right-click, drag and other addons all count.

local ADDON, ns = ...
local A = ns.Advisor

local snapshot = {}   -- "link|qty" -> how many such entries were on the buyback list

local function BuybackEntries()
  local list = {}
  local n = GetNumBuybackItems and GetNumBuybackItems() or 0
  for i = 1, n do
    local link = GetBuybackItemLink(i)
    if link then
      local _, _, price, qty = GetBuybackItemInfo(i)
      list[#list + 1] = { index = i, link = link, qty = qty or 1, price = price or 0, key = link .. "|" .. (qty or 1) }
    end
  end
  return list
end

local function TakeSnapshot()
  snapshot = {}
  for _, e in ipairs(BuybackEntries()) do snapshot[e.key] = (snapshot[e.key] or 0) + 1 end
end

-- Entries that weren't on the list last time we looked.
local function NewEntries()
  local seen, fresh = {}, {}
  for _, e in ipairs(BuybackEntries()) do
    seen[e.key] = (seen[e.key] or 0) + 1
    if seen[e.key] > (snapshot[e.key] or 0) then fresh[#fresh + 1] = e end
  end
  return fresh
end

StaticPopupDialogs["LOOTLEDGER_BUYBACK"] = {
  text = "%s",
  button1 = "Buy back",
  button2 = "Keep sold",
  OnAccept = function(_, data)
    -- Find it again: the list may have shifted since the popup opened.
    for i = (GetNumBuybackItems() or 0), 1, -1 do
      if GetBuybackItemLink(i) == data.link then
        BuybackItem(i)
        return
      end
    end
    ns.Print("Couldn't find " .. data.link .. " on the buyback list any more.")
  end,
  timeout = 0,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

local function Check(e)
  local id = tonumber(e.link:match("item:(%d+)"))
  if not (id and A.IsAHItem(id)) then return end
  local p = ns.Prices.Get(id)
  local qtyText = e.qty > 1 and (" x" .. e.qty) or ""
  if not p.hasAH then
    ns.Print("|cffff9933Heads up:|r you vendored " .. e.link .. qtyText ..
      ". It's white or better and there is no AH price for it yet, so check the AH next time.")
    return
  end
  -- The advice's own value (relisting costs counted; the vendor price when it said Vendor),
  -- for the stack you had before this sale: following the advice never sets this off.
  local ahNet = A.Decide(id, e.qty + ns.Inventory.Total(id)).unit * e.qty
  local vendor = e.price > 0 and e.price or (p.vendor or 0) * e.qty
  if ahNet <= vendor * 1.1 then return end  -- vendor was as good (or close enough)

  local msg = ("You sold %s%s to a vendor for %s.\n\nOn the AH you'd get about %s\n(after the 5%% cut and relisting).\n\nBuy it back?")
    :format(e.link, qtyText, ns.Money(vendor), ns.Money(ahNet))
  ns.Print("|cffff6b6bSold below AH value:|r " .. e.link .. qtyText .. " for " .. ns.Money(vendor)
    .. ", AH ~" .. ns.Money(ahNet))
  StaticPopup_Show("LOOTLEDGER_BUYBACK", msg, nil, { link = e.link })
  if PlaySound and SOUNDKIT and SOUNDKIT.RAID_WARNING then PlaySound(SOUNDKIT.RAID_WARNING) end
end

ns.On("MERCHANT_SHOW", TakeSnapshot)
ns.On("MERCHANT_UPDATE", function()
  for _, e in ipairs(NewEntries()) do Check(e) end
  TakeSnapshot()
end)
