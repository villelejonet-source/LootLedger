// A WoW-like Lua VM for addon tests (fengari). Loads the real addon files with
// the game API stubbed, so hooks, events, money changes and timers can be driven
// from a test. Not a test file itself (node --test runs tests/*.test.mjs).
//
// In Lua, the stubs give you:
//   NOW / CLOCK        time() and GetTime(); ADVANCE(s) moves CLOCK and runs due C_Timer callbacks
//   MONEY, GAIN(d)     GetMoney(); GAIN changes it and fires PLAYER_MONEY
//   FIRE(event, ...)   fires an event on every frame registered for it
//   ITEMS[id] = { name, sell }       item data for C_Item.GetItemInfo; LINK(id) = its link
//   BAGS[bag][slot] = { id, count }  for C_Container.GetContainerItemInfo
//   INBOX[i] = { sender, subject, money, items = { [a] = { id, count } }, invoice = { item, bid, deposit, cut, count } }
//   SERVER_TAKE_ITEM(i, a) / SERVER_TAKE_MONEY(i)   what the server does after a mail click
//   TRADE_LOG          every ns.Trade.{Sale,Returned,Vendored,Posted,Bought,Unmatched} call, as text
//   LOG(i)             gold log entry i (1 = newest) as "source amount [itemID] [qty]"
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");
export const ADDON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "addon", "LootLedger");

const STUBS = `
NOW = 1800000000; CLOCK = 1000; MONEY = 100000
unpack = unpack or table.unpack
time = function(t) if t then return os.time(t) end return NOW end
date = os.date
GetTime = function() return CLOCK end
GetMoney = function() return MONEY end
UnitName = function() return "Vanish" end
GetRealmName = function() return "" end
UnitClass = function() return "Rogue", "ROGUE" end
FACTION = "Horde"
UnitFactionGroup = function() return FACTION end
PRINTED = {}
DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) PRINTED[#PRINTED + 1] = m end }
InRepairMode = function() return false end
GetQuestReward = function() end
TakeTaxiNode = function() end
RepairAllItems = function() end

-- Frames and events. Methods a test doesn't care about (SetPoint, CreateFontString,
-- SetText, ...) do nothing and return another such object.
MAGIC = {}
MAGIC.__index = function() return function() return setmetatable({}, MAGIC) end end
-- Sizes and widths read back from widgets act as 0, text as "".
local function Zero() return 0 end
MAGIC.__add, MAGIC.__sub, MAGIC.__mul, MAGIC.__div, MAGIC.__unm, MAGIC.__mod = Zero, Zero, Zero, Zero, Zero, Zero
MAGIC.__concat = function(a, b) return (type(a) == "table" and "" or tostring(a)) .. (type(b) == "table" and "" or tostring(b)) end
MAGIC.__lt = function() return false end
MAGIC.__le = function() return true end
UIParent = setmetatable({}, MAGIC)
GameTooltip = setmetatable({}, MAGIC)
local FrameMethods = {
  SetScript = function(self, k, fn) self.scripts[k] = fn end,
  HookScript = function(self, k, fn)
    local old = self.scripts[k]
    self.scripts[k] = old and function(...) old(...); fn(...) end or fn
  end,
  GetScript = function(self, k) return self.scripts[k] end,
  RegisterEvent = function(self, e) self.events[e] = true end,
  IsShown = function(self) return self.shown end,
  Show = function(self)
    if self.shown then return end
    self.shown = true
    if self.scripts.OnShow then self.scripts.OnShow(self) end
  end,
  Hide = function(self)
    if not self.shown then return end
    self.shown = false
    if self.scripts.OnHide then self.scripts.OnHide(self) end
  end,
  SetShown = function(self, v) if v then self:Show() else self:Hide() end end,
}
local FrameMeta = { __index = function(_, k) return FrameMethods[k] or function() return setmetatable({}, MAGIC) end end }
FRAMES = {}
function CreateFrame()
  local f = setmetatable({ scripts = {}, events = {}, shown = false }, FrameMeta)
  FRAMES[#FRAMES + 1] = f
  return f
end
function FIRE(event, ...)
  for _, f in ipairs(FRAMES) do
    if f.events[event] and f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
  end
end

-- hooksecurefunc: runs fn after the original, with the same arguments
function hooksecurefunc(t, name, fn)
  if type(t) ~= "table" then t, name, fn = _G, t, name end
  local orig = t[name]
  t[name] = function(...)
    local r = { orig(...) }
    fn(...)
    return unpack(r)
  end
end

-- Timers
TIMERS = {}
local function AddTimer(s, fn)
  local t = { at = CLOCK + s, fn = fn }
  function t:Cancel() self.cancelled = true end
  TIMERS[#TIMERS + 1] = t
  return t
end
C_Timer = {
  After = function(s, fn) AddTimer(s, fn) end,
  NewTimer = AddTimer,
  NewTicker = function() return { Cancel = function() end } end,
}
function ADVANCE(s)
  local target = CLOCK + s
  while true do
    local best, bi
    for i, t in ipairs(TIMERS) do
      if t.at <= target and (not best or t.at < best.at) then best, bi = t, i end
    end
    if not best then break end
    table.remove(TIMERS, bi)
    if best.at > CLOCK then CLOCK = best.at end
    if not best.cancelled then best.fn() end
  end
  CLOCK = target
end

-- Money
function GAIN(d) MONEY = MONEY + d; FIRE("PLAYER_MONEY") end

-- Items
ITEMS = {}
local function Resolve(x)
  if type(x) == "number" then return x end
  local id = tonumber(tostring(x):match("item:(%d+)"))
  if id then return id end
  for i, it in pairs(ITEMS) do if it.name == x then return i end end
end
function LINK(id) return "|cffffffff|Hitem:" .. id .. "::::::::|h[" .. ITEMS[id].name .. "]|h|r" end
C_Item = {
  GetItemInfo = function(x)
    local id = Resolve(x)
    local it = id and ITEMS[id]
    if not it then return nil end
    return it.name, LINK(id), 1, 1, 1, "Trade Goods", "", 20, "", 0, it.sell or 0, 7, 0, 0
  end,
  DoesItemExist = function(loc) return loc ~= nil and loc.exists ~= false end,
  GetItemID = function(loc)
    if loc.exists == false then error("invalid item location") end
    return loc.id
  end,
}

-- Bags and merchant
BAGS = {}
C_Container = {
  GetContainerItemInfo = function(b, s)
    local x = BAGS[b] and BAGS[b][s]
    if not x then return nil end
    return { hyperlink = LINK(x.id), stackCount = x.count, itemID = x.id, hasNoValue = (ITEMS[x.id].sell or 0) == 0 }
  end,
  UseContainerItem = function() end,
}
MERCHANT = {}
GetMerchantItemLink = function(i) return MERCHANT[i] and LINK(MERCHANT[i]) end
BuyMerchantItem = function() end

-- Mail
ATTACHMENTS_MAX_RECEIVE = 16
AUCTION_EXPIRED_MAIL_SUBJECT = "Auction expired: %s"
AUCTION_REMOVED_MAIL_SUBJECT = "Auction cancelled: %s"
INBOX = {}
GetInboxNumItems = function() return #INBOX end
GetInboxHeaderInfo = function(i)
  local m = INBOX[i]
  if not m then return nil end
  local n = 0
  for _ in pairs(m.items or {}) do n = n + 1 end
  -- ..., hasItem, wasRead, wasReturned, textCreated, canReply (a player's mail: set canReply = true)
  return nil, nil, m.sender, m.subject, m.money or 0, 0, 30, n, false, false, false, m.canReply or false
end
GetInboxItem = function(i, a)
  local it = INBOX[i] and INBOX[i].items and INBOX[i].items[a]
  if not it then return nil end
  return ITEMS[it.id].name, it.id, nil, it.count
end
GetInboxInvoiceInfo = function(i)
  local v = INBOX[i] and INBOX[i].invoice
  if not v then return nil end
  return "seller", v.item, "Buyer", v.bid, v.bid, v.deposit, v.cut, 0, 0, 0, v.count
end
TakeInboxMoney = function() end
TakeInboxItem = function() end
AutoLootMailItem = function() end
local function DropIfEmpty(i)
  local m = INBOX[i]
  if m and not next(m.items or {}) and (m.money or 0) == 0 then table.remove(INBOX, i) end
end
function SERVER_TAKE_ITEM(i, a)
  INBOX[i].items[a] = nil
  DropIfEmpty(i)
  FIRE("MAIL_INBOX_UPDATE")
end
function SERVER_TAKE_MONEY(i)
  local amount = INBOX[i].money or 0
  INBOX[i].money = 0
  DropIfEmpty(i)
  GAIN(amount)
  FIRE("MAIL_INBOX_UPDATE")
end

-- Modern auction house
C_AuctionHouse = {
  PostItem = function() end, PostCommodity = function() end,
  SendSearchQuery = function() end, PlaceBid = function() end,
  StartCommoditiesPurchase = function() end, ConfirmCommoditiesPurchase = function() end,
  GetNumItemSearchResults = function() return 0 end,
  GetItemSearchResultInfo = function() return nil end,
}

ns = {}
`;

const AFTER_LOAD = `
TRADE_LOG = {}
for _, k in ipairs({ "Sale", "Returned", "Vendored", "Posted", "Bought", "Unmatched" }) do
  local orig = ns.Trade[k]
  ns.Trade[k] = function(...)
    local parts = { k }
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    TRADE_LOG[#TRADE_LOG + 1] = table.concat(parts, " ")
    return orig(...)
  end
end
function LOG(i)
  local e = ns.db.ledger.recent[i]
  if not e then return nil end
  return e.s .. " " .. e.a .. (e.id and (" " .. e.id) or "") .. (e.q and (" x" .. e.q) or "")
end
function TRADE(i) return TRADE_LOG[i] end
`;

// files: addon files to load after the stubs, in .toc order. login: fire PLAYER_LOGIN.
export function luaVM({ files = ["Core.lua", "Gathering.lua", "Trade.lua", "Ledger.lua"], login = true, before = "" } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const err = () => to_jsstring(lua.lua_tostring(L, -1));
  const run = (code) => { if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error(err()); };
  const get = (expr) => {
    run(`__out = (${expr})`);
    lua.lua_getglobal(L, to_luastring("__out"));
    const t = lua.lua_type(L, -1);
    const v = t === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -1)
      : t === lua.LUA_TNIL ? null
      : t === lua.LUA_TBOOLEAN ? lua.lua_toboolean(L, -1)
      : err();
    lua.lua_pop(L, 1);
    return v;
  };
  const load = (file) => {
    const src = fs.readFileSync(path.join(ADDON, ...file.split("/")));
    if (lauxlib.luaL_loadbuffer(L, src, null, to_luastring("@" + file)) !== 0) throw new Error(err());
    lua.lua_pushstring(L, to_luastring("LootLedger"));
    lua.lua_getglobal(L, to_luastring("ns"));
    if (lua.lua_pcall(L, 2, 0, 0) !== 0) throw new Error(err());
  };
  run(STUBS);
  if (before) run(before);
  for (const f of files) load(f);
  if (files.includes("Trade.lua")) run(AFTER_LOAD);
  if (login) run(`FIRE("PLAYER_LOGIN")`);
  // All gold log entries / trade calls, oldest first.
  const log = () => { const out = []; for (let i = get("#ns.db.ledger.recent"); i >= 1; i--) out.push(get(`LOG(${i})`)); return out; };
  const trade = () => { const out = []; for (let i = 1; i <= get("#TRADE_LOG"); i++) out.push(get(`TRADE(${i})`)); return out; };
  return { run, get, load, log, trade };
}
