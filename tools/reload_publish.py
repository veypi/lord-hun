"""Publish a PBZModLoader hot-reload revision via files (no hotkey, no input).
The loader's JS watch polls generated-reloads/<rev>/config every second; the
DLL's Alt+F5 normally produces that directory. We produce it directly:
copy mods snapshot first, write config.js LAST (atomic publication contract).
"""
import json
import re
import shutil
import sys
import time
from pathlib import Path

GAME = Path(r"C:\Program Files (x86)\Steam\steamapps\common\PBZ")
LOADER = GAME / "ProjectPBZ" / "Content" / "JavaScript" / "PBZModLoader"
MODS = GAME / "ProjectPBZ" / "PBZModLoader" / "mods"
RELOADS = LOADER / "generated-reloads"

rev = max((int(p.name) for p in RELOADS.iterdir() if p.name.isdigit()), default=0) + 1
target = RELOADS / str(rev)
if target.exists():
    sys.exit(f"revision dir {target} already exists")

# mods.ini [Mods] switches (id=0 disables)
disabled = set()
ini = GAME / "ProjectPBZ" / "PBZModLoader" / "mods.ini"
if ini.exists():
    for line in ini.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\s*([\w-]+)\s*=\s*0\s*$", line)
        if m:
            disabled.add(m.group(1))

entries = []
gen_mods = target / "generated-mods"
gen_mods.mkdir(parents=True)
for mod_dir in sorted(MODS.iterdir()):
    if not mod_dir.is_dir():
        continue
    entry = "main.ts" if (mod_dir / "main.ts").exists() else "main.js"
    if not (mod_dir / entry).exists():
        continue
    shutil.copytree(mod_dir, gen_mods / mod_dir.name)
    entries.append({"id": mod_dir.name, "enabled": mod_dir.name not in disabled, "entry": f"mods/{mod_dir.name}/{entry}"})

config = {"version": 1, "mods": entries}
# publication is atomic: config appears only after the full snapshot is in place
tmp = target / "config.js.tmp"
tmp.write_text("'use strict';\nmodule.exports = " + json.dumps(config, separators=(",", ":")) + ";\n", encoding="utf-8")
tmp.rename(target / "config.js")
print(f"published revision {rev} with {len(entries)} mods")

# wait for the loader to pick it up
log_dir = GAME / "ProjectPBZ" / "PBZModLoader" / "evidence"
latest = max(log_dir.iterdir(), key=lambda p: p.stat().st_mtime)
log = latest / "loader.log"
deadline = time.time() + 15
while time.time() < deadline:
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
        if f"reload complete revision={rev}" in text:
            print(f"reload complete revision={rev} confirmed in loader.log")
            break
        if f"reload failed" in text.split(f"revision={rev}")[-1] and f"revision={rev}" in text:
            pass
    except OSError:
        pass
    time.sleep(1)
else:
    print("WARNING: no reload confirmation within 15s; check loader.log")