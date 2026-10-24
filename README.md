# AutoHub for Planet Zoo 2 (version 1.4.2)

Finds related animals living together and moves them out (to Animal
Storage, by Quick Trade or by Quick Release), or puts the young ones on
contraception, so your habitats don't inbreed.

## Install (about 30 seconds)

1. In Steam: right-click Planet Zoo 2 > Manage > Browse local files.
   This opens your game folder (the one with PlanetZoo2.exe).
2. Copy the "Win64" folder from the zip into that game folder.
   Windows will say the folder already exists: choose "Replace" / merge.
   Nothing of the game is overwritten; only a new PZ2AutoHub folder is
   added.
3. Check it worked: this file should now exist:
   `Planet Zoo 2\Win64\ovldata\PZ2AutoHub\Main.ovl`
4. Start the game. It shows its normal one-time "modifications detected"
   notice; that is expected.

## Uninstall

Delete the folder `Planet Zoo 2\Win64\ovldata\PZ2AutoHub`

## Updating

Copy the new "Win64" folder over the old one and choose "Replace".

## Where to find it in game

In a park: press Esc. Next to the game's menu (Save, Load, Settings...)
is a "Mods" box with an "AutoHub" button that opens the panel.

There is also an "AutoHub" button on the left of the screen. Drag it to
move it; right-click puts it back. Don't want it on screen? Switch
"Screen button" off under Settings; AutoHub then lives in the
Esc menu only.

Too big or too small? "Size" under Settings (50-200 %).

## Habitats, aquariums and vivariums

AutoHub works in all three, and each one has its own settings: on the
Settings page, pick Habitats, Aquariums or Vivariums and set it up.
Per kind you choose:

- on or off (off: AutoHub doesn't touch this kind; "Check the open
  habitat" still checks one you have open);
- Auto: Off, New adults or Always;
- the action: Animal Storage, Quick Trade or Quick Release;
- the Brother + sister rule;
- Auto contraception.

"Copy to ..." copies the settings of the kind you're looking at to the
other two (each keeps its own on / off).

## Who leaves

AutoHub uses the game's own rule for related animals: a parent and its
child, or two animals with at least one parent in common. In one
habitat or vivarium:

- an ADULT living with its mother or father leaves;
- an ADULT brother and sister (half-siblings too) both leave. This
  rule can be switched off.

Same-sex siblings stay together. Juveniles (not grown up yet) and
elderly animals are never sent. Cousins don't count, as in the game.

Fish shoals (aquariums and vivarium tanks): with 2 or more shoals of the
same species in one tank (a shoal that split in two), all but the
YOUNGEST shoal leave.

## Where they go (the action)

- **Animal Storage** (default): the game's own "Send to Animal Storage".
  A keeper carries them to your Trade Centre; you can bring them back
  later. Your zoo needs a Trade Centre with free storage space, as for
  the normal game action.
- **Quick Trade**: sold at once, as with the game's Quick Trade button.
- **Quick Release**: released into the wild at once, as with the
  game's Quick Release.

The game doesn't allow Quick Trade or Quick Release for every animal
(the same animals whose buttons are greyed out in the game). Those go to
Animal Storage instead, and the log and a notice say why.

Animals the game says are worth 0: by default they go to Animal Storage
instead of being traded or released for nothing. "Worth 0: Anyway"
(per kind, under Settings) trades / releases them anyway.

Each Quick Trade / Release is logged with its amount, as the game shows
it just before the animal goes. "Earnings in this park" on the Overview
page adds them up per kind (habitats, aquariums, vivariums) and for all,
separately for Quick Trade and Quick Release. It is saved per park;
"Reset" (two clicks) starts it over.

## Auto contraception

Switch "Auto contraception" on and newborns living with their mother
or father of the other sex get contraception right away (with the
Brother + sister rule on: also when they live with a brother or sister
of the other sex). It uses the same toggle as the animal's info panel.
Same-sex parent only (a son with his father) is no risk, so nothing
changes then.

- Use it on its own (Auto = Off): animals stay where they are, they
  just can't breed with their family.
- Or together with Auto: the young are on contraception while they
  grow up, and leave (by that kind's action) once they are adults.

When such an animal later lives without those relatives (moved to
another habitat, or placed again from storage), AutoHub takes the
contraception off again. It only does that for animals it put on
contraception itself, and if you switch it off by hand, AutoHub leaves
it off. Off by default.

## The panel

The panel has three pages: Overview, Settings and Log.

**Overview**

| | |
|---|---|
| Table | Per kind: Auto mode, action and contraception, and when the last check ran. |
| Check all | Checks every switched-on habitat, aquarium and vivarium now, each with its own action. Click twice to confirm. |
| Check the open habitat | Checks only the habitat, aquarium or vivarium whose info panel is open. Click twice to confirm. |
| Earnings in this park | Quick Trade and Quick Release: how many animals and the total amount, per kind and for all. Saved per park. Reset: two clicks. |
| Last moved out | The last three animals auto mode moved out. |

**Settings**: pick Habitats, Aquariums or Vivariums, then:

| Setting | What it does |
|---|---|
| Look after | Whether AutoHub looks after this kind at all (on). |
| Auto | Off (default): only the Check buttons move animals. New adults: acts when an animal grows up. Always: checks at every check, whenever the animals grew up or moved in (also catches a shoal split). |
| Action | Storage (default), Quick Trade or Quick Release. See "Where they go". |
| Worth 0 | Only with Quick Trade / Release: an animal the game says is worth 0 goes to Storage (default), or is traded / released Anyway. |
| Brother + sister | The sibling rule (on). |
| Contraception | On / off (off). See "Auto contraception" above. |
| Copy to ... | Copies Auto, action, Brother + sister and contraception to the other two kinds; their on / off stays. Click twice to confirm. |
| Check every | How often Auto and contraception check, 1 s to 5 min of real time (default 5 s). Game speed doesn't change it. One setting for all kinds. |
| Size | Panel, button and notices, 50-200 %. |
| Screen button | Show or hide the button on the left of the screen. The panel is always in the Esc menu under "Mods". |
| Help texts | Shows a short explanation under each setting (off). |

**Log**: Diagnose (what the game reports, for bug reports), the log,
everything auto mode moved out this session (how and for how much),
and the contraception changes.

Vivariums: the game loads family data for vivarium animals in the
background. The first check after loading a park may say "family data
is still loading"; check again a few seconds later.

## Compatibility

- Works alongside Guardian: they share the in-park screen and the
  "Mods" box in the Esc menu.
- Works alongside Mike's QoL Toolbox: both share the in-park screen,
  in any install order.
- Settings are kept in your player profile, for all parks, and survive
  a game restart.
- The panel follows the game's UI scale and screen size.

## Changes

### 1.4.2
- New setting "Worth 0" (per kind, with Quick Trade / Quick Release):
  animals the game says are worth 0 go to Animal Storage instead
  (default), or are traded / released anyway.

### 1.4.1
- Fixed: Quick Release from aquariums (and other animals the game had
  not loaded yet) was logged and counted as 0. AutoHub now asks the game
  for the animal's data and waits up to 15 seconds for its value before
  trading or releasing it.
- Diagnose shows the trade and release value of every animal in the
  open habitat or aquarium.

### 1.4.0
- The panel is tidier: three pages (Overview, Settings, Log) instead of
  one long page. Explanations are hidden unless you switch "Help texts"
  on. Chosen options are filled, the others outlined.
- Times show as 13:15:03 instead of with the full time zone name.

### 1.3.1
- Quick Trade and Quick Release are logged with their amount.
- New "Earnings in this park": how many animals were traded or
  released and for how much, per habitat / aquarium / vivarium and for
  all. Saved per park.

### 1.3.0
- Quick Trade and Quick Release: animals that have to leave can now be
  sold or released at once instead of going to Animal Storage. If the
  game doesn't allow it for an animal, it goes to Animal Storage and the
  log says why.
- Every setting is now per kind: habitats, aquariums and vivariums each
  have their own on/off, Auto mode, action, Brother + sister rule and
  contraception. Your old settings are the starting values for all
  three.

### 1.2.1
- Fixed: Auto and auto contraception could stop a few minutes after
  loading a park ("Last check" no longer changed), while the Check
  buttons still worked. The check timer now has three independent
  drivers and warns in the log if checks stop answering.
- Diagnose shows how many ticks were sent and received.

### 1.2.0
- Settings are now saved for good: they were lost every time the
  game closed (the game's UI forgets them). They are now kept in
  your player profile. Set them once more after updating.
- Fixed: Mike's QoL Toolbox and AutoHub could not both run in the
  park; depending on the install, the Toolbox's park features or
  AutoHub's checks did not start. Both now share the in-park screen
  in any order.
- Diagnose also shows which screen AutoHub runs on and whether the
  settings were saved.

### 1.1.0
- Auto contraception: newborns living with a parent (or sibling) of
  the other sex get contraception; it comes off again once they live
  without them. Works with or without Auto.
- AutoHub is now also in the game's Esc menu ("Mods" box), and the
  screen button can be hidden ("Screen button" in the panel).
- Smaller default size: the new 100 % is the old 70 % (range
  50-200 %). A size you set before is kept as it looked.
- The button and panel now use the game's green UI colours.

### 1.0.1
- New Size setting in the panel (50-150 %): makes the panel, button
  and notices smaller or bigger, on top of the automatic scaling.
  Saved for all parks.

### 1.0.0
- First release.

## Problems?

Open the panel and click "Diagnose". It lists what the mod found in the
game, and for every animal in the open habitat its age group, sex and
parents. Post a screenshot of it with your report.

## Notes

- No game files are changed. The only thing written is the mod's own
  small entry in your player profile (its settings); nothing goes
  into park saves or online saves.
- AutoHub only moves animals to Animal Storage. It never sells or
  releases them.
- Unofficial fan mod, not affiliated with Frontier Developments.

Building from source and the release workflow: see [CONTRIBUTING.md](CONTRIBUTING.md).
