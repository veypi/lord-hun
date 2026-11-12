# 安装部署（Windows）

实测环境：Steam 版《影之刃零》（UE 5.7.4，build 26266538），游戏目录记为 `<GAME>`
（默认 `C:\Program Files (x86)\Steam\steamapps\common\PBZ`）。

## 前置

- **PBZModLoader**（JS mod 加载器，version.dll 入口）已安装。
- **UE4SS**（dwmapi.dll 入口）已安装，位于 `<GAME>\platform\steam\ue4ss\`。
- 一个可写的 IPC 目录，例如 `C:\Users\<你>\pbz-mod\ipc`（两个 mod 必须指向同一目录）。

## 1. pbz-mcp（C++ DLL）

1. 构建：`bash native/build.sh`（macOS 需 `brew install mingw-w64`），或在 Windows 用
   MSVC/mingw 编译 `native/main.cpp`（C++17，链接 ws2_32/gdi32/user32，vendor 目录加入 include 路径）。
2. 部署：
   ```
   <GAME>\platform\steam\ue4ss\Mods\pbz-mcp\dlls\main.dll
   <GAME>\platform\steam\ue4ss\Mods\pbz-mcp\pbz-mcp.json
   ```
   `pbz-mcp.json` 参照 `native/pbz-mcp.example.json`，把 `ipc_dir` 改成你的 IPC 目录。
3. 在 UE4SS 的 mods 启用配置里启用 `pbz-mcp`。

> DLL 在游戏运行时被锁定，替换必须先退出游戏。

## 2. pbz-ai-bridge（JS mod）

1. 编辑 `bridge/main.js` 顶部 `IPC_DIR`，与上面 `ipc_dir` 保持一致。
2. 复制到：
   ```
   <GAME>\ProjectPBZ\PBZModLoader\mods\pbz-ai-bridge\main.js
   ```
   PBZModLoader 自动发现，无需注册。

## 3. 启动与验证

1. 启动游戏，进入可操作场景。
2. 验证 MCP：
   ```
   curl -X POST http://127.0.0.1:8765/mcp -H "Content-Type: application/json" ^
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_state\",\"arguments\":{}}}"
   ```
   返回结构化 state 即成功。局域网内其他机器用 `http://<游戏机IP>:8765/mcp`。
3. 跑示例客户端：`python client/combat.py`（纯标准库，Python 3.10+；URL 在文件顶部）。

## 4. 开发热重载（JS）

改完 `bridge/main.js` 后：复制到游戏 mods 目录 → `python tools/reload_publish.py`。
脚本向 `Content\JavaScript\PBZModLoader\generated-reloads\<rev>\` 发布快照
（先拷 mods，最后写 config.js，原子发布契约），加载器每秒轮询并热重载，
`loader.log` 出现 `reload complete revision=<rev>` 即生效。
注意：加载器不认 SendInput 按键注入，Alt+F5 只在真实键盘焦点下有效，脚本走文件通道。

## 常见问题

- **state 读不到 / 动作被拒**：检查两个 mod 的 IPC 目录是否一致；state 超过
  `max_stale_ms`（默认 1.5s）未更新时动作工具会拒绝执行。
- **中文乱码**：EasyCsv 遇非 ASCII 会写 UTF-16；mod 端 JSON 已全部 `\uXXXX` 转义，
  DLL 侧读取兼容 UTF-8/UTF-16。自己写 IPC 文件时保持纯 ASCII。
- **飘字不显示**：需要当前有活跃 UI widget 作为宿主（正常 gameplay HUD 即可）。
- **游戏更新后失效**：关闭 Steam 自动更新；loader/反射接口可能随版本变化。