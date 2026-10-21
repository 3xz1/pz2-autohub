-----------------------------------------------------------------------
--  Database.PZ2AutoHubLuaDatabase
--
--  Entry point. Database.Main calls tryrequire("Database.<Pack>LuaDatabase")
--  for every loaded content pack; this module boots PZ2AutoHub once.
-----------------------------------------------------------------------
local global  = _G
local api     = global.api
local pcall   = global.pcall
local require = global.require

local PZ2AutoHubLuaDatabase = module(...)

local bOk, sErr = pcall(function()
	require("PZ2AutoHub.Core"):Boot()
end)
if not bOk then
	pcall(function() api.debug.Trace("[PZ2AutoHub] boot failed: " .. global.tostring(sErr)) end)
end

-- Runs on the game's startup coroutine, so the UI overlay can be awaited here.
PZ2AutoHubLuaDatabase.AddContentToCall = function(_tContentToCall)
	local Core = global.package.loaded["pz2autohub.core"]
	if Core then
		local bOk, sErr = pcall(Core.WaitUntilReady, Core)
		if not bOk then
			pcall(function() api.debug.Trace("[PZ2AutoHub] WaitUntilReady failed: " .. global.tostring(sErr)) end)
		end
	end
end
