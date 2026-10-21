-----------------------------------------------------------------------
--  PZ2AutoHub.Logic
--
--  Inbreeding rules, as the game itself defines related animals
--  (CompareMatesPopup.CompareParentsForInbreeding: parent + child, or at
--  least one shared parent). Per habitat and per vivarium (exhibit):
--   * an ADULT living with its mother or father leaves;
--   * ADULT brother + sister (one shared parent is enough, opposite sex
--     only) both leave (optional, bSiblings).
--  Fish shoals (aquariums and vivarium tanks): with 2+ shoals of one species, all but
--  the youngest leave (a split shoal keeps the new one).
--  "Leaves" = the game's own "Send to Animal Storage" action (a keeper
--  carries it to the Trade Centre).
--  Contraception (bContra, independent of the auto mode): any animal, from
--  birth, living with a parent of the other sex (or, with bSiblings, a
--  sibling of the other sex) is put on contraception, as the info panel's
--  toggle does. Animals AutoHub put on contraception are remembered by GUID
--  (tContra, saved per park by the UI); once such an animal lives without
--  those relatives, AutoHub takes it off again. If the player switches it
--  off by hand, AutoHub leaves it off.
--
--   * SendFromHabitat: button in the habitat / vivarium panel, checks it now.
--   * Tick (driven by the UI every 3 s) in auto mode:
--       "new":    only animals seen growing from juvenile to adult while
--                 the mode is on (and the relatives they pair with);
--       "always": every habitat and vivarium, every 5th tick (~15 s).
--
--  Game API shapes were read from the game's compiled Lua, not from docs,
--  so every call goes through call() (pcall, method or plain) and results
--  are normalised defensively. Diagnose shows what the game really returns.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local pairs    = global.pairs
local ipairs   = global.ipairs
local next     = global.next
local type     = global.type
local tostring = global.tostring
local tonumber = global.tonumber
local math     = global.math
local string   = global.string
local table    = global.table

local Logic = module(...)

Logic.sMode = "off"            -- "off" | "new" | "always"
Logic.bSiblings = true
-- which kinds of groups auto mode and "Check all" look at (switches in the UI)
Logic.tKinds = { habitat = true, aquarium = true, exhibit = true }
-- The UI ticks once per (real) second; times below are in ticks = seconds.
Logic.nTick = 0
Logic.nEvery = 5               -- auto checks every nEvery seconds (set in the UI)
Logic.nMinEvery = 1
Logic.nMaxEvery = 600
Logic.nRetryTicks = 300        -- a grown-up animal that can't be sent is retried for ~5 minutes
Logic.nSentHold = 300          -- at most ~5 minutes: a sent animal still in its habitat is retried after that
Logic.nFailHold = 60           -- retry a refused animal after ~1 minute
Logic.tWasJuvenile = {}        -- animal id -> true while seen as juvenile
Logic.tPending = {}            -- animal id -> tick at which retrying stops
Logic.tHold = {}               -- animal id -> { nUntil = tick, nHabitat = habitat it was in }
Logic.tCallMode = {}           -- api function name -> "method" | "plain"
Logic.bContra = false          -- auto contraception switch (UI)
Logic.tContra = {}             -- GUID key -> "on" (AutoHub switched it on) | "player" (then switched off by hand)

local Core = nil

Logic.Init = function(self, oCore)
	Core = oCore
end

-- False from the moment the park world deactivates or a quit is requested
-- (back to the main menu) until a park world activates again. While the
-- world is torn down the HUD still ticks, and exhibit calls then crash the
-- engine (crash dump 2026-10-18 13:06), so call() makes no game calls.
Logic.bParkLive = true

Logic.SetParkLive = function(self, bLive)
	self.bParkLive = bLive == true
	if not self.bParkLive then
		self:Reset()
	end
end

Logic.Reset = function(self)
	self.tWasJuvenile = {}
	self.tPending = {}
	self.tHold = {}
	self.nLastCheck = nil
end

local function toUI(sEvent, ...)
	if Core then
		Core:SendToUI(sEvent, ...)
	end
end

local function log(sMsg)
	toUI("PZ2AutoHub_Log", sMsg)
end

-----------------------------------------------------------------------
-- game API access
-----------------------------------------------------------------------

local function worldAPIs()
	local bOk, t = pcall(function() return api.world.GetWorldAPIs() end)
	return bOk and t or nil
end

local function animalsAPI()
	local t = worldAPIs()
	return t and t.animals or nil
end

-- ENGINE CRASH GUARD (crash dumps 2026-10-17/18): exhibit calls on an ID
-- that is not (or no longer) a live exhibit / exhibit animal crash the
-- engine; pcall cannot catch that. The game's own code (helpers.
-- notificationtasks) asks exhibits:EntityIsExhibit(id) before
-- GetAnimalsInExhibit and EntityIsExhibitAnimal(id) before per-animal
-- calls; call() does the same for every function listed here.
local tExhibitGuard = {
	GetAnimalsInExhibit = "EntityIsExhibit",
	ExhibitAnimalEntityIDToUID = "EntityIsExhibitAnimal",
	GetExhibitAnimalData = "EntityIsExhibitAnimal",
	GetExhibitAnimalName = "EntityIsExhibitAnimal",
	GetExhibitAnimalAgeQuadrant = "EntityIsExhibitAnimal",
	SetExhibitAnimalUsingContraceptive = "EntityIsExhibitAnimal",
}

-- true only when the exhibits API confirms the ID (sCheck is
-- EntityIsExhibit or EntityIsExhibitAnimal). Unknown = not safe.
local function exhibitConfirms(sCheck, v)
	if type(v) ~= "number" or not Logic.bParkLive then
		return false
	end
	local bOk, bYes = pcall(function()
		local X = api.world.GetWorldAPIs().exhibits
		return X[sCheck](X, v)
	end)
	return bOk and bYes == true
end

-- Calls t[sName] as a method (t:Name(...)) or a plain function, remembering
-- which works. Returns true, packed results | false, error.
local function call(t, sName, ...)
	if t == nil then
		return false, "API missing"
	end
	if not Logic.bParkLive then
		return false, sName .. " skipped: the park is closing"
	end
	local sCheck = tExhibitGuard[sName]
	if sCheck ~= nil and not exhibitConfirms(sCheck, (...)) then
		return false, sName .. " skipped: not a live exhibit entity"
	end
	local bGot, fn = pcall(function() return t[sName] end)
	if not bGot or fn == nil then
		return false, sName .. " missing"
	end
	local tArgs = table.pack(...)
	local sMode = Logic.tCallMode[sName]
	local function try(bMethod)
		if bMethod then
			return table.pack(pcall(fn, t, table.unpack(tArgs, 1, tArgs.n)))
		end
		return table.pack(pcall(fn, table.unpack(tArgs, 1, tArgs.n)))
	end
	local tRes
	if sMode ~= "plain" then
		tRes = try(true)
		if tRes[1] then
			Logic.tCallMode[sName] = "method"
		end
	end
	if (tRes == nil or not tRes[1]) and sMode ~= "method" then
		local tPlain = try(false)
		if tPlain[1] then
			Logic.tCallMode[sName] = "plain"
		end
		if tPlain[1] or tRes == nil then
			tRes = tPlain
		end
	end
	if not tRes[1] then
		return false, tostring(tRes[2])
	end
	return true, table.pack(table.unpack(tRes, 2, tRes.n))
end

local function nullEntity()
	local bOk, v = pcall(function() return api.entity.NullEntityID end)
	return bOk and v or nil
end

local function validEntity(v)
	return v ~= nil and v ~= false and v ~= 0 and v ~= -1 and v ~= nullEntity()
end

-- Accepts a list {id, ...}, a set {[id] = true}, a list of records
-- {{nEntityID = id}, ...} or a single number.
local function idList(v)
	local tOut = {}
	if type(v) == "number" then
		tOut[1] = v
	elseif type(v) == "table" then
		for k, x in pairs(v) do
			if type(x) == "number" then
				tOut[#tOut + 1] = x
			elseif type(x) == "table" then
				local n = x.nEntityID or x.entityID or x.nAnimalID or x.nID or x.id
				if type(n) == "number" then
					tOut[#tOut + 1] = n
				elseif type(k) == "number" then
					tOut[#tOut + 1] = k
				end
			elseif type(k) == "number" and x == true then
				tOut[#tOut + 1] = k
			end
		end
	end
	return tOut
end

-- Every number or string inside v (two table levels), for parent lookups.
local function collectIDs(tOut, v, nDepth)
	if type(v) == "number" or (type(v) == "string" and v ~= "") then
		tOut[#tOut + 1] = v
	elseif type(v) == "table" and nDepth < 3 then
		for _, x in pairs(v) do
			collectIDs(tOut, x, nDepth + 1)
		end
	end
end

local function dump(v, nDepth)
	nDepth = nDepth or 0
	if type(v) ~= "table" then
		return type(v) .. ":" .. tostring(v)
	end
	if nDepth >= 2 then
		return "{...}"
	end
	local tParts = {}
	local n = 0
	for k, x in pairs(v) do
		n = n + 1
		if n > 8 then
			tParts[#tParts + 1] = "..."
			break
		end
		tParts[#tParts + 1] = tostring(k) .. "=" .. dump(x, nDepth + 1)
	end
	return "{" .. table.concat(tParts, ", ") .. "}"
end

-- The world APIs that may own a function, in the order they are tried.
local tAPINames = { "animals", "habitat", "exhibits", "facilities", "park", "animalsDataHelpers" }

-- Calls sName on the first world API that has it.
-- Returns true, packed results, api name | false, error.
local function callAny(sName, ...)
	local tWorld = worldAPIs() or {}
	local sLastErr = sName .. " missing"
	for _, sAPI in ipairs(tAPINames) do
		local t = tWorld[sAPI]
		if t ~= nil then
			local bGot, fn = pcall(function() return t[sName] end)
			if bGot and fn ~= nil then
				local bOk, r = call(t, sName, ...)
				if bOk then
					return true, r, sAPI
				end
				sLastErr = r
			end
		end
	end
	return false, sLastErr
end

-----------------------------------------------------------------------
-- animal facts
-----------------------------------------------------------------------

Logic._Habitat = function(self, nID)
	local bOk, r = call(animalsAPI(), "GetAssignedHabitatEntityID", nID)
	if bOk and validEntity(r[1]) then
		return r[1]
	end
	return nil
end

-- The values GetAgeStatus returns for juveniles/adults/elderly, found by
-- name on the animals API or its data helpers. Strings are matched by name.
Logic._ResolveAgeEnums = function(self)
	if self.tAgeEnum then
		return self.tAgeEnum
	end
	local tEnum = {}
	local tWorld = worldAPIs() or {}
	local tSources = { tWorld.animals, tWorld.animalsDataHelpers }
	local tNames = {
		juvenile = { "Juvenile", "AgeStatus_Juvenile", "AGE_JUVENILE" },
		adult = { "Adult", "AgeStatus_Adult", "AGE_ADULT" },
		elderly = { "Elderly", "AgeStatus_Elderly", "AGE_ELDERLY" },
	}
	for _, tSource in ipairs(tSources) do
		for sStage, tKeys in pairs(tNames) do
			for _, sKey in ipairs(tKeys) do
				local bOk, v = pcall(function() return tSource[sKey] end)
				if bOk and v ~= nil and type(v) ~= "function" and tEnum[v] == nil then
					tEnum[v] = sStage
				end
			end
			local bOk, tSub = pcall(function() return tSource.AgeStatus end)
			if bOk and type(tSub) == "table" then
				for _, sKey in ipairs(tKeys) do
					local v = tSub[sKey]
					if v ~= nil and tEnum[v] == nil then
						tEnum[v] = sStage
					end
				end
			end
		end
	end
	self.tAgeEnum = tEnum
	return tEnum
end

-- "juvenile" | "adult" | "elderly" | nil (unknown)
Logic._Stage = function(self, nID)
	local A = animalsAPI()
	local bOk, r = call(A, "GetAgeStatus", nID)
	if bOk then
		local v = r[1]
		if type(v) == "string" then
			local s = string.lower(v)
			if string.find(s, "juvenile") or string.find(s, "infant") then
				return "juvenile"
			elseif string.find(s, "elder") then
				return "elderly"
			elseif string.find(s, "adult") then
				return "adult"
			end
		end
		local sStage = self:_ResolveAgeEnums()[v]
		if sStage then
			return sStage
		end
	end
	-- last resort: a juvenile flag
	for _, sName in ipairs({ "IsJuvenile", "GetIsJuvenile" }) do
		local bOk2, r2 = call(A, sName, nID)
		if bOk2 and type(r2[1]) == "boolean" then
			return r2[1] and "juvenile" or nil
		end
	end
	return nil
end

-- Raw parent values for an animal: the game's mate comparison calls
-- GetParents with the animal's GUID (EntityIDToAnimalGUID), so that is
-- tried when the entity ID gives nothing. Returns list, sHow | nil, error.
Logic._ParentsRaw = function(self, nID)
	local A = animalsAPI()
	local tRaw = {}
	local bOk, r = call(A, "GetParents", nID)
	if bOk then
		for i = 1, r.n do
			collectIDs(tRaw, r[i], 0)
		end
		if #tRaw > 0 then
			return tRaw, "by id"
		end
	end
	local bGUID, rGUID = call(A, "EntityIDToAnimalGUID", nID)
	if not (bGUID and validEntity(rGUID[1])) then
		-- exhibit (vivarium) animals: their UID is the GUID
		bGUID, rGUID = callAny("ExhibitAnimalEntityIDToUID", nID)
	end
	if bGUID and rGUID[1] ~= nil then
		local bOk2, r2 = call(A, "GetParents", rGUID[1])
		if bOk2 then
			for i = 1, r2.n do
				collectIDs(tRaw, r2[i], 0)
			end
			return tRaw, "by guid " .. tostring(rGUID[1])
		end
		if not bOk then
			return nil, r2
		end
	end
	if not bOk then
		return nil, r
	end
	return tRaw, "by id"
end

-- Entity IDs of the animal's known parents (dead or gone ones included;
-- the habitat check filters those out).
Logic._Parents = function(self, nID)
	local A = animalsAPI()
	local tRaw, sErr = self:_ParentsRaw(nID)
	if tRaw == nil then
		return nil, sErr
	end
	local tOut, tSeen = {}, {}
	for _, v in ipairs(tRaw) do
		-- GetParents returns GUIDs. A GUID whose animal is gone (dead, left
		-- the zoo) has no entity: it must NOT be reused as an entity ID, or a
		-- number that happens to match a sibling's entity ID makes that
		-- sibling look like a parent. Only without a converter at all are the
		-- values taken as entity IDs.
		local nEntity = nil
		local bConv, rConv = call(A, "AnimalGUIDToEntityID", v)
		if bConv then
			if validEntity(rConv[1]) then
				nEntity = rConv[1]
			end
		elseif string.find(tostring(rConv), "missing", 1, true) then
			local n = tonumber(v)
			if validEntity(n) then
				nEntity = n
			end
		end
		if nEntity ~= nil and nEntity ~= nID and not tSeen[nEntity] then
			tSeen[nEntity] = true
			tOut[#tOut + 1] = nEntity
		end
	end
	return tOut
end

-- Exhibit (vivarium) animals have two entities: the one the exhibit lists
-- (GetAnimalsInExhibit, GetExhibitAnimalData...) and the animal itself
-- ("animal brain"), which the animals API (names, sending) works on. The
-- game's exhibit panel converts with AnimalGUIDToEntityID(UID) before it
-- calls AttemptToSendToTradeCentre. Returns the animal entity or nil.
Logic._BrainID = function(self, nID)
	local bUID, rUID = callAny("ExhibitAnimalEntityIDToUID", nID)
	local vUID = bUID and rUID[1] or nil
	if vUID == nil or vUID == 0 or vUID == "" or vUID == "0" then
		return nil
	end
	local bE, rE = call(animalsAPI(), "AnimalGUIDToEntityID", vUID)
	if bE and validEntity(rE[1]) then
		return rE[1]
	end
	return nil
end

local function usableName(v)
	return type(v) == "string" and v ~= "" and not string.find(v, "HAS NO NAME", 1, true)
		and string.sub(v, 1, 5) ~= "ERROR"
end

Logic._Name = function(self, nID)
	local tWorld = worldAPIs() or {}
	for _, t in ipairs({ tWorld.animals, tWorld.animalsDataHelpers }) do
		local bOk, r = call(t, "GetName", nID)
		if bOk and usableName(r[1]) then
			return r[1]
		end
	end
	local bEx, rEx = callAny("GetExhibitAnimalName", nID)
	if bEx and usableName(rEx[1]) then
		return rEx[1]
	end
	local nBrain = self:_BrainID(nID)
	if nBrain ~= nil and nBrain ~= nID then
		local bOk, r = call(tWorld.animals, "GetName", nBrain)
		if bOk and usableName(r[1]) then
			return r[1]
		end
	end
	return "animal #" .. tostring(nID)
end

-- Trade Centre storage for habitat or exhibit animals, as the game's info
-- panels check it before enabling their send button:
-- facilities:ZooHasExhibitTradeCentre(), park:GetExhibitTradeCentreMaxCapacity(),
-- GetNumberOfAnimalsInExhibitTradeCentre() (habitat: ZooHasTradeCentre,
-- GetTradeCentreMaxCapacity, GetNumberOfAnimalsInTradeCentre).
-- Returns bHas (nil = unknown), nUsed, nMax.
Logic._Storage = function(self, bExhibit)
	local sHas = bExhibit and "ZooHasExhibitTradeCentre" or "ZooHasTradeCentre"
	local sMax = bExhibit and "GetExhibitTradeCentreMaxCapacity" or "GetTradeCentreMaxCapacity"
	local sUsed = bExhibit and "GetNumberOfAnimalsInExhibitTradeCentre" or "GetNumberOfAnimalsInTradeCentre"
	local bHasOk, rHas = callAny(sHas)
	local bMaxOk, rMax = callAny(sMax)
	local bUsedOk, rUsed = callAny(sUsed)
	local bHas = nil
	if bHasOk and type(rHas[1]) == "boolean" then
		bHas = rHas[1]
	end
	local nMax = (bMaxOk and type(rMax[1]) == "number") and rMax[1] or nil
	local nUsed = (bUsedOk and type(rUsed[1]) == "number") and rUsed[1] or nil
	return bHas, nUsed, nMax
end

local function storageText(bExhibit, nUsed, nMax)
	return (bExhibit and "vivarium" or "habitat") .. " storage " .. tostring(nUsed or "?") .. "/" .. tostring(nMax or "?")
end

-- Exhibit (vivarium) animals, as the game's exhibit animal panel sends them:
-- exhibitsAPI:AttemptToSendToTradeCentre(UID) (the EXHIBITS API, with the
-- animal's UID; the animals API version refuses them), then, if the animal
-- also exists as a habitat animal, animalsAPI:RemoveAnimal(that entity).
Logic._SendExhibit = function(self, nID, nUsed, nMax)
	local A = animalsAPI()
	local E = (worldAPIs() or {}).exhibits
	local bUID, rUID = call(E, "ExhibitAnimalEntityIDToUID", nID)
	local vUID = bUID and rUID[1] or nil
	if vUID == nil or vUID == 0 or vUID == "" or vUID == "0" then
		return false, "no animal UID (" .. tostring(bUID and "empty" or rUID) .. ")"
	end
	local nBrain = nil
	local bE, rE = call(A, "AnimalGUIDToEntityID", vUID)
	if bE and validEntity(rE[1]) then
		nBrain = rE[1]
	end
	local bOk, r = call(E, "AttemptToSendToTradeCentre", vUID)
	if not bOk then
		return false, r
	end
	if not r[1] then
		return false, "the game refused (" .. storageText(true, nUsed, nMax) .. ")"
	end
	if nBrain ~= nil then
		call(A, "RemoveAnimal", nBrain)
	end
	return true
end

-- true | false, reason. The Trade Centre storage (separate for exhibit
-- animals) is checked first, so a full storage is reported as such.
Logic._Send = function(self, nID, bExhibit)
	local A = animalsAPI()
	local bHas, nUsed, nMax = self:_Storage(bExhibit)
	if bHas == false then
		return false, bExhibit and "no Trade Centre takes vivarium animals" or "no Trade Centre"
	end
	if nUsed ~= nil and nMax ~= nil and nUsed >= nMax then
		return false, "Trade Centre full (" .. storageText(bExhibit, nUsed, nMax) .. ")"
	end
	if bExhibit then
		return self:_SendExhibit(nID, nUsed, nMax)
	end
	local bCan, rCan = call(A, "CanSendAnimalToTradeCentre", nID)
	if bCan and rCan[1] == false then
		return false, "the game does not allow it right now"
	end
	local bOk, r = call(A, "AttemptToSendToTradeCentre", nID)
	if not bOk then
		return false, r
	end
	if r[1] == false then
		return false, "the game refused (" .. storageText(bExhibit, nUsed, nMax) .. ")"
	end
	return true
end

-- Habitat animals of the whole zoo: animalAPI:GetAnimalsInPark(listType),
-- as the game's own objectives call it.
Logic._ParkAnimals = function(self)
	local A = animalsAPI()
	local tTypes = {}
	for _, sKey in ipairs({ "AnimalsListType_Habitat", "AnimalsListType_All" }) do
		local bOk, v = pcall(function() return A[sKey] end)
		if bOk and v ~= nil then
			tTypes[#tTypes + 1] = v
		end
	end
	for _, v in ipairs(tTypes) do
		local bOk, r = call(A, "GetAnimalsInPark", v)
		if bOk then
			local tIDs = idList(r[1])
			if #tIDs > 0 then
				return tIDs
			end
		end
	end
	return {}
end

-- Entity IDs of all habitats: facilitiesAPI:GetAllHabitatsEntityIDs() (as
-- the game's debug tools list them), plus the habitats of the zoo's animals.
Logic._AllHabitats = function(self)
	local tOut, tSeen = {}, {}
	local function add(n)
		if validEntity(n) and not tSeen[n] then
			tSeen[n] = true
			tOut[#tOut + 1] = n
		end
	end
	local bOk, r = callAny("GetAllHabitatsEntityIDs")
	if bOk then
		for _, n in ipairs(idList(r[1])) do
			add(n)
		end
	end
	for _, nID in ipairs(self:_ParkAnimals()) do
		add(self:_Habitat(nID))
	end
	return tOut
end

-- habitatAPI:GetAnimalsInHabitat(entityID); falls back to filtering the
-- zoo's animals by their assigned habitat.
Logic._HabitatAnimals = function(self, nHabitat)
	local bOk, r = callAny("GetAnimalsInHabitat", nHabitat)
	if bOk then
		local tIDs = idList(r[1])
		if #tIDs > 0 then
			return tIDs
		end
	end
	local tOut = {}
	for _, nID in ipairs(self:_ParkAnimals()) do
		if self:_Habitat(nID) == nHabitat then
			tOut[#tOut + 1] = nID
		end
	end
	return tOut
end

-- "12,animal_34" -> {12, 34}
local function parseIDs(sIDs)
	local tOut = {}
	for sPart in string.gmatch(tostring(sIDs or ""), "[^,;%s]+") do
		local n = tonumber(sPart) or tonumber(string.match(sPart, "(%d+)$") or "")
		if n then
			tOut[#tOut + 1] = n
		end
	end
	return tOut
end


-----------------------------------------------------------------------
-- relatedness
-----------------------------------------------------------------------

-- Values GetGender returns, found by name on the animals API: the game's
-- own Gender_Male / Gender_Female (used by its info panel); Male / Female
-- only if those don't exist. A pair that is missing or equal is unusable.
Logic._ResolveGenderEnums = function(self)
	if self.tGenderEnum then
		return self.tGenderEnum
	end
	local tEnum = {}
	local A = animalsAPI()
	local function get(sKey)
		local bOk, v = pcall(function() return A[sKey] end)
		if bOk and v ~= nil and type(v) ~= "function" then
			return v
		end
		return nil
	end
	for _, tPair in ipairs({ { "Gender_Male", "Gender_Female" }, { "Male", "Female" } }) do
		local vMale, vFemale = get(tPair[1]), get(tPair[2])
		if vMale ~= nil and vFemale ~= nil and vMale ~= vFemale then
			tEnum[vMale] = "male"
			tEnum[vFemale] = "female"
			break
		end
	end
	self.tGenderEnum = tEnum
	return tEnum
end

-- "male" | "female" | nil (unknown or unisex)
Logic._Gender = function(self, nID)
	local bOk, r = call(animalsAPI(), "GetGender", nID)
	if not bOk then
		return nil
	end
	local v = r[1]
	if type(v) == "string" then
		local s = string.lower(v)
		if string.find(s, "female") then
			return "female"
		elseif string.find(s, "male") then
			return "male"
		end
		return nil
	end
	local tEnum = self:_ResolveGenderEnums()
	if tEnum[v] then
		return tEnum[v]
	end
	if next(tEnum) == nil then
		-- no named constants: the UI's order (0 male, 1 female, 2 unisex)
		if v == 0 then
			return "male"
		elseif v == 1 then
			return "female"
		end
	end
	return nil
end

-- A parent identifier is usable unless it is empty/zero ("unknown parent"),
-- otherwise all animals with unknown parents would look like siblings.
local function usableKey(v)
	if type(v) == "number" then
		return validEntity(v)
	end
	return type(v) == "string" and v ~= "" and v ~= "0"
end

-- an ID as a text key: whole numbers without ".0" (a float and an integer
-- of the same animal must give the same key)
local function keyOf(v)
	if math.type and math.type(v) == "float" and v == math.floor(v) and math.abs(v) < 2 ^ 53 then
		return string.format("%d", math.floor(v))
	end
	return tostring(v)
end

-- Parents of a vivarium (exhibit) animal, as the game's vivarium animal
-- panel reads them (ExhibitAnimalInfoPopUp): animals:GetParents gives
-- nothing for these animals in-game. The panel calls
--   uid = exhibits:ExhibitAnimalEntityIDToUID(id)
--   tree = franchise:GetAnimalFamilyTreeData(uid)
--   (no tree yet) franchise:RequestFamilyTreeData(uid), then asks again later
-- tree.mother / tree.father = { id = UID (0 = unknown), name, gender }.
-- Returns list of parent UIDs, status text ("ok" | "loading" | error).
Logic.nTreeRetry = 20 -- seconds before asking the game again for a tree
Logic._TreeAsked = {}
Logic._ExhibitTreeParents = function(self, vUID)
	local F = (worldAPIs() or {}).franchise
	if F == nil then
		return {}, "no franchise API"
	end
	local function read()
		local bOk, r = call(F, "GetAnimalFamilyTreeData", vUID)
		if not bOk then
			return nil, r
		end
		return type(r[1]) == "table" and r[1] or nil
	end
	local tTree, sErr = read()
	if tTree == nil and sErr == nil then
		local sKey = keyOf(vUID)
		local nNow = 0
		pcall(function() nNow = api.time.GetTotalTimeUnscaled() end)
		local nAsked = self._TreeAsked[sKey]
		if nAsked == nil or nNow - nAsked >= self.nTreeRetry or nNow < nAsked then
			self._TreeAsked[sKey] = nNow
			call(F, "RequestFamilyTreeData", vUID)
			-- the answer may already be there
			tTree, sErr = read()
		end
	end
	if tTree == nil then
		return {}, sErr and ("tree: " .. tostring(sErr)) or "loading"
	end
	local tOut = {}
	for _, sWho in ipairs({ "mother", "father" }) do
		local t = tTree[sWho]
		local v = type(t) == "table" and t.id or nil
		if usableKey(v) then
			tOut[#tOut + 1] = v
		end
	end
	return tOut, "ok"
end


-----------------------------------------------------------------------
-- exhibits (vivariums) and groups
--
-- A "group" is where animals live together: { sKind = "habitat" | "exhibit",
-- nID = entity ID }. Aquariums are habitats, vivariums are exhibits; fish
-- shoals (species is a boid) can live in both.
-----------------------------------------------------------------------

-- Entity IDs of all exhibits: exhibitsAPI:GetAllExhibits().
Logic._AllExhibits = function(self)
	local bOk, r = callAny("GetAllExhibits")
	local tOut = {}
	if bOk then
		for _, n in ipairs(idList(r[1])) do
			if validEntity(n) and exhibitConfirms("EntityIsExhibit", n) then
				tOut[#tOut + 1] = n
			end
		end
	end
	return tOut
end

-- Entity IDs of the animals in one exhibit. As in the game's own code,
-- GetAnimalsInExhibit hands out records { nEntityID = id }; only IDs that
-- EntityIsExhibitAnimal confirms are kept (call() guards the exhibit too).
Logic._ExhibitAnimals = function(self, nExhibit)
	local bOk, r = call((worldAPIs() or {}).exhibits, "GetAnimalsInExhibit", nExhibit)
	local tOut, tSeen = {}, {}
	if not bOk then
		return tOut
	end
	for _, n in ipairs(idList(r[1])) do
		if validEntity(n) and not tSeen[n] and exhibitConfirms("EntityIsExhibitAnimal", n) then
			tSeen[n] = true
			tOut[#tOut + 1] = n
		end
	end
	return tOut
end

-- CRASH WARNING: exhibit calls (GetExhibitAnimalData etc.) on an entity
-- that no longer exists (a vivarium animal just sent to storage) crash the
-- game engine; pcall cannot catch that. Only call per-animal exhibit APIs
-- on IDs taken from a fresh GetAnimalsInExhibit list in the same step.
-- "Is it still there / where does it live" is answered from the member
-- lists of all groups (Logic._RefreshMembers), never by asking the game
-- about an old ID.

local function groupName(tGroup)
	return tGroup.sKind .. " " .. tostring(tGroup.nID)
end

-- "habitat" | "aquarium" | "exhibit" (vivarium): what the UI switches name
local function kindOf(tGroup)
	if tGroup.sKind == "exhibit" then
		return "exhibit"
	elseif tGroup.bAquarium then
		return "aquarium"
	end
	return "habitat"
end

-- habitatAPI:IsAquarium(habitatID), as the game's animal info panel asks it.
Logic._IsAquarium = function(self, nHabitat)
	local bOk, r = call((worldAPIs() or {}).habitat, "IsAquarium", nHabitat)
	if not bOk then
		bOk, r = callAny("IsAquarium", nHabitat)
	end
	return bOk and r[1] == true
end

Logic._IsEnabled = function(self, tGroup)
	return self.tKinds[kindOf(tGroup)] ~= false
end

-- The groups whose switch is on. Member lists still cover every group, so
-- holds and pending animals are not mistaken for gone ones.
Logic._EnabledGroups = function(self, tGroups)
	local tOut = {}
	for _, tGroup in ipairs(tGroups) do
		if self:_IsEnabled(tGroup) then
			tOut[#tOut + 1] = tGroup
		end
	end
	return tOut
end

-- All groups of the zoo: every habitat and every exhibit.
Logic._AllGroups = function(self)
	local tOut = {}
	for _, n in ipairs(self:_AllHabitats()) do
		tOut[#tOut + 1] = { sKind = "habitat", nID = n, bAquarium = self:_IsAquarium(n) }
	end
	for _, n in ipairs(self:_AllExhibits()) do
		tOut[#tOut + 1] = { sKind = "exhibit", nID = n }
	end
	return tOut
end

Logic._GroupAnimals = function(self, tGroup)
	if tGroup.sKind == "exhibit" then
		return self:_ExhibitAnimals(tGroup.nID)
	end
	return self:_HabitatAnimals(tGroup.nID) or {}
end

-- Exhibit animals' age group (GetExhibitAnimalAgeQuadrant, the game's
-- maturity: 0 infant, 1 young adult, 2 adult, 3 elderly, 4 young adult
-- infertile); other animals use GetAgeStatus.
Logic._StageOf = function(self, nID, bExhibit)
	if bExhibit then
		local bOk, r = callAny("GetExhibitAnimalAgeQuadrant", nID)
		if bOk and type(r[1]) == "number" then
			local v = r[1]
			if v == 0 then
				return "juvenile"
			elseif v == 3 then
				return "elderly"
			elseif v == 1 or v == 2 or v == 4 then
				return "adult"
			end
		end
	end
	return self:_Stage(nID)
end

-- Exhibit animals may only answer the UID-based gender call.
Logic._GenderOf = function(self, nID, bExhibit)
	local sGender = self:_Gender(nID)
	if sGender == nil and bExhibit then
		local bUID, rUID = callAny("ExhibitAnimalEntityIDToUID", nID)
		if bUID and rUID[1] ~= nil then
			local bOk, r = callAny("GetAnimalUIDGender", rUID[1])
			if bOk then
				local tEnum = self:_ResolveGenderEnums()
				sGender = tEnum[r[1]]
			end
		end
	end
	return sGender
end

-- Fish shoals are boids: IsSpeciesABoid(species). Shoals live in aquarium
-- habitats and in vivarium tanks; for exhibit animals the species and age
-- come from GetExhibitAnimalData (Species, AgeInYears), as the game's
-- exhibit info panel reads them. Returns bShoal, sSpecies, nAge.
Logic._ShoalInfo = function(self, nID, bExhibit)
	local A = animalsAPI()
	local sSpecies, nAge
	if bExhibit then
		local bData, rData = callAny("GetExhibitAnimalData", nID)
		if bData and type(rData[1]) == "table" then
			sSpecies = rData[1].Species
			nAge = rData[1].AgeInYears
		end
	end
	if sSpecies == nil then
		local bSp, rSp = call(A, "GetSpecies", nID)
		sSpecies = bSp and rSp[1] or nil
	end
	if sSpecies == nil then
		return false, nil, nil
	end
	local bOk, r = callAny("IsSpeciesABoid", sSpecies)
	if not (bOk and r[1] == true) then
		return false, sSpecies, nil
	end
	if type(nAge) ~= "number" then
		local bAge, rAge = call(A, "GetAge", nID)
		nAge = (bAge and type(rAge[1]) == "number") and rAge[1] or nil
	end
	return true, sSpecies, nAge
end

-----------------------------------------------------------------------
-- rules
-----------------------------------------------------------------------

-- What the rules need about one animal. Parents are kept as keys (GUIDs as
-- text, and "e<entity>" for parents that still exist), so siblings are
-- found even when the shared parent has died or left the zoo.
Logic._Facts = function(self, nID, bExhibit)
	local A = animalsAPI()
	local t = { nID = nID, sStage = self:_StageOf(nID, bExhibit), sGender = self:_GenderOf(nID, bExhibit), tParentKeys = {} }
	t.bShoal, t.sSpecies, t.nAge = self:_ShoalInfo(nID, bExhibit)
	if t.bShoal then
		return t
	end
	local bG, rG = call(A, "EntityIDToAnimalGUID", nID)
	if not (bG and usableKey(rG[1])) then
		bG, rG = callAny("ExhibitAnimalEntityIDToUID", nID)
	end
	if bG and usableKey(rG[1]) then
		t.sKey = keyOf(rG[1])
	end
	local tRaw = self:_ParentsRaw(nID)
	-- whether "no parent here" can be trusted (contraception is only taken
	-- off when it can)
	t.bParentsKnown = tRaw ~= nil and not bExhibit
	for _, v in ipairs(tRaw or {}) do
		if usableKey(v) and keyOf(v) ~= t.sKey then
			t.tParentKeys[keyOf(v)] = true
		end
	end
	-- vivarium animals: parents from the family tree (keys are UIDs, the
	-- same kind as sKey above)
	if bExhibit and t.sKey ~= nil then
		local tTreeParents, sTree = self:_ExhibitTreeParents(rG[1])
		t.sTree = sTree
		t.bParentsKnown = sTree == "ok"
		if sTree == "loading" then
			self.nTreesLoading = (self.nTreesLoading or 0) + 1
		end
		for _, v in ipairs(tTreeParents) do
			if keyOf(v) ~= t.sKey then
				t.tParentKeys[keyOf(v)] = true
			end
		end
	end
	for _, nParent in ipairs(self:_Parents(nID) or {}) do
		t.tParentKeys["e" .. tostring(nParent)] = true
		local bP, rP = call(A, "EntityIDToAnimalGUID", nParent)
		if bP and usableKey(rP[1]) then
			t.tParentKeys[keyOf(rP[1])] = true
		end
	end
	return t
end

local function isParentOf(tParent, tChild)
	if tParent.sKey ~= nil and tChild.tParentKeys[tParent.sKey] then
		return true
	end
	return tChild.tParentKeys["e" .. tostring(tParent.nID)] == true
end

local function shareParent(a, b)
	for k in pairs(a.tParentKeys) do
		if b.tParentKeys[k] then
			return true
		end
	end
	return false
end

-- Who in one group must leave. Returns a list of
-- { nID, sWhy ("parent" | "sibling" | "shoal"), nWith } and the facts.
--  * adult living with its mother or father: the child leaves;
--  * adult brother + sister (shared parent, opposite sex): both leave;
--  * 2+ fish shoals of one species: all but the youngest leave (a shoal
--    that split in two keeps the new one). Shoals skip the other rules.
Logic._EvaluateGroup = function(self, tGroup)
	local bExhibit = tGroup.sKind == "exhibit"
	local tAll, tAnimals, tShoals = {}, {}, {}
	for _, nID in ipairs(self:_GroupAnimals(tGroup)) do
		local f = self:_Facts(nID, bExhibit)
		tAll[#tAll + 1] = f
		if f.bShoal then
			tShoals[#tShoals + 1] = f
		else
			tAnimals[#tAnimals + 1] = f
		end
	end
	local tOut, tSeen = {}, {}
	local function add(f, sWhy, oWith)
		if not tSeen[f.nID] then
			tSeen[f.nID] = true
			tOut[#tOut + 1] = { nID = f.nID, sWhy = sWhy, nWith = oWith.nID, bExhibit = bExhibit, tGroup = tGroup }
		end
	end
	for _, c in ipairs(tAnimals) do
		if c.sStage == "adult" then
			for _, p in ipairs(tAnimals) do
				if p.nID ~= c.nID and isParentOf(p, c) then
					add(c, "parent", p)
					break
				end
			end
		end
	end
	if self.bSiblings then
		for i, a in ipairs(tAnimals) do
			for j = i + 1, #tAnimals do
				local b = tAnimals[j]
				if a.sStage == "adult" and b.sStage == "adult" and a.sGender and b.sGender and a.sGender ~= b.sGender
					and not isParentOf(a, b) and not isParentOf(b, a) and shareParent(a, b) then
					add(a, "sibling", b)
					add(b, "sibling", a)
				end
			end
		end
	end
	local tBySpecies = {}
	for _, f in ipairs(tShoals) do
		local sKey = tostring(f.sSpecies)
		tBySpecies[sKey] = tBySpecies[sKey] or {}
		table.insert(tBySpecies[sKey], f)
	end
	for _, tList in pairs(tBySpecies) do
		if #tList >= 2 then
			-- youngest first; same age: the newer entity (higher ID) counts as younger
			table.sort(tList, function(a, b)
				local nA, nB = a.nAge or math.huge, b.nAge or math.huge
				if nA ~= nB then
					return nA < nB
				end
				return a.nID > b.nID
			end)
			for i = 2, #tList do
				add(tList[i], "shoal", tList[1])
			end
		end
	end
	return tOut, tAll
end

Logic._Why = function(self, tEntry)
	local sWith = self:_Name(tEntry.nWith)
	if tEntry.sWhy == "parent" then
		return "lives with parent " .. sWith
	elseif tEntry.sWhy == "shoal" then
		return "older shoal, keeping " .. sWith
	end
	return "sibling of " .. sWith
end

-- Current members of all groups: { [animal id] = group }, plus the list and
-- the groups. Built from fresh lists only (see CRASH WARNING above).
Logic._RefreshMembers = function(self)
	local tAnimals, tGroups, tExhibit, tMember = self:_ZooAnimals()
	self.tZoo = { tAnimals = tAnimals, tGroups = tGroups, tExhibit = tExhibit }
	self.tMembers = tMember
	return self.tZoo
end

-- Holds keep an animal from being sent again while a keeper is still taking
-- it away (or, after a refusal, for a minute). A hold ends when its time is
-- up or as soon as the animal is no longer listed in the group it was sent
-- from (carried off, in storage, moved): an animal the player puts back is
-- then handled like any other.
Logic._SetHold = function(self, nID, nTicks, tGroup)
	self.tHold[nID] = { nUntil = self.nTick + nTicks, sGroup = tGroup and groupName(tGroup) or nil }
end

Logic._IsHeld = function(self, nID)
	local tHold = self.tHold[nID]
	if tHold == nil then
		return false
	end
	local bGone = false
	if self.tMembers ~= nil then
		local tNow = self.tMembers[nID]
		bGone = tNow == nil or groupName(tNow) ~= tHold.sGroup
	end
	if self.nTick >= tHold.nUntil or bGone then
		self.tHold[nID] = nil
		return false
	end
	return true
end

-- Checks every hold (called each tick after _RefreshMembers), so leaving is
-- noticed even while the animal is away.
Logic._ReleaseHolds = function(self)
	for nID in pairs(self.tHold) do
		self:_IsHeld(nID)
	end
end

-- Sends the entries (skipping animals on hold). Returns nSent, nFailed, tNotes.
-- Names are read BEFORE sending: a sent vivarium animal's ID may be gone
-- right after (see CRASH WARNING above).
Logic._SendEntries = function(self, tEntries, bReport)
	local nSent, nFailed, tNotes = 0, 0, {}
	for _, e in ipairs(tEntries) do
		if not self:_IsHeld(e.nID) then
			local sName, sWhy = self:_Name(e.nID), self:_Why(e)
			local bSent, sErr = self:_Send(e.nID, e.bExhibit)
			if bSent then
				nSent = nSent + 1
				self:_SetHold(e.nID, self.nSentHold, e.tGroup)
				if bReport then
					toUI("PZ2AutoHub_AutoSent", sName, sWhy)
				else
					tNotes[#tNotes + 1] = "sent " .. sName .. " (" .. sWhy .. ")"
				end
			else
				nFailed = nFailed + 1
				self:_SetHold(e.nID, self.nFailHold, e.tGroup)
				tNotes[#tNotes + 1] = sName .. " (" .. sWhy .. "): " .. tostring(sErr)
			end
		end
	end
	return nSent, nFailed, tNotes
end

-- Groups of the open panel: the panel's own entity (a habitat or an
-- exhibit) and the groups of the listed animals.
Logic._PanelGroups = function(self, sIDs, sPanelID)
	local tOut, tSeen = {}, {}
	local function add(tGroup)
		if tGroup ~= nil and tGroup.nID ~= nil then
			local sKey = groupName(tGroup)
			if not tSeen[sKey] then
				tSeen[sKey] = true
				tOut[#tOut + 1] = tGroup
			end
		end
	end
	local nPanel = parseIDs(sPanelID)[1]
	if nPanel ~= nil then
		-- a vivarium if it is in the zoo's exhibit list (exhibit calls are
		-- only made on IDs the game listed itself)
		local bIsExhibit = false
		for _, nEx in ipairs(self:_AllExhibits()) do
			if nEx == nPanel then
				bIsExhibit = true
				break
			end
		end
		if bIsExhibit then
			add({ sKind = "exhibit", nID = nPanel })
		else
			add({ sKind = "habitat", nID = nPanel, bAquarium = self:_IsAquarium(nPanel) })
		end
	end
	-- listed animals: only the habitat lookup (safe for any ID); vivariums
	-- are known from the panel ID above
	for _, nID in ipairs(parseIDs(sIDs)) do
		local nHabitat = self:_Habitat(nID)
		if nHabitat ~= nil then
			add({ sKind = "habitat", nID = nHabitat, bAquarium = self:_IsAquarium(nHabitat) })
		end
	end
	return tOut
end

-----------------------------------------------------------------------
-- contraception
-----------------------------------------------------------------------

-- Whether an animal is on contraception, as the game's info panels read it:
-- habitat animals animals:IsUsingContraceptive(id), vivarium animals
-- exhibits:GetExhibitAnimalData(id).UsingContraceptive. true | false | nil.
Logic._UsingContra = function(self, nID, bExhibit)
	if bExhibit then
		local bOk, r = call((worldAPIs() or {}).exhibits, "GetExhibitAnimalData", nID)
		if bOk and type(r[1]) == "table" and type(r[1].UsingContraceptive) == "boolean" then
			return r[1].UsingContraceptive
		end
		return nil
	end
	local bOk, r = call(animalsAPI(), "IsUsingContraceptive", nID)
	if bOk and type(r[1]) == "boolean" then
		return r[1]
	end
	return nil
end

-- The info panels' toggle: animals:SetUsingContraceptive(id, bOn), for
-- vivarium animals exhibits:SetExhibitAnimalUsingContraceptive(id, bOn).
-- Returns true | false, error.
Logic._SetContra = function(self, nID, bExhibit, bOn)
	local bOk, r
	if bExhibit then
		bOk, r = call((worldAPIs() or {}).exhibits, "SetExhibitAnimalUsingContraceptive", nID, bOn)
	else
		bOk, r = call(animalsAPI(), "SetUsingContraceptive", nID, bOn)
	end
	if not bOk then
		return false, r
	end
	return true
end

-- The relative of the other sex (parent first, then sibling with
-- bSiblings) an animal lives with, or nil. An unknown sex counts as other.
Logic._ContraRelative = function(self, f, tAnimals)
	local function otherSex(a, b)
		return a.sGender == nil or b.sGender == nil or a.sGender ~= b.sGender
	end
	for _, p in ipairs(tAnimals) do
		if p.nID ~= f.nID and isParentOf(p, f) and otherSex(f, p) then
			return p, "parent"
		end
	end
	if self.bSiblings then
		for _, b in ipairs(tAnimals) do
			if b.nID ~= f.nID and otherSex(f, b) and not isParentOf(f, b) and not isParentOf(b, f)
				and shareParent(f, b) then
				return b, "sibling"
			end
		end
	end
	return nil
end

-- "key:on,key:player" (what the UI saves per park)
Logic._ContraText = function(self)
	local tParts = {}
	for k, v in pairs(self.tContra) do
		tParts[#tParts + 1] = k .. ":" .. v
	end
	table.sort(tParts)
	return table.concat(tParts, ",")
end

Logic._ContraChanged = function(self)
	toUI("PZ2AutoHub_ContraKeys", self:_ContraText())
end

-- One group (facts from _EvaluateGroup): switches contraception on for
-- animals living with a relative of the other sex, and off again for the
-- ones AutoHub switched on that no longer do. Returns nOn, nOff.
Logic._ContraGroup = function(self, tGroup, tAll)
	local bExhibit = tGroup.sKind == "exhibit"
	local tAnimals = {}
	for _, f in ipairs(tAll) do
		if not f.bShoal then
			tAnimals[#tAnimals + 1] = f
		end
	end
	local nOn, nOff, bChanged = 0, 0, false
	for _, f in ipairs(tAnimals) do
		local sKey = f.sKey
		if sKey ~= nil then
			local sState = self.tContra[sKey]
			local oWith, sWhy = self:_ContraRelative(f, tAnimals)
			if oWith ~= nil then
				if sState ~= "player" then
					local bUsing = self:_UsingContra(f.nID, bExhibit)
					if bUsing == false and sState == "on" then
						-- AutoHub switched it on, someone switched it off: leave it
						self.tContra[sKey] = "player"
						bChanged = true
						log(self:_Name(f.nID) .. ": contraception was switched off by hand, AutoHub leaves it off")
					elseif bUsing == false then
						local sName = self:_Name(f.nID)
						local sText = (sWhy == "parent" and "lives with parent " or "sibling of ") .. self:_Name(oWith.nID)
						local bOk, sErr = self:_SetContra(f.nID, bExhibit, true)
						if bOk then
							self.tContra[sKey] = "on"
							bChanged = true
							nOn = nOn + 1
							toUI("PZ2AutoHub_Contra", sName, sText, true)
						else
							log("contraception for " .. sName .. " failed: " .. tostring(sErr))
						end
					end
				end
			elseif sState ~= nil and f.bParentsKnown then
				-- no relative of the other sex here any more
				if sState == "on" and self:_UsingContra(f.nID, bExhibit) == true then
					local sName = self:_Name(f.nID)
					local bOk, sErr = self:_SetContra(f.nID, bExhibit, false)
					if bOk then
						nOff = nOff + 1
						toUI("PZ2AutoHub_Contra", sName, "no parent or sibling of the other sex here", false)
					else
						log("taking " .. sName .. " off contraception failed: " .. tostring(sErr))
					end
				end
				self.tContra[sKey] = nil
				bChanged = true
			end
		end
	end
	if bChanged then
		self:_ContraChanged()
	end
	return nOn, nOff
end

-- Every switched-on group, once. The evaluations are handed on, so the
-- send step of the same tick reuses them (same fresh member lists).
Logic._TickContra = function(self)
	local tGroups = self:_EnabledGroups(self.tZoo and self.tZoo.tGroups or self:_AllGroups())
	local tEval = { tGroups = tGroups, tResults = {} }
	local nAnimals, nOn, nOff = 0, 0, 0
	for i, tGroup in ipairs(tGroups) do
		local tEntries, tAll = self:_EvaluateGroup(tGroup)
		tEval.tResults[i] = { tEntries = tEntries, tAll = tAll }
		nAnimals = nAnimals + #tAll
		local a, b = self:_ContraGroup(tGroup, tAll)
		nOn, nOff = nOn + a, nOff + b
	end
	toUI("PZ2AutoHub_ContraStatus", nAnimals, nOn, nOff)
	return tEval
end

Logic.SetContra = function(self, bOn)
	self.bContra = bOn == true or bOn == "true"
end

-- the UI's saved list for this park ("key:on,key:player")
Logic.SetContraKeys = function(self, sList)
	local t = {}
	for sKey, sState in string.gmatch(tostring(sList or ""), "([^,:]+):(%a+)") do
		if sState == "on" or sState == "player" then
			t[sKey] = sState
		end
	end
	self.tContra = t
end

-----------------------------------------------------------------------
-- features
-----------------------------------------------------------------------

-- "off" | "new" | "always" (true/false accepted from older UI versions)
Logic.SetAuto = function(self, vMode)
	local sMode = vMode
	if vMode == true or vMode == "true" then
		sMode = "new"
	elseif vMode ~= "new" and vMode ~= "always" then
		sMode = "off"
	end
	if sMode ~= self.sMode then
		-- "new" only counts transitions observed from now on
		self:Reset()
	end
	self.sMode = sMode
end

Logic.SetSiblings = function(self, bOn)
	self.bSiblings = bOn == true or bOn == "true"
end

-- "habitat,exhibit" = the kinds that are switched on ("none" = all off)
Logic.SetKinds = function(self, sKinds)
	local t = { habitat = false, aquarium = false, exhibit = false }
	for sKind in string.gmatch(tostring(sKinds or ""), "%a+") do
		if t[sKind] ~= nil then
			t[sKind] = true
		end
	end
	self.tKinds = t
end

-- habitats (without aquariums), vivariums, aquariums
local function countKinds(tGroups)
	local nHabitats, nExhibits, nAquariums = 0, 0, 0
	for _, g in ipairs(tGroups) do
		local sKind = kindOf(g)
		if sKind == "exhibit" then
			nExhibits = nExhibits + 1
		elseif sKind == "aquarium" then
			nAquariums = nAquariums + 1
		else
			nHabitats = nHabitats + 1
		end
	end
	return nHabitats, nExhibits, nAquariums
end

-- tEval: this tick's evaluations from _TickContra, if it ran.
Logic._TickAlways = function(self, tEval)
	local tGroups = tEval and tEval.tGroups or self:_EnabledGroups(self.tZoo and self.tZoo.tGroups or self:_AllGroups())
	local nAnimals, nSentTotal = 0, 0
	for i, tGroup in ipairs(tGroups) do
		local tDone = tEval and tEval.tResults[i]
		local tEntries, tAll
		if tDone then
			tEntries, tAll = tDone.tEntries, tDone.tAll
		else
			tEntries, tAll = self:_EvaluateGroup(tGroup)
		end
		nAnimals = nAnimals + #tAll
		local nSent, _, tNotes = self:_SendEntries(tEntries, true)
		nSentTotal = nSentTotal + nSent
		for _, s in ipairs(tNotes) do
			log("not sent yet: " .. s)
		end
	end
	local nHabitats, nExhibits, nAquariums = countKinds(tGroups)
	toUI("PZ2AutoHub_AutoStatus", nHabitats, nAnimals, nSentTotal, nExhibits, nAquariums)
end

-- Every animal of every group: list, groups, { [id] = bExhibit },
-- { [id] = group }.
Logic._ZooAnimals = function(self)
	local tOut, tExhibit, tMember = {}, {}, {}
	local tGroups = self:_AllGroups()
	for _, tGroup in ipairs(tGroups) do
		for _, nID in ipairs(self:_GroupAnimals(tGroup)) do
			if tExhibit[nID] == nil then
				tExhibit[nID] = tGroup.sKind == "exhibit"
				tMember[nID] = tGroup
				tOut[#tOut + 1] = nID
			end
		end
	end
	return tOut, tGroups, tExhibit, tMember
end

Logic._TickNew = function(self)
	local tZoo = self.tZoo or self:_RefreshMembers()
	local tAnimals, tExhibit = tZoo.tAnimals, tZoo.tExhibit
	local tGroups = self:_EnabledGroups(tZoo.tGroups)
	local nAnimals = 0
	for _, nID in ipairs(tAnimals) do
		if self:_IsEnabled(self.tMembers[nID]) then
			nAnimals = nAnimals + 1
		end
	end
	local nHabitats, nExhibits, nAquariums = countKinds(tGroups)
	toUI("PZ2AutoHub_AutoStatus", nHabitats, nAnimals, -1, nExhibits, nAquariums)
	for _, nID in ipairs(tAnimals) do
		local sStage = self:_StageOf(nID, tExhibit[nID])
		if sStage == "juvenile" then
			self.tWasJuvenile[nID] = true
		elseif self.tWasJuvenile[nID] then
			self.tWasJuvenile[nID] = nil
			if sStage == "adult" then
				self.tPending[nID] = self.nTick + self.nRetryTicks
			end
		end
	end
	for nID, nUntil in pairs(self.tPending) do
		local tMine = {}
		-- where it lives now, from the fresh member lists (a gone animal is dropped)
		local tGroup = self.tMembers and self.tMembers[nID]
		if tGroup ~= nil and not self:_IsEnabled(tGroup) then
			-- its kind is switched off: forget it
			tGroup = nil
		end
		if tGroup == nil then
			self.tPending[nID] = nil
		else
			for _, e in ipairs((self:_EvaluateGroup(tGroup))) do
				if e.nID == nID or e.nWith == nID then
					tMine[#tMine + 1] = e
				end
			end
		end
		if tGroup == nil then
			-- left its habitat/vivarium meanwhile: nothing to do
		elseif #tMine == 0 then
			self.tPending[nID] = nil
			log(self:_Name(nID) .. " grew up, no relatives where it lives")
		else
			local _, nFailed, tNotes = self:_SendEntries(tMine, true)
			if nFailed == 0 then
				self.tPending[nID] = nil
			elseif self.nTick >= nUntil then
				self.tPending[nID] = nil
				for _, s in ipairs(tNotes) do
					log("gave up: " .. s)
				end
			end
		end
	end
end

-- Seconds between auto checks (whole number, nMinEvery..nMaxEvery).
Logic.SetInterval = function(self, vSeconds)
	local n = math.floor((tonumber(vSeconds) or self.nEvery) + 0.5)
	-- counted from the last check, so a new interval applies at once
	self.nEvery = math.max(self.nMinEvery, math.min(self.nMaxEvery, n))
end

-- One tick per second from the UI; the auto check itself runs right after
-- switching auto on, then every nEvery ticks.
-- Contraception runs first: sending a vivarium animal can end its entity,
-- and no exhibit call may follow on it (see CRASH WARNING above).
Logic.Tick = function(self)
	if (self.sMode == "off" and not self.bContra) or not self.bParkLive then
		return
	end
	self.nTick = self.nTick + 1
	if self.nLastCheck ~= nil and self.nTick < self.nLastCheck + self.nEvery then
		return
	end
	self.nLastCheck = self.nTick
	self:_RefreshMembers()
	self:_ReleaseHolds()
	local tEval = nil
	if self.bContra then
		tEval = self:_TickContra()
	end
	if self.sMode == "always" then
		self:_TickAlways(tEval)
	elseif self.sMode == "new" then
		self:_TickNew()
	end
end

-- Button in the habitat / vivarium panel: checks that group now.
Logic.SendFromHabitat = function(self, sIDs, sPanelID)
	self.nTreesLoading = 0
	local tGroups = self:_PanelGroups(sIDs, sPanelID)
	if #tGroups == 0 then
		toUI("PZ2AutoHub_Result", 0, 0, "Could not tell which habitat or vivarium this is.")
		return
	end
	local tEntries = {}
	for _, tGroup in ipairs(tGroups) do
		for _, e in ipairs((self:_EvaluateGroup(tGroup))) do
			-- a button press always tries, even animals on hold from auto mode
			self.tHold[e.nID] = nil
			tEntries[#tEntries + 1] = e
		end
	end
	local nSent, nFailed, tNotes = self:_SendEntries(tEntries, false)
	if (self.nTreesLoading or 0) > 0 then
		tNotes[#tNotes + 1] = "family data still loading for " .. self.nTreesLoading
			.. " vivarium animals: check again in a few seconds"
	end
	toUI("PZ2AutoHub_Result", nSent, nFailed, table.concat(tNotes, "\n"))
end

-- "Check all now" in the HUD panel: every habitat and vivarium, once, with
-- the same answer as the per-habitat check.
Logic.CheckAll = function(self)
	self.nTreesLoading = 0
	local tZoo = self:_RefreshMembers()
	self:_ReleaseHolds()
	local tGroups = self:_EnabledGroups(tZoo.tGroups)
	local tEntries = {}
	local nAnimals = 0
	for _, tGroup in ipairs(tGroups) do
		local tFound, tAll = self:_EvaluateGroup(tGroup)
		nAnimals = nAnimals + #tAll
		for _, e in ipairs(tFound) do
			self.tHold[e.nID] = nil
			tEntries[#tEntries + 1] = e
		end
	end
	local nSent, nFailed, tNotes = self:_SendEntries(tEntries, false)
	local nHabitats, nExhibits, nAquariums = countKinds(tGroups)
	table.insert(tNotes, 1, "checked " .. nHabitats .. " habitats, " .. nAquariums .. " aquariums, " .. nExhibits
		.. " vivariums, " .. nAnimals .. " animals")
	if (self.nTreesLoading or 0) > 0 then
		tNotes[#tNotes + 1] = "family data still loading for " .. self.nTreesLoading
			.. " vivarium animals: check again in a few seconds"
	end
	toUI("PZ2AutoHub_Result", nSent, nFailed, table.concat(tNotes, "\n"))
end

-- Writes what the game returns for the panel's group to the UI log.
Logic.Diagnose = function(self, sIDs, sPanelID)
	local A = animalsAPI()
	log("--- PZ2AutoHub " .. (Core and Core.sVersion or "?") .. " diagnose ---")
	local tWorld = worldAPIs() or {}
	local tWhere = {}
	for _, sName in ipairs({ "GetAgeStatus", "GetGender", "GetParents", "GetAssignedHabitatEntityID",
		"GetAnimalsInHabitat", "GetAnimalsInPark", "EntityIDToAnimalGUID", "AnimalGUIDToEntityID",
		"CanSendAnimalToTradeCentre", "AttemptToSendToTradeCentre", "GetAllExhibits", "GetAnimalsInExhibit",
		"GetExhibitAnimalData", "GetExhibitAnimalAgeQuadrant", "ExhibitAnimalEntityIDToUID", "GetSpecies",
		"IsSpeciesABoid", "GetAge", "IsAquarium", "IsUsingContraceptive", "SetUsingContraceptive",
		"SetExhibitAnimalUsingContraceptive" }) do
		local sFound = "MISSING"
		for _, sAPI in ipairs(tAPINames) do
			local t = tWorld[sAPI]
			local bOk, fn = pcall(function() return t and t[sName] end)
			if bOk and fn ~= nil then
				sFound = sAPI
				break
			end
		end
		tWhere[#tWhere + 1] = sName .. "@" .. sFound
	end
	log("api: " .. table.concat(tWhere, ", "))
	local tEnum = {}
	for v, s in pairs(self:_ResolveAgeEnums()) do
		tEnum[#tEnum + 1] = s .. "=" .. tostring(v)
	end
	for v, s in pairs(self:_ResolveGenderEnums()) do
		tEnum[#tEnum + 1] = s .. "=" .. tostring(v)
	end
	log("enums: " .. (#tEnum > 0 and table.concat(tEnum, ", ") or "none found"))
	local bExOk, rEx = callAny("GetAllExhibits")
	log("GetAllExhibits -> " .. (bExOk and dump(rEx[1]) or tostring(rEx)))
	local tZoo, tGroups = self:_ZooAnimals()
	local nHabitats, nExhibits, nAquariums = countKinds(tGroups)
	for _, bEx in ipairs({ false, true }) do
		local bHas, nUsed, nMax = self:_Storage(bEx)
		log("Trade Centre for " .. (bEx and "vivarium" or "habitat") .. " animals: " .. tostring(bHas)
			.. ", " .. storageText(bEx, nUsed, nMax))
	end
	log("auto: " .. self.sMode .. (self.bParkLive and "" or " (paused: park closing)") .. " every " .. self.nEvery .. " s, siblings rule: " .. tostring(self.bSiblings) .. ", ticks: " .. self.nTick
		.. ", habitats: " .. nHabitats .. ", aquariums: " .. nAquariums .. ", vivariums: " .. nExhibits
		.. ", animals: " .. #tZoo)
	log("switched on: habitats " .. tostring(self.tKinds.habitat) .. ", aquariums " .. tostring(self.tKinds.aquarium)
		.. ", vivariums " .. tostring(self.tKinds.exhibit))
	local nOnKeys, nPlayerKeys = 0, 0
	for _, v in pairs(self.tContra) do
		if v == "on" then
			nOnKeys = nOnKeys + 1
		else
			nPlayerKeys = nPlayerKeys + 1
		end
	end
	log("contraception: " .. (self.bContra and "on" or "off") .. ", set by AutoHub: " .. nOnKeys
		.. ", switched off by hand: " .. nPlayerKeys)
	for _, tGroup in ipairs(self:_PanelGroups(sIDs, sPanelID)) do
		local tEntries, tAll = self:_EvaluateGroup(tGroup)
		local bGroupExhibit = tGroup.sKind == "exhibit"
		local tNoShoals = {}
		for _, f in ipairs(tAll) do
			if not f.bShoal then
				tNoShoals[#tNoShoals + 1] = f
			end
		end
		log(groupName(tGroup) .. " (" .. kindOf(tGroup) .. "): " .. #tAll .. " animals")
		for i, f in ipairs(tAll) do
			if i > 15 then
				log("(more animals not shown)")
				break
			end
			if f.bShoal then
				log(string.format("#%s %s: shoal of %s, age %s", tostring(f.nID), self:_Name(f.nID),
					tostring(f.sSpecies), tostring(f.nAge)))
			else
				local tKeys = {}
				for k in pairs(f.tParentKeys) do
					tKeys[#tKeys + 1] = k
				end
				table.sort(tKeys)
				local oWith = self:_ContraRelative(f, tNoShoals)
				local sMine = f.sKey and self.tContra[f.sKey]
				log(string.format("#%s %s (%s): %s %s, guid %s, parents [%s]%s, contraception %s%s%s", tostring(f.nID),
					self:_Name(f.nID), tostring(f.sSpecies), tostring(f.sStage), tostring(f.sGender), tostring(f.sKey),
					table.concat(tKeys, " "), f.sTree and (", family tree " .. f.sTree) or "",
					tostring(self:_UsingContra(f.nID, bGroupExhibit)), sMine and (" (" .. sMine .. ")") or "",
					oWith and (", needs it: with " .. self:_Name(oWith.nID)) or ""))
			end
		end
		if #tEntries == 0 then
			log("=> nobody has to leave")
		end
		for _, e in ipairs(tEntries) do
			if e.bExhibit then
				local _, rUID = call(tWorld.exhibits, "ExhibitAnimalEntityIDToUID", e.nID)
				log("=> " .. self:_Name(e.nID) .. " leaves (" .. self:_Why(e) .. "), sent via exhibits API as uid "
					.. dump(rUID) .. ", habitat entity " .. tostring(self:_BrainID(e.nID)))
			else
				local _, rCan = call(A, "CanSendAnimalToTradeCentre", e.nID)
				log("=> " .. self:_Name(e.nID) .. " leaves (" .. self:_Why(e) .. "), canSend " .. dump(rCan))
			end
			if e.bExhibit then
				-- every plain field of the exhibit record (looking for the flock's own entity ID)
				local _, rUID = callAny("ExhibitAnimalEntityIDToUID", e.nID)
				local bData, rData = callAny("GetExhibitAnimalData", e.nID)
				local tFields = {}
				if bData and type(rData[1]) == "table" then
					for k, v in pairs(rData[1]) do
						if type(v) ~= "table" and type(v) ~= "function" then
							tFields[#tFields + 1] = tostring(k) .. "=" .. tostring(v)
						end
					end
					table.sort(tFields)
				end
				log("   uid " .. dump(rUID) .. ", record: " .. table.concat(tFields, ", "))
			end
		end
	end
	local tModes = {}
	for k, v in pairs(self.tCallMode) do
		tModes[#tModes + 1] = k .. "=" .. v
	end
	log("call modes: " .. table.concat(tModes, ", "))
end
