// Only one page can replace the game's HUD.html. When Mike's QoL Toolbox
// (PZ2QoL), PZ2Guardian, PZ2Studbook, PZ2TimeWarp or PZ2BreedAdvisor is
// installed too, this page may take its place, so load their UI here as
// well. A mod that is not installed simply fails to import.
//
// The Toolbox builds its park launcher (Species board, Autosave) only on a
// page whose path contains "PZ2QoLHUD". Its script runs here, so the page
// takes that name before the import (same folder, nothing reloads; the
// view keeps its real address).
try {
    if (!/PZ2QoLHUD/i.test(String(window.location.pathname)) && window.history && window.history.replaceState) {
        window.history.replaceState(window.history.state, '', 'PZ2QoLHUD.html');
    }
}
catch (e) {
    // no history API: the Toolbox runs without its launcher
}
import('/js/mods/pz2qol/main.js').catch(() => { });
import('/js/mods/pz2guardian/main.js').catch(() => { });
import('/js/mods/pz2studbook/main.js').catch(() => { });
import('/js/mods/pz2timewarp/main.js').catch(() => { });
import('/js/mods/pz2breedadvisor/main.js').catch(() => { });
