"""Runs pz2autohub.core.lua against a fake game (lupa, Lua 5.3): sharing the
HUD page with other mods, and the settings kept in the player save.

The fakes follow the game's compiled Lua, as in PZ2Guardian's tests:
  * UI2.ViewWrapper.Init stores the address, calls self:Load(), then copies
    fnOnReadyCallback into tOnReadyCallbacks; HUDUI is a subclass without a
    Load of its own.
  * Mike's QoL Toolbox (PZ2QoL.Hub, 3.x) wraps HUDUI.Init and swaps the
    page only when it is exactly HUD.html; it wraps fnOnReadyCallback.
  * Player save: Database.GameDatabase.GetPlayerKey(api.player.GetGameOwner())
    -> key (0 = no profile yet), GetPlayer(key):GetData(...) / SetData(v, ...),
    api.save.RequestSaveMainPlayer().
"""
import itertools
import json
import os
import sys
from lupa.lua53 import LuaRuntime

LUA_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "lua")
GUARDIAN_LUA = os.path.join(LUA_DIR, "..", "..", "PZ2Guardian", "lua")

FAKE = r"""
loaded_src = {}
game_modules = {}
package.loaded = {}
module = function(name)
  local t = {}
  package.loaded[string.lower(name)] = t
  return t
end
require = function(name)
  local key = string.lower(name)
  if package.loaded[key] then return package.loaded[key] end
  if game_modules[key] then package.loaded[key] = game_modules[key]; return game_modules[key] end
  local src = loaded_src[key]
  assert(src, "no module " .. name)
  local fn = assert(load(src, name))
  local r = fn(name)
  return package.loaded[key] or r
end
tryrequire = function(name) local ok, r = pcall(require, name); if ok then return r end end

ViewWrapper = {}
ViewWrapper.__index = ViewWrapper
function ViewWrapper:new() return setmetatable({}, self) end
function ViewWrapper:subclass() local c = setmetatable({}, { __index = self }); c.__index = c; return c end
function ViewWrapper:Init(t)
  self.tInitSettings = t
  self.sViewAddress = t.sViewAddress
  self.tOnReadyCallbacks = {}
  self.tListeners = {}
  self:Load()
  if t.fnOnReadyCallback then table.insert(self.tOnReadyCallbacks, t.fnOnReadyCallback) end
end
function ViewWrapper:Load() self.sLoaded = self.sViewAddress end
function ViewWrapper:Ready() for _, fn in ipairs(self.tOnReadyCallbacks) do fn() end end
function ViewWrapper:Shutdown() self.bShut = true end
function ViewWrapper:AddEventListener(name, n, fn, arg) self.tListeners[name] = { n = n, fn = fn, arg = arg } end
sent = {}
function ViewWrapper:TriggerEventAtNextAdvance(name, ...) sent[#sent + 1] = { name = name, args = table.pack(...) } end
function ViewWrapper:Fire(name, ...) local l = self.tListeners[name]; assert(l, "no listener " .. name); return l.fn(l.arg, ...) end
game_modules["ui2.viewwrapper"] = ViewWrapper
game_modules["ui.controllers.hudui"] = ViewWrapper:subclass()
game_modules["game.gamescript"] = { OnPrepareToShutdown = function() end }
game_modules["worlds.darwinworld"] = {
  OnActivate = function() end, OnDeactivate = function() end, OnQuitRequested = function() end,
  OnUnload = function() end, OnShutdown = function() end,
}

-- the player save --------------------------------------------------------
playerKey = 7
playerData = {}
saveRequests = 0
setDataFails = false
Player = {}
function Player:GetData(...)
  local t = playerData
  for _, k in ipairs({ ... }) do
    if type(t) ~= "table" then return nil end
    t = t[k]
  end
  return t
end
function Player:SetData(v, ...)
  assert(not setDataFails, "SetData refused")
  local tKeys = { ... }
  local t = playerData
  for i = 1, #tKeys - 1 do
    t[tKeys[i]] = t[tKeys[i]] or {}
    t = t[tKeys[i]]
  end
  t[tKeys[#tKeys]] = v
end
game_modules["database.gamedatabase"] = {
  GetPlayerKey = function(owner) assert(owner == "owner"); return playerKey end,
  GetPlayer = function(key) assert(key == playerKey); return Player end,
}

local P = {}
function P:GetParkName() return "[STRING_LITERAL:Value=|Lions|]" end
api = {
  debug = { Trace = function() end },
  entity = { NullEntityID = -1 },
  player = { GetGameOwner = function() return "owner" end },
  save = { RequestSaveMainPlayer = function() saveRequests = saveRequests + 1 end },
  time = { GetTotalTimeUnscaled = function() return 0 end },
  world = { GetWorldAPIs = function() return { park = P } end },
  ui2 = {
    LoadOverlay = function() end,
    IsOverlayLoaded = function() return true end,
    MapResources = function() end,
    UnmapResources = function() end,
    AreResourcesUnmapped = function() return true end,
    UnloadOverlay = function() end,
  },
}
"""

# Mike's QoL Toolbox, the part that matters here (PZ2QoL.Hub._PatchHUDUI and
# its require hook, 3.x): Init-level swap of exactly HUD.html.
FAKE_QOL = r"""
local Hub = module("PZ2QoL.Hub")
Hub.sVanillaHUD = "coui://UIGameface/HUD.html"
Hub.sModHUD = "coui://UIGameface/PZ2QoLHUD.html"
Hub.nReady = 0
local fnRequire = require
require = function(name, ...)
  local t = fnRequire(name, ...)
  if string.lower(name) == "ui.controllers.hudui" and not Hub.bPatched then
    Hub.bPatched = true
    local fnInit = t.Init or ViewWrapper.Init
    t.Init = function(oUI, tInitSettings)
      if type(tInitSettings) == "table" and tInitSettings.sViewAddress == Hub.sVanillaHUD then
        tInitSettings.sViewAddress = Hub.sModHUD
        local fnReady = tInitSettings.fnOnReadyCallback
        tInitSettings.fnOnReadyCallback = function(...)
          Hub.nReady = Hub.nReady + 1
          oUI:TriggerEventAtNextAdvance("PZ2QoL_Hello", "3.0.2")
          if fnReady then return fnReady(...) end
        end
        Hub.oHUDUI = oUI
      end
      return fnInit(oUI, tInitSettings)
    end
  end
  return t
end
"""

# PZ2Essentials 1.0.1 (PZ2Essentials.UI, from its Tools/PZ2Shared template):
# shared registry PZ2HUDMods v2; HUDUI.Init swaps exactly HUD.html to its
# page and hooks the ready callback, which calls every ready mod's OnReady
# and then answers PZ2HUD_GetScripts with every ready mod's scripts.
FAKE_ESS = r"""
local function registry()
  local R = rawget(_G, "PZ2HUDMods")
  if type(R) ~= "table" or R.nVersion ~= 2 then
    R = { nVersion = 2, tMods = {}, tPages = {}, tWrapped = setmetatable({}, { __mode = "k" }), tUIs = {} }
    rawset(_G, "PZ2HUDMods", R)
  end
  return R
end
Ess = { sPage = "coui://UIGameface/PZ2EssentialsHUD.html", nReady = 0 }
Ess.tEntry = {
  tScripts = { HUD = { "/js/mods/pz2essentials/autosave/main.js" } },
  IsReady = function() return true end,
  OnReady = function(sView, oUI) Ess.nReady = Ess.nReady + 1 end,
}
local function scripts(R)
  local tNames, tOut = {}, {}
  for sName, tMod in pairs(R.tMods) do if tMod.IsReady() then tNames[#tNames + 1] = sName end end
  table.sort(tNames)
  for _, sName in ipairs(tNames) do
    for _, s in ipairs(R.tMods[sName].tScripts.HUD or {}) do tOut[#tOut + 1] = s end
  end
  return table.concat(tOut, ",")
end
local fnRequire = require
require = function(name, ...)
  local t = fnRequire(name, ...)
  if string.lower(name) == "ui.controllers.hudui" and not Ess.bPatched then
    Ess.bPatched = true
    local fnInit = t.Init or ViewWrapper.Init
    t.Init = function(oUI, tInitSettings)
      local R = registry()
      R.tPages[Ess.sPage] = "HUD"
      R.tMods.PZ2Essentials = Ess.tEntry
      if tInitSettings.sViewAddress == "coui://UIGameface/HUD.html" then
        tInitSettings.sViewAddress = Ess.sPage
      end
      if R.tPages[tInitSettings.sViewAddress] == "HUD" and not R.tWrapped[oUI] then
        R.tWrapped[oUI] = true
        R.tUIs.HUD = oUI
        local fnReady = tInitSettings.fnOnReadyCallback
        tInitSettings.fnOnReadyCallback = function(...)
          local R2 = registry()
          for _, tMod in pairs(R2.tMods) do if tMod.IsReady() then tMod.OnReady("HUD", oUI) end end
          oUI:TriggerEventAtNextAdvance("PZ2HUD_Scripts", scripts(R2))
          if fnReady then return fnReady(...) end
        end
      end
      return fnInit(oUI, tInitSettings)
    end
  end
  return t
end
"""

# More Path Stamp Sizes (Pure Winter, Nexus planetzoo2 mod 64, version 4):
# MorePathStampSizes.Core.PatchHUD wraps HUDUI.Init, swaps exactly HUD.html
# and wraps fnOnReadyCallback (its listeners; its JS sends the hello).
FAKE_MPSS = r"""
Mpss = { nReady = 0 }
local fnRequire = require
require = function(name, ...)
  local t = fnRequire(name, ...)
  if string.lower(name) == "ui.controllers.hudui" and not Mpss.bPatched then
    Mpss.bPatched = true
    local oldInit = t.Init or ViewWrapper.Init
    t.Init = function(view, settings, ...)
      if type(settings) == "table" and settings.sViewAddress == "coui://UIGameface/HUD.html" then
        settings.sViewAddress = "coui://UIGameface/MorePathStampSizesHUD.html"
        local ready = settings.fnOnReadyCallback
        settings.fnOnReadyCallback = function(...)
          Mpss.nReady = Mpss.nReady + 1
          view:AddEventListener("MorePathStampSizes_Hello", 0, function() end, Mpss)
          if ready then return ready(...) end
        end
      end
      return oldInit(view, settings, ...)
    end
  end
  return t
end
"""

FAILS = 0
OKS = 0


def check(cond, msg):
    global FAILS, OKS
    if cond:
        OKS += 1
    else:
        FAILS += 1
        print("FAIL:", msg)


def read_dir(lua, d):
    for f in sorted(os.listdir(d)):
        if f.endswith(".lua"):
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                lua.globals().loaded_src[f[:-4]] = fh.read()


def boot(order):
    """order: mod names booted in this order ("AutoHub", "Guardian", "QoL")."""
    lua = LuaRuntime(unpack_returned_tuples=True)
    lua.execute(FAKE)
    read_dir(lua, LUA_DIR)
    if os.path.isdir(GUARDIAN_LUA):
        read_dir(lua, GUARDIAN_LUA)
    for name in order:
        if name == "QoL":
            lua.execute(FAKE_QOL)
        elif name == "Ess":
            lua.execute(FAKE_ESS)
        elif name == "Mpss":
            lua.execute(FAKE_MPSS)
        else:
            lua.execute(f'require("Database.PZ2{name}LuaDatabase")')
            lua.execute(f'package.loaded["pz2{name.lower()}.core"].bProbeOk = true')
    return lua


def open_hud(lua, address="coui://UIGameface/HUD.html"):
    lua.execute("sent = {}")
    view = lua.eval('require("UI.Controllers.HUDUI"):new()')
    lua.execute('function _init(v, a) v:Init({ sViewAddress = a, fnOnReadyCallback = function() end }) end')
    lua.globals()._init(view, address)
    view.Ready(view)
    return view


def events(lua, name=None):
    out = []
    for e in lua.globals().sent.values():
        args = [e.args[i] for i in range(1, e.args.n + 1)]
        if name is None or e.name == name:
            out.append((e.name, args))
    return out


def names(lua):
    return [n for n, _ in events(lua)]


AUTOHUB_PAGE = "coui://UIGameface/PZ2AutoHubHUD.html"
GUARDIAN_PAGE = "coui://UIGameface/PZ2GuardianHUD.html"

# --- AutoHub alone ---------------------------------------------------------
lua = boot(["AutoHub"])
view = open_hud(lua)
check(view.sLoaded == AUTOHUB_PAGE, f"takes over the game's HUD, got {view.sLoaded}")
hello = events(lua, "PZ2AutoHub_Hello")
check(len(hello) == 1, "one hello")
check(hello and hello[0][1][:2] == ["1.7.2", "Lions"], f"hello: version and park name, got {hello}")
check(hello and hello[0][1][2:] == ["", "ok"], f"hello: nothing kept yet, got {hello and hello[0][1][2:]}")
want_args = {
    "PZ2AutoHub_SetAuto": 1, "PZ2AutoHub_SetSiblings": 1, "PZ2AutoHub_SetKinds": 1, "PZ2AutoHub_SetKindCfg": 1, "PZ2AutoHub_SetInterval": 1,
    "PZ2AutoHub_SetContra": 1, "PZ2AutoHub_SetContraKeys": 1, "PZ2AutoHub_SetYoungKeys": 1, "PZ2AutoHub_Tick": 1, "PZ2AutoHub_SendFromHabitat": 2,
    "PZ2AutoHub_CheckAll": 1, "PZ2AutoHub_Diagnose": 2, "PZ2AutoHub_StoreSave": 1, "PZ2AutoHub_HelloAgain": 1,
}
got_args = {k: v.n for k, v in view.tListeners.items()}
check(got_args == want_args, f"listeners and argument counts (main.js), got {got_args}")
lua.execute("sent = {}")
lua.globals().HUDUI = lua.eval('require("UI.Controllers.HUDUI")')
view.Shutdown(view)
check(lua.eval('package.loaded["pz2autohub.core"].oHUDUI') is None, "shutdown forgets the view")

# a page AutoHub does not know stays
lua = boot(["AutoHub"])
view = open_hud(lua, "coui://UIGameface/SomeOtherMod.html")
check(view.sLoaded == "coui://UIGameface/SomeOtherMod.html", "leaves unknown pages alone")
check("PZ2AutoHub_Hello" not in names(lua), "no hello on a page it did not take")

# --- with Mike's QoL Toolbox, both boot orders -----------------------------
# 1.1.0 wrapped Init: booted after the Toolbox, AutoHub swapped the page
# first, the Toolbox no longer saw HUD.html, and its Lua never attached.
for order in (["AutoHub", "QoL"], ["QoL", "AutoHub"]):
    lua = boot(order)
    view = open_hud(lua)
    n = names(lua)
    check(view.sLoaded == AUTOHUB_PAGE, f"{order}: AutoHub's page (it loads the Toolbox's script), got {view.sLoaded}")
    check("PZ2QoL_Hello" in n, f"{order}: the Toolbox's ready callback ran")
    check("PZ2AutoHub_Hello" in n, f"{order}: AutoHub's ready callback ran")
    same = lua.eval('function(v) return package.loaded["pz2qol.hub"].oHUDUI == v end')
    check(same(view), f"{order}: the Toolbox knows the HUD view")

# --- with Guardian (its real Lua) and the Toolbox, every boot order ---------
if os.path.isdir(GUARDIAN_LUA):
    for order in itertools.permutations(["AutoHub", "Guardian", "QoL"]):
        order = list(order)
        lua = boot(order)
        view = open_hud(lua)
        n = names(lua)
        check(view.sLoaded in (AUTOHUB_PAGE, GUARDIAN_PAGE), f"{order}: AutoHub's or Guardian's page, got {view.sLoaded}")
        for hello in ("PZ2AutoHub_Hello", "PZ2Guardian_Hello", "PZ2QoL_Hello"):
            check(n.count(hello) == 1, f"{order}: {hello} once, got {n.count(hello)}")
    for order in (["AutoHub", "Guardian"], ["Guardian", "AutoHub"]):
        lua = boot(order)
        view = open_hud(lua)
        n = names(lua)
        check("PZ2AutoHub_Hello" in n and "PZ2Guardian_Hello" in n, f"{order}: both ready callbacks ran")
else:
    print("(PZ2Guardian source not found next to this mod: page-sharing test with Guardian skipped)")

# --- settings kept in the player save ---------------------------------------
lua = boot(["AutoHub"])
lua.execute("playerKey = 0")
view = open_hud(lua)
hello = events(lua, "PZ2AutoHub_Hello")
check(hello[0][1][2:] == ["", "noplayer"], f"no profile yet: says so, got {hello[0][1][2:]}")
lua.execute("sent = {}")
view.Fire(view, "PZ2AutoHub_StoreSave", '{"PZ2AutoHub.mode":"always"}')
check(events(lua, "PZ2AutoHub_StoreSaved") == [("PZ2AutoHub_StoreSaved", ["noplayer"])], "no profile: nothing written")

lua = boot(["AutoHub"])
view = open_hud(lua)
settings = {"PZ2AutoHub.mode": "always", "PZ2AutoHub.siblings": "false",
            "PZ2AutoHub.buttonPos": '{"x":0,"y":420}', "PZ2AutoHub.contraKeys.Z\\u00fcrich": "1001,1002"}
text = json.dumps(settings, separators=(",", ":"))
lua.execute("sent = {}")
view.Fire(view, "PZ2AutoHub_StoreSave", text)
check(events(lua, "PZ2AutoHub_StoreSaved") == [("PZ2AutoHub_StoreSaved", ["saved"])], "write: saved")
check(lua.eval("saveRequests") == 1, "write: asks the game to save the player once")
check(lua.eval("playerData.PZ2AutoHub.N") == "1", "write: one part")
check(list(lua.eval("playerData").keys()) == ["PZ2AutoHub"], "write: only our own entry in the player data")
view2 = open_hud(lua)
hello = events(lua, "PZ2AutoHub_Hello")
check(hello and hello[0][1][2:] == [text, "ok"], f"next park: hello carries the saved text, got {hello and hello[0][1][2:]}")

# long text in parts
big = json.dumps({"PZ2AutoHub.contraKeys.park": ",".join(str(1000 + i) for i in range(2000))}, separators=(",", ":"))
check(len(big) > 8000, "test text is longer than two parts")
lua.execute("sent = {}")
view2.Fire(view2, "PZ2AutoHub_StoreSave", big)
check(lua.eval("playerData.PZ2AutoHub.N") == str(-(-len(big) // 4000)), "long text: split into 4000-character parts")
core = lua.eval('package.loaded["pz2autohub.core"]')
got = core.StoreRead(core)
check(got == (big, "ok"), "long text: read back whole")

# refused texts leave the kept one alone
for bad, why in (("not json", "bad"), ('{"PZ2AutoHub.x":"ä"}', "bad"), ("{" + "x" * 60001 + "}", "toobig")):
    lua.execute("sent = {}")
    view2.Fire(view2, "PZ2AutoHub_StoreSave", bad)
    check(events(lua, "PZ2AutoHub_StoreSaved") == [("PZ2AutoHub_StoreSaved", [why])], f"refuses {why}: {bad[:20]!r}")
check(core.StoreRead(core) == (big, "ok"), "refused writes keep the saved text")

# SetData refused; then a broken entry
lua.execute("setDataFails = true; sent = {}")
view2.Fire(view2, "PZ2AutoHub_StoreSave", text)
check(events(lua, "PZ2AutoHub_StoreSaved") == [("PZ2AutoHub_StoreSaved", ["failed"])], "SetData error: failed, no crash")
lua.execute('setDataFails = false; playerData.PZ2AutoHub = { V = "1", N = "3", P1 = "{" }')
check(core.StoreRead(core) == ("", "unreadable"), "missing parts: unreadable")
lua.execute('playerData.PZ2AutoHub = "junk"')
check(core.StoreRead(core) == ("", "unreadable"), "not a table: unreadable")
lua.execute('game_modules["database.gamedatabase"] = nil; package.loaded["database.gamedatabase"] = nil')
check(core.StoreRead(core) == ("", "noplayer"), "no GameDatabase: no player, no error")
lua.execute("sent = {}")
view2.Fire(view2, "PZ2AutoHub_Diagnose", "", "")
logs = [a[0] for _, a in events(lua, "PZ2AutoHub_Log")]
check(any("settings store:" in s and "HUD: took over" in s for s in logs), f"Diagnose shows the HUD and store state, got {logs[:2]}")

# --- More Path Stamp Sizes (Init swap of exactly HUD.html), every order ------
mods = ["AutoHub", "Mpss"] + (["Guardian"] if os.path.isdir(GUARDIAN_LUA) else [])
for order in itertools.permutations(mods):
    order = list(order)
    lua = boot(order)
    view = open_hud(lua)
    n = names(lua)
    tag = "+".join(order)
    check(view.sLoaded in (AUTOHUB_PAGE, GUARDIAN_PAGE), f"{tag}: our page (it loads the path mod's script), got {view.sLoaded}")
    check(lua.eval("Mpss.nReady") == 1, f"{tag}: the path mod's ready callback ran")
    check("MorePathStampSizes_Hello" in view.tListeners, f"{tag}: the path mod listens on the view")
    for hello in ["PZ2AutoHub_Hello"] + (["PZ2Guardian_Hello"] if "Guardian" in order else []):
        check(n.count(hello) == 1, f"{tag}: {hello} once, got {n.count(hello)}")

# --- PZ2Essentials (shared registry page) ---------------------------------
ESS_PAGE = "coui://UIGameface/PZ2EssentialsHUD.html"
for order in (["Ess", "AutoHub"], ["AutoHub", "Ess"], ["Ess", "AutoHub", "Guardian"], ["Guardian", "AutoHub", "Ess"]):
    if "Guardian" in order and not os.path.isdir(GUARDIAN_LUA):
        continue
    lua = boot(order)
    view = open_hud(lua)
    tag = "+".join(order)
    check(view.sLoaded == ESS_PAGE, f"{tag}: Essentials keeps its page, got {view.sLoaded}")
    check(lua.eval("Ess.nReady") == 1, f"{tag}: Essentials' own ready hook ran")
    scripts = [a[0] for _, a in events(lua, "PZ2HUD_Scripts")]
    check(scripts and "/js/mods/pz2autohub/main.js" in scripts[0].split(","), f"{tag}: the shared loader gets AutoHub's script, got {scripts}")
    if "Guardian" in order:
        check(scripts and "/js/mods/pz2guardian/main.js" in scripts[0].split(","), f"{tag}: and Guardian's, got {scripts}")
        check(len(events(lua, "PZ2Guardian_Hello")) == 1, f"{tag}: Guardian says hello once")
    check(len(events(lua, "PZ2AutoHub_Hello")) == 1, f"{tag}: AutoHub's ready ran once (one hello)")
    check("PZ2AutoHub_Tick" in view.tListeners, f"{tag}: AutoHub listens on the shared page")
    core = lua.eval('package.loaded["pz2autohub.core"]')
    check(str(core.sHUDState).startswith("joined " + ESS_PAGE), f"{tag}: HUD state says joined, got {core.sHUDState}")
    # the page imports our script late and asks for the hello again
    lua.execute("sent = {}")
    view.Fire(view, "PZ2AutoHub_HelloAgain", 1)
    hello = events(lua, "PZ2AutoHub_Hello")
    check(len(hello) == 1 and hello[0][1][:2] == ["1.7.2", "Lions"], f"{tag}: HelloAgain answers with a hello, got {hello}")

# overlay not ready: Essentials keeps its page, AutoHub stays out of it
lua = boot(["Ess", "AutoHub"])
lua.execute('package.loaded["pz2autohub.core"].bProbeOk = false')
view = open_hud(lua)
scripts = [a[0] for _, a in events(lua, "PZ2HUD_Scripts")]
check(view.sLoaded == ESS_PAGE and scripts and "pz2autohub" not in scripts[0], f"no probe: not registered as ready, got {scripts}")
check(not events(lua, "PZ2AutoHub_Hello"), "no probe: no hello")

print(f"{OKS} ok, {FAILS} failed")
sys.exit(1 if FAILS else 0)
