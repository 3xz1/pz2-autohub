// PZ2AutoHub UI. Loaded by PZ2AutoHubHUD.html (or another mod's HUD page)
// after the game's HUDApp.js, so it shares the game's module instances.
//
// An "AutoHub" button (drag to move, right-click to reset) with a panel, in
// the same style as PZ2Guardian and PZ2Studbook. Rules (Lua, as the game
// defines related animals): an adult living with its mother or father
// leaves; an adult brother + sister (shared parent) both leave; of 2+
// shoals of one species in a tank, all but the youngest leave.
//   * every setting per kind (habitats, aquariums, vivariums; saved as
//     PZ2AutoHub.kindCfg): on/off, Auto (Off / New adults / Always), the
//     action (Animal Storage / Quick Trade / Quick Release; a Quick Trade or
//     Release the game refuses goes to Animal Storage, with a log line),
//     brother + sister, contraception. Lua does the work on a tick from here;
//   * Contraception: young animals living with an opposite-sex parent (or
//     sibling) get contraception; Lua takes it off again once they live
//     without them. Works with or without Auto;
//   * Check all now / Check the open habitat (click twice);
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

const VERSION = '1.4.2';
const MODE_KEY = 'PZ2AutoHub.mode';
const OLD_AUTO_KEY = 'PZ2AutoHub.auto';
const SIBLINGS_KEY = 'PZ2AutoHub.siblings';
const POS_KEY = 'PZ2AutoHub.buttonPos';
const KINDS_KEY = 'PZ2AutoHub.kinds';
const INTERVAL_KEY = 'PZ2AutoHub.interval';
const CONTRA_KEY = 'PZ2AutoHub.contra';
// animals AutoHub put on contraception, per park: 'PZ2AutoHub.contraKeys.<park>'
const CONTRA_KEYS_PREFIX = 'PZ2AutoHub.contraKeys.';
// what Quick Trade / Quick Release brought, per park: 'PZ2AutoHub.earned.<park>'
// = JSON { habitat: { trade: { n, sum, unknown }, release: {...} }, aquarium: ..., exhibit: ... }
const EARNED_PREFIX = 'PZ2AutoHub.earned.';
const SHOW_BTN_KEY = 'PZ2AutoHub.screenButton';
// every setting per kind (JSON { habitat: { on, mode, siblings, contra, action, zero }, ... };
// zero: an animal worth 0 goes to Animal Storage instead of Quick Trade / Release);
// MODE_KEY, SIBLINGS_KEY, KINDS_KEY and CONTRA_KEY (1.2 and older, one set for
// all kinds) are only read as its starting values
const KIND_CFG_KEY = 'PZ2AutoHub.kindCfg';
const TAB_KEY = 'PZ2AutoHub.tab';
// the panel's pages and the help texts switch
const VIEW_KEY = 'PZ2AutoHub.view';
const HELP_KEY = 'PZ2AutoHub.help';
const VIEWS = ['overview', 'settings', 'log'];
const VIEW_LABELS = { overview: 'Overview', settings: 'Settings', log: 'Log' };
const ACTIONS = ['storage', 'trade', 'release'];
const ACTION_LABELS = { storage: 'Animal Storage', trade: 'Quick Trade', release: 'Quick Release' };
const ACTION_SHORT = { storage: 'Storage', trade: 'Quick Trade', release: 'Quick Release' };
const ACTION_TIPS = {
    storage: 'A keeper carries them to Animal Storage. You can bring them back later.',
    trade: 'Sold at once. If the game doesn\'t allow it, Animal Storage (the log says why).',
    release: 'Released into the wild at once. If the game doesn\'t allow it, Animal Storage (the log says why).',
};
// what Lua reports as done, for the lists and notices
const DONE_LABELS = { storage: 'to Animal Storage', trade: 'sold (Quick Trade)', release: 'released (Quick Release)' };
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
    off: 'Only "Check" below moves animals out.',
    new: 'When an animal grows up next to a parent or an opposite-sex sibling, it (and that sibling) leaves.',
    always: 'At every check, everyone who has to leave goes, no matter when they grew up or moved in.',
};
const TICK_MS = 1000;      // Lua counts these; it checks every `interval` of them
const LOG_LINES = 120;
const SENT_LINES = 40;

let connected = false;
let open = false;
let kindCfg = readKindCfg();
let tab = readTab();
let view = VIEWS.includes(readSetting(VIEW_KEY, '')) ? readSetting(VIEW_KEY, '') : 'overview';
let help = readSetting(HELP_KEY, 'false') === 'true';
let interval = readInterval();
let showButton = readSetting(SHOW_BTN_KEY, 'show') !== 'hide';
let parkKey = '';
let menuAnchor = null;      // { menu, box } rects while the panel was opened from the pause menu
const contraLines = [];     // "12:01 Bob: on (lives with its mother)"
let infoPanelContext = null;
let status = { text: '', kind: '' };
let lastCheck = '';         // "13:15:03 · 61 animals" from the last auto / contraception check
let autoSentTotal = 0;
let earned = emptyEarned();
// The tick to Lua. In 1.2.0 a lone setInterval stopped firing a few minutes
// into a park (cause unknown; buttons kept working), so auto mode went
// silent. Now three drivers share one sender (it sends at most once per
// TICK_MS) and each driver re-arms itself; the counters show in Diagnose.
const ticks = { sent: 0, lastSent: 0, lastAnswer: 0, warned: false, by: { interval: 0, timeout: 0, frame: 0, event: 0 } };
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
    return [KIND_CFG_KEY, TAB_KEY, VIEW_KEY, HELP_KEY, MODE_KEY, SIBLINGS_KEY, POS_KEY, KINDS_KEY, INTERVAL_KEY, CONTRA_KEY, SHOW_BTN_KEY, SIZE_KEY];
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
    // too big: the other parks' contraception lists and earnings go first
    for (const key of Object.keys(kept)) {
        if (text.length <= STORE_CAP) break;
        const perPark = [CONTRA_KEYS_PREFIX, EARNED_PREFIX].find(p => key.startsWith(p));
        if (perPark && key != perPark + parkKey) {
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
        for (const prefix of [CONTRA_KEYS_PREFIX, EARNED_PREFIX]) {
            const v = readSetting(prefix + parkKey, null);
            if (v != null) kept[prefix + parkKey] = v;
        }
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
    kindCfg = readKindCfg();
    tab = readTab();
    view = VIEWS.includes(readSetting(VIEW_KEY, '')) ? readSetting(VIEW_KEY, '') : 'overview';
    help = readSetting(HELP_KEY, 'false') === 'true';
    interval = readInterval();
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

// 1.2 and older had one set of settings for all kinds: the starting values
function oldKindCfg() {
    const kinds = readKinds();
    const t = {};
    for (const k of KINDS) {
        t[k] = {
            on: kinds[k],
            mode: readMode(),
            siblings: readSetting(SIBLINGS_KEY, 'true') === 'true',
            contra: readSetting(CONTRA_KEY, 'false') === 'true',
            action: 'storage',
            zero: true,
        };
    }
    return t;
}

function readKindCfg() {
    const t = oldKindCfg();
    try {
        const saved = JSON.parse(readSetting(KIND_CFG_KEY, 'null'));
        if (saved && typeof saved == 'object') {
            for (const k of KINDS) {
                const s = saved[k];
                if (!s || typeof s != 'object') continue;
                if (typeof s.on == 'boolean') t[k].on = s.on;
                if (MODES.includes(s.mode)) t[k].mode = s.mode;
                if (typeof s.siblings == 'boolean') t[k].siblings = s.siblings;
                if (typeof s.contra == 'boolean') t[k].contra = s.contra;
                if (ACTIONS.includes(s.action)) t[k].action = s.action;
                if (typeof s.zero == 'boolean') t[k].zero = s.zero;
            }
        }
    }
    catch (e) {
        // starting values
    }
    return t;
}

function readTab() {
    const v = readSetting(TAB_KEY, 'habitat');
    return KINDS.includes(v) ? v : 'habitat';
}

// "habitat,1,always,1,0,trade,1;aquarium,...": kind, on, auto, brother + sister, contraception, action, worth 0 -> storage
function sendKindCfg() {
    send('PZ2AutoHub_SetKindCfg', KINDS.map(k => {
        const c = kindCfg[k];
        return [k, c.on ? 1 : 0, c.mode, c.siblings ? 1 : 0, c.contra ? 1 : 0, c.action, c.zero ? 1 : 0].join(',');
    }).join(';'));
}

function saveKindCfg() {
    saveSetting(KIND_CFG_KEY, JSON.stringify(kindCfg));
    if (connected) sendKindCfg();
    render();
}

function anyAuto() {
    return KINDS.some(k => kindCfg[k].on && kindCfg[k].mode != 'off');
}

function anyContra() {
    return KINDS.some(k => kindCfg[k].on && kindCfg[k].contra);
}

function kindsText() {
    const on = KINDS.filter(k => kindCfg[k].on).map(k => KIND_LABELS[k].toLowerCase());
    return on.length ? on.join(', ') : 'nothing (all switched off)';
}

function emptyEarned() {
    const t = {};
    for (const k of KINDS) t[k] = { trade: { n: 0, sum: 0, unknown: 0 }, release: { n: 0, sum: 0, unknown: 0 } };
    return t;
}

function readEarned() {
    const t = emptyEarned();
    try {
        const saved = JSON.parse(readSetting(EARNED_PREFIX + parkKey, 'null'));
        for (const k of KINDS) {
            for (const a of ['trade', 'release']) {
                const s = saved && saved[k] && saved[k][a];
                if (!s) continue;
                for (const f of ['n', 'sum', 'unknown']) if (typeof s[f] == 'number' && isFinite(s[f])) t[k][a][f] = s[f];
            }
        }
    }
    catch (e) {
        // nothing recorded yet
    }
    return t;
}

// 12345.6 -> "12,346"
function amount(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// "3 for 12,346" (+ "2 unknown" when the game gave no amount)
function earnedText(e) {
    if (!e.n) return '–';
    return `${e.n} for ${amount(e.sum)}` + (e.unknown ? ` (${e.unknown} without amount)` : '');
}

// "13:15:03"
function clock(d) {
    d = d || new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => ('0' + n).slice(-2)).join(':');
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
        addLog(`UI tick: ${tickRunning() ? 'running' : 'off'}, ${tickText()}`);
        send('PZ2AutoHub_Diagnose', ids.join(','), panelEntityID());
    });
}

// ------------------------------------------------------------------ UI
let btn = null;
let panel = null;

function labelText() {
    const tParts = [];
    if (anyAuto()) tParts.push('Auto');
    if (anyContra()) tParts.push('Contraception');
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
    head.appendChild(el('div', 'PZ2AH_name PZ2AH_grow', `AutoHub ${VERSION}` + (connected ? '' : ' · not connected')));
    head.appendChild(button('Close', () => toggle(false)));
    panel.appendChild(head);
    const viewRow = el('div', 'PZ2AH_row PZ2AH_tabs');
    for (const v of VIEWS) {
        viewRow.appendChild(button(VIEW_LABELS[v], () => {
            view = v;
            saveSetting(VIEW_KEY, view);
            render();
        }, 'tab' + (v == view ? ' on' : ' opt')));
    }
    panel.appendChild(viewRow);

    if (view == 'settings') renderSettings();
    else if (view == 'log') renderLog();
    else renderOverview();

    const boxes = panel.querySelectorAll('.PZ2AH_box');
    boxes.forEach((b, i) => {
        wheelScroll(b);
        if (tBoxTops[i] != undefined) b.scrollTop = tBoxTops[i];
    });
    const log = panel.querySelector('.PZ2AH_box.log');
    if (log) log.scrollTop = log.scrollHeight;
    panel.scrollTop = nTop;
    place();
}

// a settings line: label column + controls (+ a help line with Help on)
function settingRow(text, controls, helpText) {
    const row = el('div', 'PZ2AH_row');
    row.appendChild(el('div', 'PZ2AH_label', text));
    for (const c of controls) row.appendChild(c);
    panel.appendChild(row);
    if (help && helpText) panel.appendChild(el('div', 'PZ2AH_help', helpText));
}

// buttons for a choice; the current one is "on"
function choice(values, labels, current, onPick) {
    return values.map(v => button(labels[v], () => onPick(v), v == current ? 'on' : 'opt'));
}

function onOff(current, onPick) {
    return choice([true, false], { true: 'On', false: 'Off' }, current, onPick);
}

function stepper(text, onMinus, onPlus, minusOff, plusOff) {
    return [
        button('−', onMinus, 'small' + (minusOff ? ' disabled' : '')),
        el('div', 'PZ2AH_value', text),
        button('+', onPlus, 'small' + (plusOff ? ' disabled' : '')),
    ];
}

function renderOverview() {
    // what each kind does
    const tHead = el('div', 'PZ2AH_row table');
    for (const t of ['', 'Auto', 'Action', 'Contraception']) tHead.appendChild(el('div', 'PZ2AH_cell head', t));
    panel.appendChild(tHead);
    for (const k of KINDS) {
        const c = kindCfg[k];
        const row = el('div', 'PZ2AH_row table' + (c.on ? '' : ' off'));
        row.appendChild(el('div', 'PZ2AH_cell head', KIND_LABELS[k]));
        if (c.on) {
            row.appendChild(el('div', 'PZ2AH_cell', MODE_LABELS[c.mode]));
            row.appendChild(el('div', 'PZ2AH_cell', ACTION_LABELS[c.action]));
            row.appendChild(el('div', 'PZ2AH_cell', c.contra ? 'On' : 'Off'));
        }
        else row.appendChild(el('div', 'PZ2AH_cell wide', 'not looked after'));
        panel.appendChild(row);
    }
    let sCheck = 'Auto and contraception are off.';
    if (anyAuto() || anyContra()) {
        sCheck = `Every ${intervalText(interval)} · last check ${lastCheck || 'waiting for the mod…'}`;
    }
    panel.appendChild(el('div', 'PZ2AH_dim', sCheck));

    panel.appendChild(section('Check now'));
    const checkRow = el('div', 'PZ2AH_row');
    const off = !connected || !!checking;
    checkRow.appendChild(button(isArmed('all') ? 'Click again to confirm' : 'Check all', () => confirmClick('all', checkAll),
        (isArmed('all') ? 'armed' : '') + (off ? ' disabled' : '')));
    const habOpen = infoPanelOpen();
    checkRow.appendChild(button(isArmed('habitat') ? 'Click again to confirm' : 'Check the open habitat', () => confirmClick('habitat', checkHabitat),
        (isArmed('habitat') ? 'armed' : '') + (off || !habOpen ? ' disabled' : '')));
    panel.appendChild(checkRow);
    if (status.text) panel.appendChild(el('div', 'PZ2AH_line ' + (status.kind || ''), status.text));

    panel.appendChild(section('Earnings in this park'));
    const earnHead = el('div', 'PZ2AH_row table');
    for (const t of ['', 'Quick Trade', 'Quick Release']) earnHead.appendChild(el('div', 'PZ2AH_cell head', t));
    panel.appendChild(earnHead);
    const all = { trade: { n: 0, sum: 0, unknown: 0 }, release: { n: 0, sum: 0, unknown: 0 } };
    for (const k of KINDS) {
        const row = el('div', 'PZ2AH_row table');
        row.appendChild(el('div', 'PZ2AH_cell head', KIND_LABELS[k]));
        for (const a of ['trade', 'release']) {
            row.appendChild(el('div', 'PZ2AH_cell', earnedText(earned[k][a])));
            for (const f of ['n', 'sum', 'unknown']) all[a][f] += earned[k][a][f];
        }
        panel.appendChild(row);
    }
    const totalRow = el('div', 'PZ2AH_row table total');
    totalRow.appendChild(el('div', 'PZ2AH_cell', 'All'));
    for (const a of ['trade', 'release']) totalRow.appendChild(el('div', 'PZ2AH_cell', earnedText(all[a])));
    panel.appendChild(totalRow);
    const resetRow = el('div', 'PZ2AH_row right');
    resetRow.appendChild(button(isArmed('earned') ? 'Click again to confirm' : 'Reset', () => confirmClick('earned', () => {
        earned = emptyEarned();
        if (parkKey) saveSetting(EARNED_PREFIX + parkKey, null);
        render();
    }), isArmed('earned') ? 'armed small' : 'small'));
    panel.appendChild(resetRow);

    panel.appendChild(section('Last moved out'));
    if (!sentLines.length) panel.appendChild(el('div', 'PZ2AH_dim', 'Nothing yet.'));
    for (const s of sentLines.slice(0, 3)) panel.appendChild(el('div', 'PZ2AH_line', s));
}

function renderSettings() {
    const kindRow = el('div', 'PZ2AH_row');
    for (const k of KINDS) {
        kindRow.appendChild(button(KIND_LABELS[k] + (kindCfg[k].on ? '' : ' (off)'), () => {
            tab = k;
            saveSetting(TAB_KEY, tab);
            render();
        }, k == tab ? 'on' : 'opt'));
    }
    panel.appendChild(kindRow);
    const c = kindCfg[tab];
    const set = (field, v) => {
        c[field] = v;
        if (field == 'mode' && v != 'off' && !lastCheck) lastCheck = 'starting…';
        saveKindCfg();
    };
    settingRow('Look after', onOff(c.on, v => set('on', v)),
        'Off: AutoHub leaves these alone. "Check the open habitat" still works.');
    if (c.on) {
        settingRow('Auto', choice(MODES, MODE_LABELS, c.mode, v => set('mode', v)), MODE_TIPS[c.mode]);
        settingRow('Action', choice(ACTIONS, ACTION_SHORT, c.action, v => set('action', v)), ACTION_TIPS[c.action]);
        if (c.action != 'storage') {
            settingRow('Worth 0', choice([true, false], { true: 'Storage', false: 'Anyway' }, c.zero, v => set('zero', v)),
                c.zero ? 'An animal the game says is worth 0 goes to Animal Storage instead.'
                    : `An animal worth 0 is ${c.action == 'trade' ? 'traded' : 'released'} anyway.`);
        }
        settingRow('Brother + sister', onOff(c.siblings, v => set('siblings', v)),
            'On: an adult brother and sister living together both leave. Same-sex siblings stay.');
        settingRow('Contraception', onOff(c.contra, v => set('contra', v)),
            'On: newborns living with a parent (or sibling) of the other sex get contraception. AutoHub takes it off once they live apart.');
        const others = KINDS.filter(k => k != tab).map(k => KIND_LABELS[k].toLowerCase()).join(' + ');
        settingRow('', [button(isArmed('copy') ? 'Click again to confirm' : `Copy to ${others}`, () => confirmClick('copy', () => {
            // each kind keeps its own on / off
            for (const k of KINDS) if (k != tab) kindCfg[k] = Object.assign({}, c, { on: kindCfg[k].on });
            saveKindCfg();
        }), isArmed('copy') ? 'armed small' : 'small')]);
    }

    panel.appendChild(section('General'));
    const iNow = INTERVALS.indexOf(interval);
    settingRow('Check every', stepper(intervalText(interval), () => stepInterval(-1), () => stepInterval(1),
        iNow <= 0, iNow >= INTERVALS.length - 1),
        'Real seconds, whatever the game speed. In a very big zoo 1-2 s can cost frame rate.');
    settingRow('Size', stepper(`${Math.round(sizeSetting * 100)}%`, () => stepSize(-1), () => stepSize(1),
        sizeSetting <= SIZE_MIN, sizeSetting >= SIZE_MAX), 'Panel, button and notices, on top of the game\'s UI scale.');
    settingRow('Screen button', onOff(showButton, v => {
        showButton = v;
        saveSetting(SHOW_BTN_KEY, showButton ? 'show' : 'hide');
        place();
        render();
    }), 'AutoHub is always in the game menu too: Esc → Mods.');
    settingRow('Help texts', onOff(help, v => {
        help = v;
        saveSetting(HELP_KEY, help);
        render();
    }));
}

function renderLog() {
    const top = el('div', 'PZ2AH_row');
    top.appendChild(button('Diagnose', diagnose));
    top.appendChild(el('div', 'PZ2AH_grow'));
    top.appendChild(button('Clear', () => {
        logLines.length = 0;
        render();
    }, 'small'));
    panel.appendChild(top);
    const log = el('div', 'PZ2AH_box log');
    log.textContent = logLines.length ? logLines.join('\n') : '(nothing yet)';
    panel.appendChild(log);

    panel.appendChild(section(autoSentTotal ? `Moved out by auto (${autoSentTotal})` : 'Moved out by auto'));
    const sentBox = el('div', 'PZ2AH_box');
    if (!sentLines.length) sentBox.appendChild(el('div', 'PZ2AH_dim', 'Nothing yet.'));
    for (const s of sentLines) sentBox.appendChild(el('div', 'PZ2AH_line', s));
    panel.appendChild(sentBox);

    panel.appendChild(section('Contraception changes'));
    const contraBox = el('div', 'PZ2AH_box');
    if (!contraLines.length) contraBox.appendChild(el('div', 'PZ2AH_dim', 'Nothing yet.'));
    for (const s of contraLines) contraBox.appendChild(el('div', 'PZ2AH_line', s));
    panel.appendChild(contraBox);
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
    btn.title = `PZ2AutoHub ${VERSION}: moves related animals out (drag to move, right-click to reset)`;
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
    earned = readEarned();
    // the animals AutoHub put on contraception in this park, before any tick
    send('PZ2AutoHub_SetContraKeys', readSetting(CONTRA_KEYS_PREFIX + parkKey, ''));
    sendKindCfg();
    send('PZ2AutoHub_SetInterval', interval);
    addLog(`connected to mod Lua v${version}; settings: ${storeState}`);
});

// Lua's answer to PZ2AutoHub_StoreSave
engine.on('PZ2AutoHub_StoreSaved', result => {
    result = String(result || '');
    if (result == 'saved' || result == 'kept') storeState = `saved in the player save (${clock()})`;
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
        const sNotes = String(notes || '');
        if (sNotes.includes('values still loading')) text = 'The game is still loading what some animals are worth. Check again in a few seconds.';
        else if (sNotes.includes('family data still loading')) text = 'Vivarium family data is still loading. Check again in a few seconds.';
        else text = 'Nobody has to leave.';
    }
    else {
        // Lua's notes: "sent ..." (Animal Storage), "sold ..." (Quick Trade), "released ..." (Quick Release)
        const lines = String(notes || '').split('\n');
        const count = word => lines.filter(l => l.startsWith(word + ' ')).length;
        const parts = [];
        if (count('sent')) parts.push(`${count('sent')} to Animal Storage`);
        if (count('sold')) parts.push(`${count('sold')} sold (Quick Trade)`);
        if (count('released')) parts.push(`${count('released')} released (Quick Release)`);
        text = sent ? `Moved ${sent} animal${sent == 1 ? '' : 's'} out: ${parts.join(', ')}.` : '';
        const nFallback = lines.filter(l => l.includes('sent to Animal Storage instead')).length;
        if (nFallback) text += ` ${nFallback} could not be traded / released and went to Animal Storage (see log).`;
        if (lines.some(l => l.includes('values still loading'))) text += ' Some are waiting until the game knows what they are worth: check again in a few seconds.';
        if (failed) {
            // the first failure's reason, e.g. "... : Trade Centre full (vivarium storage 12/12)"
            const firstFail = lines.find(l => l && !/^(sent|sold|released|checked) /.test(l)) || '';
            const reason = firstFail.includes('): ') ? firstFail.slice(firstFail.lastIndexOf('): ') + 3) : '';
            text += ` ${failed} could not be moved` + (reason ? `: ${plainName(reason)}` : ' (see log)') + '.';
        }
    }
    if (notes) addLog(plainName(notes));
    setStatus(text.trim(), failed || /instead/.test(String(notes || '')) ? 'warn' : 'ok');
});

// done: what happened ("storage" | "trade" | "release"); note: why a Quick
// Trade / Release went to Animal Storage instead ("" when it did not)
engine.on('PZ2AutoHub_AutoSent', (name, why, done, note, value) => {
    const sName = plainName(name), sWhy = plainName(why);
    const nValue = Number(value);
    const sDone = (DONE_LABELS[done] || DONE_LABELS.storage)
        + (done == 'trade' || done == 'release' ? (nValue >= 0 ? ` for ${amount(nValue)}` : ' (amount unknown)') : '');
    sentLines.unshift(`${clock()}  ${sName}: ${sDone} (${sWhy})`);
    while (sentLines.length > SENT_LINES) sentLines.pop();
    if (note) {
        toast(`${sName}: ${plainName(note)}. Sent to Animal Storage instead.`);
        addLog(`auto: ${sName} ${sDone} (${sWhy}); ${plainName(note)}`);
    }
    else {
        toast(`${sName}: ${sDone} (${sWhy})`);
        addLog(`auto: ${sName} ${sDone} (${sWhy})`);
    }
});

engine.on('PZ2AutoHub_Log', line => addLog(plainName(line)));

// every Quick Trade / Release (Auto and Check buttons): kind, 'trade' | 'release', value (-1 = unknown)
engine.on('PZ2AutoHub_Earned', (kind, done, value) => {
    const e = earned[kind] && earned[kind][done];
    if (!e) return;
    const n = Number(value);
    e.n++;
    if (n >= 0) e.sum += n;
    else e.unknown++;
    if (parkKey) saveSetting(EARNED_PREFIX + parkKey, JSON.stringify(earned));
    render();
});

// one animal's contraception was switched by auto (bOn) and why
engine.on('PZ2AutoHub_Contra', (name, why, on) => {
    const sOn = on === true || on === 'true';
    const line = `${clock()}  ${plainName(name)}: ${sOn ? 'on' : 'off'} (${plainName(why)})`;
    contraLines.unshift(line);
    while (contraLines.length > SENT_LINES) contraLines.pop();
    addLog(`contraception ${sOn ? 'on' : 'off'}: ${plainName(name)} (${plainName(why)})`);
});

// summary per check: animals checked, switched on, switched off
engine.on('PZ2AutoHub_ContraStatus', (animals, nOn, nOff) => {
    ticks.lastAnswer = Date.now();
    nOn = Number(nOn) || 0;
    nOff = Number(nOff) || 0;
    lastCheck = `${clock()} · ${animals} animals`;
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
    ticks.lastAnswer = Date.now();
    sent = Number(sent);
    if (sent > 0) autoSentTotal += sent;
    const nGroups = (Number(habitats) || 0) + (Number(vivariums) || 0) + (Number(aquariums) || 0);
    let text = `${clock()} · ${animals} animals`;
    if (nGroups == 0 || Number(animals) == 0) text += ' (none found? try Diagnose)';
    lastCheck = text;
    render();
});

function tickRunning() {
    return connected && (anyAuto() || anyContra());
}

// called by every driver; sends when a tick is due
function maybeTick(driver) {
    try {
        const now = Date.now();
        if (!tickRunning()) {
            ticks.lastSent = now;
            return;
        }
        if (now - ticks.lastSent < TICK_MS - 50) return;
        ticks.lastSent = now;
        ticks.by[driver]++;
        if (send('PZ2AutoHub_Tick', 1)) ticks.sent++;
        // watchdog: ticks go out but Lua's checks stopped answering
        const quiet = Math.max(3 * interval, 15) * 1000;
        if (ticks.lastAnswer && now - ticks.lastAnswer > quiet && !ticks.warned) {
            ticks.warned = true;
            addLog(`auto: no check result for ${Math.round((now - ticks.lastAnswer) / 1000)} s although ticks are sent (${tickText()}). Please click Diagnose and send a screenshot.`);
        }
        else if (ticks.warned && now - ticks.lastAnswer <= quiet) ticks.warned = false;
    }
    catch (e) {
        // a driver must never die from an error here
    }
}

function tickText() {
    const b = ticks.by;
    const since = ticks.lastAnswer ? `${Math.round((Date.now() - ticks.lastAnswer) / 1000)} s ago` : 'never';
    return `ticks sent ${ticks.sent} (interval ${b.interval}, timeout ${b.timeout}, frame ${b.frame}, event ${b.event}), last check result ${since}`;
}

setInterval(() => maybeTick('interval'), TICK_MS / 2);
(function timeoutLoop() {
    try { maybeTick('timeout'); }
    finally { setTimeout(timeoutLoop, TICK_MS / 2); }
})();
(function frameLoop() {
    try { maybeTick('frame'); }
    finally { requestAnimationFrame(frameLoop); }
})();
// the game's own panel events as a last resort
engine.on('InfoPanel_SetContext', () => maybeTick('event'));

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
