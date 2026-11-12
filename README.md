# Lord Hun（魂大人）

让外部 AI 通过 MCP 亲自操作《影之刃零》(Phantom Blade Zero) 主角的 mod。
AI 以结构化状态感知战场（不靠截图），以游戏进程内函数调用执行动作（不靠模拟按键），
已验证闭环：外部 AI 自主完成「感知前摇 → 闪避 → 连击 → 击杀」全流程。

## 架构

两个 mod 运行在**同一个游戏进程**内，文件 IPC 解耦：

```
外部 AI（MCP 客户端，如 client/combat.py）
   │  streamable-http MCP
   ▼
PBZ.exe ──────────────────────────────────────────────
 ├─ pbz-mcp        UE4SS C++ mod：进程内 HTTP :8765/mcp
 │                 感知/动作工具 + 窗口截图（GDI）
 │      ↕ 文件 IPC：ipc/state.json（100ms） / ipc/command.json（50ms 轮询）
 └─ pbz-ai-bridge  PBZModLoader JS mod（Puerts）：
                   结构化感知（玩家/敌人/属性/蒙太奇/tag）+ 动作执行 + 头顶飘字
```

设计要点：

- **单进程**：MCP 服务由 mod 在游戏进程内启动，无外部代理进程。
- **零模拟输入**：移动/攻击/闪避全部走游戏自身的输入组件与技能系统函数。
- **结构化感知**：位置、血量、煞气、技能 tag、蒙太奇前摇全部是数据，截图仅调试用。
- **staleness 保护**：state 超过 1.5s 未更新时拒绝执行动作。

## 目录

```
native/   pbz-mcp：UE4SS C++ mod 源码 + vendor 头文件 + mingw 交叉编译脚本
bridge/   pbz-ai-bridge：PBZModLoader JS mod（感知 + 执行 + 飘字）
client/   外部 MCP 客户端示例：combat.py（自主战斗）、verify.py（感知校验）
tools/    reload_publish.py：JS mod 文件式热重载
docs/     deploy.md：安装部署步骤
DESIGN.md 设计文档与实测 API 笔记
```

## 快速开始

1. 按 [docs/deploy.md](docs/deploy.md) 安装两个 mod 并启动游戏。
2. MCP 端点：`http://<游戏机IP>:8765/mcp`，任意 MCP 客户端可接入。
3. 跑示例战斗客户端：`python client/combat.py`（进战自动开打、喊话，脱战自动停）。

## MCP 工具

| 分类 | 工具 |
| --- | --- |
| 感知 | `get_state` `screenshot` `wait` `probe` |
| 基础动作 | `move` `stop` `ability` `dodge` `combo` `command`（低层通用） |
| 战斗动作 | `attack_light` `attack_heavy` `execution` `shachi_ability` `jump` `change_weapon` `deflect` |
| 演出/系统 | `send_msg`（头顶飘字喊话） `pause` `resume` `menu_close` |

`send_msg` 支持中文，多条并发扇形发散、沿飞行方向微倾斜、到期淡出，默认显示 2s。

## 开发

- 构建 DLL（macOS/Linux 交叉编译）：`bash native/build.sh`（需 mingw-w64）。
- JS 热重载：改 `bridge/main.js` → 复制到游戏 mods 目录 → `python tools/reload_publish.py`
  （文件式发布热重载，无需焦点、无需按键注入）。
- 实测环境：UE 5.7.4（Steam build 26266538）+ PBZModLoader 1.0.2 + UE4SS。

## 声明

单机游戏本地自用 mod，仅供学习交流；请支持正版游戏。游戏更新可能破坏 mod，建议关闭自动更新。