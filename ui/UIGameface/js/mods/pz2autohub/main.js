// PZ2AutoHub UI. Loaded by PZ2AutoHubHUD.html (or another mod's HUD page)
// after the game's HUDApp.js, so it shares the game's module instances.
//
// An "AutoHub" button (drag to move, right-click to reset) with a panel, in
// the same style as PZ2Guardian and PZ2Studbook. Rules (Lua, as the game
// defines related animals): an adult living with its mother or father
// leaves; an adult brother + sister (shared parent) both leave; of 2+
// shoals of one species in a tank, all but the youngest leave.
//   * Auto (saved, Off by default, all habitats): "New adults" acts when an
//     animal grows up, "Always" keeps checking every habitat (Lua does the
//     work on a tick from here);
//   * Check all now / Check the open habitat (click twice);
//   * Brother + sister switch (saved, on by default);
//   * Contraception (saved, off by default): young animals living with an
//     opposite-sex parent (or sibling) get contraception; Lua takes it off
//     again once they live without them. Works with or without Auto;
//   * Diagnose: what the game reports, for troubleshooting.
//   * an "AutoHub" entry in the game's pause menu (pausemenu.js); the
//     screen button can be hidden.
//
// Event argument counts must match pz2autohub.core.lua, and no event name
// may be both sent and listened to here (engine.trigger also fires this
// page's own engine.on).
import * as DS from '/js/common/core/DataStore.js';
import { DataStoreCollection } from '/js/common/data/DataStoreCollection.js';
import { loadCSS } from '/js/common/util/CSSUtil.js';
import { addPauseMenuEntry, refreshPauseMenu } from './pausemenu.js';

const VERSION = '1.2.0';
const MODE_KEY = 'PZ2AutoHub.mode';
const OLD_AUTO_KEY = 'PZ2AutoHub.auto';
const SIBLINGS_KEY = 'PZ2AutoHub.siblings';
const POS_KEY = 'PZ2AutoHub.buttonPos';
const KINDS_KEY = 'PZ2AutoHub.kinds';
const INTERVAL_KEY = 'PZ2AutoHub.interval';
const CONTRA_KEY = 'PZ2AutoHub.contra';
// animals AutoHub put on contraception, per park: 'PZ2AutoHub.contraKeys.<park>'
const CONTRA_KEYS_PREFIX = 'PZ2AutoHub.contraKeys.';
const SHOW_BTN_KEY = 'PZ2AutoHub.screenButton';
// seconds between auto checks: the - / + buttons step through these
const INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300];
const DEFAULT_INTERVAL = 5;
// switches: which groups auto mode and "Check all" look at (Lua names)
const KINDS = ['habitat', 'aquarium', 'exhibit'];
const KIND_LABELS = { habitat: 'Habitats', aquarium: 'Aquariums', exhibit: 'Vivariums' };
// default spot: slot 3 of the mod button stack (Studbook, Guardian,
// Breeding, AutoHub, Speed) at the left screen edge, centred vertically
function defaultPos() {
    return { x: 0, y: Math.max(0, Math.round(window.innerHeight / 2 - 99 + 3 * 42)) };
}
const PANEL_W = 520; // px at 1920x1080; scaled with uiScale()
const MODES = ['off', 'new', 'always'];
const MODE_LABELS = { off: 'Off', new: 'New adults', always: 'Always' };
const MODE_TIPS = {
    off: 'Only "Check" below sends animals.',
    new: 'All habitats: when an animal grows up next to a parent or an opposite-sex sibling, it (and that sibling) is sent.',
    always: 'All habitats, at every check: everyone who has to leave is sent, no matter when they grew up or moved in.',
};
const TICK_MS = 1000;      // Lua counts these; it checks every `interval` of them
const LOG_LINES = 120;
const SENT_LINES = 40;

let connected = false;
let open = false;
let mode = readMode();
let siblings = readSetting(SIBLINGS_KEY, 'true') === 'true';
let kinds = readKinds();
let interval = readInterval();
let contra = readSetting(CONTRA_KEY, 'false') === 'true';
let showButton = readSetting(SHOW_BTN_KEY, 'show') !== 'hide';
let parkKey = '';
let menuAnchor = null;      // { menu, box } rects while the panel was opened from the pause menu
let contraStatus = '';
const contraLines = [];     // "12:01 Bob: on (lives with its mother)"
let infoPanelContext = null;
let status = { text: '', kind: '' };
let autoStatus = '';
let autoSentTotal = 0;
let checking = '';          // 'all' | 'habitat' while waiting for Lua
let armed = { key: '', until: 0 };
const logLines = [];
const sentLines = [];       // "12:01 Bob (lives with its mother)"

// ------------------------------------------------------------ helpers

function readSetting(key, fallback) {
    try {
        const v = window.localStorage && window.localStorage.getItem(key);
        return v == null ? fallback : v;
    }
    catch (e) {
        return fallback;
    }
}

function saveSetting(key, value) {
    try {
        if (value == null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(value));
    }
    catch (e) {
        // storage unavailable: the setting still works for this session
    }
    keep(key, value);
}

// ------------------------------------------- settings that outlast the game
// The game's UI keeps localStorage in memory only: it is empty after every
// game start. So every setting is also kept in the game's player save
// (Lua: Core.StoreRead / StoreWrite). The saved set comes with the hello and
// is written back into localStorage; changes go to Lua 1.5 s after the last
// one. localStorage stays the copy the page reads.
const STORE_DELAY_MS = 1500;
const STORE_CAP = 60000;    // characters; Lua refuses more
let kept = {};              // key -> string, everything the player save holds
let storeState = 'waiting for the mod';
let storeReady = false;     // the saved set has arrived (or there is none)
let storeTimer = null;

// settings kept for all parks (the contraception lists are per park)
function settingKeys() {
    return [MODE_KEY, SIBLINGS_KEY, POS_KEY, KINDS_KEY, INTERVAL_KEY, CONTRA_KEY, SHOW_BTN_KEY, SIZE_KEY];
}

function keep(key, value) {
    if (value == null) delete kept[key];
    else kept[key] = String(value);
    if (!storeReady) return;
    clearTimeout(storeTimer);
    storeTimer = setTimeout(flushStore, STORE_DELAY_MS);
}

// JSON with every non-ASCII character as \uXXXX (Lua keeps printable ASCII only)
function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

function flushStore() {
    storeTimer = null;
    let text = asciiJson(kept);
    // too big: the other parks' contraception lists go first
    for (const key of Object.keys(kept)) {
        if (text.length <= STORE_CAP) break;
        if (key.startsWith(CONTRA_KEYS_PREFIX) && key != CONTRA_KEYS_PREFIX + parkKey) {
            delete kept[key];
            text = asciiJson(kept);
        }
    }
    if (text.length > STORE_CAP) {
        storeState = `too big to keep (${text.length} characters)`;
        return;
    }
    send('PZ2AutoHub_StoreSave', text);
}

// The hello's saved set (sText = JSON object, "" when nothing is kept yet).
function applyStore(text, status) {
    storeReady = true;
    let saved = null;
    if (status == 'ok' && text) {
        try {
            saved = JSON.parse(text);
        }
        catch (e) {
            saved = null;
        }
    }
    if (saved && typeof saved == 'object' && !Array.isArray(saved)) {
        kept = {};
        for (const [key, value] of Object.entries(saved)) {
            if (typeof key == 'string' && key.startsWith('PZ2AutoHub.') && value != null) kept[key] = String(value);
        }
        try {
            for (const [key, value] of Object.entries(kept)) window.localStorage.setItem(key, value);
        }
        catch (e) {
            // the values below still come from the saved set
        }
        storeState = 'settings loaded from the player save';
        readSettings();
        return;
    }
    // nothing kept yet (first start with this version): keep what this
    // session has
    for (const key of settingKeys()) {
        const v = readSetting(key, null);
        if (v != null) kept[key] = v;
    }
    if (parkKey) {
        const v = readSetting(CONTRA_KEYS_PREFIX + parkKey, null);
        if (v != null) kept[CONTRA_KEYS_PREFIX + parkKey] = v;
    }
    if (status == 'ok' || status == 'unreadable') {
        storeState = status == 'ok' ? 'nothing saved yet' : 'saved settings unreadable, starting over';
        flushStore();
    }
    else {
        storeReady = false;
        storeState = `not available (${status || 'no answer'}): settings last until the game closes`;
    }
}

// (re)reads every setting from localStorage, e.g. after applyStore
function readSettings() {
    mode = readMode();
    siblings = readSetting(SIBLINGS_KEY, 'true') === 'true';
    kinds = readKinds();
    interval = readInterval();
    contra = readSetting(CONTRA_KEY, 'false') === 'true';
    showButton = readSetting(SHOW_BTN_KEY, 'show') !== 'hide';
    sizeSetting = readSize();
    place();
    render();
}

function loadPos() {
    try {
        const p = JSON.parse(readSetting(POS_KEY, 'null'));
        if (p && typeof p.x == 'number' && typeof p.y == 'number') return p;
    }
    catch (e) {
        // default place
    }
    return defaultPos();
}

// Early test builds stored an on/off switch; "on" meant what is now "new".
function readMode() {
    const v = readSetting(MODE_KEY, null);
    if (MODES.includes(v)) return v;
    return readSetting(OLD_AUTO_KEY, 'false') === 'true' ? 'new' : 'off';
}

// all on unless saved otherwise
function readKinds() {
    const t = { habitat: true, aquarium: true, exhibit: true };
    try {
        const saved = JSON.parse(readSetting(KINDS_KEY, 'null'));
        if (saved && typeof saved == 'object') {
            for (const k of KINDS) if (typeof saved[k] == 'boolean') t[k] = saved[k];
        }
    }
    catch (e) {
        // defaults
    }
    return t;
}

function readInterval() {
    const n = Number(readSetting(INTERVAL_KEY, DEFAULT_INTERVAL));
    return INTERVALS.includes(n) ? n : DEFAULT_INTERVAL;
}

function intervalText(n) {
    return n < 60 ? `${n} s` : `${n / 60} min`;
}

function stepInterval(dir) {
    const i = INTERVALS.indexOf(interval);
    const next = INTERVALS[Math.max(0, Math.min(INTERVALS.length - 1, i + dir))];
    if (next == interval) return;
    interval = next;
    saveSetting(INTERVAL_KEY, interval);
    if (connected) send('PZ2AutoHub_SetInterval', interval);
    render();
}

function sendKinds() {
    const on = KINDS.filter(k => kinds[k]);
    send('PZ2AutoHub_SetKinds', on.length ? on.join(',') : 'none');
}

function kindsText() {
    const on = KINDS.filter(k => kinds[k]).map(k => KIND_LABELS[k].toLowerCase());
    return on.length ? on.join(', ') : 'nothing (all switched off)';
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != undefined) e.textContent = text;
    return e;
}

function button(label, onClick, extra) {
    const b = el('div', 'PZ2AH_btn' + (extra ? ' ' + extra : ''), label);
    b.addEventListener('click', e => {
        e.stopPropagation();
        if (b.classList.contains('disabled')) return;
        onClick();
    });
    return b;
}

function section(title) {
    return el('div', 'PZ2AH_title', title);
}

// The UI engine does not scroll plain overflow boxes by itself.
function wheelScroll(box) {
    box.addEventListener('wheel', e => {
        box.scrollTop += e.deltaY > 0 ? 60 : -60;
        e.preventDefault();
        e.stopPropagation();
    });
}

// "sibling of [STRING_LITERAL:Value=|Bob|]" -> "sibling of Bob"
function plainName(raw) {
    if (typeof raw !== 'string') return String(raw);
    return raw.replace(/\[STRING_LITERAL:Value=\|(.*?)\|\]/g, '$1');
}

function addLog(line) {
    String(line).split('\n').forEach(l => logLines.push(l));
    while (logLines.length > LOG_LINES) logLines.shift();
    render();
}

function setStatus(text, kind) {
    status = { text: text || '', kind: kind || '' };
    render();
}

function send(name, ...args) {
    try {
        engine.trigger(name, ...args);
        return true;
    }
    catch (e) {
        addLog(`could not send ${name}: ${e}`);
        return false;
    }
}

// Second click within 4 s confirms.
function confirmClick(key, fn) {
    if (armed.key == key && Date.now() < armed.until) {
        armed = { key: '', until: 0 };
        fn();
        return;
    }
    armed = { key, until: Date.now() + 4000 };
    setTimeout(render, 4100);
    render();
}
function isArmed(key) {
    return armed.key == key && Date.now() < armed.until;
}

// ------------------------------------------------------ open info panel

// Child contexts of a DataStore context. The direct getter only answers in
// debug builds, so normally a short-lived collection listens until the game
// delivers the children (asynchronously) or the timeout passes.
function childrenOf(context, timeoutMs = 700) {
    try {
        const list = DS.__getChildrenOfContext(context);
        if (Array.isArray(list) && list.length) return Promise.resolve(list);
    }
    catch (e) {
        // not available in this build
    }
    return new Promise(resolve => {
        let col = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            const list = col ? col._source.slice() : [];
            try {
                if (col) col.dispose();
            }
            catch (e) {
                // already gone
            }
            resolve(list);
        };
        try {
            col = new DataStoreCollection(context);
        }
        catch (e) {
            resolve([]);
            return;
        }
        if (col._source.length) {
            finish();
            return;
        }
        const signal = col.onChange || col._onChange;
        if (signal && signal.add) signal.add(() => {
            if (col._source.length) setTimeout(finish, 50);
        });
        setTimeout(finish, timeoutMs);
    });
}

// IDs of the animals listed in the open habitat panel's Animals tab
// (all species, not only the one shown in the carousel).
async function listedAnimalIDs() {
    const ids = new Set();
    if (!infoPanelContext) return [];
    for (const tab of await childrenOf(infoPanelContext.concat('tabs'))) {
        for (const species of await childrenOf(tab.concat('speciesList'), 400)) {
            for (const animal of await childrenOf(species.concat('animalsList'), 400)) {
                let id;
                try {
                    id = DS.getValue(animal, 'id');
                }
                catch (e) {
                    id = undefined;
                }
                if (id != undefined && String(id).length > 0) ids.add(String(id));
            }
        }
    }
    return [...ids];
}

// Last element of the info panel context, e.g. "501309" in
// ["infopanel", "habitatGateInfoPanel", "501309"]: Lua tries it as habitat.
function panelEntityID() {
    if (!infoPanelContext || !infoPanelContext.length) return '';
    return String(infoPanelContext[infoPanelContext.length - 1]);
}

function visibleElement(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    for (let n = node; n && n != document.body; n = n.parentNode) {
        if (n.classList && n.classList.contains('hidden')) return null;
    }
    return node;
}

// Only offered while the game's info panel is on screen (a habitat's or a
// vivarium's; Lua says so if it is neither).
function infoPanelOpen() {
    return !!(infoPanelContext && visibleElement('.InfoPanel_scrollPane'));
}

// ------------------------------------------------------------ checks

function checkAll() {
    if (!connected) return;
    checking = 'all';
    setStatus(`Checking ${kindsText()}…`, 'muted');
    send('PZ2AutoHub_CheckAll', 1);
    noAnswerLater();
}

function checkHabitat() {
    if (!connected) return;
    checking = 'habitat';
    setStatus('Checking the open habitat…', 'muted');
    listedAnimalIDs().then(ids => {
        if (!ids.length && !panelEntityID()) {
            checking = '';
            setStatus('Could not read the animals of this habitat. Try Diagnose.', 'warn');
            return;
        }
        send('PZ2AutoHub_SendFromHabitat', ids.join(','), panelEntityID());
        noAnswerLater();
    });
}

function noAnswerLater() {
    setTimeout(() => {
        if (checking) {
            checking = '';
            setStatus('No answer from the mod. Please click Diagnose and send a screenshot.', 'warn');
        }
    }, 8000);
}

function diagnose() {
    if (!connected) {
        addLog('Mod Lua is not connected (no hello from the game yet).');
        return;
    }
    listedAnimalIDs().then(ids => {
        addLog(`UI ${VERSION}: panel context ${JSON.stringify(infoPanelContext)}; ${ids.length} listed animals`);
        addLog(`recent panels: ${panelHistory.join('  ') || 'none'}`);
        addLog(scaleInfo());
        addLog(`settings: ${storeState}; page ${window.location && window.location.pathname}`);
        send('PZ2AutoHub_Diagnose', ids.join(','), panelEntityID());
    });
}

// ------------------------------------------------------------------ UI
let btn = null;
let panel = null;

function labelText() {
    const tParts = [];
    if (mode != 'off') tParts.push(MODE_LABELS[mode]);
    if (contra) tParts.push('Contraception');
    return tParts.length ? `AutoHub · ${tParts.join(' + ')}` : 'AutoHub';
}

function label() {
    refreshPauseMenu();
    if (!btn) return;
    btn.textContent = labelText();
    btn.classList.toggle('attention', status.kind == 'warn');
}

function render() {
    label();
    if (!panel || !open) return;
    const nTop = panel.scrollTop;
    const tBoxTops = Array.from(panel.querySelectorAll('.PZ2AH_box')).map(b => b.scrollTop);
    panel.textContent = '';

    const head = el('div', 'PZ2AH_row');
    head.appendChild(el('div', 'PZ2AH_name', `AutoHub ${VERSION}`));
    head.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', connected ? 'inbreeding check → Animal Storage' : 'not connected'));
    head.appendChild(button('Diagnose', diagnose));
    head.appendChild(button('Close', () => toggle(false)));
    panel.appendChild(head);
    const sizeRow = el('div', 'PZ2AH_row');
    sizeRow.appendChild(el('div', 'PZ2AH_dim', 'Size'));
    sizeRow.appendChild(button('−', () => stepSize(-1), 'small' + (sizeSetting <= SIZE_MIN ? ' disabled' : '')));
    sizeRow.appendChild(el('div', 'PZ2AH_name', `${Math.round(sizeSetting * 100)}%`));
    sizeRow.appendChild(button('+', () => stepSize(1), 'small' + (sizeSetting >= SIZE_MAX ? ' disabled' : '')));
    sizeRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', 'of the panel, button and notices, on top of the game\'s UI scale (saved).'));
    panel.appendChild(sizeRow);
    const btnRow = el('div', 'PZ2AH_row');
    btnRow.appendChild(button(`Screen button: ${showButton ? 'on' : 'off'}`, () => {
        showButton = !showButton;
        saveSetting(SHOW_BTN_KEY, showButton ? 'show' : 'hide');
        place();
        render();
    }, showButton ? 'on' : ''));
    btnRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', showButton
        ? 'AutoHub is also in the game menu (Esc → Mods).'
        : 'Open AutoHub from the game menu: Esc → Mods → AutoHub.'));
    panel.appendChild(btnRow);
    panel.appendChild(el('div', 'PZ2AH_dim', 'Leaves: adults living with a parent, adult brother + sister pairs (both), and older fish shoals when a species has 2+ shoals in one tank.'));

    panel.appendChild(section('Look at'));
    const kindRow = el('div', 'PZ2AH_row');
    for (const k of KINDS) {
        const b = button(`${KIND_LABELS[k]}: ${kinds[k] ? 'on' : 'off'}`, () => {
            kinds[k] = !kinds[k];
            saveSetting(KINDS_KEY, JSON.stringify(kinds));
            if (connected) sendKinds();
            render();
        }, kinds[k] ? 'on' : '');
        b.title = `Auto and "Check all" ${kinds[k] ? 'check' : 'skip'} ${KIND_LABELS[k].toLowerCase()}.`;
        kindRow.appendChild(b);
    }
    kindRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', 'For Auto and "Check all". "Check the open habitat" always checks the open one.'));
    panel.appendChild(kindRow);

    panel.appendChild(section(`Auto: send to Animal Storage (${kindsText()})`));
    const autoRow = el('div', 'PZ2AH_row');
    for (const m of MODES) {
        const b = button(MODE_LABELS[m], () => {
            mode = m;
            saveSetting(MODE_KEY, mode);
            if (connected) send('PZ2AutoHub_SetAuto', mode);
            autoStatus = mode == 'off' ? '' : 'starting…';
            render();
        }, m == mode ? 'on' : '');
        b.title = MODE_TIPS[m];
        autoRow.appendChild(b);
    }
    autoRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', MODE_TIPS[mode]));
    panel.appendChild(autoRow);
    const everyRow = el('div', 'PZ2AH_row');
    everyRow.appendChild(el('div', 'PZ2AH_dim', 'Check every'));
    const iNow = INTERVALS.indexOf(interval);
    const minus = button('−', () => stepInterval(-1), 'small' + (iNow <= 0 ? ' disabled' : ''));
    minus.title = 'Check more often';
    everyRow.appendChild(minus);
    everyRow.appendChild(el('div', 'PZ2AH_name', intervalText(interval)));
    const plus = button('+', () => stepInterval(1), 'small' + (iNow >= INTERVALS.length - 1 ? ' disabled' : ''));
    plus.title = 'Check less often';
    everyRow.appendChild(plus);
    everyRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', 'real seconds, whatever the game speed. Shorter = faster at high speed; in a very big zoo 1-2 s can cost frame rate.'));
    panel.appendChild(everyRow);
    if (mode != 'off') panel.appendChild(el('div', 'PZ2AH_dim', `Last check: ${autoStatus || 'waiting for the mod…'}`));

    const sibRow = el('div', 'PZ2AH_row');
    sibRow.appendChild(button(`Brother + sister: ${siblings ? 'on' : 'off'}`, () => {
        siblings = !siblings;
        saveSetting(SIBLINGS_KEY, siblings);
        if (connected) send('PZ2AutoHub_SetSiblings', siblings);
        render();
    }, siblings ? 'on' : ''));
    sibRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', siblings
        ? 'Adult brother and sister (one shared parent is enough) in one habitat both leave. Same-sex siblings stay.'
        : 'Brother + sister pairs may stay together.'));
    panel.appendChild(sibRow);

    panel.appendChild(section(`Contraception (${kindsText()})`));
    const contraRow = el('div', 'PZ2AH_row');
    const contraBtn = button(`Auto contraception: ${contra ? 'on' : 'off'}`, () => {
        contra = !contra;
        saveSetting(CONTRA_KEY, contra);
        if (connected) send('PZ2AutoHub_SetContra', contra);
        contraStatus = contra ? 'starting…' : '';
        render();
    }, contra ? 'on' : '');
    contraBtn.title = 'Works on its own or together with Auto above.';
    contraRow.appendChild(contraBtn);
    contraRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', contra
        ? 'Newborns living with their mother or father of the other sex'
            + (siblings ? ' (or with a brother / sister)' : '') + ' get contraception, also with Auto off.'
        : 'Off: AutoHub does not touch contraception.'));
    panel.appendChild(contraRow);
    if (contra) {
        panel.appendChild(el('div', 'PZ2AH_dim', 'AutoHub takes it off again once the animal lives without them (only animals it put on contraception). If you switch it off yourself, AutoHub leaves it off.'));
        panel.appendChild(el('div', 'PZ2AH_dim', `Last check: ${contraStatus || 'waiting for the mod…'}`));
    }
    if (contra || contraLines.length) {
        const contraBox = el('div', 'PZ2AH_box');
        for (const s of contraLines) contraBox.appendChild(el('div', 'PZ2AH_line', s));
        if (!contraLines.length) contraBox.appendChild(el('div', 'PZ2AH_dim', 'Nothing changed yet.'));
        panel.appendChild(contraBox);
    }

    panel.appendChild(section('Check now'));
    const checkRow = el('div', 'PZ2AH_row');
    const off = !connected || !!checking;
    const allBtn = button(isArmed('all') ? 'Click again to confirm' : 'Check all', () => confirmClick('all', checkAll),
        (isArmed('all') ? 'armed' : '') + (off ? ' disabled' : ''));
    allBtn.title = 'Checks every switched-on habitat, aquarium and vivarium once and sends the animals that have to leave to Animal Storage (via the Trade Centre).';
    checkRow.appendChild(allBtn);
    const habOpen = infoPanelOpen();
    const habBtn = button(isArmed('habitat') ? 'Click again to confirm' : 'Check the open habitat', () => confirmClick('habitat', checkHabitat),
        (isArmed('habitat') ? 'armed' : '') + (off || !habOpen ? ' disabled' : ''));
    habBtn.title = 'Only the habitat or vivarium whose info panel is open.';
    checkRow.appendChild(habBtn);
    if (!habOpen) checkRow.appendChild(el('div', 'PZ2AH_dim PZ2AH_grow', '(open a habitat\'s info panel)'));
    panel.appendChild(checkRow);
    if (status.text) panel.appendChild(el('div', 'PZ2AH_line ' + (status.kind || ''), status.text));

    panel.appendChild(section(autoSentTotal ? `Sent by auto (${autoSentTotal} this session)` : 'Sent by auto'));
    const sentBox = el('div', 'PZ2AH_box');
    if (!sentLines.length) sentBox.appendChild(el('div', 'PZ2AH_dim', 'Nothing yet.'));
    for (const s of sentLines) sentBox.appendChild(el('div', 'PZ2AH_line', s));
    panel.appendChild(sentBox);

    const logHead = el('div', 'PZ2AH_row PZ2AH_title');
    logHead.appendChild(el('div', 'PZ2AH_grow', 'Log'));
    logHead.appendChild(button('Clear', () => {
        logLines.length = 0;
        render();
    }, 'small'));
    panel.appendChild(logHead);
    const log = el('div', 'PZ2AH_box log');
    log.textContent = logLines.length ? logLines.join('\n') : '(nothing yet)';
    panel.appendChild(log);

    const boxes = panel.querySelectorAll('.PZ2AH_box');
    boxes.forEach((b, i) => {
        wheelScroll(b);
        if (tBoxTops[i] != undefined) b.scrollTop = tBoxTops[i];
    });
    log.scrollTop = log.scrollHeight;
    panel.scrollTop = nTop;
    place();
}

function toggle(v) {
    open = v;
    if (!open) menuAnchor = null;
    if (panel) panel.style.display = open ? 'block' : 'none';
    render();
}

// The game's UI scale (js/common/core/UIScale.js): html font-size grows with
// the screen and the UI scale option. The CSS uses 1rem = 14.4 design px
// (calibrated in-game at 1920x1080); the sizes worked out here use the same
// factor, so k = 1 gives the design size.
function uiScale() {
    let n = 18;
    try {
        // UIScale.updateScale writes it inline; computed style as a fallback
        n = parseFloat(document.documentElement.style.fontSize)
            || parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 18;
    }
    catch (e) {
        // unscaled
    }
    return n / 14.4 * SIZE_BASE * sizeSetting;
}

// "Size" in the panel: 50-150 % on top of the game's scale, saved for all parks
// Size 100 % (the default) = 70 % of the 1.0.x design size. Sizes saved
// under the old key are converted once, so they look the same as before.
const SIZE_BASE = 0.7;
const SIZE_MIN = 0.5;
const SIZE_MAX = 2;
const SIZE_KEY = 'PZ2AutoHub.uiSize';
const OLD_SIZE_KEY = 'PZ2AutoHub.size';
let sizeSetting = readSize();
function readSize() {
    let v = NaN;
    try {
        v = parseFloat(window.localStorage.getItem(SIZE_KEY));
        if (isNaN(v)) {
            const old = parseFloat(window.localStorage.getItem(OLD_SIZE_KEY));
            if (!isNaN(old)) {
                v = Math.round(old / SIZE_BASE * 20) / 20;
                v = Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
                window.localStorage.setItem(SIZE_KEY, String(v));
            }
        }
    }
    catch (e) {
        // default
    }
    return v >= SIZE_MIN && v <= SIZE_MAX ? v : 1;
}
function stepSize(dir) {
    sizeSetting = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, sizeSetting + dir * 0.05)) * 100) / 100;
    saveSetting(SIZE_KEY, sizeSetting);
    place();
    render();
}

// one line for Diagnose: the numbers the scaling works from
function scaleInfo() {
    let body = '?';
    try {
        body = document.body.style.fontSize || window.getComputedStyle(document.body).fontSize;
    }
    catch (e) {
        // unknown
    }
    const html = document.documentElement.style.fontSize || '?';
    return `UI scale: view ${window.innerWidth}x${window.innerHeight}, html ${html}, body ${body}, size ${Math.round(sizeSetting * 100)}%, k ${uiScale().toFixed(3)}`;
}

// draggable button; right-click puts it back. The button's spot is a screen
// position in px (where you dropped it), so it stays put when the scale changes.
let drag = null;
function place() {
    if (!btn) return;
    const k = uiScale();
    const pos = loadPos();
    // off: AutoHub is reached through the pause menu's Mods box only
    btn.style.display = showButton ? '' : 'none';
    btn.style.left = `${pos.x}px`;
    btn.style.top = `${pos.y}px`;
    // the CSS is in em of these: everything scales with k
    btn.style.fontSize = `${14 * k}px`;
    if (toastBox) toastBox.style.fontSize = `${13 * k}px`;
    if (panel) {
        panel.style.fontSize = `${13 * k}px`;
        const w = PANEL_W * k;
        panel.style.width = `${w}px`;
        if (menuAnchor && menuAnchor.menu) {
            placeByMenu(w, k);
            return;
        }
        const x = Math.min(Math.max(4, pos.x), window.innerWidth - w - 4);
        panel.style.left = `${x}px`;
        // below the button, or above it when there is more room there
        const nBtn = btn.offsetHeight || 30 * k;
        const nBelow = window.innerHeight - pos.y - nBtn - 26 * k;
        if (nBelow >= 420 * k || nBelow >= pos.y - 20 * k) {
            panel.style.bottom = '';
            panel.style.top = `${pos.y + nBtn + 4 * k}px`;
            panel.style.maxHeight = `${Math.max(200 * k, nBelow)}px`;
        }
        else {
            panel.style.top = '';
            panel.style.bottom = `${window.innerHeight - pos.y + 4 * k}px`;
            panel.style.maxHeight = `${Math.max(200 * k, pos.y - 20 * k)}px`;
        }
    }
}
// Opened from the pause menu: left of the menu, else right of the Mods box,
// level with the menu's top.
function placeByMenu(w, k) {
    const { menu, box } = menuAnchor;
    let x = menu.left - 8 * k - w;
    if (x < 4) x = (box ? box.right : menu.right) + 8 * k;
    x = Math.min(Math.max(4, x), window.innerWidth - w - 4);
    const y = Math.max(4, menu.top);
    panel.style.left = `${x}px`;
    panel.style.bottom = '';
    panel.style.top = `${y}px`;
    panel.style.maxHeight = `${Math.max(200 * k, window.innerHeight - y - 20 * k)}px`;
}

// re-place when the game rescales (window size, UI scale option)
window.addEventListener('resize', () => requestAnimationFrame(place));
import('/js/common/core/UIScale.js').then(m => {
    if (m && m.onScaleChange && m.onScaleChange.add) m.onScaleChange.add(() => requestAnimationFrame(place));
}).catch(() => { });

function build() {
    if (btn) return;
    btn = el('div', 'PZ2AH_toggle', 'AutoHub');
    btn.title = `PZ2AutoHub ${VERSION}: related animals to Animal Storage (drag to move, right-click to reset)`;
    btn.addEventListener('mousedown', e => {
        if (e.button != 0) return;
        const pos = loadPos();
        drag = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y, moved: false };
        e.stopPropagation();
    });
    window.addEventListener('mousemove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
            saveSetting(POS_KEY, JSON.stringify({ x: Math.max(0, drag.x + dx), y: Math.max(0, drag.y + dy) }));
            place();
        }
    });
    window.addEventListener('mouseup', () => {
        if (drag && !drag.moved) toggle(!open);
        drag = null;
    });
    btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        saveSetting(POS_KEY, null);
        place();
    });
    panel = el('div', 'PZ2AH_panel');
    panel.style.width = `${PANEL_W * uiScale()}px`;
    panel.style.display = 'none';
    panel.addEventListener('mousedown', e => e.stopPropagation());
    wheelScroll(panel);
    document.body.appendChild(btn);
    document.body.appendChild(panel);
    place();
    label();
    addPauseMenuEntry({
        id: 'PZ2AutoHub',
        order: 3,
        label: labelText,
        onSelect: anchor => {
            if (open && menuAnchor) {
                toggle(false);
                return;
            }
            menuAnchor = anchor;
            toggle(true);
        },
        // a panel opened from the menu closes with it
        onMenuClosed: () => {
            if (open && menuAnchor) toggle(false);
        },
    });
}

// ------------------------------------------------------------- toasts

let toastBox = null;
function toast(text) {
    if (!toastBox) {
        toastBox = el('div', 'PZ2AH_toasts');
        toastBox.style.fontSize = `${13 * uiScale()}px`;
        document.body.appendChild(toastBox);
    }
    const t = el('div', 'PZ2AH_toast', text);
    toastBox.appendChild(t);
    setTimeout(() => t.parentNode && t.parentNode.removeChild(t), 6000);
}

// ------------------------------------------------------------- wiring

// The last info panels opened (any kind: animal, shoal, habitat...), so
// Diagnose can show which entity ID the game uses for e.g. a shoal's panel.
const panelHistory = [];
let wasHabOpen = false;
engine.on('InfoPanel_SetContext', context => {
    infoPanelContext = Array.isArray(context) ? context : null;
    if (infoPanelContext) {
        const key = JSON.stringify(infoPanelContext);
        if (panelHistory[panelHistory.length - 1] !== key) panelHistory.push(key);
        while (panelHistory.length > 6) panelHistory.shift();
    }
    render();
});

engine.on('PZ2AutoHub_Hello', (version, park, storeText, storeStatus) => {
    connected = true;
    parkKey = String(park || 'park');
    // the saved settings first: everything below sends them to Lua
    applyStore(String(storeText || ''), String(storeStatus || ''));
    // the animals AutoHub put on contraception in this park, before any tick
    send('PZ2AutoHub_SetContraKeys', readSetting(CONTRA_KEYS_PREFIX + parkKey, ''));
    send('PZ2AutoHub_SetContra', contra);
    send('PZ2AutoHub_SetAuto', mode);
    send('PZ2AutoHub_SetSiblings', siblings);
    sendKinds();
    send('PZ2AutoHub_SetInterval', interval);
    addLog(`connected to mod Lua v${version}; settings: ${storeState}`);
});

// Lua's answer to PZ2AutoHub_StoreSave
engine.on('PZ2AutoHub_StoreSaved', result => {
    result = String(result || '');
    if (result == 'saved' || result == 'kept') storeState = `saved in the player save (${new Date().toLocaleTimeString()})`;
    else {
        storeState = `could not save (${result})`;
        addLog(`settings: ${storeState}`);
    }
});

engine.on('PZ2AutoHub_Result', (sent, failed, notes) => {
    checking = '';
    sent = Number(sent) || 0;
    failed = Number(failed) || 0;
    let text;
    if (sent == 0 && failed == 0) {
        // vivarium family trees load in the background on the first check
        text = String(notes || '').includes('family data still loading')
            ? 'Vivarium family data is still loading. Check again in a few seconds.'
            : 'Nobody has to leave.';
    }
    else {
        text = `Sent ${sent} animal${sent == 1 ? '' : 's'} to Animal Storage.`;
        if (failed) {
            // the first failure's reason, e.g. "... : Trade Centre full (vivarium storage 12/12)"
            const firstFail = String(notes || '').split('\n').find(l => l && !l.startsWith('sent ') && !l.startsWith('checked ')) || '';
            const reason = firstFail.includes('): ') ? firstFail.slice(firstFail.lastIndexOf('): ') + 3) : '';
            text += ` ${failed} could not be sent` + (reason ? `: ${plainName(reason)}` : ' (see log)') + '.';
        }
    }
    if (notes) addLog(plainName(notes));
    setStatus(text, failed ? 'warn' : 'ok');
});

engine.on('PZ2AutoHub_AutoSent', (name, why) => {
    const line = `${new Date().toLocaleTimeString()}  ${plainName(name)} (${plainName(why)})`;
    sentLines.unshift(line);
    while (sentLines.length > SENT_LINES) sentLines.pop();
    toast(`Sent to Animal Storage: ${plainName(name)} (${plainName(why)})`);
    addLog(`auto: sent ${plainName(name)} (${plainName(why)})`);
});

engine.on('PZ2AutoHub_Log', line => addLog(plainName(line)));

// one animal's contraception was switched by auto (bOn) and why
engine.on('PZ2AutoHub_Contra', (name, why, on) => {
    const sOn = on === true || on === 'true';
    const line = `${new Date().toLocaleTimeString()}  ${plainName(name)}: ${sOn ? 'on' : 'off'} (${plainName(why)})`;
    contraLines.unshift(line);
    while (contraLines.length > SENT_LINES) contraLines.pop();
    addLog(`contraception ${sOn ? 'on' : 'off'}: ${plainName(name)} (${plainName(why)})`);
});

// summary per check: animals checked, switched on, switched off
engine.on('PZ2AutoHub_ContraStatus', (animals, nOn, nOff) => {
    nOn = Number(nOn) || 0;
    nOff = Number(nOff) || 0;
    let text = `${new Date().toLocaleTimeString()}: ${animals} animals`;
    if (nOn) text += `, ${nOn} switched on`;
    if (nOff) text += `, ${nOff} switched off`;
    contraStatus = text;
    if (nOn || nOff) {
        const tParts = [];
        if (nOn) tParts.push(`on for ${nOn}`);
        if (nOff) tParts.push(`off for ${nOff}`);
        toast(`Contraception ${tParts.join(', ')} animal${nOn + nOff == 1 ? '' : 's'}`);
    }
    render();
});

// Lua's list of animals it put on contraception (saved per park)
engine.on('PZ2AutoHub_ContraKeys', list => {
    if (parkKey) saveSetting(CONTRA_KEYS_PREFIX + parkKey, String(list || '') || null);
});

// Lua reports every auto check: proof that auto mode is really running.
engine.on('PZ2AutoHub_AutoStatus', (habitats, animals, sent, vivariums, aquariums) => {
    sent = Number(sent);
    if (sent > 0) autoSentTotal += sent;
    const nGroups = (Number(habitats) || 0) + (Number(vivariums) || 0) + (Number(aquariums) || 0);
    let text = `${new Date().toLocaleTimeString()}: ${habitats} habitats, ${Number(aquariums) || 0} aquariums, ${Number(vivariums) || 0} vivariums, ${animals} animals`;
    if (!KINDS.some(k => kinds[k])) text += ' (everything switched off)';
    else if (nGroups == 0 || Number(animals) == 0) text += ' (none found? try Diagnose)';
    autoStatus = text;
    render();
});

setInterval(() => {
    if (connected && (mode != 'off' || contra)) send('PZ2AutoHub_Tick', 1);
}, TICK_MS);

// the "Check the open habitat" button follows the game's info panel
setInterval(() => {
    if (!open) return;
    const habOpen = infoPanelOpen();
    if (habOpen != wasHabOpen) {
        wasHabOpen = habOpen;
        render();
    }
}, 500);

try {
    loadCSS('mods/pz2autohub');
}
catch (e) {
    // unstyled, still works
}
const boot = setInterval(() => {
    if (document.body) {
        clearInterval(boot);
        build();
    }
}, 250);
console.log(`[PZ2AutoHub] UI v${VERSION} loaded`);
