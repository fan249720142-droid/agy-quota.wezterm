# agy-quota.wezterm

面向 WezTerm 的 Google Antigravity (`agy`) 实时配额与上下文状态栏插件：在标签栏右侧展示 **Prompt 缓存命中率 (`Cached`)**、**上下文用量 (`Context`)**、**5 小时配额 (`Five Hours`)** 与 **每周配额 (`Weekly`)**，并与 Antigravity CLI 原生界面及 `settings.json` 完全共存。

---

## 核心特性

- **实时多维指标**：展示 `Cached`（缓存命中率）、`Context`（已用百分比、进度条与 Token 用量）、`Five Hours` / `Weekly`（剩余配额百分比、进度条与动态重置倒计时）。
- **池感知自动切换**：按当前 Pane 使用的模型自动匹配 `Gemini` (`gemini`) 或 `Claude & GPT` (`3p`) 配额池，支持手动覆盖。
- **三档自适应布局**：根据当前 Tab 宽度 (`tab:get_size().cols - cols_offset`) 在 `full` / `compact` / `minimal` 间自动切换，默认 105 列窗口下不截断。
- **零阻塞纯异步架构**：WezTerm 渲染主线程仅节流读取本地缓存 JSON 并在超时时后台派生 `node` 采集器，不阻塞终端渲染。
- **进程感知展示**：仅在当前 Pane 前台进程为 `agy` / `agy-cli` / `antigravity` 时显示 `Cached` 与 `Context`，其余 Shell Pane 默认仅保留全局配额（可配置开启）。

---

## 3-Stop 连续 RGB 渐变配色

指标颜色采用连续三段 RGB 线性插值（定义于 `plugin/render.lua`）：

| 分值区间 | 渐变锚点 | RGB / Hex |
| --- | --- | --- |
| `0%` | 警告红 | `#ff5555` (`255, 85, 85`) |
| `50%` | 过渡黄 | `#ffd427` (`255, 212, 39`) |
| `100%` | 健康绿 | `#5cdb6d` (`92, 219, 109`) |

各指标分值映射规则：

- **`Cached`**（缓存命中率）：将 `[80%, 100%]` 线性映射到 `0 ~ 100`（`clamp((cached_pct - 80) / 20 * 100, 0, 100)`），`100%` 为亮绿、`90%` 为明黄、`<= 80%` 为红色。
- **`Context`**（上下文占用率）：以剩余空间 `100 - used_pct` 作为分值，低占用呈绿色，高占用接近上限时平滑过渡为黄色与红色。
- **`Five Hours` / `Weekly`**（配额剩余率）：直接使用 `remaining_pct`，充沛为绿、半数为黄、耗尽为红。

辅助元素固定语义色：标签 `#a9b0c2`、Token 统计 `#8c92a4`、分隔符 `#4e5568`、重置倒计时 `#57caff`、进度条底槽 `#3b4052`、缺失占位 `#6c7386`、配额池标签 `#e6dcc3`。

---

## 共存架构（Hooks + Official LS RPC + SQLite Fallback）

本插件**永不修改 `~/.gemini/antigravity-cli/settings.json`**（`statusLine` 保持原样），通过外部插件与独立缓存目录实现无冲突协同：

```text
agy CLI Hooks (agy-plugin/hooks.json)
  └─▶ hook-bridge.mjs ──▶ 更新 ~/.cache/wezterm-agy-status/panes/pane_<id>.json & ls_endpoints.json (0600)
                                 │ (异步派生)
                                 ▼
bin/agy-status-collector.mjs (--refresh)
  ├─▶ 1. Official LS Connect-JSON RPC (/exa.language_server_pb.LanguageServerService/)
  │      ├─ RetrieveUserQuotaSummary / GetUserStatus / GetAvailableModels ──▶ quota.json + model_limits.json
  │      └─ GetCascadeTrajectoryGeneratorMetadata ──▶ 当前会话最新 usage (ls_rpc)
  └─▶ 2. Read-only SQLite Fallback (node:sqlite)
         └─ 读取 ~/.gemini/antigravity-cli/conversation_summaries.db 解析 protobuf (sqlite)
                                 │
                                 ▼
WezTerm Lua (plugin/init.lua + state.lua + render.lua)
  └─▶ 节流读取缓存 (1s TTL) + 过期后台刷新 ──▶ window:set_right_status(...)
```

安全边界：

- 缓存根目录 `~/.cache/wezterm-agy-status`（可通过 `WEZTERM_AGY_STATUS_DIR` 或 `XDG_CACHE_HOME` 覆盖）权限为 `0700`。
- `ls_endpoints.json` 权限强制 `0600`；`quota.json`、`panes/pane_<id>.json` 与 `--dump` 输出均严格剥离 `csrf_token`。

---

## 安装与卸载

### 1. 执行安装脚本

```bash
chmod +x /home/xiaolu/agy-quota.wezterm/install.sh
/home/xiaolu/agy-quota.wezterm/install.sh
```

`install.sh` 支持幂等执行，完成以下操作：

1. 软链接 `./agy-plugin` → `~/.gemini/config/plugins/agy-quota-wezterm-bridge`（注册 Antigravity Hook 桥接插件）。
2. 软链接仓库根目录 → `~/.local/share/wezterm/plugins/httpssCssZssZsgithubsDscomsZsfan249720142-droidsZsagy-quotasDswezterm`。
3. 以**只读方式**核验 `~/.gemini/antigravity-cli/settings.json` 中的 `statusLine` 状态，确保未被改动。

> [!NOTE]
> **私有仓库与 `wezterm.plugin.require` 说明**：WezTerm 内置 `libgit2` 在拉取私有 GitHub 仓库的 HTTPS URL 时常因缺少交互式凭据而报认证错误。通过上述 slug 软链接，配置中的 `wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")` 会直接命中本地目录加载，且 `wezterm.plugin.list()` 可正常识别插件路径，无需网络拉取或额外 Git 凭据。

### 2. 卸载软链接

```bash
/home/xiaolu/agy-quota.wezterm/install.sh --uninstall
```

仅移除指向本仓库的软链接，不会修改 `settings.json` 或删除用户非软链接文件。

---

## WezTerm 配置与选项

### 推荐配置（与自定义 `cwd` / 时钟组合）

在 `~/.config/wezterm/wezterm.lua` 中关闭插件内置事件 (`register_status_event = false`)，在统一的 `update-status` 中组合 `agy_quota.get_status_cells(window, pane)` 与个人状态段。注意将 `agy_quota.apply_to_config(...)` 放在 `config.keys = { ... }` 之后，避免覆盖按键表：

```lua
local wezterm = require("wezterm")
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
local config = wezterm.config_builder()

-- ... 字体、配色、tab_bar、config.keys、config.mouse_bindings ...

wezterm.on("update-status", function(window, pane)
  local tab_cols = window:active_tab():get_size().cols
  local quota_cells = agy_quota.get_status_cells(window, pane)
  local snap = agy_quota.get_snapshot(pane)

  local cells = {}
  if #quota_cells > 0 then
    table.insert(cells, { Text = " " })
    for _, item in ipairs(quota_cells) do
      table.insert(cells, item)
    end
    table.insert(cells, { Foreground = { Color = "#4e5568" } })
    table.insert(cells, { Text = " │ " })
  end

  if (not (snap and snap.is_agy)) or (tab_cols >= 135) then
    -- 仅在非 agy 或宽窗口 (>= 135 列) 时附带 cwd，保证 105 列不裁切
    -- ... 插入 cwd cell ...
  end

  table.insert(cells, { Foreground = { Color = "#e6dcc3" } })
  table.insert(cells, { Text = "󰥔 " .. wezterm.strftime("%H:%M") .. " " })
  window:set_right_status(wezterm.format(cells))
end)

agy_quota.apply_to_config(config, {
  register_status_event = false,
  toggle_layout_key = "q",
  refresh_key = "u",
  compact_bar_width = 4,
  cols_offset = 18,
})

return config
```

### 独立模式（快速接入）

若无自定义状态栏，可直接由插件托管 `update-status`：

```lua
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
agy_quota.apply_to_config(config, {
  toggle_layout_key = "q",
  refresh_key = "u",
  append_cwd = true,
  append_time = true,
})
```

### 配置项一览

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `layout` | `"auto"` | `"auto"` / `"full"` / `"compact"` / `"minimal"` |
| `default_cols` | `105` | 无法取得 Tab/Pane 宽度时的回退列数 |
| `cols_offset` | `0` | 计算布局前扣除的预留列宽（标签页/按钮/时钟占位，推荐 `18`） |
| `full_min_cols` | `145` | 有效列宽 `>= full_min_cols` 启用 `full`（`cols_offset=18` 时即 Tab >= 163 列） |
| `compact_min_cols` | `100` | 有效列宽 `>= compact_min_cols` 启用 `compact`（`cols_offset=18` 时即 Tab >= 118 列） |
| `full_bar_width` | `8` | `full` 模式下进度条字符宽度 |
| `compact_bar_width` | `6` | `compact` 模式下进度条字符宽度（组合模式建议设为 `4`） |
| `separator` | `" │ "` | 指标段之间的分隔符 |
| `hide_context_outside_agy` | `true` | 非 `agy` 进程隐藏 `Cached` 与 `Context`（可用 `show_context_outside_agy` 反向配置） |
| `hide_when_empty` | `false` | 无配额与上下文数据时隐藏整个状态段 |
| `show_pool` | `false` | 是否前置显示当前池名称 (`Gemini` / `Claude & GPT`) |
| `pool` | `nil` | 手动指定配额池 key（如 `"gemini"` / `"3p"`） |
| `poll_interval_secs` | `30` | 全局配额缓存刷新周期（秒） |
| `active_poll_interval_secs` | `5` | 活跃 `agy` Pane 上下文刷新周期（秒） |
| `cache_read_ttl_secs` | `1` | Lua 内存读盘节流时间（秒） |
| `spawn_cooldown_secs` | `4` | 后台刷新派生最小冷却时间（秒） |
| `register_status_event` | `true` | 是否由插件直接注册 `update-status` |
| `toggle_layout_key` | `nil` | 绑定布局切换快捷键（如 `"q"`） |
| `refresh_key` | `nil` | 绑定手动刷新快捷键（如 `"u"`） |
| `key_mods` | `"CTRL\|SHIFT"` | 上述快捷键修饰键 |
| `append_cwd` / `append_time` | `false` / `false` | 独立模式下是否追加当前目录与时间 |
| `colors` | `{ ... }` | 覆盖 `label` / `tokens` / `separator` / `countdown` / `bar_empty` / `muted` / `pool` |

### 自适应布局格式对比

| 模式 | 触发条件 (`effective = cols - cols_offset`) | 渲染示例 |
| --- | --- | --- |
| `full` | `effective >= 145` | `Cached 97.6% │ Context 9.8% █░░░░░░░ 102.7k/1.0M │ Five Hours 63% █████░░░ 3h53m │ Weekly 87% ███████░ 6d0h` |
| `compact` | `100 <= effective < 145` | `Cache 97.6% │ Ctx 9.8% ░░░░ 103k/1.0M │ 5h 63% ███░ 3h53m │ Wk 87% ███░ 6d0h` |
| `minimal` | `effective < 100` | `C 98% │ Ctx 10% │ 5h 63% 3h53m │ Wk 87% 6d0h` |

---

## 快捷键说明

| 快捷键 | 功能 | 说明 |
| --- | --- | --- |
| `Ctrl+Shift+Q` | 切换布局 | 按窗口循环切换 `auto` → `full` → `compact` → `minimal` |
| `Ctrl+Shift+U` | 手动刷新 | 立即丢弃内存缓存并异步触发 `agy-status-collector.mjs --refresh` |
| `Ctrl+Shift+R` | 重载配置 | **保留 WezTerm 默认 `ReloadConfiguration`**，不被插件占用 |

---

## 验证与故障排查

```bash
# 1. 验证 Antigravity Hook 插件已注册且清单合法
agy plugin list
agy plugin validate /home/xiaolu/agy-quota.wezterm/agy-plugin --strict

# 2. 验证 WezTerm 配置语法与键位加载（无报错且含 Q / U / R 绑定）
wezterm --config-file ~/.config/wezterm/wezterm.lua show-keys >/dev/null

# 3. 手动执行一次强刷并检查脱敏缓存快照（不含 csrf_token）
node /home/xiaolu/agy-quota.wezterm/bin/agy-status-collector.mjs --refresh --force --pane "${WEZTERM_PANE:-default}" --cwd "$PWD"
node /home/xiaolu/agy-quota.wezterm/bin/agy-status-collector.mjs --dump

# 4. 开启调试日志排查 LS RPC / SQLite / Hook 问题（仅输出到 stderr）
WEZTERM_AGY_DEBUG=1 node /home/xiaolu/agy-quota.wezterm/bin/agy-status-collector.mjs --refresh --force

# 5. 运行完整自动化测试套件
node --test /home/xiaolu/agy-quota.wezterm/tests/collector.test.mjs
wezterm --config-file /home/xiaolu/agy-quota.wezterm/tests/run_wezterm_tests.lua show-keys >/dev/null
```

常见问题排查：

- **提示 `libgit2` / HTTPS 私有仓库拉取失败**：确认 `~/.local/share/wezterm/plugins/httpssCssZssZsgithubsDscomsZsfan249720142-droidsZsagy-quotasDswezterm` 软链接指向 `/home/xiaolu/agy-quota.wezterm`；可重新运行 `./install.sh`。
- **只显示 `5h` / `Wk`，不显示 `Cached` / `Context`**：确认当前焦点 Pane 正在运行 `agy`，或刚开启会话尚未产生首轮 Token 用量；也可按 `Ctrl+Shift+U` 触发刷新。
- **状态显示 `--`**：检查是否处于 `agy` 运行环境中（或 `~/.gemini/antigravity*/daemon/hub_*.json` 是否存在活跃端点），使用 `--dump` 查看 `quota.source` 与 `panes` 字段。
