-- Cutpurse Ledger: inventory
-- What each character owns, by place (bags, bank, mail). Bags are rescanned
-- whenever they change; bank and mail only while those windows are open, so
-- their counts are "as of the last visit".
--
-- Stored per character in ns.db.inv:
--   { bags = { [itemID] = n }, bank = {...}, mail = {...},
--     scanned = { bags = time, bank = time, mail = time } }
-- Item details shared by all characters in ns.acc.items:
--   { [itemID] = { name = "Light Leather", quality = 1, bound = true|nil } }

local ADDON, ns = ...
local I = {}
ns.Inventory = I

I.PLACES = { "bags", "bank", "mail" }

local function NumSlots(bag)
  if C_Container and C_Container.GetContainerNumSlots then return C_Container.GetContainerNumSlots(bag) end
  return GetContainerNumSlots and GetContainerNumSlots(bag) or 0
end

-- Link, count, quality and soulbound flag for one bag slot.
local function SlotInfo(bag, slot)
  if C_Container and C_Container.GetContainerItemInfo then
    local info = C_Container.GetContainerItemInfo(bag, slot)
    if info then return info.hyperlink, info.stackCount, info.quality, info.isBound end
  elseif GetContainerItemInfo then
    local _, count, _, quality, _, _, link = GetContainerItemInfo(bag, slot)
    return link, count, quality, nil
  end
end

local function Remember(id, link, quality, bound)
  local items = ns.acc.items
  local it = items[id]
  if not it then it = {}; items[id] = it end
  it.name = link:match("%[(.-)%]") or it.name
  if quality then it.quality = quality end
  if bound ~= nil then it.bound = bound or nil end
end

local function ScanBags(bagList)
  local counts = {}
  for _, bag in ipairs(bagList) do
    for slot = 1, NumSlots(bag) do
      local link, count, quality, bound = SlotInfo(bag, slot)
      local id = link and tonumber(link:match("item:(%d+)"))
      if id then
        counts[id] = (counts[id] or 0) + (count or 1)
        Remember(id, link, quality, bound)
      end
    end
  end
  return counts
end

local function BagList()
  local list = {}
  for bag = 0, (NUM_BAG_SLOTS or 4) + ((NUM_REAGENTBAG_SLOTS or 0)) do list[#list + 1] = bag end
  return list
end

-- Each container once, and never one the bag scan already counts: on newer
-- clients the reagent bag sits right after the bags (where bank bags used to
-- start), and the character bank tabs reuse the old bank bag IDs. Counting
-- them twice doubled what you own.
local function BankList()
  local list, seen = {}, {}
  for _, bag in ipairs(BagList()) do seen[bag] = true end
  local function Add(bag)
    if bag and not seen[bag] then seen[bag] = true; list[#list + 1] = bag end
  end
  Add(BANK_CONTAINER or -1)
  local first = (NUM_BAG_SLOTS or 4) + 1
  for bag = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do Add(bag) end
  -- Newer clients: character bank tabs
  if Enum and Enum.BagIndex then
    for i = 1, 6 do Add(Enum.BagIndex["CharacterBankTab_" .. i]) end
  end
  return list
end

local function Store(place, counts)
  local inv = ns.db.inv
  inv[place] = counts
  inv.scanned[place] = time()
  ns.Refresh()
end

function I.ScanBags() Store("bags", ScanBags(BagList())) end
function I.ScanBank() Store("bank", ScanBags(BankList())) end

function I.ScanMail()
  if not (GetInboxNumItems and GetInboxItemLink) then return end
  local counts = {}
  for i = 1, GetInboxNumItems() do
    for j = 1, (ATTACHMENTS_MAX_RECEIVE or 16) do
      local link = GetInboxItemLink(i, j)
      local id = link and tonumber(link:match("item:(%d+)"))
      if id then
        local count = GetInboxItem and select(4, GetInboxItem(i, j)) or 1
        counts[id] = (counts[id] or 0) + (count or 1)
        Remember(id, link)
      end
    end
  end
  Store("mail", counts)
end

-- How many of an item a character has, total and by place.
function I.Count(ch, id)
  local inv = ch.inv
  if not inv then return 0 end
  local total, by = 0, {}
  for _, place in ipairs(I.PLACES) do
    local n = inv[place] and inv[place][id] or 0
    by[place] = n
    total = total + n
  end
  return total, by
end

-- Characters that share this character's AH (same realm and faction).
function I.RealmChars()
  local list = {}
  for _, ch in pairs(ns.acc.chars) do
    if ns.Trade.SameAH(ch) then list[#list + 1] = ch end
  end
  return list
end

-- How many of an item the characters on this AH own, and who: total, { "Vanish 12", ... }
function I.Total(id)
  local total, parts = 0, {}
  for _, ch in ipairs(I.RealmChars()) do
    local n = I.Count(ch, id)
    if n > 0 then
      total = total + n
      parts[#parts + 1] = ch.name .. " " .. n
    end
  end
  return total, parts
end

-- Every item owned on this realm: { [id] = { total, chars = { [name] = n } } }
function I.AllItems()
  local all = {}
  for _, ch in ipairs(I.RealmChars()) do
    for _, place in ipairs(I.PLACES) do
      for id, n in pairs(ch.inv and ch.inv[place] or {}) do
        local e = all[id]
        if not e then e = { total = 0, chars = {} }; all[id] = e end
        e.total = e.total + n
        e.chars[ch.name] = (e.chars[ch.name] or 0) + n
      end
    end
  end
  return all
end

ns.OnInit(function()
  ns.acc.items = ns.acc.items or {}
  ns.db.inv = ns.db.inv or { scanned = {} }
  ns.db.inv.scanned = ns.db.inv.scanned or {}
  I.ScanBags()
end)

local bankOpen = false
ns.On("BAG_UPDATE_DELAYED", function()
  if not ns.db then return end
  I.ScanBags()
  if bankOpen then I.ScanBank() end
end)
ns.On("BANKFRAME_OPENED", function() bankOpen = true; I.ScanBank() end)
ns.On("BANKFRAME_CLOSED", function() bankOpen = false end)
ns.On("PLAYERBANKSLOTS_CHANGED", function() if bankOpen then I.ScanBank() end end)
ns.On("MAIL_INBOX_UPDATE", function() if ns.db then I.ScanMail() end end)
