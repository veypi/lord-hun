"""M3 combat policy v2 — combat-state driven, with battle cries.
Waits for inCombat (game's OffCombat tag) -> runs combat logic -> stops
automatically when combat ends. Shouts skill names/taunts via send_msg.
External AI client over MCP HTTP; structured perception only.
"""
import json
import math
import random
import time
import urllib.request

URL = "http://127.0.0.1:8765/mcp"
LOG = []
T0 = time.time()

CRY_ATTACK = ["破剑式！", "看招！", "斩！", "疾风连斩！", "破！", "剑出无痕！"]
CRY_DODGE = ["太慢了！", "哼，雕虫小技", "闪！", "打不着！"]
CRY_KILL = ["不过如此！", "还有谁！", "不堪一击。", "下一个。"]
CRY_ENGAGE = ["来战！", "拔剑吧！"]


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def tool(name, args=None):
    r = rpc("tools/call", {"name": name, "arguments": args or {}})
    res = r.get("result", {})
    txt = res.get("content", [{}])[0].get("text", "{}")
    try:
        return json.loads(txt), res.get("isError", False)
    except Exception:
        return {"raw": txt}, True


def cmd(action, params=None):
    return tool("command", {"action": action, "params": params or {}})


def say(text):
    try:
        cmd("send_msg", {"text": text})
    except Exception:
        pass


def log(event, **kw):
    entry = {"t": round(time.time() - T0, 2), "event": event, **kw}
    LOG.append(entry)
    print(json.dumps(entry, ensure_ascii=False), flush=True)


def components(tx, ty, px, py, yaw_deg):
    dx, dy = tx - px, ty - py
    n = math.hypot(dx, dy) or 1
    dx, dy = dx / n, dy / n
    c = math.radians(yaw_deg)
    return dx * math.cos(c) + dy * math.sin(c), -dx * math.sin(c) + dy * math.cos(c)


def monsters(st):
    return sorted(
        [e for e in st.get("enemies", [])
         if e.get("hp") is not None and e["hp"] > 0 and not e["class"].startswith("BP_NPC")],
        key=lambda e: e["dist"])


last_attack = 0
last_dodge = 0
last_cry = 0
kills = []
known_hp = {}
target_name = None
combat_active = False
out_since = None
engage_cried = False

log("waiting_for_combat")
while time.time() - T0 < 600:
    st, err = tool("get_state")
    if err or not st.get("player"):
        time.sleep(0.3)
        continue
    if st.get("paused"):
        time.sleep(0.3)
        continue

    # kill detection: tracked monster hp crossed to <=0 or vanished
    for e in st.get("enemies", []):
        old = known_hp.get(e["name"])
        if old is not None and old > 0 and (e.get("hp") or 0) <= 0:
            kills.append(e["class"])
            log("kill", enemy=e["class"], total=len(kills))
            say(random.choice(CRY_KILL))
        if e.get("hp") is not None:
            known_hp[e["name"]] = e["hp"]
    live_names = {e["name"] for e in st.get("enemies", []) if (e.get("hp") or 0) > 0}
    for name, hp in list(known_hp.items()):
        if hp > 0 and name not in live_names and not any(k in name for k in []):
            # vanished while previously alive and damaged -> count once
            if hp < 999999 and name not in [k.get("_name") for k in []]:
                pass

    in_combat = bool(st.get("inCombat"))
    if in_combat:
        out_since = None
        if not combat_active:
            combat_active = True
            log("combat_start")
            if not engage_cried:
                say(random.choice(CRY_ENGAGE))
                engage_cried = True
    else:
        if combat_active:
            if out_since is None:
                out_since = time.time()
            elif time.time() - out_since > 2.5:
                log("combat_end", kills=len(kills))
                break
        time.sleep(0.2)
        continue

    p = st["player"]
    attrs = p["attrs"]
    if attrs["Health"] <= 0:
        log("player_dead")
        break
    enemies = monsters(st)
    if not enemies:
        time.sleep(0.2)
        continue
    target = enemies[0]
    if target["name"] != target_name:
        target_name = target["name"]
        log("target", enemy=target["class"], hp=target["hp"], dist=target["dist"])

    yaw = p.get("controlYaw") if p.get("controlYaw") is not None else p["yaw"]
    now = time.time()

    # threat: live enemy attack montage nearby -> dodge away (+ occasional taunt)
    threat = None
    for e in enemies:
        m = e.get("montage") or ""
        if e["dist"] < 450 and any(k in m for k in ("Attack", "Hit", "Special", "Skill")):
            threat = e
            break
    if threat and now - last_dodge > 0.9:
        f, r = components(threat["pos"]["x"], threat["pos"]["y"], p["pos"]["x"], p["pos"]["y"], yaw)
        cmd("move", {"dir": "vector", "forward": -f, "right": -r, "ms": 120})
        resp, e2 = cmd("dodge")
        last_dodge = now
        log("dodge", threat=threat["class"], ok=not e2)
        if now - last_cry > 4 and random.random() < 0.5:
            say(random.choice(CRY_DODGE))
            last_cry = now
        time.sleep(0.25)
        continue

    if target["dist"] > 250:
        f, r = components(target["pos"]["x"], target["pos"]["y"], p["pos"]["x"], p["pos"]["y"], yaw)
        cmd("move", {"dir": "vector", "forward": f, "right": r, "ms": 150})
        time.sleep(0.12)
        continue

    if now - last_attack > 0.45:
        resp, e2 = cmd("attack_light")
        last_attack = now
        ack = resp.get("ack", {})
        log("attack", ok=ack.get("ok"), tag=ack.get("msg", "")[:60], target_hp=target["hp"], player_hp=attrs["Health"])
        if now - last_cry > 3 and random.random() < 0.45:
            say(random.choice(CRY_ATTACK))
            last_cry = now
    time.sleep(0.1)

st, _ = tool("get_state")
log("end", kills=kills, player_hp=(st.get("player") or {}).get("attrs", {}).get("Health"),
    elapsed=round(time.time() - T0, 1))
with open(r"C:\Users\v\pbz-mod\ipc\combat_log.json", "w", encoding="utf-8") as f:
    json.dump(LOG, f, ensure_ascii=False, indent=1)
print(f"DONE kills={len(kills)}", flush=True)