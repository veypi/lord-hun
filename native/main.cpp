// pbz-mcp — in-game MCP server for Phantom Blade Zero.
// Loaded as a UE4SS C++ mod (dlls/main.dll). Hosts streamable-http MCP on :8765
// inside the game process; perception/actions are bridged through the JSON
// files written by the pbz-ai-bridge JS mod (PBZModLoader).
// Build (mingw cross): x86_64-w64-mingw32-g++ -shared -O2 -static -o main.dll
//   main.cpp -lws2_32 -lgdi32 -luser32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <fstream>
#include <sstream>
#include <chrono>
#include <cstring>
#include <algorithm>
#include <filesystem>
#include "httplib.h"
#include "json.hpp"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

using json = nlohmann::json;
namespace fs = std::filesystem;

static HMODULE g_self = nullptr;
static std::string g_ipc = "C:/Users/v/pbz-mod/ipc";
static std::string g_title = "Phantom Blade Zero";
static int g_port = 8765;
static int g_max_stale_ms = 1500;
static httplib::Server g_srv;
static std::thread g_thread;
static std::atomic<bool> g_running{false};

static long long now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

static void load_config() {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(g_self, buf, MAX_PATH);
    fs::path cfg = fs::path(buf).parent_path() / "pbz-mcp.json";
    std::ifstream f(cfg);
    if (!f) return;
    try {
        json j = json::parse(f);
        if (j.contains("ipc_dir")) g_ipc = j["ipc_dir"].get<std::string>();
        if (j.contains("port")) g_port = j["port"].get<int>();
        if (j.contains("window_title")) g_title = j["window_title"].get<std::string>();
        if (j.contains("max_stale_ms")) g_max_stale_ms = j["max_stale_ms"].get<int>();
    } catch (...) {}
}

// ---------- file IPC ----------
static bool read_state(json& out) {
    fs::path p = fs::path(g_ipc) / "state.json";
    for (int i = 0; i < 3; i++) {
        std::ifstream f(p, std::ios::binary);
        if (!f) return false;
        std::stringstream ss; ss << f.rdbuf();
        std::string s = ss.str();
        if (s.size() >= 2 && (unsigned char)s[0] == 0xFF && (unsigned char)s[1] == 0xFE) {
            // UTF-16 LE (EasyCsv fallback for non-ASCII content)
            std::wstring w(reinterpret_cast<const wchar_t*>(s.data()), s.size() / 2);
            const wchar_t* wp = w.c_str();
            if (*wp == 0xFEFF) wp++;
            int need = WideCharToMultiByte(CP_UTF8, 0, wp, -1, nullptr, 0, nullptr, nullptr);
            if (need > 0) {
                std::string u8(need, '\0');
                WideCharToMultiByte(CP_UTF8, 0, wp, -1, u8.data(), need, nullptr, nullptr);
                while (!u8.empty() && u8.back() == '\0') u8.pop_back();
                s = u8;
            }
        } else if (s.size() >= 3 && (unsigned char)s[0] == 0xEF) {
            s.erase(0, 3); // UTF-8 BOM
        }
        try { out = json::parse(s); return true; }
        catch (...) { Sleep(30); } // torn write from game side
    }
    return false;
}

static json require_fresh() {
    json st;
    if (!read_state(st)) throw std::runtime_error("no state.json - game not started or JS mod not loaded");
    long long age = now_ms() - st.value("wall", 0LL);
    if (age > g_max_stale_ms) throw std::runtime_error("state stale (" + std::to_string(age) + "ms) - game paused/loading or mod stopped");
    return st;
}

static json send_command(const std::string& action, const json& params, double timeout_s = 3.0) {
    require_fresh();
    long long seq = now_ms();
    json cmd = {{"seq", seq}, {"action", action}, {"params", params}};
    fs::path dir = g_ipc;
    fs::path tmp = dir / "command.json.tmp";
    fs::path dst = dir / "command.json";
    { std::ofstream f(tmp, std::ios::binary | std::ios::trunc); f << cmd.dump(); }
    fs::rename(tmp, dst); // atomic replace on Windows
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds((int)(timeout_s * 1000));
    while (std::chrono::steady_clock::now() < deadline) {
        json st;
        if (read_state(st) && st.contains("ack") && st["ack"].value("seq", 0LL) == seq) {
            if (!st["ack"].value("ok", false))
                throw std::runtime_error("mod rejected: " + st["ack"].value("msg", std::string("?")));
            return st;
        }
        Sleep(50);
    }
    throw std::runtime_error("no ack for " + action + " within timeout");
}

// ---------- screenshot (GDI) ----------
struct FindCtx { std::wstring needle; HWND best = nullptr; long long area = 0; };
static BOOL CALLBACK enum_win(HWND hwnd, LPARAM lp) {
    FindCtx& ctx = *(FindCtx*)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    wchar_t title[512]; GetWindowTextW(hwnd, title, 512);
    std::wstring t(title);
    std::transform(t.begin(), t.end(), t.begin(), ::towlower);
    if (t.find(ctx.needle) == std::wstring::npos) return TRUE;
    RECT rc; GetWindowRect(hwnd, &rc);
    long long a = (long long)(rc.right - rc.left) * (rc.bottom - rc.top);
    if (a > ctx.area) { ctx.area = a; ctx.best = hwnd; }
    return TRUE;
}

static void png_write_cb(void* ctx, void* data, int len) {
    auto* v = (std::vector<unsigned char>*)ctx;
    v->insert(v->end(), (unsigned char*)data, (unsigned char*)data + len);
}

static std::string base64(const std::vector<unsigned char>& in) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((in.size() + 2) / 3) * 4);
    for (size_t i = 0; i < in.size(); i += 3) {
        unsigned v = in[i] << 16 | (i + 1 < in.size() ? in[i + 1] << 8 : 0) | (i + 2 < in.size() ? in[i + 2] : 0);
        out.push_back(tbl[(v >> 18) & 63]);
        out.push_back(tbl[(v >> 12) & 63]);
        out.push_back(i + 1 < in.size() ? tbl[(v >> 6) & 63] : '=');
        out.push_back(i + 2 < in.size() ? tbl[v & 63] : '=');
    }
    return out;
}

static std::string capture_png_b64() {
    FindCtx ctx;
    std::wstring needle(g_title.begin(), g_title.end());
    std::transform(needle.begin(), needle.end(), needle.begin(), ::towlower);
    ctx.needle = needle;
    EnumWindows(enum_win, (LPARAM)&ctx);
    int x = 0, y = 0, w = 0, h = 0;
    HDC src = nullptr;
    HWND hwnd = ctx.best;
    if (hwnd) {
        RECT rc; GetWindowRect(hwnd, &rc);
        x = rc.left; y = rc.top; w = rc.right - rc.left; h = rc.bottom - rc.top;
        src = GetWindowDC(hwnd);
    } else {
        w = GetSystemMetrics(SM_CXSCREEN); h = GetSystemMetrics(SM_CYSCREEN);
        src = GetDC(nullptr);
    }
    if (!src || w <= 0 || h <= 0) throw std::runtime_error("no capture surface");
    HDC mem = CreateCompatibleDC(src);
    HBITMAP bmp = CreateCompatibleBitmap(src, w, h);
    HGDIOBJ old = SelectObject(mem, bmp);
    BOOL ok = hwnd ? PrintWindow(hwnd, mem, 2 /*PW_RENDERFULLCONTENT*/)
                   : BitBlt(mem, 0, 0, w, h, src, x, y, SRCCOPY);
    std::vector<unsigned char> png;
    if (ok) {
        BITMAPINFO bmi{};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;
        std::vector<unsigned char> px((size_t)w * h * 4);
        if (GetDIBits(mem, bmp, 0, h, px.data(), &bmi, DIB_RGB_COLORS)) {
            std::vector<unsigned char> rgb((size_t)w * h * 3);
            for (size_t i = 0, j = 0; i < px.size(); i += 4, j += 3) {
                rgb[j] = px[i + 2]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i];
            }
            stbi_write_png_to_func(png_write_cb, &png, w, h, 3, rgb.data(), w * 3);
        }
    }
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(hwnd, src);
    if (png.empty()) throw std::runtime_error("capture failed");
    return base64(png);
}

// ---------- MCP tools ----------
static json tool_defs() {
    auto s_obj = [](json props, std::vector<std::string> req = {}) {
        return json{{"type", "object"}, {"properties", props}, {"required", req}};
    };
    json tools = json::array();
    tools.push_back({{"name", "get_state"}, {"description", "Latest game state: player pos/yaw/attributes, nearby enemies (class,pos,dist,hp), mod errors, last ack, staleness_ms. Abilities/probe data included only with include_abilities=true."},
        {"inputSchema", s_obj({{"include_abilities", {{"type", "boolean"}}}})}});
    tools.push_back({{"name", "screenshot"}, {"description", "Capture the game window as PNG (falls back to full screen)."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "move"}, {"description", "Move relative to camera: forward/back/left/right, hold ms (0-5000)."},
        {"inputSchema", s_obj({{"direction", {{"type", "string"}, {"enum", {"forward", "back", "left", "right"}}}}, {"ms", {{"type", "integer"}}}})}});
    tools.push_back({{"name", "ability"}, {"description", "Activate a game ability via the input component. tag: GameplayTag; asset: input action path (discover via probe). Acceptance != execution; verify via state."},
        {"inputSchema", s_obj({{"tag", {{"type", "string"}}}, {"asset", {{"type", "string"}}}, {"priority", {{"type", "integer"}}}}, {"tag", "asset"})}});
    tools.push_back({{"name", "dodge"}, {"description", "Dodge via the known IA_Dodge asset."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "stop"}, {"description", "Stop ongoing movement."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "probe"}, {"description", "Force-refresh mod probe data (candidate input assets, attribute names)."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "wait"}, {"description", "Wait ms (0-10000) then return latest state."}, {"inputSchema", s_obj({{"ms", {{"type", "integer"}}}})}});
    tools.push_back({{"name", "combo"}, {"description", "Sequence of steps: {action: move|ability|dodge|stop|wait, params:{...}, delay_ms}. Stops at first rejection."},
        {"inputSchema", s_obj({{"steps", {{"type", "array"}, {"items", {{"type", "object"}}}}}}, {"steps"})}});
    tools.push_back({{"name", "command"}, {"description", "Low-level raw action to the mod (move/stop/probe/dodge/ability/check_tags/owned_tags/send_msg/pause_game/resume_game/menu_close/deflect)."},
        {"inputSchema", s_obj({{"action", {{"type", "string"}}}, {"params", {{"type", "object"}}}}, {"action"})}});
    // high-level combat actions (pure in-game ability activation via AIM routing)
    for (const auto& n : {"attack_light", "attack_heavy", "execution", "shachi_ability", "jump", "change_weapon", "deflect"}) {
        tools.push_back({{"name", n}, {"description", std::string("Combat action: ") + n + ". Routes through the game's AIM binding rules; returns the activated ability tag in ack."}, {"inputSchema", s_obj({})}});
    }
    tools.push_back({{"name", "send_msg"}, {"description", "Float a message above the protagonist's head; bursts outward and vanishes (default 2s). Multiple messages fan out, so rapid sends (skill names, taunts) coexist."},
        {"inputSchema", s_obj({{"text", {{"type", "string"}}}, {"ms", {{"type", "integer"}, {"description", "display duration 300-30000, default 2000"}}}}, {"text"})}});
    tools.push_back({{"name", "pause"}, {"description", "Pause the game world (AI thinking time). The JS bridge keeps running; get_state reports paused=true. Resume with resume."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "resume"}, {"description", "Resume the game world after pause."}, {"inputSchema", s_obj({})}});
    tools.push_back({{"name", "menu_close"}, {"description", "Close the active menu widget (system menu/settings) through its own deactivation. Refuses if the active widget is not a menu."}, {"inputSchema", s_obj({})}});
    return tools;
}

static json text_result(const json& j) {
    return {{"content", json::array({{{"type", "text"}, {"text", j.dump()}}})}};
}

static json call_tool(const std::string& name, const json& args) {
    if (name == "get_state") {
        json st;
        if (!read_state(st)) return text_result({{"error", "no state.json yet - start the game with the mod installed"}});
        st["staleness_ms"] = now_ms() - st.value("wall", 0LL);
        if (!args.value("include_abilities", false)) st.erase("abilities");
        return text_result(st);
    }
    if (name == "screenshot") {
        std::string b64 = capture_png_b64();
        return {{"content", json::array({{{"type", "image"}, {"data", b64}, {"mimeType", "image/png"}}})}};
    }
    if (name == "move") return text_result(send_command("move", {{"dir", args.value("direction", "forward")}, {"ms", args.value("ms", 300)}}));
    if (name == "ability") return text_result(send_command("ability", {{"tag", args.at("tag")}, {"asset", args.at("asset")}, {"priority", args.value("priority", -5)}}));
    if (name == "dodge") return text_result(send_command("dodge", json::object()));
    if (name == "stop") return text_result(send_command("stop", json::object()));
    if (name == "probe") {
        send_command("probe", json::object());
        Sleep(300);
        json st; read_state(st);
        return text_result({{"probe", st.value("probe", json::object())}, {"errors", st.value("errors", json::array())}});
    }
    if (name == "wait") {
        Sleep(std::max(0, std::min(10000, args.value("ms", 500))));
        json st; read_state(st);
        st["staleness_ms"] = now_ms() - st.value("wall", 0LL);
        st.erase("abilities");
        return text_result(st);
    }
    if (name == "combo") {
        json results = json::array();
        auto steps = args.value("steps", json::array());
        int i = 0;
        for (auto& step : steps) {
            if (i >= 20) break;
            std::string action = step.value("action", "");
            json params = step.value("params", json::object());
            if (action == "wait") {
                Sleep(std::max(0, std::min(5000, params.value("ms", 200))));
                results.push_back({{"step", i}, {"action", "wait"}, {"ok", true}});
            } else {
                json st = send_command(action, params);
                results.push_back({{"step", i}, {"action", action}, {"ok", true}, {"ack", st.value("ack", json::object())}});
            }
            int delay = step.value("delay_ms", 0);
            if (delay > 0) Sleep(std::min(5000, delay));
            i++;
        }
        json st; read_state(st);
        st.erase("abilities");
        return text_result({{"results", results}, {"state", st}});
    }
    if (name == "command") return text_result(send_command(args.at("action"), args.value("params", json::object())));
    if (name == "attack_light" || name == "attack_heavy" || name == "execution" || name == "shachi_ability" ||
        name == "jump" || name == "change_weapon" || name == "deflect")
        return text_result(send_command(name, json::object()));
    if (name == "send_msg") return text_result(send_command("send_msg", {{"text", args.at("text")}, {"ms", args.value("ms", 1500)}}));
    if (name == "pause") return text_result(send_command("pause_game", json::object()));
    if (name == "resume") return text_result(send_command("resume_game", json::object()));
    if (name == "menu_close") return text_result(send_command("menu_close", json::object()));
    throw std::runtime_error("unknown tool: " + name);
}

// ---------- JSON-RPC over streamable-http ----------
static json rpc_result(const json& id, const json& result) {
    return {{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
}
static json rpc_error(const json& id, int code, const std::string& msg) {
    return {{"jsonrpc", "2.0"}, {"id", id}, {"error", {{"code", code}, {"message", msg}}}};
}

static json handle_request(const json& req) {
    std::string method = req.value("method", "");
    json id = req.value("id", json());
    json params = req.value("params", json::object());
    if (method == "initialize") {
        return rpc_result(id, {
            {"protocolVersion", params.value("protocolVersion", "2025-03-26")},
            {"capabilities", {{"tools", json::object()}}},
            {"serverInfo", {{"name", "pbz-ai-bridge-native"}, {"version", "1.0.0"}}}});
    }
    if (method == "ping") return rpc_result(id, json::object());
    if (method == "tools/list") return rpc_result(id, {{"tools", tool_defs()}});
    if (method == "resources/list") return rpc_result(id, {{"resources", json::array()}});
    if (method == "prompts/list") return rpc_result(id, {{"prompts", json::array()}});
    if (method == "tools/call") {
        std::string name = params.value("name", "");
        json args = params.value("arguments", json::object());
        try {
            return rpc_result(id, call_tool(name, args));
        } catch (std::exception& e) {
            json r = text_result({{"error", e.what()}});
            r["isError"] = true;
            return rpc_result(id, r);
        }
    }
    return rpc_error(id, -32601, "method not found: " + method);
}

static void handle_mcp_post(const httplib::Request& req, httplib::Response& res) {
    json body;
    try { body = json::parse(req.body); }
    catch (...) {
        res.status = 400;
        res.set_content(rpc_error(nullptr, -32700, "parse error").dump(), "application/json");
        return;
    }
    // notifications carry no id -> 202 no body
    auto is_notification = [](const json& j) { return !j.contains("id"); };
    if (body.is_array()) {
        json out = json::array();
        for (auto& r : body) if (!is_notification(r)) out.push_back(handle_request(r));
        if (out.empty()) { res.status = 202; return; }
        res.set_content(out.dump(), "application/json");
        return;
    }
    if (is_notification(body)) { res.status = 202; return; }
    json resp = handle_request(body);
    if (body.value("method", "") == "initialize")
        res.set_header("Mcp-Session-Id", "pbz-" + std::to_string(now_ms()));
    res.set_content(resp.dump(), "application/json");
}

static void server_thread() {
    g_srv.Post("/mcp", handle_mcp_post);
    g_srv.Get("/mcp", [](const httplib::Request&, httplib::Response& res) { res.status = 405; });
    g_srv.Delete("/mcp", [](const httplib::Request&, httplib::Response& res) { res.status = 200; });
    g_srv.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        json st; bool has = read_state(st);
        res.set_content(json{{"ok", true}, {"state", has}}.dump(), "application/json");
    });
    g_srv.listen("0.0.0.0", g_port);
}

// ---------- UE4SS mod exports ----------
// UE4SS contract: start_mod() returns a CppUserModBase* whose virtuals it calls
// (all void); uninstall_mod(ptr) stops it. The real base class is MSVC-CRT
// coupled, so we hand back a zero-filled object with an all-noop vtable:
// zeroed std::vector/std::wstring members are valid empty MSVC objects, and
// UE4SS's event registry has no callbacks registered for this pointer.
static void noop(void*) {}
static void* g_vtable[32];
struct FakeMod { void* vtbl; unsigned char pad[512]; };
static FakeMod g_mod{};

extern "C" __declspec(dllexport) void* start_mod() {
    for (auto& p : g_vtable) p = (void*)noop;
    g_mod.vtbl = g_vtable;
    if (g_running.exchange(true)) return &g_mod;
    load_config();
    g_thread = std::thread(server_thread);
    g_thread.detach();
    return &g_mod;
}

extern "C" __declspec(dllexport) void uninstall_mod(void*) {
    if (!g_running.exchange(false)) return;
    g_srv.stop();
}

extern "C" __declspec(dllexport) void stop_mod() {
    uninstall_mod(nullptr);
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { g_self = h; DisableThreadLibraryCalls(h); }
    return TRUE;
}