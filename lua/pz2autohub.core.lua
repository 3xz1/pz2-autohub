-----------------------------------------------------------------------
--  PZ2AutoHub.Core
--
--  Boots the mod once per Lua state:
--   * installs a require hook so game modules are patched the moment
--     they are first loaded (chains with other mods' hooks);
--   * loads the mod's UI overlay (Win64/ovldata/PZ2AutoHub/UI) and, once
--     a hidden probe page proves it serves files, points the in-park HUD
--     view at PZ2AutoHubHUD.html (the game's HUDApp.js plus our module);
--   * bridges UI events to PZ2AutoHub.Logic;
--   * keeps the UI's settings in the game's player save (see "settings").
--  If any UI step fails the vanilla HUD is used, so the game always works.
--
--  Sharing the HUD page: like PZ2Guardian and PZ2Studbook, AutoHub takes
--  the page over in the view class's Load, not Init. Load runs inside Init,
--  after every mod that swaps the page in an Init wrapper (Mike's QoL
--  Toolbox = PZ2QoL) has done so and hooked its ready callback, so those
--  mods always attach, whatever order the mods boot in. Mods that also hook
--  Load list this page as replaceable and import our script (and we
--  theirs), so either order ends with one page that runs every mod's UI.
-----------------------------------------------------------------------
local global    = _G
local api       = global.api
local pcall     = global.pcall
local tostring  = global.tostring
local type      = global.type
local ipairs    = global.ipairs
local string    = global.string
local table     = global.table
local coroutine = global.coroutine
local tonumber  = global.tonumber
local math      = global.math

local Core = module(...)

Core.sVersion = "1.2.0"
Core.bBooted = false

Core.sOverlayName = "PZ2AutoHubUI"
Core.sOverlayPath = "PZ2AutoHub/UI/PZ2AutoHubUI"
Core.sProbeAddress = "coui://UIGameface/PZ2AutoHub/probe.html"
Core.sModHUD = "coui://UIGameface/PZ2AutoHubHUD.html"
-- HUD pages we may replace: the game's, or another mod's copy of it (our
-- compat.js loads those mods' scripts too, and their pages load ours).
Core.tReplaceableHUDs = {
	["coui://UIGameface/HUD.html"] = true,
	["coui://UIGameface/PZ2QoLHUD.html"] = true,
	["coui://UIGameface/PZ2GuardianHUD.html"] = true,
	["coui://UIGameface/PZ2StudbookHUD.html"] = true,
	["coui://UIGameface/PZ2TimeWarpHUD.html"] = true,
	["coui://UIGameface/PZ2BreedAdvisorHUD.html"] = true,
}

Core.sOverlayState = "not loaded" -- "loading" | "mapped" | "failed" | "unloaded"
Core.bProbeOk = false
Core.oHUDUI = nil
Core.bHUDIsModded = false
Core.sHUDState = "not seen" -- for Diagnose

-- lower-cased module name -> list of patch functions(tModule)
Core.tPatches = {}
Core.tPatched = {}

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2AutoHub] " .. sMsg) end)
end
Core.Trace = trace

local function logic()
	return Core.oLogic
end

-----------------------------------------------------------------------
-- module patching
-----------------------------------------------------------------------

-- Register fnPatch(tModule) to run once when sModuleName is loaded
-- (immediately if it already is).
Core.AddModulePatch = function(self, sModuleName, fnPatch)
	local sKey = string.lower(sModuleName)
	local tList = self.tPatches[sKey]
	if not tList then
		tList = {}
		self.tPatches[sKey] = tList
	end
	tList[#tList + 1] = fnPatch
	local tLoaded = global.package and global.package.loaded and global.package.loaded[sKey]
	if type(tLoaded) == "table" then
		self:_ApplyPatches(sKey, tLoaded)
	end
end

Core._ApplyPatches = function(self, sKey, tModule)
	local tList = self.tPatches[sKey]
	if not tList or type(tModule) ~= "table" then
		return
	end
	self.tPatched[sKey] = self.tPatched[sKey] or {}
	for i, fnPatch in ipairs(tList) do
		if not self.tPatched[sKey][i] then
			self.tPatched[sKey][i] = true
			local bOk, sErr = pcall(fnPatch, tModule)
			if not bOk then
				trace("patch for " .. sKey .. " failed: " .. tostring(sErr))
			end
		end
	end
end

Core._InstallRequireHook = function(self)
	local fnRequire = global.require
	local fnTryRequire = global.tryrequire
	local function after(sName, tModule)
		if type(sName) == "string" and type(tModule) == "table" then
			local sKey = string.lower(sName)
			if self.tPatches[sKey] then
				self:_ApplyPatches(sKey, tModule)
			end
		end
		return tModule
	end
	global.require = function(sName, ...)
		return after(sName, fnRequire(sName, ...))
	end
	if fnTryRequire then
		global.tryrequire = function(sName, ...)
			return after(sName, fnTryRequire(sName, ...))
		end
	end
end

-----------------------------------------------------------------------
-- UI overlay
-----------------------------------------------------------------------

-- Lua 5.3: coroutine.running() returns (thread, isMain); never nil.
Core._CanYield = function(self)
	local co, bMain = coroutine.running()
	return co ~= nil and not bMain
end

-- Called at boot. Boot runs inside require(), which cannot yield, so this
-- only starts the load; WaitUntilReady does the waiting.
Core._LoadOverlay = function(self)
	local bOk, sErr = pcall(function()
		api.ui2.LoadOverlay(self.sOverlayName, self.sOverlayPath)
	end)
	if not bOk then
		self.sOverlayState = "failed"
		trace("LoadOverlay failed: " .. tostring(sErr))
		return
	end
	self.sOverlayState = "loading"
	self:_TryMap()
end

-- Called from the database's AddContentToCall, which the game runs on its
-- startup coroutine. Bounded, so a broken overlay costs a few seconds once.
Core.WaitUntilReady = function(self)
	if self.bWaited or not self:_CanYield() then
		return
	end
	self.bWaited = true
	local nFrames = 0
	while self.sOverlayState == "loading" and nFrames < 300 do
		if self:_TryMap() then
			break
		end
		nFrames = nFrames + 1
		coroutine.yield()
	end
	nFrames = 0
	while self.sOverlayState == "mapped" and not self.bProbeOk and nFrames < 180 do
		nFrames = nFrames + 1
		coroutine.yield()
	end
	-- Destroy the probe here, on the startup coroutine. Never from a UI
	-- callback: DestroyView inside a view callback deadlocks the UI engine.
	if self.bProbeOk then
		self:_ShutdownProbe()
	end
	trace("overlay " .. self.sOverlayState .. ", probe " .. tostring(self.bProbeOk))
end

Core._TryMap = function(self)
	if self.sOverlayState ~= "loading" then
		return self.sOverlayState == "mapped"
	end
	local bOk, bLoaded = pcall(api.ui2.IsOverlayLoaded, self.sOverlayName)
	if not bOk or not bLoaded then
		return false
	end
	local bMapped, sErr = pcall(api.ui2.MapResources, self.sOverlayName)
	if not bMapped then
		self.sOverlayState = "failed"
		trace("MapResources failed: " .. tostring(sErr))
		return false
	end
	self.sOverlayState = "mapped"
	self:_StartProbe()
	return true
end

-- A hidden 16x16 view that loads probe.html from the overlay. Its JS
-- fires "OnReady", which ViewWrapper turns into the ready callback.
Core._StartProbe = function(self)
	local bOk, sErr = pcall(function()
		local ViewWrapper = global.require("UI2.ViewWrapper")
		local oProbe = ViewWrapper:new()
		oProbe:Init({
			sViewName = "PZ2AutoHubProbe",
			sViewAddress = self.sProbeAddress,
			bRenderToScreen = false,
			bRenderToFullScreen = false,
			nViewWidth = 16,
			nViewHeight = 16,
			fnOnReadyCallback = function()
				self.bProbeOk = true
			end,
		})
		self.oProbe = oProbe
	end)
	if not bOk then
		trace("probe failed to start: " .. tostring(sErr))
	end
end

Core._ShutdownProbe = function(self)
	if self.oProbe ~= nil then
		pcall(function() self.oProbe:Shutdown() end)
		self.oProbe = nil
	end
end

-- On exit the game unmaps and unloads its own UI overlays
-- (GameScript.OnPrepareToShutdown). Ours must go the same way, or the UI
-- system shuts down with an overlay still mapped (fatal crash).
Core.UnloadOverlay = function(self)
	if self.sOverlayState ~= "mapped" and self.sOverlayState ~= "loading" then
		return
	end
	pcall(api.ui2.UnmapResources, self.sOverlayName)
	if self:_CanYield() then
		local nFrames = 0
		while nFrames < 300 do
			local bOk, bDone = pcall(api.ui2.AreResourcesUnmapped, self.sOverlayName)
			if not bOk or bDone then
				break
			end
			nFrames = nFrames + 1
			coroutine.yield()
		end
	end
	pcall(api.ui2.UnloadOverlay, self.sOverlayName)
	self.sOverlayState = "unloaded"
end

Core._PatchGameScript = function(self, GameScript)
	local fnPrepare = GameScript.OnPrepareToShutdown
	if type(fnPrepare) ~= "function" then
		return
	end
	GameScript.OnPrepareToShutdown = function(oGame, ...)
		local bOk, sErr = pcall(self.UnloadOverlay, self)
		if not bOk then
			trace("overlay unload failed: " .. tostring(sErr))
		end
		return fnPrepare(oGame, ...)
	end
end

-- The park world (DarwinWorld): AutoHub only calls the game while it is
-- active. Leaving for the main menu deactivates it first; the HUD keeps
-- ticking for a while after that.
Core._PatchDarwinWorld = function(self, DarwinWorld)
	local function setLive(bLive)
		local Logic = logic()
		if Logic and Logic.SetParkLive then
			pcall(Logic.SetParkLive, Logic, bLive)
		end
	end
	local function wrap(sName, bLive)
		local fn = DarwinWorld[sName]
		if type(fn) ~= "function" then
			return
		end
		DarwinWorld[sName] = function(...)
			if not bLive then
				setLive(false)
			end
			local tRes = table.pack(fn(...))
			if bLive then
				setLive(true)
			end
			return table.unpack(tRes, 1, tRes.n)
		end
	end
	wrap("OnActivate", true)
	wrap("OnDeactivate", false)
	wrap("OnQuitRequested", false)
	wrap("OnUnload", false)
	wrap("OnShutdown", false)
end

-----------------------------------------------------------------------
-- in-park HUD view
-----------------------------------------------------------------------

-- HUDUI is a ViewWrapper subclass without a Load of its own, so Load comes
-- from ViewWrapper through the class (as PZ2Guardian found).
Core._PatchHUDUI = function(self, HUDUI)
	local fnLoad = HUDUI.Load
	if type(fnLoad) ~= "function" then
		self.sHUDState = "no Load to wrap"
		trace("HUDUI has no Load; using the vanilla HUD")
		return
	end
	HUDUI.Load = function(oUI, ...)
		local bOk, sErr = pcall(self._TakeOver, self, oUI)
		if not bOk then
			self.sHUDState = "take-over failed: " .. tostring(sErr)
			trace(self.sHUDState)
		end
		return fnLoad(oUI, ...)
	end
	local fnShutdown = HUDUI.Shutdown
	if type(fnShutdown) ~= "function" then
		return
	end
	HUDUI.Shutdown = function(oUI, ...)
		if self.oHUDUI == oUI then
			self.oHUDUI = nil
			self.bHUDIsModded = false
			local Logic = logic()
			if Logic then
				pcall(Logic.Reset, Logic)
				-- the next park sends its own list
				Logic.tContra = {}
			end
		end
		return fnShutdown(oUI, ...)
	end
end

Core._TakeOver = function(self, oUI)
	local sAddress = type(oUI) == "table" and oUI.sViewAddress or nil
	if not self.tReplaceableHUDs[sAddress] then
		return
	end
	self:_TryMap()
	if self.sOverlayState ~= "mapped" or not self.bProbeOk then
		self.sHUDState = "left " .. tostring(sAddress) .. " (overlay " .. self.sOverlayState .. ", probe " .. tostring(self.bProbeOk) .. ")"
		trace("using vanilla HUD (overlay " .. self.sOverlayState .. ", probe " .. tostring(self.bProbeOk) .. ")")
		return
	end
	oUI.sViewAddress = self.sModHUD
	self.oHUDUI = oUI
	self.bHUDIsModded = true
	self.sHUDState = "took over " .. sAddress
	-- Init copies tInitSettings.fnOnReadyCallback into tOnReadyCallbacks
	-- right after Load; add ours to the same list (works whether Load runs
	-- before or after that copy)
	local fnReady = function()
		local bOk, sErr = pcall(self._OnHUDReady, self, oUI)
		if not bOk then
			trace("HUD ready failed: " .. tostring(sErr))
		end
	end
	if type(oUI.tOnReadyCallbacks) == "table" then
		table.insert(oUI.tOnReadyCallbacks, fnReady)
	elseif type(oUI.tInitSettings) == "table" then
		local fnOld = oUI.tInitSettings.fnOnReadyCallback
		oUI.tInitSettings.fnOnReadyCallback = function(...)
			fnReady()
			if fnOld then
				return fnOld(...)
			end
		end
	end
end

-- Sends an event to our page. Safe to call any time; dropped without a page.
Core.SendToUI = function(self, sEvent, ...)
	local oUI = self.oHUDUI
	if oUI == nil or not self.bHUDIsModded then
		return false
	end
	local tArgs = table.pack(...)
	local bOk = pcall(function()
		oUI:TriggerEventAtNextAdvance(sEvent, table.unpack(tArgs, 1, tArgs.n))
	end)
	return bOk
end

-- ViewWrapper:AddEventListener(sEventName, nArgCount, fnCallback, callbackArgument):
-- nArgCount must match the number of arguments the page sends, or the
-- event never arrives. Callbacks get (callbackArgument, eventArgs...); we
-- pass Core as the callback argument, but accept either shape.
local function listen(oUI, sEvent, nArgCount, fn)
	oUI:AddEventListener(sEvent, nArgCount, function(a, ...)
		if a == Core then
			return fn(...)
		end
		return fn(a, ...)
	end, Core)
end

-- Runs inside the view's ready callback: keep it to non-blocking calls
-- (no view creation/destruction here).
Core._OnHUDReady = function(self, oUI)
	local bOk, sErr = pcall(function()
		local function guarded(sName, nArgCount, fn)
			listen(oUI, sName, nArgCount, function(...)
				local Logic = logic()
				if not Logic then
					self:SendToUI("PZ2AutoHub_Log", sName .. ": logic module not loaded")
					return
				end
				local bOk2, sErr2 = pcall(fn, Logic, ...)
				if not bOk2 then
					self:SendToUI("PZ2AutoHub_Log", "error in " .. sName .. ": " .. tostring(sErr2))
				end
			end)
		end
		-- argument counts must match engine.trigger calls in main.js
		guarded("PZ2AutoHub_SetAuto", 1, function(Logic, sMode) Logic:SetAuto(sMode) end)
		guarded("PZ2AutoHub_SetSiblings", 1, function(Logic, bOn) Logic:SetSiblings(bOn) end)
		-- the tick carries a dummy value: argument-less events are not delivered reliably
		guarded("PZ2AutoHub_SetKinds", 1, function(Logic, sKinds) Logic:SetKinds(sKinds) end)
		guarded("PZ2AutoHub_SetInterval", 1, function(Logic, nSeconds) Logic:SetInterval(nSeconds) end)
		guarded("PZ2AutoHub_SetContra", 1, function(Logic, bOn) Logic:SetContra(bOn) end)
		guarded("PZ2AutoHub_SetContraKeys", 1, function(Logic, sList) Logic:SetContraKeys(sList) end)
		guarded("PZ2AutoHub_Tick", 1, function(Logic) Logic:Tick() end)
		guarded("PZ2AutoHub_SendFromHabitat", 2, function(Logic, sIDs, sPanelID) Logic:SendFromHabitat(sIDs, sPanelID) end)
		guarded("PZ2AutoHub_CheckAll", 1, function(Logic) Logic:CheckAll() end)
		guarded("PZ2AutoHub_Diagnose", 2, function(Logic, sIDs, sPanelID)
			self:SendToUI("PZ2AutoHub_Log", "HUD: " .. tostring(self.sHUDState) .. " | settings store: " .. self:StoreStatus())
			Logic:Diagnose(sIDs, sPanelID)
		end)
		-- the page's settings (works without the logic module)
		listen(oUI, "PZ2AutoHub_StoreSave", 1, function(sText)
			local bOk2, sResult = pcall(self.StoreWrite, self, sText)
			self:SendToUI("PZ2AutoHub_StoreSaved", bOk2 and sResult or ("error: " .. tostring(sResult)))
		end)
	end)
	if not bOk then
		trace("HUD listeners failed: " .. tostring(sErr))
		return
	end
	-- a new park HUD: the park is live (in case OnActivate was missed)
	local Logic = logic()
	if Logic and Logic.SetParkLive then
		pcall(Logic.SetParkLive, Logic, true)
	end
	-- the saved settings go with the hello, so the page has them before it
	-- hands its settings to Lua
	local bRead, sText, sStatus = pcall(self.StoreRead, self)
	if not bRead then
		sText, sStatus = "", "error: " .. tostring(sText)
	end
	self:SendToUI("PZ2AutoHub_Hello", self.sVersion, self:_ParkKey(), sText, sStatus)
end

-- The park's name (park:GetParkName(), as the game's save screens read it):
-- the UI keeps the animals AutoHub put on contraception per park.
Core._ParkKey = function(self)
	local bOk, v = pcall(function()
		local P = api.world.GetWorldAPIs().park
		return P:GetParkName()
	end)
	if bOk and type(v) == "string" and v ~= "" then
		return (string.gsub(v, "%[STRING_LITERAL:Value=|(.-)|%]", "%1"))
	end
	return "park"
end

-----------------------------------------------------------------------
-- settings that outlast the game
-----------------------------------------------------------------------
-- The game's UI keeps localStorage in memory only, so it is empty after
-- every game start. The page's settings are kept in the game's player save
-- instead (Saves\player, the main player's tData, saved whole by the game:
-- GetData / SetData, api.save.RequestSaveMainPlayer), the way Mike's QoL
-- Toolbox keeps its own (proven in game there, Franchise included). Our own
-- "PZ2AutoHub" entry only, short ASCII strings, a size cap and pcall around
-- every call; nothing else in that save is touched, and nothing goes into
-- park or online saves.
--   tData.PZ2AutoHub = { V = "1", N = "<parts>", P1 = "<= 4000 chars", ... }
Core.sStoreRoot = "PZ2AutoHub"
Core.nStoreChunk = 4000
Core.nStoreCap = 60000
Core.sStoreLast = "not used yet"

-- the game's main player (nil until the profile is loaded: key 0)
Core._Player = function(self)
	local bOk, tPlayer = pcall(function()
		local GDB = global.package.loaded["database.gamedatabase"] or global.require("Database.GameDatabase")
		local nKey = GDB.GetPlayerKey(api.player.GetGameOwner())
		if nKey == nil or nKey == 0 then
			return nil
		end
		return GDB.GetPlayer(nKey)
	end)
	if bOk and type(tPlayer) == "table" and type(tPlayer.GetData) == "function" and type(tPlayer.SetData) == "function" then
		return tPlayer
	end
	return nil
end

-- a JSON object as printable ASCII (the page escapes everything else)
local function validStoreText(s)
	return type(s) == "string" and string.sub(s, 1, 1) == "{" and not string.find(s, "[^\32-\126]")
end

-- Returns the kept text ("" when nothing is kept yet) and a status:
-- "ok" | "noplayer" | "unreadable".
Core.StoreRead = function(self)
	local tPlayer = self:_Player()
	if tPlayer == nil then
		self.sStoreLast = "read: no player profile"
		return "", "noplayer"
	end
	local bOk, t = pcall(tPlayer.GetData, tPlayer, self.sStoreRoot)
	if not bOk or t == nil then
		self.sStoreLast = "read: nothing kept yet"
		return "", "ok"
	end
	local n = type(t) == "table" and tonumber(t.N) or nil
	local tParts = {}
	if n ~= nil and n >= 1 and n <= 100 then
		for i = 1, n do
			local s = t["P" .. i]
			if type(s) ~= "string" then
				break
			end
			tParts[i] = s
		end
	end
	local sText = table.concat(tParts)
	if n == nil or #tParts ~= n or not validStoreText(sText) then
		self.sStoreLast = "read: unreadable entry"
		return "", "unreadable"
	end
	self.sStoreLast = "read " .. #sText .. " chars"
	return sText, "ok"
end

-- Replaces the kept text and asks the game to write the player save.
-- Returns "saved" | "kept" (in the player table; the game saves it when a
-- park closes) | "bad" | "toobig" | "noplayer" | "failed".
Core.StoreWrite = function(self, sText)
	local sResult
	if not validStoreText(sText) then
		sResult = "bad"
	elseif #sText > self.nStoreCap then
		sResult = "toobig"
	else
		local tPlayer = self:_Player()
		if tPlayer == nil then
			sResult = "noplayer"
		else
			local nParts = math.max(1, math.ceil(#sText / self.nStoreChunk))
			local tEntry = { V = "1", N = tostring(math.floor(nParts)) }
			for i = 1, nParts do
				tEntry["P" .. i] = string.sub(sText, (i - 1) * self.nStoreChunk + 1, i * self.nStoreChunk)
			end
			if not pcall(tPlayer.SetData, tPlayer, tEntry, self.sStoreRoot) then
				sResult = "failed"
			elseif pcall(function() api.save.RequestSaveMainPlayer() end) then
				sResult = "saved"
			else
				sResult = "kept"
			end
		end
	end
	self.sStoreLast = "write " .. (type(sText) == "string" and #sText or 0) .. " chars: " .. sResult
	if sResult ~= "saved" and sResult ~= "kept" then
		trace("settings store: " .. self.sStoreLast)
	end
	return sResult
end

Core.StoreStatus = function(self)
	return (self:_Player() ~= nil and "player profile ok" or "no player profile") .. ", last " .. self.sStoreLast
end

-----------------------------------------------------------------------
-- boot
-----------------------------------------------------------------------

Core.Boot = function(self)
	if self.bBooted then
		return
	end
	self.bBooted = true
	self:_InstallRequireHook()
	local bOk, sErr = pcall(function()
		self.oLogic = global.require("PZ2AutoHub.Logic")
		self.oLogic:Init(self)
	end)
	if not bOk then
		trace("logic failed to init: " .. tostring(sErr))
	end
	self:AddModulePatch("UI.Controllers.HUDUI", function(t) self:_PatchHUDUI(t) end)
	self:AddModulePatch("Game.GameScript", function(t) self:_PatchGameScript(t) end)
	self:AddModulePatch("Worlds.DarwinWorld", function(t) self:_PatchDarwinWorld(t) end)
	self:_LoadOverlay()
	trace("booted v" .. self.sVersion)
end
