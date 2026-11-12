"use strict";
// pbz-ai-bridge — perception + command execution bridge for external AI (via pbz_mcp).
// Deploy: <game>\ProjectPBZ\PBZModLoader\mods\pbz-ai-bridge\main.js
// Hot reload: Alt+F5 with the game window in foreground. stop() clears every timer.
// IPC: writes state.json every 100ms, polls command.json every 50ms (see DESIGN.md).

const UE = require("ue");
const puerts = require("puerts");

const IPC_DIR = "C:/Users/v/pbz-mod/ipc";
const STATE_PATH = IPC_DIR + "/state.json";
const CMD_PATH = IPC_DIR + "/command.json";
const STATE_MS = 100;
const CMD_MS = 50;
const MOVE_MS = 30;
const ABILITY_DUMP_MS = 2000;
const ENEMY_RANGE = 4000; // cm
const ATTR_NAMES = ["Health", "Health_Max", "Shachi", "Shachi_Max", "Attack", "Level", "Shield", "Shield_Max", "UltimateCharge", "UltimateCharge_Max", "Awakening", "Awakening_Max"];
// Known-good assets/tags; extend after probing the live ability list.
const ALIASES = {
    dodge: { asset: "/PBZDeflectSystem/Input/IA_Dodge.IA_Dodge", tag: "Ability.Action.Dodge", priority: -5 },
};

let gi = null;
let timers = [];
let tick = 0;
let lastSeq = 0;
let cmdPrimed = false;
let ack = { seq: 0, ok: true, msg: "bridge started" };
let errors = [];
const attrCache = {};
const tagCache = {};
let abilityCache = null;
let abilityCacheAt = 0;
let forceProbe = false;
let move = null; // {vec, until}
// combat/pause state tracking
let prevPlayerHp = null;
const prevEnemyHp = {};
let lastPlayerHit = 0, lastEnemyHit = 0, lastAttackCmd = 0;
let prevGameTime = null, frozenSince = 0;
// send_msg: floating texts above the player's head (multiple concurrent, rise & expire)
let sayMsgs = []; // {tb, slot, host, mode, born, life, ang, dist, text}
let sayTimer = null;
let sayFont = null;

function getSayFont() {
    if (sayFont) return sayFont;
    try {
        const cls = UE.Class.Load("/Game/PBZContent/UI/UINew/System/Character/Textstyle_Main_CN.Textstyle_Main_CN_C");
        const cdo = UE.SGameAIFunctionLibrary.GetClassDefaultObject(cls);
        sayFont = cdo.Font; // FSlateFontInfo (composite font, Slate renders CJK)
    } catch (e) { note("sayFont", e); }
    return sayFont;
}

function makeSayWidget(text) {
    // Proven path (same as pbz-map-tracker): TextBlock on the game HUD's own
    // CanvasPanel, positioned each tick by projecting the head world position.
    const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
    const TH = require("Library/TsHelper").default;
    const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
    const w = router ? router.GetActiveWidget() : null;
    if (!w) throw new Error("no active widget to host say text");
    const findCanvas = (widget, depth) => {
        if (!widget || depth > 5) return null;
        try { if (widget.IsA(UE.CanvasPanel.StaticClass())) return widget; } catch (e) { }
        try {
            if (typeof widget.GetChildrenCount === "function") {
                for (let i = 0; i < widget.GetChildrenCount(); i++) {
                    const c = findCanvas(widget.GetChildAt(i), depth + 1);
                    if (c) return c;
                }
            }
        } catch (e) { }
        return null;
    };
    let root = null;
    try { root = w.GetRootWidget(); } catch (e) { }
    try { if (!root && w.WidgetTree) root = w.WidgetTree.RootWidget; } catch (e) { }
    const canvas = findCanvas(root, 0);
    const panel = canvas || root;
    if (!panel) throw new Error("no root panel under " + String(w.GetName()));
    const tb = UE.NewObject(UE.TextBlock.StaticClass(), panel);
    tb.SetText(UE.KismetTextLibrary.Conv_StringToText(String(text)));
    const f = getSayFont();
    if (f) { try { tb.SetFont(f); } catch (e) { note("say.setFont", e); } }
    try {
        const sc = new UE.SlateColor();
        sc.SpecifiedColor = new UE.LinearColor(1, 0.94, 0.78, 1);
        tb.SetColorAndOpacity(sc);
    } catch (e) { }
    try { tb.SetRenderTransformPivot(new UE.Vector2D(0.5, 0.5)); } catch (e) { }
    let slot, mode;
    if (canvas) {
        slot = canvas.AddChildToCanvas(tb);
        try { slot.SetAutoSize(true); } catch (e) { }
        mode = "canvas";
    } else {
        slot = panel.AddChildToOverlay(tb);
        try { slot.SetHorizontalAlignment(UE.EHorizontalAlignment.HAlign_Left); } catch (e) { }
        try { slot.SetVerticalAlignment(UE.EVerticalAlignment.VAlign_Top); } catch (e) { }
        mode = "overlay";
    }
    return { tb: tb, slot: slot, host: w, mode: mode };
}

function sayTick() {
    try {
        const now = Date.now();
        const pawn = player();
        const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
        const loc = pawn ? pawn.K2_GetActorLocation() : null;
        let scale = 1;
        try { scale = UE.WidgetLayoutLibrary.GetViewportScale(pc) || 1; } catch (e) { }
        const keep = [];
        for (const m of sayMsgs) {
            const age = now - m.born;
            const valid = loc && UE.KismetSystemLibrary.IsValid(m.tb) && UE.KismetSystemLibrary.IsValid(m.host);
            if (age >= m.life || !valid) {
                try { m.tb.RemoveFromParent(); } catch (e) { }
                continue;
            }
            // fly outward for the entire lifetime: punchy start, never pauses, gone when time is up
            const t = Math.min(age / m.life, 1);
            const e = Math.sqrt(t);
            const rad = m.ang * Math.PI / 180;
            const ref = puerts.$ref();
            const ok = UE.GameplayStatics.ProjectWorldToScreen(pc, new UE.Vector(loc.X, loc.Y, loc.Z + 110), ref, false);
            if (ok) {
                const p2 = puerts.$unref(ref);
                let x = p2.X / scale + Math.sin(rad) * m.dist * e;
                const y = p2.Y / scale - 30 - Math.cos(rad) * m.dist * e;
                try { x -= m.tb.GetDesiredSize().X / 2; } catch (err) { } // center text on the flight point
                if (m.mode === "overlay") m.slot.SetPadding(new UE.Margin(x, y, 0, 0));
                else m.slot.SetPosition(new UE.Vector2D(x, y));
            }
            // restrained stamp-like tilt, text stays readable
            const tilt = Math.max(-14, Math.min(14, m.ang * 0.4));
            try { m.tb.SetRenderTransformAngle(tilt * e); } catch (err) { }
            // fade out over the last 400ms
            const fade = Math.min(1, (m.life - age) / 400);
            try {
                const sc = new UE.SlateColor();
                sc.SpecifiedColor = new UE.LinearColor(1, 0.94, 0.78, fade);
                m.tb.SetColorAndOpacity(sc);
            } catch (e) { }
            keep.push(m);
        }
        sayMsgs = keep;
    } catch (e) { note("sayTick", e); }
}

function sendMsg(text, ms) {
    const pawn = player();
    if (!pawn) throw new Error("no player pawn");
    if (!sayTimer) {
        sayTimer = setInterval(sayTick, 30);
        timers.push(sayTimer);
    }
    const parts = makeSayWidget(text);
    // organic fan-out: random angle/distance/speed, only enforce angular separation
    let ang = 0, tries = 0;
    do {
        ang = (Math.random() - 0.5) * 64; // mostly-upward cone, [-32, 32]
        tries++;
    } while (tries < 12 && sayMsgs.some(m => Math.abs(m.ang - ang) < 15));
    const dist = 260 + Math.random() * 180;
    sayMsgs.push({ tb: parts.tb, slot: parts.slot, host: parts.host, mode: parts.mode, born: Date.now(), life: Math.max(300, Math.min(30000, ms || 2000)), ang: ang, dist: dist, text: String(text) });
    if (sayMsgs.length > 16) {
        const old = sayMsgs.shift();
        try { old.tb.RemoveFromParent(); } catch (e) { }
    }
}

function note(where, e) {
    errors.push({ where: where, msg: String(e), wall: Date.now() });
    if (errors.length > 10)
        errors.shift();
}

function tag(name) {
    if (!tagCache[name]) {
        tagCache[name] = new UE.GameplayTag();
        tagCache[name].TagName = name;
    }
    return tagCache[name];
}

function attr(name) {
    if (!attrCache[name])
        attrCache[name] = UE.PBZBlueprintFunctionLibrary.MakeAttribute(name, UE.BasicAttributeSet.StaticClass());
    return attrCache[name];
}

function player() {
    try {
        return UE.GameplayStatics.GetPlayerCharacter(gi, 0) || null;
    } catch (e) {
        note("player", e);
        return null;
    }
}

function vec3(v) {
    return v ? { x: v.X, y: v.Y, z: v.Z } : null;
}

function readAttrs(actor, names) {
    const out = {};
    for (const n of names) {
        try {
            const v = UE.PBZBlueprintFunctionLibrary.GetAttributeFromCharacter(actor, attr(n));
            if (typeof v === "number")
                out[n] = Math.round(v * 100) / 100;
        } catch (e) { /* attribute not present on this actor */ }
    }
    return out;
}

function enemies(pawn) {
    let actors;
    try {
        const out = puerts.$ref();
        UE.GameplayStatics.GetAllActorsOfClass(gi, UE.Character.StaticClass(), out);
        actors = puerts.$unref(out);
        if (!actors)
            actors = UE.GameplayStatics.GetAllActorsOfClass(gi, UE.Character.StaticClass());
    } catch (e) {
        note("enemies.enum", e);
        return [];
    }
    if (!actors)
        return [];
    const out = [];
    const playerPath = pawn ? UE.KismetSystemLibrary.GetPathName(pawn) : "";
    const pp = pawn ? pawn.K2_GetActorLocation() : null;
    try {
        const n = actors.Num();
        for (let i = 0; i < n; i++) {
            const a = actors.Get(i);
            if (!a)
                continue;
            let path = "";
            try { path = UE.KismetSystemLibrary.GetPathName(a); } catch (e) { continue; }
            if (path === playerPath)
                continue;
            const loc = a.K2_GetActorLocation();
            let dist = null;
            if (pp && loc) {
                const dx = loc.X - pp.X, dy = loc.Y - pp.Y, dz = loc.Z - pp.Z;
                dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
                if (dist > ENEMY_RANGE)
                    continue;
            }
            let cls = "", name = "";
            try { cls = String(a.GetClass().GetName()); } catch (e) { }
            try { name = String(a.GetName()); } catch (e) { }
            const attrs = readAttrs(a, ["Health", "Health_Max"]);
            let montage = null;
            try { const m = a.GetCurrentMontage(); if (m) montage = String(m.GetName()); } catch (e) { }
            out.push({ name: name, class: cls, path: path, pos: vec3(loc), dist: dist, hp: attrs.Health, maxHp: attrs.Health_Max, montage: montage });
        }
    } catch (e) {
        note("enemies.iter", e);
    }
    out.sort((a, b) => (a.dist || 0) - (b.dist || 0));
    return out;
}

// Runtime discovery: GetActivatableAbilities is not reflected, so probe candidate
// input-action assets and attribute names instead. Results land in state.probe.
const IA_DIRS = ["/PBZInput/InputActions/", "/PBZDeflectSystem/Input/", "/SGameCombatSystem/Weapon/Input/", "/Game/PBZContent/Input/InputActions/"];
const IA_NAMES = ["IA_AttackL_Press", "IA_AttackH_Press", "IA_AttackH_PressLong", "IA_Dodge", "IA_Deflect", "IA_Jump", "IA_ShachiAbility", "IA_ShachiAbility_LongPress", "IA_ChangeWeapon", "IA_LockOn", "IA_Lock", "IA_Target", "IA_SwitchTarget", "IA_Interaction", "IA_Sprint", "IA_Execution", "IA_AttackL_PressLong"];
const ATTR_CANDIDATES = ["Health", "HealthMax", "MaxHealth", "Life", "LifeMax", "MaxLife", "ShaChi", "ShaChiMax", "MaxShaChi", "Stamina", "StaminaMax", "Anger", "AngerMax", "Poise", "PoiseMax", "Attack", "Defense", "Speed"];
const assetCache = {};
let probeData = {};

function probeAssets() {
    const out = [];
    for (const dir of IA_DIRS) {
        for (const name of IA_NAMES) {
            const path = dir + name + "." + name;
            if (assetCache[path] === undefined) {
                try { assetCache[path] = !!UE.Object.Load(path); } catch (e) { assetCache[path] = false; }
            }
            if (assetCache[path])
                out.push(path);
        }
    }
    return out;
}

// Generic UE value dumper for probing reflected containers (TMap/TArray/structs).
// Order matters: puerts TMap has Num()/Get(key) too, so iterate FIRST (Get(i)
// on a map is a key lookup and yields undefined). Struct fields live on the
// prototype chain, not own properties.
function dumpValue(v, depth) {
    if (v === null || v === undefined) return null;
    if (typeof v !== "object") return v;
    if (depth > 8) return "<deep>";
    try {
        if (typeof v.GetName === "function" && typeof v.GetClass === "function")
            return { obj: UE.KismetSystemLibrary.GetPathName(v) };
    } catch (e) { }
    try {
        if (typeof v[Symbol.iterator] === "function") {
            const arr = [];
            for (const entry of v) {
                if (arr.length >= 100) break;
                if (Array.isArray(entry)) arr.push(entry.map(x => dumpValue(x, depth + 1)));
                else arr.push(dumpValue(entry, depth + 1));
            }
            return arr;
        }
    } catch (e) { }
    try {
        if (typeof v.Num === "function" && typeof v.Get === "function") {
            const arr = [];
            const n = Math.min(v.Num(), 100);
            for (let i = 0; i < n; i++) arr.push(dumpValue(v.Get(i), depth + 1));
            return arr;
        }
    } catch (e) { }
    const keys = [];
    let p = Object.getPrototypeOf(v);
    while (p && p !== Object.prototype && keys.length < 60) {
        for (const k of Object.getOwnPropertyNames(p)) {
            if (k === "constructor" || k.startsWith("__")) continue;
            const desc = Object.getOwnPropertyDescriptor(p, k);
            if (desc && typeof desc.value === "function") continue;
            if (keys.indexOf(k) < 0) keys.push(k);
        }
        p = Object.getPrototypeOf(p);
    }
    for (const k of Object.getOwnPropertyNames(v))
        if (keys.indexOf(k) < 0) keys.push(k);
    const o = {};
    for (const k of keys.slice(0, 60)) {
        try { o[k] = dumpValue(v[k], depth + 1); } catch (e) { o[k] = "<err>"; }
    }
    return o;
}

// Tag oracle: CanActivateExternalActionAbility answers without activating.
const TAG_CANDIDATES = [
    "Ability.Action.AttackL", "Ability.Action.AttackH", "Ability.Action.Attack", "Ability.Action.Attack.Light", "Ability.Action.Attack.Heavy",
    "Ability.Action.Dodge", "Ability.Action.Deflect", "Ability.Action.Guard", "Ability.Action.Parry", "Ability.Action.Jump",
    "Ability.Action.ShachiAbility", "Ability.Action.ChangeWeapon", "Ability.Action.LockOn", "Ability.Action.Lock", "Ability.Action.Target",
    "Ability.Action.Hun.AttackL", "Ability.Action.Hun.AttackH", "Ability.Action.Hun.Dodge", "Ability.Action.Hun.PerfectDodge",
    "Ability.Action.Interaction", "Ability.Action.Execution", "Ability.Action.Sprint"
];
function probeTags() {
    const pawn = player();
    if (!pawn) return { error: "no pawn" };
    const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
    if (!input) return { error: "no input component" };
    const out = {};
    for (const t of TAG_CANDIDATES) {
        try { out[t] = input.CanActivateExternalActionAbility(tag(t)); } catch (e) { out[t] = "<err: " + String(e).slice(0, 120) + ">"; }
    }
    return out;
}

const AIM_DEFAULT = [
    "/PBZCombatAsset/ActorData/Players/Hun/InputMap/AIM_Hun_LightAttack.AIM_Hun_LightAttack",
    "/PBZCombatAsset/ActorData/Players/Hun/InputMap/AIM_Hun_HeavyAttack.AIM_Hun_HeavyAttack",
    "/PBZCombatAsset/ActorData/Players/Hun/InputMap/AIM_Hun_Dash.AIM_Hun_Dash",
    "/PBZCombatAsset/ActorData/Players/Hun/InputMap/AIM_Hun_Execution.AIM_Hun_Execution",
    "/PBZCombatAsset/ActorData/Players/Hun/InputMap/AIM_Hun_ShachiAbility.AIM_Hun_ShachiAbility",
    "/PBZCombatAsset/ActorData/Players/Hun/Weapon/Long/AIM_Long_LightAttack.AIM_Long_LightAttack"
];
function dumpUObject(obj, depth) {
    const keys = [];
    let p = Object.getPrototypeOf(obj);
    while (p && p !== Object.prototype && keys.length < 80) {
        for (const k of Object.getOwnPropertyNames(p)) {
            if (k === "constructor" || k.startsWith("__")) continue;
            const desc = Object.getOwnPropertyDescriptor(p, k);
            if (desc && typeof desc.value === "function") continue;
            if (keys.indexOf(k) < 0) keys.push(k);
        }
        p = Object.getPrototypeOf(p);
    }
    const o = {};
    for (const k of keys.slice(0, 80)) {
        try { o[k] = dumpValue(obj[k], depth + 1); } catch (e) { o[k] = "<err>"; }
    }
    return o;
}
function probeAim(paths) {
    const out = {};
    for (const path of paths) {
        try {
            const a = UE.Object.Load(path);
            out[path] = a ? dumpUObject(a, 0) : null;
        } catch (e) { out[path] = String(e); }
    }
    return out;
}

// --- Pure ability activation via the game's own AIM routing rules ---
// InputBindings maps IA -> AIM assets; each AIM lists entries with
// RequiredTags/IgnoredTags/TriggerTag/ActionPriority. We replicate the
// selection (highest priority, conditions matched against the ASC) and
// activate through TryActivateExternalActionAbilityByTag. No input simulation.
let bindingCache = null;
function getAimMap() {
    if (bindingCache) return bindingCache;
    const pawn = player();
    if (!pawn) throw new Error("no pawn");
    const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
    const map = {};
    for (const entry of input.InputBindings) {
        const ia = entry[0], data = entry[1];
        const iaPath = UE.KismetSystemLibrary.GetPathName(ia);
        const aims = [];
        const bs = data.Bindings;
        for (let i = 0; i < bs.Num(); i++)
            aims.push(UE.KismetSystemLibrary.GetPathName(bs.Get(i)));
        map[iaPath] = aims;
    }
    bindingCache = map;
    return map;
}

function tagList(container) {
    const out = [];
    if (!container) return out;
    try {
        const arr = container.GameplayTags;
        for (let i = 0; i < arr.Num(); i++) out.push(String(arr.Get(i).TagName));
    } catch (e) { }
    return out;
}

function aimActivate(iaPath) {
    const aims = getAimMap()[iaPath];
    if (!aims || !aims.length) throw new Error("no AIM binding for " + iaPath);
    const pawn = player();
    const asc = UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn);
    const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
    const entries = [];
    for (const p of aims) {
        const aim = UE.Object.Load(p);
        if (!aim) continue;
        const bs = aim.Bindings;
        for (let i = 0; i < bs.Num(); i++) {
            const b = bs.Get(i);
            const nd = b.NormalData;
            if (!nd) continue;
            for (const list of [nd.Actions, nd.Combos]) {
                if (!list) continue;
                for (let j = 0; j < list.Num(); j++)
                    entries.push({ prio: b.ActionPriority, e: list.Get(j) });
            }
        }
    }
    entries.sort((a, b) => b.prio - a.prio);
    const tried = [];
    for (const { e } of entries) {
        const req = tagList(e.RequiredTags);
        const ign = tagList(e.IgnoredTags);
        let ok = true;
        for (const t of req) if (!asc.HasMatchingGameplayTag(tag(t))) { ok = false; break; }
        if (ok) for (const t of ign) if (asc.HasMatchingGameplayTag(tag(t))) { ok = false; break; }
        if (!ok) continue;
        let name = "";
        try { name = String(e.TriggerTag.TagName); } catch (err) { continue; }
        if (!name || name === "None") continue;
        // Skip the ability that is already running (e.g. attack 1 during its
        // own animation); the next matching entry is the combo continuation.
        if (asc.HasMatchingGameplayTag(tag(name))) continue;
        tried.push(name);
        if (input.TryActivateExternalActionAbilityByTag(tag(name)))
            return name;
        // Refused while conditions hold: combo follow-ups and dodge-cancels
        // go through the forced path (the game buffers these internally).
        input.ForceActivateExternalActionAbilityByTag(tag(name));
        return name + " (forced)";
    }
    throw new Error("no AIM entry activated; tried: " + tried.slice(0, 6).join(", "));
}

const ACTION_IA = {
    attack_light: "/PBZInput/InputActions/IA_AttackL_Press.IA_AttackL_Press",
    attack_heavy: "/PBZInput/InputActions/IA_AttackH_Press.IA_AttackH_Press",
    dodge: "/PBZDeflectSystem/Input/IA_Dodge.IA_Dodge",
    execution: "/PBZInput/InputActions/IA_Execution.IA_Execution",
    shachi_ability: "/PBZInput/InputActions/IA_ShachiAbility.IA_ShachiAbility",
    jump: "/PBZInput/InputActions/IA_Jump.IA_Jump",
    change_weapon: "/SGameCombatSystem/Weapon/Input/IA_ChangeWeapon.IA_ChangeWeapon"
};

function probeBindings() {
    const pawn = player();
    if (!pawn) return { error: "no pawn" };
    const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
    if (!input) return { error: "no input component" };
    const out = {};
    for (const prop of ["InputSets", "CurrentInputSets", "InputBindings", "ValidBufferInputs"]) {
        try { out[prop] = dumpValue(input[prop], 0); } catch (e) { out[prop] = "<err: " + e + ">"; }
    }
    return out;
}

function runProbe() {
    const pawn = player();
    probeData = { wall: Date.now(), assets: [], attrs: {} };
    try { probeData.assets = probeAssets(); } catch (e) { note("probe.assets", e); }
    try { if (pawn) probeData.attrs = readAttrs(pawn, ATTR_CANDIDATES); } catch (e) { note("probe.attrs", e); }
}

// Deep probe: the game's universal input-action DataTable + reflected class members.
function probeInput() {
    const out = { rows: [], classKeys: {} };
    try {
        const UIHelper = require("Library/UIHelper").default;
        const handle = UIHelper.MakeInputDataTableHandle("Test");
        const dt = handle && handle.DataTable;
        if (dt) {
            out.table = UE.KismetSystemLibrary.GetPathName(dt);
            const names = UE.DataTableFunctionLibrary.GetDataTableRowNames(dt);
            for (let i = 0; i < names.Num(); i++)
                out.rows.push(String(names.Get(i)));
        }
    } catch (e) { out.tableError = String(e); }
    const protoKeys = (cls) => {
        try {
            const cdo = UE.SGameAIFunctionLibrary.GetClassDefaultObject(cls);
            const keys = [];
            let p = Object.getPrototypeOf(cdo);
            while (p && keys.length < 400) {
                for (const k of Object.getOwnPropertyNames(p))
                    if (!k.startsWith("__") && keys.indexOf(k) < 0) keys.push(k);
                p = Object.getPrototypeOf(p);
            }
            return keys;
        } catch (e) { return ["<err: " + e + ">"] ; }
    };
    try { out.classKeys.BasicAttributeSet = protoKeys(UE.BasicAttributeSet.StaticClass()); } catch (e) { note("probe.bas", e); }
    try {
        const pawn = player();
        const input = pawn ? pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass()) : null;
        if (input) out.classKeys.AbilityInputComponent = protoKeys(input.GetClass());
    } catch (e) { note("probe.aic", e); }
    return out;
}

function collect() {
    const st = { wall: Date.now(), tick: ++tick, ack: ack, errors: errors };
    try { st.t = UE.GameplayStatics.GetTimeSeconds(gi); } catch (e) { }
    // pause detection: game time frozen while wall clock moves
    const nowMs = Date.now();
    if (prevGameTime !== null && Math.abs(st.t - prevGameTime) < 0.001) {
        if (!frozenSince) frozenSince = nowMs;
    } else {
        frozenSince = 0;
    }
    prevGameTime = st.t;
    st.paused = frozenSince > 0 && nowMs - frozenSince > 400;
    const pawn = player();
    if (!pawn) {
        st.player = null;
        return st;
    }
    try {
        const rot = pawn.K2_GetActorRotation();
        let montage = null;
        try { const m = pawn.GetCurrentMontage(); if (m) montage = String(m.GetName()); } catch (e) { }
        let controlYaw = null;
        try { const ctrl = pawn.GetController(); if (ctrl) controlYaw = ctrl.GetControlRotation().Yaw; } catch (e) { }
        st.player = {
            pos: vec3(pawn.K2_GetActorLocation()),
            yaw: rot ? rot.Yaw : null,
            controlYaw: controlYaw,
            attrs: readAttrs(pawn, ATTR_NAMES),
            montage: montage,
            path: UE.KismetSystemLibrary.GetPathName(pawn),
        };
    } catch (e) { note("collect.player", e); }
    try { st.enemies = enemies(pawn); } catch (e) { note("collect.enemies", e); }
    // combat state: recent damage exchange / attack commands, or hostile nearby
    try {
        const hp = st.player ? st.player.attrs.Health : null;
        if (hp !== null) {
            if (prevPlayerHp !== null && hp < prevPlayerHp - 0.5) lastPlayerHit = nowMs;
            prevPlayerHp = hp;
        }
        for (const e of st.enemies || []) {
            const old = prevEnemyHp[e.path];
            if (old !== undefined && e.hp !== null && e.hp < old - 0.5) lastEnemyHit = nowMs;
            if (e.hp !== null) prevEnemyHp[e.path] = e.hp;
        }
        const hostileNear = (st.enemies || []).some(e => e.hp > 0 && e.dist < 1500 && /Attack|Hit|Special|Skill/.test(e.montage || ""));
        const recent = nowMs - Math.max(lastPlayerHit, lastEnemyHit, lastAttackCmd) < 6000;
        // authoritative: the game's own OffCombat tag; heuristic as fallback
        let tagCombat = null;
        try {
            const asc = UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn);
            if (asc) tagCombat = !asc.HasMatchingGameplayTag(tag("CharacterState.OffCombat"));
        } catch (e) { }
        st.inCombat = !st.paused && (tagCombat !== null ? tagCombat : (hostileNear || recent));
        st.combatByTag = tagCombat;
    } catch (e) { note("combatState", e); }
    // active UI widget (menu detection)
    try {
        const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
        const TH = require("Library/TsHelper").default;
        const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
        const w = router ? router.GetActiveWidget() : null;
        st.activeWidget = w ? String(w.GetName()) : null;
    } catch (e) { }
    if (!probeData.wall) {
        // first tick with a live pawn: auto-run all discovery probes once
        try { runProbe(); probeData.input = probeInput(); probeData.bindings = probeBindings(); probeData.tags = probeTags(); probeData.aim = probeAim(AIM_DEFAULT); } catch (e) { note("autoProbe", e); }
    }
    if (forceProbe) {
        forceProbe = false;
        try { runProbe(); } catch (e) { note("probe", e); }
    }
    st.probe = probeData;
    st.say = sayMsgs.map(m => m.text);
    return st;
}

function writeState() {
    try {
        const st = collect();
        // Keep the file pure ASCII: EasyCsv switches to UTF-16 for non-ASCII
        // content, which breaks the UTF-8 readers. Escape everything >= 0x7f.
        const text = JSON.stringify(st).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
        UE.EasyCsv.SaveStringToFileWithFullPath(text, STATE_PATH);
    } catch (e) {
        note("writeState", e);
    }
}

function activate(p) {
    const pawn = player();
    if (!pawn)
        throw new Error("no player pawn");
    const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
    if (!input)
        throw new Error("no AbilityInputComponent");
    if (!p.asset || !p.tag)
        throw new Error("ability needs params.asset and params.tag");
    const ia = UE.Object.Load(p.asset);
    if (!ia)
        throw new Error("asset load failed: " + p.asset);
    const priority = typeof p.priority === "number" ? p.priority : -5;
    const ok = input.TryActivateExternalActionAbilityInterruptLowerByTag(tag(p.tag), ia, priority);
    if (!ok)
        throw new Error("input component refused (tag=" + p.tag + ")");
}

function startMove(p) {
    const pawn = player();
    if (!pawn)
        throw new Error("no player pawn");
    const ms = Math.max(0, Math.min(5000, typeof p.ms === "number" ? p.ms : 300));
    let f = 0, r = 0;
    const dir = p.dir || "forward";
    if (dir === "forward") f = 1;
    else if (dir === "back") f = -1;
    else if (dir === "left") r = -1;
    else if (dir === "right") r = 1;
    else if (dir === "vector" && (typeof p.forward === "number" || typeof p.right === "number")) {
        f = p.forward || 0;
        r = p.right || 0;
    } else throw new Error("bad dir: " + dir);
    const ctrl = pawn.GetController();
    const rot = ctrl ? ctrl.GetControlRotation() : pawn.K2_GetActorRotation();
    const fwd = UE.KismetMathLibrary.GetForwardVector(rot);
    const right = UE.KismetMathLibrary.GetRightVector(rot);
    const x = fwd.X * f + right.X * r, y = fwd.Y * f + right.Y * r;
    const len = Math.sqrt(x * x + y * y) || 1;
    move = { vec: new UE.Vector(x / len, y / len, 0), until: Date.now() + ms };
}

function moveTick() {
    if (!move)
        return;
    if (Date.now() > move.until) {
        move = null;
        return;
    }
    try {
        const pawn = player();
        if (pawn)
            pawn.AddMovementInput(move.vec, 1.0, false);
    } catch (e) {
        note("move", e);
        move = null;
    }
}

function execute(cmd) {
    try {
        const p = cmd.params || {};
        switch (cmd.action) {
            case "move": startMove(p); break;
            case "stop": move = null; break;
            case "send_msg": sendMsg(p.text || "", p.ms); break;
            case "pause_game": UE.GameplayStatics.SetGamePaused(gi, true); break;
            case "resume_game": UE.GameplayStatics.SetGamePaused(gi, false); break;
            case "attack_light": case "attack_heavy": case "dodge": case "execution":
            case "shachi_ability": case "jump": case "change_weapon": {
                lastAttackCmd = Date.now();
                const activated = aimActivate(ACTION_IA[cmd.action]);
                ack = { seq: cmd.seq, ok: true, msg: cmd.action + " -> " + activated };
                return;
            }
            case "probe": forceProbe = true; break;
            case "probe_assets": case "probe_attrs": forceProbe = true; break;
            case "probe_input":
                probeData.input = probeInput();
                probeData.wall = Date.now();
                break;
            case "probe_bindings":
                probeData.bindings = probeBindings();
                probeData.wall = Date.now();
                break;
            case "probe_tags":
                probeData.tags = probeTags();
                probeData.wall = Date.now();
                break;
            case "probe_aim":
                probeData.aim = probeAim(p.paths || AIM_DEFAULT);
                probeData.wall = Date.now();
                break;
            case "check_tags": {
                const pawn = player();
                const asc = pawn ? UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn) : null;
                if (!asc) throw new Error("no asc");
                const out = {};
                for (const t of (p.tags || [])) out[t] = asc.HasMatchingGameplayTag(tag(t));
                probeData.checkTags = { wall: Date.now(), tags: out };
                break;
            }
            case "input_action": {
                // Route through the component's own input handler, like a real key press.
                const pawn = player();
                if (!pawn) throw new Error("no player pawn");
                const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
                const ia = UE.Object.Load(p.asset);
                if (!ia) throw new Error("asset load failed: " + p.asset);
                input.HandleInputAction(ia);
                break;
            }
            case "ability_tag": {
                const pawn = player();
                if (!pawn) throw new Error("no player pawn");
                const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
                if (!input) throw new Error("no AbilityInputComponent");
                const ok = input.TryActivateExternalActionAbilityByTag(tag(p.tag));
                if (!ok) throw new Error("refused (tag=" + p.tag + ")");
                break;
            }
            case "force_tag": {
                const pawn = player();
                if (!pawn) throw new Error("no player pawn");
                const input = pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass());
                input.ForceActivateExternalActionAbilityByTag(tag(p.tag));
                break;
            }
            case "menu": {
                // ESC equivalent: the game's own system-menu input action.
                const ia = UE.Object.Load("/Game/PBZContent/Input/InputActions/IA_PushGameSystemMenu.IA_PushGameSystemMenu");
                if (!ia) throw new Error("system menu IA not found");
                const pawn = player();
                const input = pawn ? pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass()) : null;
                if (!input) throw new Error("no input component");
                input.HandleInputAction(ia);
                break;
            }
            case "menu_back": {
                // Close the active menu through its own back handler (what ESC calls).
                const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                const TH = require("Library/TsHelper").default;
                const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
                const w = router ? router.GetActiveWidget() : null;
                if (!w) throw new Error("no active widget");
                if (typeof w.BackInput === "function") { w.BackInput(); break; }
                if (typeof w.BP_OnHandleBackAction === "function") { w.BP_OnHandleBackAction(); break; }
                throw new Error("active widget has no back handler: " + UE.KismetSystemLibrary.GetPathName(w));
            }
            case "menu_open": case "pause": {
                const ia = UE.Object.Load("/Game/PBZContent/Input/InputActions/IA_PushGameSystemMenu.IA_PushGameSystemMenu");
                if (!ia) throw new Error("system menu IA not found");
                const pawn = player();
                const input = pawn ? pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass()) : null;
                if (!input) throw new Error("no input component");
                input.HandleInputAction(ia);
                break;
            }
            case "menu_close": case "resume": {
                const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                const TH = require("Library/TsHelper").default;
                const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
                const w = router ? router.GetActiveWidget() : null;
                if (!w) throw new Error("no active widget");
                const wn = String(w.GetName());
                if (!/Systembase|Setting|Menu|Dialog/i.test(wn)) throw new Error("active widget is not a menu: " + wn);
                if (typeof w.DeactivateWidget !== "function") throw new Error("active widget cannot deactivate: " + wn);
                w.DeactivateWidget();
                break;
            }
            case "deflect": {
                const ia = UE.Object.Load("/PBZDeflectSystem/Input/IA_Deflect.IA_Deflect");
                if (!ia) throw new Error("IA_Deflect not found");
                const pawn = player();
                const input = pawn ? pawn.GetComponentByClass(UE.AbilityInputComponent.StaticClass()) : null;
                if (!input) throw new Error("no input component");
                input.HandleInputAction(ia);
                break;
            }
            case "restore_hud": {
                const candidates = [
                    "/Game/PBZContent/UI/FrontEnd/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C",
                    "/Game/PBZContent/UI/FrontEnd/HUD/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C",
                    "/Game/PBZContent/UI/InGame/HUD/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C",
                    "/Game/PBZContent/UI/UINew/HUD/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C",
                    "/Game/PBZContent/UI/HUD/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C",
                    "/Game/PBZContent/UI/InGame/W_FrontEndHUDLayout.W_FrontEndHUDLayout_C"
                ];
                const out = { tried: [] };
                const um = UE.SubsystemBlueprintLibrary.GetGameInstanceSubsystem(gi, UE.PBZUIManagerSubsystem.StaticClass());
                for (const path of candidates) {
                    let cls = null;
                    try { cls = UE.Object.Load(path); } catch (e) { }
                    out.tried.push({ path: path, loaded: !!cls });
                    if (!cls) continue;
                    out.classPath = path;
                    let w = null;
                    const attempts = [];
                    try { w = um.GetCachedLayerWidget(path); attempts.push("string:ok"); } catch (e) { attempts.push("string:" + String(e).slice(0, 80)); }
                    if (!w) {
                        try {
                            const conv = UE.KismetSystemLibrary.Conv_SoftClassPathToSoftClassRef;
                            if (typeof conv === "function") {
                                const soft = conv(path);
                                w = um.GetCachedLayerWidget(soft);
                                attempts.push("conv:ok");
                            } else attempts.push("conv:missing");
                        } catch (e) { attempts.push("conv:" + String(e).slice(0, 80)); }
                    }
                    out.attempts = attempts;
                    if (!w) {
                        try {
                            const soft = UE.KismetSystemLibrary.Conv_SoftClassPathToSoftClassRef(path);
                            const r = um.PushCachedWidgetToLayer(soft);
                            out.push = r === undefined || r === null ? String(r) : (typeof r === "object" ? String(r.GetName ? r.GetName() : r) : String(r));
                        } catch (e) { out.push = String(e).slice(0, 150); }
                    }
                    if (w) {
                        out.widget = String(w.GetName());
                        out.hasActivate = typeof w.ActivateWidget === "function";
                        if (typeof w.ActivateWidget === "function") { w.ActivateWidget(); out.activated = true; }
                    }
                    break;
                }
                probeData.restoreHud = out;
                break;
            }
            case "ui_manager_call": {
                const um = UE.SubsystemBlueprintLibrary.GetGameInstanceSubsystem(gi, UE.PBZUIManagerSubsystem.StaticClass());
                if (!um) throw new Error("no ui manager");
                const fn = p.fn;
                if (typeof um[fn] !== "function") throw new Error("no function " + fn);
                const args = p.args || [];
                const r = um[fn](...args);
                probeData.uiCall = { fn: fn, args: args, result: r === undefined || r === null ? String(r) : (typeof r === "object" ? UE.KismetSystemLibrary.GetPathName(r) : String(r)) };
                break;
            }
            case "probe_ui_layers": {
                const um = UE.SubsystemBlueprintLibrary.GetGameInstanceSubsystem(gi, UE.PBZUIManagerSubsystem.StaticClass());
                const out = {};
                for (let i = 0; i < 10; i++) {
                    const row = {};
                    try { const w = um.GetCachedLayerWidget(i); row.cached = w ? String(w.GetName()) : null; } catch (e) { row.cached = "<err: " + String(e).slice(0, 150) + ">"; }
                    if (i > 0) break;
                    try { const w = um.GetActivateWidgetByLayer(i); row.active = w ? String(w.GetName()) : null; } catch (e) { row.active = "<err>"; }
                    out[i] = row;
                }
                probeData.uiLayers = out;
                probeData.wall = Date.now();
                break;
            }
            case "probe_say_host": {
                const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                const TH = require("Library/TsHelper").default;
                const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
                const w = router ? router.GetActiveWidget() : null;
                const out = { widget: w ? String(w.GetName()) : null };
                out.hasGetRootWidget = w ? typeof w.GetRootWidget : "n/a";
                let root = null;
                try { root = w.GetRootWidget(); } catch (e) { out.getRootErr = String(e).slice(0, 100); }
                try { if (!root && w.WidgetTree) root = w.WidgetTree.RootWidget; } catch (e) { out.treeErr = String(e).slice(0, 100); }
                out.rootClass = root ? String(root.GetClass().GetName()) : null;
                const tree = [];
                const walk = (widget, depth) => {
                    if (!widget || depth > 6 || tree.length > 60) return;
                    let cls = "?";
                    try { cls = String(widget.GetClass().GetName()); } catch (e) { }
                    tree.push("  ".repeat(depth) + cls);
                    try {
                        if (typeof widget.GetChildrenCount === "function")
                            for (let i = 0; i < widget.GetChildrenCount(); i++) walk(widget.GetChildAt(i), depth + 1);
                    } catch (e) { }
                };
                walk(root, 0);
                out.tree = tree;
                probeData.sayHost = out;
                break;
            }
            case "probe_combat_ui": {
                const out = {};
                const staticFuncs = (cls) => {
                    try { return Object.getOwnPropertyNames(cls).filter(k => typeof cls[k] === "function"); } catch (e) { return String(e); }
                };
                const instFuncs = (obj) => {
                    if (!obj) return null;
                    const keys = [];
                    let q = Object.getPrototypeOf(obj);
                    while (q && q !== Object.prototype && keys.length < 300) {
                        for (const k of Object.getOwnPropertyNames(q)) {
                            if (k === "constructor" || k.startsWith("__")) continue;
                            const desc = Object.getOwnPropertyDescriptor(q, k);
                            if (desc && typeof desc.value === "function" && keys.indexOf(k) < 0) keys.push(k);
                        }
                        q = Object.getPrototypeOf(q);
                    }
                    return keys;
                };
                out.uiManagerStatic = staticFuncs(UE.PBZUIManagerSubsystem);
                out.gameSystemStatic = staticFuncs(UE.PBZGameSystem);
                try {
                    const pawn = player();
                    const dc = pawn ? pawn.GetComponentByClass(UE.DeflectComponent.StaticClass()) : null;
                    out.deflectFuncs = instFuncs(dc);
                } catch (e) { out.deflectFuncs = String(e); }
                try {
                    const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                    const TH = require("Library/TsHelper").default;
                    const um = TH.getWorldSubsystem(pc, UE.PBZUIManagerSubsystem.StaticClass());
                    out.uiManagerWorld = instFuncs(um);
                } catch (e) { out.uiManagerWorld = String(e); }
                try {
                    const um2 = UE.SubsystemBlueprintLibrary.GetGameInstanceSubsystem(gi, UE.PBZUIManagerSubsystem.StaticClass());
                    out.uiManagerGI = instFuncs(um2);
                } catch (e) { out.uiManagerGI = String(e); }
                try {
                    const gs = UE.SubsystemBlueprintLibrary.GetGameInstanceSubsystem(gi, UE.PBZGameSystem.StaticClass());
                    out.gameSystemGI = instFuncs(gs);
                } catch (e) { out.gameSystemGI = String(e); }
                probeData.combatUi = out;
                probeData.wall = Date.now();
                break;
            }
            case "owned_tags": {
                const pawn = player();
                const asc = pawn ? UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn) : null;
                if (!asc) throw new Error("no asc");
                let container = null;
                try { container = asc.BP_GetOwnedGameplayTags(); } catch (e) { }
                if (!container) {
                    const ref = puerts.$ref();
                    asc.BP_GetOwnedGameplayTags(ref);
                    container = puerts.$unref(ref);
                }
                probeData.ownedTags = { wall: Date.now(), tags: tagList(container) };
                break;
            }
            case "probe_asc": {
                const pawn = player();
                const asc = pawn ? UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn) : null;
                const keys = [];
                if (asc) {
                    let q = Object.getPrototypeOf(asc);
                    while (q && q !== Object.prototype && keys.length < 500) {
                        for (const k of Object.getOwnPropertyNames(q)) {
                            if (k === "constructor" || k.startsWith("__")) continue;
                            const desc = Object.getOwnPropertyDescriptor(q, k);
                            if (desc && typeof desc.value === "function" && keys.indexOf(k) < 0) keys.push(k);
                        }
                        q = Object.getPrototypeOf(q);
                    }
                }
                probeData.asc = keys.filter(k => /tag|combat|battle|state/i.test(k));
                // lock-on related components on the pawn
                try {
                    const comps = pawn.GetComponents();
                    const names = [];
                    for (let i = 0; i < comps.Num(); i++) names.push(String(comps.Get(i).GetClass().GetName()));
                    probeData.pawnComponents = names;
                } catch (e) { probeData.pawnComponents = String(e); }
                try {
                    const cdo = UE.SGameAIFunctionLibrary.GetClassDefaultObject(UE.SwitchLockObject.StaticClass());
                    const keys2 = [];
                    let q = Object.getPrototypeOf(cdo);
                    while (q && q !== Object.prototype && keys2.length < 200) {
                        for (const k of Object.getOwnPropertyNames(q)) {
                            const desc = Object.getOwnPropertyDescriptor(q, k);
                            if (desc && typeof desc.value === "function" && keys2.indexOf(k) < 0) keys2.push(k);
                        }
                        q = Object.getPrototypeOf(q);
                    }
                    probeData.switchLock = keys2;
                } catch (e) { probeData.switchLock = String(e); }
                probeData.wall = Date.now();
                break;
            }
            case "widget_call": {
                const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                const TH = require("Library/TsHelper").default;
                const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
                const w = router ? router.GetActiveWidget() : null;
                if (!w) throw new Error("no active widget");
                const fn = p.fn;
                if (typeof w[fn] !== "function") throw new Error("no function " + fn + " on " + UE.KismetSystemLibrary.GetPathName(w));
                const r = w[fn]();
                probeData.widgetCall = { fn: fn, widget: UE.KismetSystemLibrary.GetPathName(w), result: r === undefined ? "void" : String(r) };
                break;
            }
            case "probe_ui": {
                const pc = UE.GameplayStatics.GetPlayerController(gi, 0);
                const TH = require("Library/TsHelper").default;
                const keysOf = (obj) => {
                    if (!obj) return null;
                    const keys = [];
                    let q = Object.getPrototypeOf(obj);
                    while (q && q !== Object.prototype && keys.length < 200) {
                        for (const k of Object.getOwnPropertyNames(q)) {
                            if (k === "constructor" || k.startsWith("__")) continue;
                            const desc = Object.getOwnPropertyDescriptor(q, k);
                            if (desc && typeof desc.value === "function" && keys.indexOf(k) < 0) keys.push(k);
                        }
                        q = Object.getPrototypeOf(q);
                    }
                    return keys;
                };
                const out = {};
                try { out.router = keysOf(TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass())); } catch (e) { out.router = String(e); }
                try { out.uiManager = keysOf(TH.getlocalPlayerSubsystem(pc, UE.PBZUIManagerSubsystem.StaticClass())); } catch (e) { out.uiManager = String(e); }
                try { out.einput = keysOf(TH.getlocalPlayerSubsystem(pc, UE.EnhancedInputLocalPlayerSubsystem.StaticClass())); } catch (e) { out.einput = String(e); }
                try {
                    const router = TH.getlocalPlayerSubsystem(pc, UE.PBZUIActionRouterBase.StaticClass());
                    const w = router ? router.GetActiveWidget() : null;
                    out.activeWidget = w ? UE.KismetSystemLibrary.GetPathName(w) : null;
                    out.activeWidgetKeys = keysOf(w);
                    out.inputMode = router ? String(router.GetActiveInputMode()) : null;
                } catch (e) { out.activeWidget = String(e); }
                try { out.uiManagerWorld = keysOf(TH.getWorldSubsystem(pc, UE.PBZUIManagerSubsystem.StaticClass())); } catch (e) { out.uiManagerWorld = String(e); }
                probeData.ui = out;
                probeData.wall = Date.now();
                break;
            }
            case "aim_activate": {
                const activated = aimActivate(p.ia);
                ack = { seq: cmd.seq, ok: true, msg: "aim_activate -> " + activated };
                return;
            }
            case "ability": activate(p); break;
            default: throw new Error("unknown action: " + cmd.action);
        }
        ack = { seq: cmd.seq, ok: true, msg: cmd.action + " accepted" };
    } catch (e) {
        note("execute", e);
        ack = { seq: cmd.seq, ok: false, msg: String(e) };
    }
}

function readCommand() {
    try {
        if (!UE.BlueprintPathsLibrary.FileExists(CMD_PATH))
            return;
        const out = puerts.$ref("");
        if (!UE.EasyCsv.LoadStringFromLocalFile(CMD_PATH, out))
            return; // locked mid-write or too short; retry next poll
        const text = String(puerts.$unref(out)).replace(/^\uFEFF/, "");
        const cmd = JSON.parse(text);
        if (!cmd || typeof cmd.seq !== "number")
            return;
        if (!cmdPrimed) {
            // first readable command after (re)load: adopt its seq, never replay stale commands
            cmdPrimed = true;
            lastSeq = cmd.seq;
            return;
        }
        if (cmd.seq <= lastSeq)
            return;
        lastSeq = cmd.seq;
        execute(cmd);
    } catch (e) {
        note("readCommand", e);
    }
}

exports.stop = function () {
    for (const t of timers)
        clearInterval(t);
    timers = [];
    move = null;
    for (const m of sayMsgs) {
        try { m.tb.RemoveFromParent(); } catch (e) { }
    }
    sayMsgs = [];
};

gi = puerts.argv.getByName("GameInstance");
timers.push(setInterval(writeState, STATE_MS));
timers.push(setInterval(readCommand, CMD_MS));
timers.push(setInterval(moveTick, MOVE_MS));
writeState();