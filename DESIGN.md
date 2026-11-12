# Lord Hun 设计文档

更新：2026-11-13（v0.1.0，单进程实现版）

## 目标与红线

外部 AI 经 MCP 操作《影之刃零》主角打怪。Phase 1（已达成）= 自主击杀一只怪物。

- **单进程**：MCP 服务必须在游戏进程内、由 mod 启动，无外部代理进程。
- **禁系统模拟输入**：游戏指令全走进程内函数调用（SendInput 对游戏无效，实测返回 0）。
- **状态全结构化**：感知不依赖截图；截图仅调试辅助。

## 环境事实

- 游戏：`C:\Program Files (x86)\Steam\steamapps\common\PBZ`，主程序 `platform\steam\PBZ.exe`（UE 5.7.4，Steam build 26266538）；窗口标题 **"Phantom Blade Zero"**（不是 PBZ）。
- 加载器：PBZModLoader 1.0.2（version.dll 入口）+ UE4SS（dwmapi.dll 入口）。
- JS mod 目录：`<游戏>\ProjectPBZ\PBZModLoader\mods\<id>\main.js`，自动发现；必须导出 `stop()`。
- 日志：`<游戏>\ProjectPBZ\PBZModLoader\evidence\<run>\loader.log`。

## 架构（定稿）

```
外部 AI（MCP 客户端）
   │ streamable-http
PBZ.exe
 ├─ pbz-mcp（UE4SS C++ mod，native/）
 │   进程内 HTTP :8765/mcp；cpp-httplib + nlohmann/json + stb/GDI 截图
 │      ↕ 文件 IPC：ipc/state.json（100ms 写） / ipc/command.json（50ms 轮询）
 └─ pbz-ai-bridge（PBZModLoader JS mod，bridge/）
     感知 + 执行 + 头顶飘字
```

- DLL 配置：dll 同目录 `pbz-mcp.json`（ipc_dir/port/window_title/max_stale_ms）。
- JS 配置：main.js 顶部 `IPC_DIR`，必须与 DLL 一致。
- 早期 Python FastMCP 外置方案已废弃（违反单进程红线）。

## IPC 协议

- `state.json`（mod→DLL，100ms）：
  `{wall, t, tick, paused, inCombat, player:{pos,yaw,attrs,alive}, enemies:[{name,class,pos,dist,hp}], abilities:[...](2s节流), say:[...], ack:{seq,ok,msg}, errors:[]}`
- `command.json`（DLL→mod，50ms 轮询）：`{seq, action, params}`；seq 单调递增，mod 只执行新 seq，结果写 state.ack。重载后首条旧指令只记录 seq 不重放。
- DLL 原子写（tmp+rename）；mod 侧 EasyCsv 非原子 → 解析失败重试。
- **纯 ASCII**：EasyCsv 遇非 ASCII 写 UTF-16 → mod 端 JSON 全 `\uXXXX` 转义；DLL 读取兼容 UTF-8/UTF-16；≤10 字符的文件 LoadStringFromLocalFile 拒读。
- staleness 保护：state.wall 超过 max_stale_ms（1.5s）→ 动作 tool 拒绝。

## MCP tools

- 感知：get_state / screenshot / wait / probe
- 基础：move / stop / ability / dodge / combo / command（低层通用）
- 战斗：attack_light / attack_heavy / execution / shachi_ability / jump / change_weapon / deflect
- 演出/系统：send_msg / pause / resume / menu_close

send_msg：中文飘字，多条并发；随机角度（头顶 ±32° 锥形）/距离（260~440px）扇形发散，
运动贯穿整个显示时长（默认 2s），文字沿飞行方向微倾斜（±14° 封顶），到期前 400ms 淡出。
渲染走游戏 UI（活跃 widget 根 Overlay 挂 TextBlock + GameplayStatics.ProjectWorldToScreen 投影定位），
字体取 Textstyle_Main_CN 的 FSlateFontInfo（Slate 复合字体才能渲染 CJK）。

## 关键游戏 API（实测确认）

### Puerts 基础
- `require("ue")` / `require("puerts")`；`puerts.argv.getByName("GameInstance")`。
- 玩家：`UE.GameplayStatics.GetPlayerCharacter(gi, 0)`。
- 属性：`PBZBlueprintFunctionLibrary.MakeAttribute(name, BasicAttributeSet)` → `GetAttributeFromCharacter(pawn, attr)`。
  真实名：Health/Health_Max/Shachi/Shachi_Max/Attack/Level/UltimateCharge(_Max)/Awakening(_Max)/Shield（FName 大小写不敏感）。
- ASC：`AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn)`；`asc.HasMatchingGameplayTag(tag)`；
  战斗状态 = `CharacterState.OffCombat` tag 缺失即 inCombat。
- 文件：`EasyCsv.SaveStringToFileWithFullPath` / `LoadStringFromLocalFile(path, $ref)`。
- 反射枚举：CDO 原型链 `Object.getOwnPropertyNames` 拿全部属性/函数；TMap 先试 for..of 再 Num/Get；结构体字段在原型链；out 参 `$ref`。
- **不可用**（未反射）：GetActivatableAbilities / GetRootWidget / CreateWidgetFromClass / WidgetLayoutLibrary.ProjectWorldLocationToScreen / pawn.GetComponents。
  替代：`w.WidgetTree.RootWidget`、`GameplayStatics.ProjectWorldToScreen(pc, vec, $ref, false)`。

### 输入与技能
- InputBindings = TMap<IA, {Bindings:[AIM资产]}>；AIM.Bindings[].NormalData.Actions/Combos[] 含 RequiredTags/IgnoredTags/TriggerTag/ActionPriority。
- 激活：`TryActivateExternalActionAbilityByTag`（不打断）；连击续段/闪避取消用 `ForceActivateExternalActionAbilityByTag`；先跳过 ASC 已持有的 trigger tag（正在运行的动作）。返回值 true 仅代表受理，用 ack + 状态变化验证。
- 真实 tag：普攻 Ability.Action.Hun.Light.A.Normal → Light.AA → AAA；闪避 Hun.Dash；完美闪避 Hun.PerfectDodge；处决 Ability.Action.Execution.Channel.Execution。
- 输入资产目录：/PBZInput/InputActions/（IA_AttackL_Press/IA_AttackH_Press/IA_Execution/IA_Jump/IA_ShachiAbility）、/PBZDeflectSystem/Input/（IA_Dodge/IA_Deflect）。
- 蒙太奇：pawn.GetCurrentMontage() → 攻击动画名（Hun_PoJun_Attack_A/AA_Montage），敌人前摇同法。

### 系统
- 暂停/恢复：SetGamePaused（JS bridge 不受暂停影响，继续感知）。
- 关菜单：router.GetActiveWidget() → DeactivateWidget()（带菜单名 guard；BackInput 无效）。
- 热重载：文件发布 generated-reloads/<rev>/（先拷 generated-mods 快照，最后写 config.js）；tools/reload_publish.py。

## UE4SS C++ mod 契约（硬坑）

- 导出 `start_mod()` 返回非空 CppUserModBase*：用零填充对象 + 全 noop 虚表，避开 MSVC CRT 耦合；`uninstall_mod(ptr)` 回收。**stop_mod 不被识别**。
- mingw 交叉编译：`x86_64-w64-mingw32-g++ -shared -O2 -static -std=c++17 -Ivendor -o main.dll main.cpp -lws2_32 -lgdi32 -luser32`。

## 里程碑

- M0 ✅ 环境勘察 + API 确认
- M1 ✅ 感知：state.json 100ms 稳定，属性/敌人/蒙太奇全结构化
- M2 ✅ 动作：纯技能激活（AIM 路由 + Try/Force），轻击连段 A→AA，移动/闪避/重击/处决/煞气技/跳/切武器
- M3 ✅ 外部 AI 闭环击杀（2026-11-13）：combat.py 经 MCP 自主作战，蓝衣枪兵 HP 2439→925→168→死亡，主角存活 1818/3085
- M4 ✅ 演出与系统：send_msg 中文飘字、pause/resume、menu_close、战斗状态驱动（进战自动打/脱战自动停）

## 待补

- 锁定（SwitchLockObject 未探测）、格挡路由（IA_Deflect 经 HandleInputAction 未设 tag）、开菜单路由（IA_PushGameSystemMenu 无效）。
- DLL 高层 tools 已进源码，需随下次游戏重启部署新编译的 dll。

## 风险

- 敌人 Pawn 类型/HP 属性兼容性未知 → state 带 class 名与 errors，运行时迭代。
- 游戏更新可能破坏 loader/mod → 关自动更新，本地自用。