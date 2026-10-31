"""Runs pz2autohub.logic.lua against a fake game API (lupa) and checks the rules.

The fake API is shaped like the real game (seen in diagnose logs): numeric
age enums, GetParents only answers for GUIDs (entity id + 1000), parents of
unknown origin come back as 0, GetAnimalsInPark needs a list type,
GetAnimalsInHabitat lives on the habitat API.

Fake zoo (f = female, m = male; parents by entity id, 50 = dead animal):
  habitat 100: 1 mom f, 2 dad m, 3 adult m (1+2), 4 juvenile f (1+2), 5 adult m (unknown)
  habitat 200: 6 adult m (1+2, parents live elsewhere)
  habitat 300: 8 adult f (1+2), 9 adult m (2+50, half-sibling of 8),
               10 adult m (1+2, brother of 8 and of 9), 11 adult f (unknown),
               12 adult m (unknown)  -> 11/12 must NOT count as siblings
"""
import os
import sys
from lupa import LuaRuntime

# argument: the mod's lua folder (tools/check_mod.sh) or the logic file itself
SRC = sys.argv[1]
if os.path.isdir(SRC):
    SRC = os.path.join(SRC, "pz2autohub.logic.lua")
lua = LuaRuntime(unpack_returned_tuples=True)

lua.execute(r"""
module = function(name)
  local t = {}
  package.loaded[string.lower(name)] = t
  return t
end
sent = {}
ui = {}
animals = {
  [1] = {hab=100, age="A", sex="f", parents={0, 0}},
  [2] = {hab=100, age="A", sex="m", parents={0, 0}},
  [3] = {hab=100, age="A", sex="m", parents={1, 2}},
  [4] = {hab=100, age="J", sex="f", parents={1, 2}},
  [5] = {hab=100, age="A", sex="m", parents={0, 0}},
  [6] = {hab=200, age="A", sex="m", parents={1, 2}},
  [8] = {hab=300, age="A", sex="f", parents={1, 2}},
  [9] = {hab=300, age="A", sex="m", parents={2, 50}},
  [10] = {hab=300, age="A", sex="m", parents={1, 2}},
  [11] = {hab=300, age="A", sex="f", parents={0, 0}},
  [12] = {hab=300, age="A", sex="m", parents={0, 0}},
  -- habitat 400: two sisters whose parents are gone. GetParents returns raw
  -- GUIDs; the dead mother's GUID (21) happens to equal sister 21's entity ID.
  [20] = {hab=400, age="A", sex="f", rawParents={21, 9999}},
  [21] = {hab=400, age="A", sex="f", rawParents={21, 9999}},
  -- vivarium (exhibit) 500: not in any habitat; age via quadrant
  -- (0 infant, 1 young adult, 2 adult, 3 elderly); only UID calls work
  [30] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}},     -- mother
  [31] = {hab=0, ex=500, q=1, sex="m", parents={30, 0}},    -- young adult son -> leaves
  [32] = {hab=0, ex=500, q=0, sex="f", parents={30, 0}},    -- infant daughter -> stays
  [33] = {hab=0, ex=500, q=2, sex="m", parents={98, 99}},   -- brother (parents gone)
  [34] = {hab=0, ex=500, q=2, sex="f", parents={98, 99}},   -- sister -> both leave
  [35] = {hab=0, ex=500, q=3, sex="m", parents={98, 99}},   -- elderly brother -> stays
  -- aquarium 600 (a habitat): fish shoals; 41 split off 40 (game may link it as child)
  [40] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=5, parents={0, 0}},
  [41] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=1, parents={40, 0}},
  [42] = {hab=600, age="A", sex="u", species="Tang", boid=true, gameAge=3, parents={0, 0}},
  -- vivarium tank 510 with fish shoals: species/age only via GetExhibitAnimalData
  [50] = {hab=0, ex=510, q=2, sex="u", species="Guppy", years=4, parents={0, 0}},
  [51] = {hab=0, ex=510, q=2, sex="u", species="Guppy", years=1, parents={50, 0}},
  [52] = {hab=0, ex=510, q=2, sex="u", species="Neon", years=2, parents={0, 0}},
}
local A = {}
A.Juvenile = 0
A.Adult = 1
A.Gender_Male = 0
A.Gender_Female = 1
-- unrelated constants with confusing names must not change the sexes
A.Male = 1
A.Female = 0
A.AnimalsListType_All = 10
A.AnimalsListType_Habitat = 11
-- exhibit animals only answer the exhibit/UID calls
function A:GetAgeStatus(id) local a = animals[id]; if a.ex then error("not a habitat animal") end return a.age == "J" and 0 or 1 end
function A:GetGender(id)
  local a = animals[id]
  -- in the game it answers vivarium animals with the default: male (seen 2026-10-31)
  if a.ex then return 0 end
  if a.sex == "u" then return 2 end
  return a.sex == "m" and 0 or 1
end
function A:GetAssignedHabitatEntityID(id) local a = animals[id]; return a and a.hab or 0 end
function A:EntityIDToAnimalGUID(id) if animals[id] and animals[id].ex then return 0 end return id + 1000 end
function A:GetSpecies(id) if animals[id].ex then error("not a habitat animal") end return animals[id].species or "RedPanda" end
function A:IsSpeciesABoid(s) return s == "Clownfish" or s == "Tang" or s == "Guppy" or s == "Neon" end
function A:GetAge(id) if animals[id].ex then error("not a habitat animal") end return animals[id].gameAge or 4 end
function A:GetParents(guid)
  local a = animals[guid - 1000]
  if not a then return {} end
  -- as in the game (2026-10-18): nothing for vivarium animals; their
  -- parents come from franchise:GetAnimalFamilyTreeData
  if a.ex then return {} end
  if a.rawParents then return { a.rawParents[1], a.rawParents[2] } end
  local t = {}
  for i, p in ipairs(a.parents) do t[i] = (p == 0) and 0 or (p + 1000) end
  return t
end
-- exhibit animals: the exhibit lists one entity, the animal itself ("brain")
-- is another (id + 20000), which is what AnimalGUIDToEntityID returns
function A:AnimalGUIDToEntityID(g)
  g = tonumber(g)
  if g and g > 1000 and animals[g - 1000] then
    if animals[g - 1000].ex then return g - 1000 + 20000 end
    return g - 1000
  end
  return 0
end
parkListBroken = false
function A:GetAnimalsInPark(listType)
  if parkListBroken then return {} end
  if listType ~= A.AnimalsListType_Habitat and listType ~= A.AnimalsListType_All then return {} end
  local t = {} for id, a in pairs(animals) do if a.hab ~= 0 then t[#t+1] = id end end table.sort(t) return t
end
-- as in the game: CanSend answers false for exhibit animals (both entities)
-- refuseSend: the game refuses every habitat animal (storage full)
refuseSend = false
function A:CanSendAnimalToTradeCentre(id)
  if id > 20000 or refuseSend then return false end
  local a = animals[id]
  if a.ex then return false end
  return a.hab ~= 0
end
-- keeperSlow: the animal stays assigned to its habitat until picked up
keeperSlow = false
-- as in the game: the animals API refuses exhibit animals (send them with
-- exhibits:AttemptToSendToTradeCentre(uid), then RemoveAnimal(brain))
function A:AttemptToSendToTradeCentre(id)
  if id > 20000 then return false end
  if animals[id].ex then error("not an animal brain") end
  sent[#sent+1] = id
  if not keeperSlow then animals[id].hab = 0 end
  return true
end
function A:GetName(id)
  if animals[id] and animals[id].ex then return "ERROR, ANIMAL BRAIN HAS NO NAME" end
  return "[STRING_LITERAL:Value=|Animal" .. id .. "|]"
end
local H = {}
function H:IsAquarium(h) return h == 600 end
function H:GetAnimalsInHabitat(h) local t = {} for id, a in pairs(animals) do if a.hab == h then t[#t+1] = id end end table.sort(t) return t end
local F = {}
function F:GetAllHabitatsEntityIDs() return { 100, 200, 300, 600, 700 } end
-- contraception (the info panel toggle); flags live on the animal
function A:IsUsingContraceptive(id) if animals[id].ex then error("not a habitat animal") end return animals[id].contra == true end
function A:SetUsingContraceptive(id, b) if animals[id].ex then error("not a habitat animal") end animals[id].contra = b end
-- exhibits API: as in the game (helpers.notificationtasks),
-- GetAnimalsInExhibit hands out records { nEntityID = id }.
-- 520 is listed by GetAllExhibits but not (yet) a live exhibit, like one
-- being built or demolished.
local X = {}
function X:GetAllExhibits() return { 500, 510, 520 } end
function X:EntityIsExhibit(id) return id == 500 or id == 510 end
function X:EntityIsExhibitAnimal(id) local a = animals[id] return a ~= nil and a.ex ~= nil and a.ex ~= 0 end
-- In the real game, exhibit calls on an ID that is not a live exhibit /
-- exhibit animal crash the engine (seen in crash dumps). Count them.
engineCrashes = 0
function X:GetAnimalsInExhibit(ex)
  if not X:EntityIsExhibit(ex) then engineCrashes = engineCrashes + 1 return nil end
  local t = {} for id, a in pairs(animals) do if a.ex == ex then t[#t+1] = { nEntityID = id } end end
  table.sort(t, function(a, b) return a.nEntityID < b.nEntityID end) return t
end
local function goneExhibitAnimal(id)
  if not X:EntityIsExhibitAnimal(id) then
    engineCrashes = engineCrashes + 1
    return true
  end
  return false
end
function X:ExhibitAnimalEntityIDToUID(id) if goneExhibitAnimal(id) then return 0 end if animals[id].ex then return id + 1000 end return 0 end
function X:GetExhibitAnimalData(id)
  if goneExhibitAnimal(id) then return nil end
  local a = animals[id]
  if a.ex and a.ex ~= 0 then return { ParentExhibitEntityID = a.ex, Species = a.species or "Gecko", AgeInYears = a.years or 3, UsingContraceptive = a.contra == true } end
  return nil
end
function X:GetExhibitAnimalAgeQuadrant(id) if goneExhibitAnimal(id) then return nil end return animals[id].q end
function X:GetExhibitAnimalName(id) if goneExhibitAnimal(id) then return nil end return "[STRING_LITERAL:Value=|Animal" .. id .. "|]" end
-- vivarium storage at the Trade Centre (separate capacity)
exhibitStorageUsed, exhibitStorageMax = 0, 50
F.ZooHasExhibitTradeCentre = function(self) return true end
local P = {}
function P:GetExhibitTradeCentreMaxCapacity() return exhibitStorageMax end
function P:GetNumberOfAnimalsInExhibitTradeCentre() return exhibitStorageUsed end
removedBrains = {}
function X:AttemptToSendToTradeCentre(uid)
  uid = tonumber(uid)
  local real = uid and uid - 1000
  if not (real and animals[real] and animals[real].ex and animals[real].ex ~= 0) then return false end
  sent[#sent+1] = real
  animals[real].ex = 0
  return true
end
function X:SetExhibitAnimalUsingContraceptive(id, b) if goneExhibitAnimal(id) then return end animals[id].contra = b end
function A:RemoveAnimal(id) removedBrains[#removedBrains+1] = id end
function X:GetAnimalUIDGender(uid) return animals[uid - 1000].sex == "m" and 0 or 1 end
-- franchise API: family trees of vivarium animals, keyed by UID (id + 1000).
-- The game loads a tree after RequestFamilyTreeData; treeDelay = true keeps
-- it loading until deliverTrees() (the next frames in the game).
local FR = {}
treeDelay = false
treeRequests = {}
treeReady = {}
function FR:RequestFamilyTreeData(uid)
  treeRequests[#treeRequests + 1] = uid
  if not treeDelay then treeReady[uid] = true end
  return #treeRequests
end
function deliverTrees() for _, uid in ipairs(treeRequests) do treeReady[uid] = true end end
function FR:GetAnimalFamilyTreeData(uid)
  if not treeReady[uid] then return nil end
  local a = animals[uid - 1000]
  if not a or not a.ex then return nil end
  local function member(p) return { id = (p == 0) and 0 or (p + 1000), name = "A" .. p, gender = false } end
  return { mother = member(a.parents[1]), father = member(a.parents[2]), siblings = {}, children = {} }
end
-- Quick Trade / Quick Release (RelocateAnimalsPopup): noTrade / noRelease
-- on an animal make the game's "Can..." answer false
sold, released = {}, {}
function A:CanSellAnimal(id) local a = animals[id] or animals[id - 20000]; return a ~= nil and not a.noTrade end
function A:InstantlySellAnimal(id) if animals[id].ex then error("not a habitat animal") end sold[#sold+1] = id; animals[id].hab = 0 end
function A:CanReleaseAnimal(id) local a = animals[id]; return a ~= nil and not a.ex and not a.noRelease end
function A:ReleaseAnimalIntoWild(id) if animals[id].ex then error("not a habitat animal") end released[#released+1] = id; animals[id].hab = 0 end
function X:CanReleaseAnimalUID(uid) local a = animals[uid - 1000]; return a ~= nil and a.ex ~= nil and a.ex ~= 0 and not a.noRelease end
function X:ReleaseAnimalIntoWild(uid) local a = animals[uid - 1000]; released[#released+1] = uid - 1000; a.ex = 0 end
function X:SellAnimalFromExhibit(id) if goneExhibitAnimal(id) then return end sold[#sold+1] = id; animals[id].ex = 0 end
-- what the relocate window shows (value = nil on an animal: the game gives nothing)
function A:GetAnimalSellValue(id) local a = animals[id]; if a.noValue then return nil end return a.sellValue or 1234.6 end
-- lazy = true: like aquarium animals in-game, the release value is 0 until
-- franchise:RequestAnimalData(guid) has loaded the animal's data
dataLoaded, dataRequests, dataDelay = {}, {}, false
function A:GetServerAnimalReleaseValue(id)
  local a = animals[id]
  if a.noValue then return nil end
  if a.lazy and not dataLoaded[id + 1000] then return 0 end
  return a.releaseValue or 200
end
function FR:GetAnimalData(guid) if dataLoaded[guid] then return { guid = guid } end return nil end
function FR:RequestAnimalData(guid) dataRequests[#dataRequests + 1] = guid; if not dataDelay then dataLoaded[guid] = true end return #dataRequests end
function deliverData() for _, g in ipairs(dataRequests) do dataLoaded[g] = true end end
function X:GetExhibitAnimalSellValueUID(uid) return 75 end
zeroExhibitValue = false
-- genes (GetGeneticGrades): animal.genes = { nSize, nLongevity, nFertility, nImmunity }
-- (0-1 like the game; noGenes = the game gives nothing); default 0.4 each
local function genesOf(a)
  if a.noGenes then return nil end
  return a.genes or { nSize = 0.4, nLongevity = 0.4, nFertility = 0.4, nImmunity = 0.4 }
end
function A:GetGeneticGrades(id) local a = animals[id]; if a.ex then error("not a habitat animal") end return genesOf(a) end
function X:GetExhibitAnimalUIDGeneticGrades(uid) local a = animals[uid - 1000]; return a and genesOf(a) end
function X:GetAnimalReleaseValue(uid) if zeroExhibitValue then return 0 end return 30 end
movesOn = true
api = { world = { GetWorldAPIs = function() return { animals = A, habitat = H, facilities = F, exhibits = X, park = P, franchise = FR } end },
  entity = { NullEntityID = 0 }, time = { GetTotalTimeUnscaled = function() return clock or 0 end },
  planetHub = { IsPlayerAnimalMovementEnabled = function() return movesOn end } }
""")

with open(SRC, encoding="utf-8") as fh:
    code = fh.read()
lua.execute(code.replace("module(...)", 'module("PZ2AutoHub.Logic")'))
lua.execute(r"""
Logic = package.loaded["pz2autohub.logic"]
Logic:Init({ sVersion = "test", SendToUI = function(self, ev, ...) ui[#ui+1] = {ev, ...} end })
Logic:SetInterval(1)  -- every tick is a check, unless a test says otherwise
""")

def sent():
    return sorted(lua.eval("sent").values())

def ui_events(name):
    return [list(e.values())[1:] for e in lua.eval("ui").values() if list(e.values())[0] == name]

failures = []
def check(label, got, want):
    ok = got == want
    print(("PASS " if ok else "FAIL ") + label + f": got {got!r}" + ("" if ok else f", want {want!r}"))
    if not ok:
        failures.append(label)

def reset_sent():
    lua.execute("sent = {}")

# 1. Button, parent rule: adult child leaves, parents and stranger stay
lua.execute('Logic:SendFromHabitat("animal_1,animal_4", "100")')
check("button: adult child living with parents", sent(), [3])
check("button result counts", ui_events("PZ2AutoHub_Result")[-1][:2], [1, 0])

# 2. Button, sibling rule: brother+sister and half-siblings leave, unknown-parent animals stay
reset_sent()
lua.execute('Logic:SendFromHabitat("", "300")')
check("button: brother/sister + half-sibling pairs (both leave)", sent(), [8, 9, 10])

# 2b. Sisters with gone parents (GUID colliding with an entity ID): nobody leaves
reset_sent()
lua.execute('Logic:SendFromHabitat("", "400")')
check("button: two sisters, parents gone, ID collision -> nobody leaves", sent(), [])
lua.execute('animals[22] = {hab=400, age="A", sex="m", rawParents={9999, 0}}')
lua.execute('Logic:SendFromHabitat("", "400")')
check("button: their brother joins -> brother + both sisters leave", sent(), [20, 21, 22])

# 2c. Vivarium: same rules via exhibit API (young adult counts as adult,
#     infant and elderly stay). Parents come from the family tree, which
#     the game loads after a request (GetParents gives nothing in-game).
reset_sent()
lua.execute('treeDelay = true; clock = 0')
lua.execute('Logic:SendFromHabitat("", "500")')
check("vivarium: family trees not loaded yet -> nobody sent", sent(), [])
check("vivarium: says the family data is loading", "family data still loading for 6 vivarium animals" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
check("vivarium: one tree request per animal", len(lua.eval("treeRequests")), 6)
lua.execute('Logic:SendFromHabitat("", "500")')
check("vivarium: no repeated requests within 20 s", len(lua.eval("treeRequests")), 6)
lua.execute('deliverTrees(); treeDelay = false')
lua.execute('Logic:SendFromHabitat("", "500")')
check("vivarium: son with mother + brother/sister pair leave", sent(), [31, 33, 34])
check("vivarium: no loading note once loaded", "still loading" in str(ui_events("PZ2AutoHub_Result")[-1][2]), False)
# a vivarium animal's own panel (exhibitAnimalInfoPanel) checks its vivarium
reset_sent()
lua.execute('for _, n in ipairs({31, 33, 34}) do animals[n].ex = 500 end; Logic.tHold = {}; Logic:SendFromHabitat("", "32")')
check("vivarium animal panel: checks its vivarium", sent(), [31, 33, 34])

# 2d. Aquarium: older shoal of a species leaves, youngest stays; a split
#     shoal linked as 'child' is NOT sent by the parent rule
reset_sent()
lua.execute('Logic:SendFromHabitat("", "600")')
check("aquarium: only the older Clownfish shoal leaves", sent(), [40])
check("aquarium: reason names the kept shoal", ui_events("PZ2AutoHub_Result")[-1][2],
      "sent [STRING_LITERAL:Value=|Animal40|] (older Clownfish shoal, keeping [STRING_LITERAL:Value=|Animal41|])")

# 2e. Vivarium tank with shoals: older Guppy shoal leaves, single Neon shoal stays
reset_sent()
lua.execute('Logic:SendFromHabitat("", "510")')
check("vivarium: only the older Guppy shoal leaves", sent(), [50])
check("vivarium: result names the shoals (no 'ANIMAL BRAIN' error)", ui_events("PZ2AutoHub_Result")[-1][2],
      "sent [STRING_LITERAL:Value=|Animal50|] (older Guppy shoal, keeping [STRING_LITERAL:Value=|Animal51|])")

# 2f. Vivarium storage at the Trade Centre full: nothing sent, reason given
reset_sent()
lua.execute('animals[50].ex = 510; exhibitStorageUsed = 50; Logic:SendFromHabitat("", "510")')
check("vivarium storage full: nothing sent", sent(), [])
res = ui_events("PZ2AutoHub_Result")[-1]
check("vivarium storage full: reason reported", [res[1], "Trade Centre full (vivarium storage 50/50)" in str(res[2])], [1, True])
lua.execute('exhibitStorageUsed = 0; Logic:SendFromHabitat("", "510")')
check("vivarium storage free again: older shoal sent", sent(), [50])

# 3. Siblings switch off: nothing for pure sibling habitats
lua.execute('for _, id in ipairs({8, 9, 10}) do animals[id].hab = 300 end')
reset_sent()
lua.execute('Logic:SetSiblings(false); Logic:SendFromHabitat("", "300"); Logic:SetSiblings(true)')
check("siblings off: nobody leaves", sent(), [])

# 4. Auto "new": only transitions seen while on
reset_sent()
lua.execute('for _, id in ipairs({8, 9, 10}) do animals[id].hab = 0 end')  # leave only habitat 100/200 relevant
lua.execute('Logic:SetAuto("new"); Logic:Tick()')
check("new: first tick sends nobody", sent(), [])
lua.execute('animals[4].age = "A"; Logic:Tick()')
check("new: grown-up daughter living with parents is sent", sent(), [4])
check("new: notification with reason", [str(v) for v in ui_events("PZ2AutoHub_AutoSent")[-1]][:2],
      ["[STRING_LITERAL:Value=|Animal4|]", "lives with parent [STRING_LITERAL:Value=|Animal1|]"])

# 5. Auto "new" ignores animals that were adults before; "always" does not
reset_sent()
lua.execute('animals[13] = {hab=200, age="A", sex="f", parents={14, 0}}; animals[14] = {hab=200, age="A", sex="m", parents={0, 0}}')
lua.execute('Logic:Tick(); Logic:Tick()')
check("new: existing adult living with parent is not touched", sent(), [])
lua.execute('Logic:SetAuto("always"); Logic:Tick()')
check("always: existing adult living with parent is sent", sent(), [13])
lua.execute('for i = 1, 12 do Logic:Tick() end')
check("always: not sent twice while in transit", sent(), [13])

# 5b. Park list empty (as in the real game): habitats come from facilities
reset_sent()
lua.execute('parkListBroken = true; animals[16] = {hab=300, age="A", sex="f", parents={14, 0}}; animals[14].hab = 300')
lua.execute('Logic:SetAuto("off"); Logic:SetAuto("always"); Logic:Tick()')
check("always with empty park list: found via facilities", sent(), [16])
status = ui_events("PZ2AutoHub_AutoStatus")[-1]
check("auto status reports habitats/animals", [status[0] >= 3, status[1] > 0], [True, True])
lua.execute('animals[17] = {hab=300, age="J", sex="m", parents={14, 0}}; Logic:SetAuto("new"); Logic:Tick()')
lua.execute('animals[17].age = "A"; Logic:Tick()')
check("new with empty park list: grown-up found via facilities", sent(), [16, 17])
lua.execute('parkListBroken = false')

# 5c. Animal put back into the habitat is sent again at the next check
reset_sent()
lua.execute('Logic:SetAuto("off"); Logic:SetAuto("always"); Logic:Tick()')
check("always: nothing left to send", sent(), [])
lua.execute('animals[16].hab = 300')                       # player puts it back
lua.execute('for i = 1, 5 do Logic:Tick() end')            # within one "always" cycle
check("always: animal put back is sent again within one check", sent(), [16])

# 5d. While the keeper has not picked it up yet (still in the habitat), no double send
reset_sent()
# one check sees it gone from the habitat (in the game the keeper's walk takes far longer)
lua.execute('Logic:Tick(); keeperSlow = true; animals[16].hab = 300; for i = 1, 6 do Logic:Tick() end')
check("always: sent once, waiting for keeper", sent(), [16])
lua.execute('for i = 1, 20 do Logic:Tick() end')
check("always: still not sent twice while waiting", sent(), [16])
lua.execute('keeperSlow = false; animals[16].hab = 0; Logic:Tick(); animals[16].hab = 300; for i = 1, 5 do Logic:Tick() end')
check("always: after pickup and return, sent again", sent(), [16, 16])
lua.execute('animals[16].hab = 0')

# 5e. Always: a new split shoal appears -> the older one (41) leaves
reset_sent()
lua.execute('animals[16].hab = 0; animals[43] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=0, parents={41, 0}}')
lua.execute('Logic:SetAuto("off"); Logic:SetAuto("always"); Logic:Tick()')
check("always: shoal split -> older Clownfish shoal leaves", sent(), [41])

# 5e2. Shoals per species (per kind): the youngest N of one species stay,
#      other species don't count, 0 = no limit
lua.execute("""
Logic:SetAuto("off")
for id, a in pairs(animals) do if a.hab == 600 then a.hab = 0 end end
animals[90] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=6, parents={0, 0}}
animals[91] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=4, parents={0, 0}}
animals[92] = {hab=600, age="A", sex="u", species="Clownfish", boid=true, gameAge=2, parents={0, 0}}
animals[93] = {hab=600, age="A", sex="u", species="Tang", boid=true, gameAge=9, parents={0, 0}}
""")
def shoals_run(n):
    lua.execute('for _, id in ipairs({90, 91, 92, 93}) do animals[id].hab = 600 end; Logic.tHold = {}')
    lua.execute(f'Logic:SetKindCfg("aquarium,1,off,1,0,storage,1,0,0,0,0,0,g,g,a,{n}")')
    reset_sent()
    lua.execute('Logic:SendFromHabitat("", "600")')
    return sorted(sent())
check("shoals 1: the two older Clownfish shoals leave, the Tang stays", shoals_run(1), [90, 91])
check("shoals: reason names the species", "older Clownfish shoal" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
check("shoals 2: only the oldest Clownfish shoal leaves", shoals_run(2), [90])
check("shoals 3: all stay", shoals_run(3), [])
check("shoals 0 (no limit): all stay", shoals_run(0), [])
check("shoals: setting per kind", [lua.eval("Logic.tCfg.aquarium.nShoals"), lua.eval("Logic.tCfg.exhibit.nShoals")], [0, 1])
lua.execute('Logic:SetKindCfg("aquarium,1,off,1,0,storage,1,0,0,0,0,0,g,g,a,1")')
lua.execute('for _, id in ipairs({90, 91, 92, 93}) do animals[id] = nil end')

# 5f. New adults: vivarium infant grows up next to its mother -> leaves
reset_sent()
lua.execute('Logic:SetAuto("new"); Logic:Tick()')
lua.execute('animals[32].q = 1; Logic:Tick()')
check("new: vivarium daughter grows up next to mother -> leaves", sent(), [32])

# 5f2. New adults: a grown-up missed when it grew up (park reloaded) is
#      still caught at a later check
reset_sent()
lua.execute('animals[19] = {hab=300, age="J", sex="f", parents={14, 0}}; animals[14].hab = 300; Logic:Tick()')
check("new: juvenile remembered by GUID", lua.eval('Logic.tYoung["1019"]'), True)
lua.execute('Logic:SetParkLive(false); animals[19].age = "A"; Logic:SetParkLive(true); Logic:Tick()')
check("new: grew up while the park reloaded -> still sent", sent(), [19])

# 5f3. New adults: refused for longer than 5 minutes (storage full) -> keeps
#      trying, sent once the game allows it
reset_sent()
lua.execute('animals[20] = {hab=300, age="J", sex="m", parents={14, 0}}; Logic:Tick(); Logic:Tick()')
lua.execute('refuseSend = true; animals[20].age = "A"; for i = 1, 400 do Logic:Tick() end')
check("new: refused -> nothing sent", sent(), [])
lua.execute('refuseSend = false; for i = 1, 70 do Logic:Tick() end')
check("new: refused for 6+ minutes, then allowed -> sent", sent(), [20])
lua.execute('animals[19].hab = 0; animals[20].hab = 0')

# 5f4. New adults: when a park opens, everyone is checked once (adults that
#      grew up before AutoHub saw them as juveniles); after that only new ones
reset_sent()
lua.execute('animals[21] = {hab=300, age="A", sex="f", parents={14, 0}}; for i = 1, 6 do Logic:Tick() end')
check("new: unknown adult next to her father is left alone", sent(), [])
lua.execute('Logic:SetParkLive(false); Logic:SetParkLive(true); Logic:Tick()')
check("new: park opened -> checked once, she leaves", sent(), [21])
check("new: park-open check is done", lua.eval("Logic.bStartCheck"), False)
lua.execute('animals[21].hab = 300; Logic.tHold = {}; for i = 1, 6 do Logic:Tick() end')
check("new: after the park-open check, only grown-up animals again", sent(), [21])
lua.execute('animals[21].hab = 0')

# 5f5. Performance: sex and parents are cached by GUID, the next check makes
#      far fewer game calls; Diagnose reads fresh
lua.execute('Logic.tStatic = {}; Logic.nLastCheck = nil; Logic:Tick()')
first = lua.eval("Logic.nCheckCalls")
lua.execute('Logic.nLastCheck = nil; Logic:Tick()')
check("cache: second check needs far fewer game calls", lua.eval("Logic.nCheckCalls") < first * 0.6, True)
lua.execute('clock = (clock or 0) + 300; Logic.nLastCheck = nil; Logic:Tick()')
check("cache: GUID parents kept while the animal is seen", lua.eval("Logic.nCheckCalls") < first * 0.6, True)
lua.execute('Logic.tStatic["1999"] = {nAt = (clock or 0) - 1000, nSeen = (clock or 0) - 700, nUntil = math.huge, tParentKeys = {}}; Logic.nLastCheck = nil; Logic:Tick()')
check("cache: animal not seen for 10 minutes forgotten", lua.eval('Logic.tStatic["1999"]'), None)
lua.execute('clock = (clock or 0) - 500; Logic.nLastCheck = nil; Logic:Tick()')
check("cache: clock went back -> read again", lua.eval("Logic.nCheckCalls") > first * 0.8, True)

# 5g. The crash case: Always mode sends a vivarium shoal, its ID is gone,
#     the following checks must not ask exhibit APIs about it
reset_sent()
lua.execute('engineCrashes = 0')
lua.execute('animals[50] = {hab=0, ex=510, q=2, sex="u", species="Guppy", years=9, parents={0, 0}}')
lua.execute('Logic:SetAuto("off"); Logic:SetAuto("always"); for i = 1, 12 do Logic:Tick() end')
check("crash case: older vivarium shoal sent once", sent(), [50])
check("crash case: no exhibit calls on the gone animal (engine crashes)", lua.eval("engineCrashes"), 0)
lua.execute('animals[50] = nil')   # the game deletes the entity entirely
lua.execute('for i = 1, 12 do Logic:Tick() end; Logic:SendFromHabitat("", "510"); Logic:Diagnose("", "510")')
check("crash case: entity deleted -> still no exhibit calls on it", lua.eval("engineCrashes"), 0)

# 6. Off: nothing happens
reset_sent()
lua.execute('animals[15] = {hab=200, age="A", sex="m", parents={14, 0}}; Logic:SetAuto("off"); for i = 1, 6 do Logic:Tick() end')
check("off: nothing sent", sent(), [])

# 6b. "Check all now" works with auto off: adult 17 lives with its father 18
reset_sent()
lua.execute('animals[18] = {hab=200, age="A", sex="m", parents={0, 0}}; animals[17] = {hab=200, age="A", sex="f", parents={18, 0}}')
lua.execute('Logic:CheckAll()')
check("check all: sends animal 17 with auto off", 17 in sent(), True)
res = ui_events("PZ2AutoHub_Result")[-1]
check("check all: result counts sent", int(res[0]) >= 1, True)
check("check all: result says what was checked", str(res[2]).startswith("checked "), True)

# 6c. Switches: each kind can be left out of "Check all" and auto.
# Fresh animals each run: habitat 100 parent 70 + adult son 71, aquarium 600
# Tang shoals 72 (old) + 73 (young), vivarium 500 mother 74 + adult son 75.
FRESH = """
animals[70] = {hab=100, age="A", sex="m", parents={0, 0}}
animals[71] = {hab=100, age="A", sex="m", parents={70, 0}}
animals[72] = {hab=600, age="A", sex="u", species="Tang", boid=true, gameAge=6, parents={0, 0}}
animals[73] = {hab=600, age="A", sex="u", species="Tang", boid=true, gameAge=1, parents={0, 0}}
animals[74] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
animals[75] = {hab=0, ex=500, q=2, sex="m", parents={74, 0}}
"""
def kinds_run(kinds, how='Logic:CheckAll()'):
    lua.execute(FRESH)
    reset_sent()
    lua.execute(f'Logic:SetKinds("{kinds}"); Logic.tHold = {{}}; {how}')
    return [i for i in sent() if 70 <= i <= 75]
check("switches all on: habitat, aquarium and vivarium sent", kinds_run("habitat,aquarium,exhibit"), [71, 72, 75])
check("habitats off", kinds_run("aquarium,exhibit"), [72, 75])
check("aquariums off", kinds_run("habitat,exhibit"), [71, 75])
check("vivariums off", kinds_run("habitat,aquarium"), [71, 72])
check("all off: nothing sent", kinds_run("none"), [])
check("all off: result still answers", str(ui_events("PZ2AutoHub_Result")[-1][2]).startswith("checked 0 habitats, 0 aquariums, 0 vivariums"), True)
check("all off: the open-panel check still works", kinds_run("none", 'Logic:SendFromHabitat("", "600")'), [72])
check("auto always, only vivariums on", kinds_run("exhibit", 'Logic:SetAuto("off"); Logic:SetAuto("always"); Logic:Tick()'), [75])
status = ui_events("PZ2AutoHub_AutoStatus")[-1]
check("auto status counts only switched-on kinds (habitats, aquariums)", [status[0], status[4]], [0, 0])
lua.execute('Logic:SetAuto("off"); Logic:SetKinds("habitat,aquarium,exhibit")')
for i in range(70, 76):
    lua.execute(f'animals[{i}] = nil')

# 6d. Check interval: one check right after auto goes on, then every N ticks (seconds)
def checks_in(ticks):
    before = len(ui_events("PZ2AutoHub_AutoStatus"))
    lua.execute(f'for i = 1, {ticks} do Logic:Tick() end')
    return len(ui_events("PZ2AutoHub_AutoStatus")) - before
lua.execute('Logic:SetInterval(5); Logic:SetAuto("off"); Logic:SetAuto("always")')
check("interval 5 s: 11 ticks = checks at 1, 6, 11", checks_in(11), 3)
lua.execute('Logic:SetInterval(30)')
check("interval 30 s: no check in the next 29 ticks", checks_in(29), 0)
lua.execute('Logic:SetInterval(2)')
check("shorter interval applies at once (not after the old 30 s)", checks_in(2), 1)
lua.execute('Logic:SetInterval(0)')
check("interval below 1 s is clamped to 1", lua.eval("Logic.nEvery"), 1)
lua.execute('Logic:SetInterval("15")')
check("interval as text from the UI", lua.eval("Logic.nEvery"), 15)
lua.execute('Logic:SetAuto("new")')
check("new adults uses the interval too: first check at once", checks_in(1), 1)
check("new adults: then nothing for 14 s", checks_in(14), 0)
lua.execute('Logic:SetAuto("off"); Logic:SetInterval(1)')

# 6e. Contraception (independent of auto). Habitat 700: mother 80, father 81,
#     newborn son 82, newborn daughter 83, unrelated female 84; vivarium 500:
#     mother 85 + infant son 86.
lua.execute("""
animals[80] = {hab=700, age="A", sex="f", parents={0, 0}}
animals[81] = {hab=700, age="A", sex="m", parents={0, 0}}
animals[82] = {hab=700, age="J", sex="m", parents={80, 81}}
animals[83] = {hab=700, age="J", sex="f", parents={80, 81}}
animals[84] = {hab=700, age="A", sex="f", parents={0, 0}}
animals[85] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
animals[86] = {hab=0, ex=500, q=0, sex="m", parents={85, 0}}
""")
def contra_on():
    return sorted(i for i in range(80, 100) if lua.eval(f"animals[{i}] and animals[{i}].contra") is True)
reset_sent()
lua.execute('engineCrashes = 0; Logic:SetAuto("off"); Logic:SetContra(true); Logic:SetContraKeys(""); Logic:Tick()')
check("contraception, auto off: newborns with a parent of the other sex", contra_on(), [82, 83, 86])
check("contraception, auto off: nobody sent", [i for i in sent() if i >= 80], [])
check("contraception: summary event", ui_events("PZ2AutoHub_ContraStatus")[-1][1:], [3, 0])
check("contraception: keys handed to the UI to save", ui_events("PZ2AutoHub_ContraKeys")[-1][0], "1082:on,1083:on,1086:on")
check("contraception: no exhibit calls on gone animals", lua.eval("engineCrashes"), 0)
lua.execute('Logic:Tick(); Logic:Tick()')
check("contraception: nothing new on the next checks", ui_events("PZ2AutoHub_ContraStatus")[-1][1:], [0, 0])
# the player switches the daughter's contraception off by hand: it stays off
lua.execute('animals[83].contra = false; Logic:Tick(); Logic:Tick()')
check("contraception switched off by hand stays off", contra_on(), [82, 86])
check("contraception: remembered as the player's choice", lua.eval('Logic.tContra["1083"]'), "player")
# the son moves to a habitat without relatives: AutoHub takes it off again
lua.execute('animals[82].hab = 200; Logic:Tick()')
check("contraception taken off once it lives without relatives", contra_on(), [86])
check("contraception: off reported with reason", [str(v) for v in ui_events("PZ2AutoHub_Contra")[-1][1:]],
      ["no parent or sibling of the other sex here", "False"])
check("contraception: forgotten after taking it off", lua.eval('Logic.tContra["1082"]'), None)
# contraception the player set themselves is never taken off
lua.execute('animals[82].contra = true; Logic:Tick()')
check("contraception set by the player is left alone", contra_on(), [82, 86])
lua.execute('animals[82].contra = false')
# same-sex parent only: no contraception; an opposite-sex half-sibling counts with the sibling rule
lua.execute('animals[88] = {hab=700, age="J", sex="m", parents={81, 0}}; animals[83].hab = 0')
lua.execute('Logic:SetSiblings(false); Logic:Tick()')
check("son living only with his father: no contraception", 88 in contra_on(), False)
lua.execute('animals[83].hab = 700; Logic:SetSiblings(true); Logic:Tick()')
check("with the sibling rule: half-sister of the other sex counts", 88 in contra_on(), True)
# saved list from the UI is read back (new park load)
lua.execute('Logic:SetContraKeys("1082:on,1083:player,bad,1099:x")')
check("saved keys read back", sorted(lua.eval('Logic:_ContraText()').split(",")), ["1082:on", "1083:player"])
# both: auto "always" + contraception in one tick; an adult child living with
# its mother is sent and newborns still get contraception
reset_sent()
lua.execute('Logic:SetContraKeys(""); animals[89] = {hab=700, age="A", sex="m", parents={80, 0}}; animals[90] = {hab=700, age="J", sex="f", parents={80, 81}}')
lua.execute('engineCrashes = 0; Logic:SetAuto("always"); Logic:Tick()')
check("both: adult son of 80 sent", 89 in sent(), True)
check("both: new daughter gets contraception", 90 in contra_on(), True)
check("both: no exhibit calls on gone animals", lua.eval("engineCrashes"), 0)
# contraception off: nothing is touched any more
lua.execute('Logic:SetAuto("off"); Logic:SetContra(false); animals[91] = {hab=700, age="J", sex="m", parents={80, 0}}; Logic:Tick()')
check("contraception off: newborn untouched", 91 in contra_on(), False)
for i in range(80, 92):
    lua.execute(f'animals[{i}] = nil')

# 7. Diagnose runs without errors
lua.execute('Logic:Diagnose("", "200")')
logs = [e[0] for e in ui_events("PZ2AutoHub_Log")]
check("diagnose produced lines", len(logs) >= 5, True)
for line in logs[-7:]:
    print("   log:", line)

# 8. Settings per kind and the actions (Quick Trade / Quick Release)
def moved(name):
    return sorted(lua.eval(name).values())

def reset_moves():
    lua.execute('sent = {}; sold = {}; released = {}; Logic.tHold = {}; Logic.tPending = {}')

lua.execute("""
Logic:SetAuto("off"); Logic:SetContra(false); treeDelay = false
animals[120] = {hab=700, age="A", sex="f", parents={0, 0}}
animals[121] = {hab=700, age="A", sex="m", parents={120, 0}}
animals[122] = {hab=700, age="A", sex="f", parents={120, 0}}
""")
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
check("kind config: habitat action", lua.eval("Logic.tCfg.habitat.sAction"), "trade")
check("kind config: vivarium action", lua.eval("Logic.tCfg.exhibit.sAction"), "release")
check("kind config: unknown action falls back to storage",
      lua.eval('(function() Logic:SetKindCfg("aquarium,1,off,1,0,eat"); return Logic.tCfg.aquarium.sAction end)()'), "storage")
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("Quick Trade: both children sold", moved("sold"), [121, 122])
check("Quick Trade: nobody sent to storage", moved("sent"), [])
check("Quick Trade: result says sold", "sold " in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
check("Quick Trade: result has the amount", "for 1,235" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
earned = ui_events("PZ2AutoHub_Earned")
check("Quick Trade: earnings per kind", [[str(v) for v in e] for e in earned[-2:]], [["habitat", "trade", "1234.6"]] * 2)

# refused by the game -> Animal Storage, with the reason
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[122].noTrade = true')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("Quick Trade refused: sold the allowed one", moved("sold"), [121])
check("Quick Trade refused: sent the other to storage", moved("sent"), [122])
notes = str(ui_events("PZ2AutoHub_Result")[-1][2])
check("Quick Trade refused: note says why", "Quick Trade not possible: the game does not allow Quick Trade" in notes
      and "sent to Animal Storage instead" in notes, True)

# Quick Release
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[122].noTrade = nil')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("Quick Release: both released", moved("released"), [121, 122])
check("Quick Release: earnings", [list(e) for e in ui_events("PZ2AutoHub_Earned")[-2:]], [["habitat", "release", 200]] * 2)

# the game has animal moves switched off: everything goes to storage
lua.execute('animals[121].hab = 700; animals[122].hab = 700; movesOn = false')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("moves off: nobody released", moved("released"), [])
check("moves off: both sent to storage", moved("sent"), [121, 122])
check("moves off: note says why", "animal moves switched off" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
lua.execute('movesOn = true')

# release value still loading (aquarium animals in-game said "0"): wait for it
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[121].lazy = true; animals[122].lazy = true; animals[122].releaseValue = 75')
reset_moves()
lua.execute('dataDelay = false; Logic:SendFromHabitat("", "700")')
check("value loads at once: released", moved("released"), [121, 122])
check("value loads at once: real values", sorted(e[2] for e in ui_events("PZ2AutoHub_Earned")[-2:]), [75, 200])
lua.execute('animals[121].hab = 700; animals[122].hab = 700; dataLoaded = {}; dataRequests = {}; dataDelay = true; clock = 100')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("value loading: nobody released yet", moved("released"), [])
check("value loading: nobody sent to storage", moved("sent"), [])
check("value loading: result says so", "values still loading for 2 animals" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
check("value loading: the game was asked", len(lua.eval("dataRequests")) >= 2, True)
lua.execute('deliverData(); clock = 103; Logic:SendFromHabitat("", "700")')
check("value loaded: released", moved("released"), [121, 122])
check("value loaded: real values", sorted(e[2] for e in ui_events("PZ2AutoHub_Earned")[-2:]), [75, 200])
# the data never comes: after nValueWait the animal goes anyway, for 0
# ("Worth 0: anyway"; the default sends it to storage, see below)
lua.execute('Logic.tCfg.habitat.bZeroToStorage = false')
lua.execute('animals[121].hab = 700; animals[122].hab = 700; dataLoaded = {}; dataRequests = {}; Logic.tValueWait = {}; clock = 200')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700"); clock = 210; Logic:SendFromHabitat("", "700")')
check("still loading after 10 s: waits", moved("released"), [])
lua.execute('clock = 216; Logic:SendFromHabitat("", "700")')
check("after 15 s: released anyway", moved("released"), [121, 122])
check("after 15 s: value 0", [e[2] for e in ui_events("PZ2AutoHub_Earned")[-2:]], [0, 0])
# a real 0 (data loaded) does not wait
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[121].releaseValue = 0; animals[122].releaseValue = 0; dataDelay = false; deliverData(); Logic.tValueWait = {}')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("real 0 with data loaded: no waiting", moved("released"), [121, 122])
# Worth 0 -> Animal Storage (the default)
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[122].releaseValue = 50; Logic.tValueWait = {}')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release,1;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
check("kind config: worth 0 -> storage", lua.eval("Logic.tCfg.habitat.bZeroToStorage"), True)
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("worth 0: sent to storage", moved("sent"), [121])
check("worth 0: the other one released", moved("released"), [122])
check("worth 0: note says why", "the game says it is worth 0, sent to Animal Storage instead" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
check("kind config: left out keeps worth 0", lua.eval("Logic.tCfg.habitat.bZeroToStorage"), True)
# vivarium worth 0
lua.execute("""
animals[67] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
animals[68] = {hab=0, ex=500, q=1, sex="m", parents={67, 0}}
""")
lua.execute('zeroExhibitValue = true; Logic:SetKindCfg("habitat,1,off,1,0,release,1;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release,1")')
reset_moves()
lua.execute('engineCrashes = 0; Logic:SendFromHabitat("", "500")')
check("vivarium worth 0: sent to storage", 68 in moved("sent") and 68 not in moved("released"), True)
check("vivarium worth 0: no engine crash", lua.eval("engineCrashes"), 0)
lua.execute('zeroExhibitValue = false; animals[67] = nil; animals[68] = nil')
lua.execute('animals[121].releaseValue = nil; animals[122].releaseValue = nil; Logic.tCfg.habitat.bZeroToStorage = false')
lua.execute('animals[121].lazy = nil; animals[122].lazy = nil; animals[121].releaseValue = nil; animals[122].releaseValue = nil; dataDelay = false; clock = 0')
# auto mode keeps a waiting animal and releases it once the value is there
lua.execute('animals[121].hab = 700; animals[121].lazy = true; dataLoaded = {}; dataRequests = {}; dataDelay = true; Logic.tValueWait = {}; clock = 300')
lua.execute('Logic:SetKindCfg("habitat,1,always,1,0,release;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
reset_moves()
lua.execute('Logic:Tick(); Logic:Tick()')
check("auto: waits for the value", 121 in moved("released"), False)
lua.execute('deliverData(); clock = 302; Logic:Tick(); Logic:Tick()')
check("auto: released once loaded", 121 in moved("released"), True)
check("auto: with its value", list(ui_events("PZ2AutoHub_AutoSent")[-1])[4], 200)
lua.execute('animals[121].lazy = nil; dataDelay = false; clock = 0')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release")')
lua.execute('animals[121].hab = 700; animals[122].hab = 700')

# keep good genes: animals that have to leave are kept in storage when
# their genes reach every limit, the others are sold
lua.execute("""
animals[121].hab = 700; animals[122].hab = 700
animals[121].genes = { nSize = 0.62, nLongevity = 0.55, nFertility = 0.7, nImmunity = 0.1 }
animals[122].genes = { nSize = 0.62, nLongevity = 0.55, nFertility = 0.3, nImmunity = 0.9 }
Logic.tValueWait = {}
""")
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade,1,1,50,50,50,0,g,g;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
check("genes config: limits", [lua.eval(f"Logic.tCfg.habitat.tMinGenes.{g}") for g in ("Size", "Longevity", "Fertility", "Immunity")], [50, 50, 50, 0])
check("genes config: on", lua.eval("Logic.tCfg.habitat.bGenes"), True)
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("good genes: kept in storage", moved("sent"), [121])
check("low fertility: sold", moved("sold"), [122])
notes = str(ui_events("PZ2AutoHub_Result")[-1][2])
check("good genes: note with the values", "good genes (Vitality 62, Longevity 55, Fertility 70, Immunity 10): kept for breeding" in notes, True)
# males always sold: the good male goes too
lua.execute('animals[121].hab = 700; animals[122].hab = 700')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade,1,1,50,50,50,0,a,g;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
check("genes config: males always", lua.eval("Logic.tCfg.habitat.sMale"), "always")
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("males always: both sold", moved("sold"), [121, 122])
# genes unknown: kept (safe side)
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[122].noGenes = true')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("genes unknown: kept", moved("sent"), [122])
lua.execute('animals[122].noGenes = nil')
# percent scale (values above 1) works the same
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[122].genes = { nSize = 80, nLongevity = 80, nFertility = 80, nImmunity = 80 }')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("percent scale: good female kept", moved("sent"), [122])
# switched off: everyone is sold as before
lua.execute('animals[121].hab = 700; animals[122].hab = 700')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade,1,0;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("genes off: all sold", moved("sold"), [121, 122])
check("genes off: limits kept", lua.eval("Logic.tCfg.habitat.tMinGenes.Fertility"), 50)
# vivarium genes (by UID); the fake reuses IDs 69-71 with new parents
# (real GUIDs are never reused), so the remembered facts go
lua.execute("""
Logic.tStatic = {}
animals[69] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
animals[70] = {hab=0, ex=500, q=1, sex="f", parents={69, 0}, genes = { nSize = 0.9, nLongevity = 0.9, nFertility = 0.9, nImmunity = 0.9 }}
animals[71] = {hab=0, ex=500, q=1, sex="m", parents={69, 0}}
""")
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade,1,0;aquarium,1,off,1,0,storage;exhibit,1,off,0,0,trade,1,1,50,50,50,0,g,g")')
reset_moves()
lua.execute('engineCrashes = 0; Logic:SendFromHabitat("", "500")')
check("vivarium genes: good one kept", 70 in moved("sent") and 70 not in moved("sold"), True)
check("vivarium genes: weak one sold", 71 in moved("sold"), True)
check("vivarium genes: no engine crash", lua.eval("engineCrashes"), 0)
for i in (69, 70, 71):
    lua.execute(f'animals[{i}] = nil')
lua.execute('animals[121].genes = nil; animals[122].genes = nil; animals[121].hab = 700; animals[122].hab = 700')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release,1,0;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,release,1,0")')

# vivarium: release by UID, sale from the exhibit
lua.execute("""
animals[60] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
animals[61] = {hab=0, ex=500, q=1, sex="m", parents={60, 0}}
animals[62] = {hab=0, ex=500, q=1, sex="f", parents={60, 0}}
""")
reset_moves()
lua.execute('engineCrashes = 0; Logic:SendFromHabitat("", "500")')
check("vivarium Quick Release: children released", [n for n in moved("released") if n >= 60], [61, 62])
check("vivarium Quick Release: earnings", [list(e) for e in ui_events("PZ2AutoHub_Earned")[-2:]], [["exhibit", "release", 30]] * 2)
check("vivarium Quick Release: no engine crash", lua.eval("engineCrashes"), 0)
lua.execute('animals[61].ex = 500; animals[62].ex = 500')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,release;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
reset_moves()
lua.execute('engineCrashes = 0; Logic:SendFromHabitat("", "500")')
check("vivarium Quick Trade: children sold", [n for n in moved("sold") if n >= 60], [61, 62])
check("vivarium Quick Trade: earnings", [list(e) for e in ui_events("PZ2AutoHub_Earned")[-2:]], [["exhibit", "trade", 75]] * 2)
check("vivarium Quick Trade: no engine crash", lua.eval("engineCrashes"), 0)

# auto per kind: habitats on Always, vivariums Off -> only the habitat moves
lua.execute('animals[121].hab = 700; animals[122].hab = 700; animals[61].ex = 500; animals[62].ex = 500')
lua.execute('Logic:SetKindCfg("habitat,1,always,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
reset_moves()
lua.execute('Logic:Tick(); Logic:Tick()')
check("auto per kind: habitat children sold", [n for n in moved("sold") if n >= 120], [121, 122])
check("auto per kind: vivarium untouched", [n for n in moved("sold") + moved("sent") + moved("released") if 60 <= n < 70], [])
autosent = ui_events("PZ2AutoHub_AutoSent")[-1]
check("auto per kind: notification names the action", str(autosent[2]), "trade")
check("auto per kind: notification has the value", autosent[4], 1234.6)
# no value from the game: -1 (unknown) in the earnings, "an unknown amount" in the notes
lua.execute('animals[121].hab = 700; animals[121].noValue = true')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "700")')
check("unknown value: earnings get -1", list(ui_events("PZ2AutoHub_Earned")[-1]), ["habitat", "trade", -1])
check("unknown value: note says so", "for an unknown amount" in str(ui_events("PZ2AutoHub_Result")[-1][2]), True)
lua.execute('animals[121].noValue = nil')
lua.execute('Logic:SetKindCfg("habitat,1,always,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')

# brother + sister per kind: off for vivariums -> the siblings stay there
lua.execute("""
animals[63] = {hab=0, ex=500, q=2, sex="m", parents={98, 97}}
animals[64] = {hab=0, ex=500, q=2, sex="f", parents={98, 97}}
animals[60].ex = 0; animals[61].ex = 0; animals[62].ex = 0
""")
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,0,0,trade")')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "500")')
check("siblings off for vivariums: they stay", [n for n in moved("sold") if n in (63, 64)], [])
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,trade;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,trade")')
reset_moves()
lua.execute('Logic:SendFromHabitat("", "500")')
check("siblings on for vivariums: both leave", [n for n in moved("sold") if n in (63, 64)], [63, 64])

# contraception per kind: on for habitats only
lua.execute("""
animals[123] = {hab=700, age="J", sex="m", parents={120, 0}}
animals[65] = {hab=0, ex=500, q=0, sex="m", parents={66, 0}}
animals[66] = {hab=0, ex=500, q=2, sex="f", parents={0, 0}}
Logic:SetContraKeys("")
""")
lua.execute('Logic:SetKindCfg("habitat,1,off,1,1,storage;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage"); Logic:Tick(); Logic:Tick()')
check("contraception per kind: habitat newborn on", lua.eval("animals[123].contra"), True)
check("contraception per kind: vivarium newborn untouched", lua.eval("animals[65].contra"), None)
for i in list(range(120, 124)) + list(range(60, 67)):
    lua.execute(f'animals[{i}] = nil')
lua.execute('Logic:SetKindCfg("habitat,1,off,1,0,storage;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage")')

# 9. "Who leaves: grown up here": adults the player placed stay, animals
# that grew up in the habitat leave
lua.execute("""
Logic.tYoung = {}; Logic.tSeenIn = {}; Logic.tYoungMiss = {}; Logic.tHold = {}; Logic.tPending = {}
Logic:SetContraKeys("")
animals[130] = {hab=700, age="A", sex="f", parents={0, 0}}       -- placed mother
animals[131] = {hab=700, age="A", sex="m", parents={130, 0}}     -- placed adult son
animals[132] = {hab=700, age="J", sex="f", parents={130, 0}}     -- daughter born here
""")
lua.execute('Logic:SetKindCfg("habitat,1,always,1,1,storage,1,0,0,0,0,0,g,g,g;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage")')
check("grown up here: config", lua.eval("Logic.tCfg.habitat.bGrownOnly"), True)
reset_moves()
lua.execute('Logic:Tick(); Logic:Tick()')
check("grown up here: placed son stays with his mother", 131 in moved("sent"), False)
check("grown up here: young daughter remembered", lua.eval('Logic.tYoung["1132"]'), True)
young = ui_events("PZ2AutoHub_YoungKeys")
check("grown up here: list goes to the UI", bool(young) and "1132" in str(young[-1][0]), True)
check("grown up here: young daughter gets contraception", lua.eval("animals[132].contra"), True)
check("grown up here: placed son gets none", lua.eval("animals[131].contra"), None)
lua.execute('animals[132].age = "A"; Logic:Tick(); Logic:Tick()')
check("grown up here: grown daughter leaves", 132 in moved("sent"), True)
check("grown up here: her placed brother stays", 131 in moved("sent"), False)
# "all related" (the old way): the placed son leaves too
lua.execute('animals[132].hab = 700; Logic.tHold = {}')
lua.execute('Logic:SetKindCfg("habitat,1,always,1,0,storage,1,0,0,0,0,0,g,g,a;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage")')
reset_moves()
lua.execute('Logic:Tick(); Logic:Tick()')
check("all related: placed son leaves", 131 in moved("sent"), True)
# the saved list comes back from the UI
lua.execute('Logic:SetYoungKeys("1132,1999")')
check("saved list restored", [lua.eval('Logic.tYoung["1132"]'), lua.eval('Logic.tYoung["1999"]')], [True, True])
# moved to another habitat as an adult: placed there, forgotten
lua.execute("""
animals[131].hab = 700; animals[132].hab = 700; Logic.tHold = {}
Logic:SetKindCfg("habitat,1,always,1,0,storage,1,0,0,0,0,0,g,g,g;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage")
""")
reset_moves()
lua.execute('animals[132].hab = 200; Logic:Tick()')
check("moved as an adult: forgotten", lua.eval('Logic.tYoung["1132"]'), None)
# gone (sent away, in storage): forgotten after a few passes
lua.execute('for i = 1, 4 do Logic:Tick() end')
check("gone: unknown key forgotten", lua.eval('Logic.tYoung["1999"]'), None)
for i in (130, 131, 132):
    lua.execute(f'animals[{i}] = nil')
lua.execute('Logic.tYoung = {}; Logic.tSeenIn = {}; Logic:SetKindCfg("habitat,1,off,1,0,storage,1,0,0,0,0,0,g,g,a;aquarium,1,off,1,0,storage;exhibit,1,off,1,0,storage")')

# crash 2026-10-18: GetAnimalsInExhibit on exhibit 520 (listed by
# GetAllExhibits, but EntityIsExhibit says no) crashed the engine
lua.execute('engineCrashes = 0; Logic:SetAuto("always"); for i = 1, 12 do Logic:Tick() end; Logic:CheckAll(); Logic:Diagnose("", "510")')
check("crash case: no exhibit calls on a dead exhibit or non-exhibit animal", lua.eval("engineCrashes"), 0)

# crash 2026-10-18 13:06: back to the main menu, the HUD still ticked while
# the park world was torn down. Once DarwinWorld deactivates, no game calls.
lua.execute("""
worldCalls = 0
local realAPIs = api.world.GetWorldAPIs
api.world.GetWorldAPIs = function()
  local tOut = {}
  for sName, t in pairs(realAPIs()) do
    tOut[sName] = setmetatable({}, { __index = function(_, k)
      local f = t[k]
      if type(f) ~= "function" then return f end
      return function(_, ...) worldCalls = worldCalls + 1; return f(t, ...) end
    end })
  end
  return tOut
end
""")
lua.execute('Logic:SetParkLive(false); worldCalls = 0; for i = 1, 12 do Logic:Tick() end; Logic:CheckAll(); Logic:SendFromHabitat("", "510"); Logic:Diagnose("", "510")')
check("park closing: no game calls at all", lua.eval("worldCalls"), 0)
lua.execute('Logic:SetParkLive(true); worldCalls = 0; Logic:CheckAll()')
check("park active again: checks work", lua.eval("worldCalls") > 0, True)

sys.exit(1 if failures else 0)
