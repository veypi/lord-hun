"""Full capability verification for pbz-ai-bridge (perception + actions).
Runs as an MCP client over HTTP. Structured signals only, no screenshots.
Run in a SAFE area (no monsters) for clean results.
"""
import json
import math
import time
import urllib.request

URL = "http://127.0.0.1:8765/mcp"
RESULTS = []


def rpc(method, params, rid=1):
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def tool(name, args=None):
    r = rpc("tools/call", {"name": name, "arguments": args or {}})
    res = r.get("result", {})
    is_err = res.get("isError", False)
    txt = res.get("content", [{}])[0].get("text", "{}")
    try:
        data = json.loads(txt)
    except Exception:
        data = {"raw": txt}
    return data, is_err


def state():
    d, err = tool("get_state")
    return d


def cmd(action, params=None):
    return tool("command", {"action": action, "params": params or {}})


def record(name, ok, detail):
    RESULTS.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + " | " + str(detail)[:160])


def sample_for(seconds, pick):
    """Sample state every 100ms, collect pick(state) values."""
    out = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        try:
            out.append(pick(state()))
        except Exception:
            pass
        time.sleep(0.1)
    return out


def dist(a, b):
    return math.sqrt(sum((a[k] - b[k]) ** 2 for k in "xyz"))


# ---------- perception ----------
d = state()
record("state_fresh", d.get("staleness_ms", 9999) < 500, f"staleness={d.get('staleness_ms')}ms tick={d.get('tick')}")
p = d.get("player") or {}
a = p.get("attrs", {})
record("attrs_complete", a.get("Health", 0) > 0 and a.get("Health_Max", 0) > 0 and a.get("Attack", 0) > 0 and a.get("Level", 0) >= 1,
       f"HP={a.get('Health')}/{a.get('Health_Max')} Shachi={a.get('Shachi')}/{a.get('Shachi_Max')} Atk={a.get('Attack')} Lv={a.get('Level')} Ult={a.get('UltimateCharge')}")
record("control_yaw", p.get("controlYaw") is not None, f"yaw={p.get('yaw')} controlYaw={p.get('controlYaw')}")
enemies = d.get("enemies", [])
record("enemy_fields", all(e.get("class") and e.get("pos") and e.get("dist") is not None for e in enemies) if enemies else True,
       f"{len(enemies)} enemies; classes={[e.get('class') for e in enemies][:4]}")
record("no_mod_errors", not d.get("errors"), f"errors={d.get('errors', [])[-2:]}")

# ---------- movement ----------
for direction in ["forward", "back", "left", "right"]:
    before = state()["player"]["pos"]
    yaw = math.radians(state()["player"].get("controlYaw") or 0)
    cmd("move", {"dir": direction, "ms": 500})
    time.sleep(0.7)
    after = state()["player"]["pos"]
    delta = {k: after[k] - before[k] for k in "xyz"}
    mag = math.sqrt(delta["x"] ** 2 + delta["y"] ** 2)
    fwd = (math.cos(yaw), math.sin(yaw))
    right = (-math.sin(yaw), math.cos(yaw))
    dot_f = (delta["x"] * fwd[0] + delta["y"] * fwd[1]) / (mag or 1)
    dot_r = (delta["x"] * right[0] + delta["y"] * right[1]) / (mag or 1)
    expect = {"forward": dot_f > 0.7, "back": dot_f < -0.7, "left": dot_r < -0.7, "right": dot_r > 0.7}[direction]
    record("move_" + direction, mag > 80 and expect, f"moved={mag:.0f}cm dot_f={dot_f:.2f} dot_r={dot_r:.2f}")

# vector move toward an arbitrary world direction (diagonal)
before = state()["player"]["pos"]
cmd("move", {"dir": "vector", "forward": 1, "right": 1, "ms": 400})
time.sleep(0.6)
after = state()["player"]["pos"]
record("move_vector", dist(before, after) > 60, f"moved={dist(before, after):.0f}cm")

# stop
cmd("move", {"dir": "forward", "ms": 3000})
time.sleep(0.3)
cmd("stop")
s1 = state()["player"]["pos"]
time.sleep(0.5)
s2 = state()["player"]["pos"]
record("stop", dist(s1, s2) < 40, f"drift_after_stop={dist(s1, s2):.0f}cm")

# ---------- attacks ----------
data, err = cmd("attack_light")
montages = sample_for(1.0, lambda s: (s.get("player") or {}).get("montage"))
record("attack_light", not err and any(m and "Attack" in m for m in montages),
       f"ack={data.get('ack', data.get('error'))} montages={sorted(set(m for m in montages if m))}")
time.sleep(0.8)

shachi_before = state()["player"]["attrs"]["Shachi"]
data, err = cmd("attack_heavy")
montages = sample_for(1.2, lambda s: (s.get("player") or {}).get("montage"))
shachi_after = state()["player"]["attrs"]["Shachi"]
record("attack_heavy", not err and (any(m and "Attack" in m for m in montages) or shachi_after < shachi_before),
       f"ack={data.get('ack', data.get('error'))} montages={sorted(set(m for m in montages if m))} shachi {shachi_before}->{shachi_after}")
time.sleep(1.0)

# ---------- dodge ----------
before = state()["player"]["pos"]
data, err = cmd("dodge")
positions = sample_for(0.7, lambda s: (s.get("player") or {}).get("pos"))
burst = max((dist(before, q) for q in positions if q), default=0)
record("dodge", not err and burst > 120, f"ack={data.get('ack', data.get('error'))} burst={burst:.0f}cm")
time.sleep(0.8)

# ---------- jump ----------
z_before = state()["player"]["pos"]["z"]
data, err = cmd("jump")
zs = sample_for(0.9, lambda s: (s.get("player") or {}).get("pos", {}).get("z", z_before))
record("jump", not err and max(zs) - z_before > 40, f"ack={data.get('ack', data.get('error'))} z_gain={max(zs) - z_before:.0f}cm")
time.sleep(1.0)

# ---------- shachi ability / change weapon ----------
shachi_before = state()["player"]["attrs"]["Shachi"]
data, err = cmd("shachi_ability")
montages = sample_for(1.0, lambda s: (s.get("player") or {}).get("montage"))
shachi_after = state()["player"]["attrs"]["Shachi"]
record("shachi_ability", not err, f"ack={data.get('ack', data.get('error'))} montages={sorted(set(m for m in montages if m))} shachi {shachi_before}->{shachi_after}")
time.sleep(1.0)

data, err = cmd("change_weapon")
montages = sample_for(1.0, lambda s: (s.get("player") or {}).get("montage"))
record("change_weapon", not err, f"ack={data.get('ack', data.get('error'))} montages={sorted(set(m for m in montages if m))}")
time.sleep(0.8)

# ---------- combo tool ----------
data, err = tool("combo", {"steps": [
    {"action": "attack_light"}, {"action": "wait", "params": {"ms": 450}}, {"action": "attack_light"},
]})
results = data.get("results", [])
record("combo_tool", not err and len(results) == 3 and all(r.get("ok") for r in results), f"steps={results}")
time.sleep(1.0)

# ---------- wait / error path ----------
data, err = tool("wait", {"ms": 200})
record("wait_tool", not err and "player" in data, f"keys={list(data.keys())[:5]}")
data, err = cmd("no_such_action")
record("error_path", err or "error" in data or not data.get("ack", {}).get("ok", True), f"resp={str(data)[:100]}")

# ---------- summary ----------
passed = sum(1 for r in RESULTS if r["ok"])
print(f"\n=== {passed}/{len(RESULTS)} PASSED ===")
with open(r"C:\Users\v\pbz-mod\ipc\verify_report.json", "w", encoding="utf-8") as f:
    json.dump({"time": time.time(), "passed": passed, "total": len(RESULTS), "results": RESULTS}, f, ensure_ascii=False, indent=1)
print("report: C:/Users/v/pbz-mod/ipc/verify_report.json")