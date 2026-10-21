# AutoHub for Planet Zoo 2 (version 1.2.0)

Finds related animals living together and sends them to Animal Storage,
or puts the young ones on contraception, so your habitats don't inbreed.

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
"Screen button" off at the top of the panel; AutoHub then lives in the
Esc menu only.

Too big or too small? "Size" at the top of the panel (50-200 %).

## Habitats, aquariums and vivariums

AutoHub works in all three. Each one has its own switch in the panel
("Look at"), so you can turn off any kind you don't want AutoHub to
touch. Auto mode and "Check all" skip the kinds you switched off;
"Check the open habitat" always checks the one you have open.

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

Animals go with the game's own "Send to Animal Storage": a keeper
carries them to your Trade Centre. Your zoo needs a Trade Centre with
free storage space, as for the normal game action.

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
  grow up, and are sent to Animal Storage once they are adults.

When such an animal later lives without those relatives (moved to
another habitat, or placed again from storage), AutoHub takes the
contraception off again. It only does that for animals it put on
contraception itself, and if you switch it off by hand, AutoHub leaves
it off. Off by default.

## The panel

| Setting | What it does |
|---|---|
| Look at | Habitats / Aquariums / Vivariums: which kinds auto mode and "Check all" look at (all on). |
| Check all | Checks every switched-on habitat, aquarium and vivarium now. Click twice to confirm. |
| Check the open habitat | Checks only the habitat, aquarium or vivarium whose info panel is open. Click twice to confirm. |
| Auto | Off (default): only the Check buttons send animals. New adults: acts when an animal grows up. Always: checks everything at every check, whenever the animals grew up or moved in (also catches a shoal split). |
| Check every | How often auto mode checks, 1 s to 5 min of real time (default 5 s). Game speed doesn't change it. |
| Brother + sister | The sibling rule (on). |
| Auto contraception | On / off (off). See "Auto contraception" above. Uses the same "Look at" switches and "Check every" time as Auto. |
| Screen button | Show or hide the button on the left of the screen. The panel is always in the Esc menu under "Mods". |
| Sent by auto | What auto mode sent this session. A notice also pops up for each animal it sends. |
| Diagnose | What the game reports, for bug reports. |

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
