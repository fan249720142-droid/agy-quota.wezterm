# agy-quota.wezterm

面向 WezTerm 的 Google Antigravity (`agy`) 实时配额与上下文状态栏插件：采用**双项目协作架构**——由 `wezterm-custom` 提供原生 `bottom_status_rows = 2` 与 `window:set_bottom_status` 底部双行槽位，`agy-quota.wezterm` 自动探测该 API 并在当前 Pane 运行 `agy` 时在底部透明双行区展示 **Cached / Context**（第 1 行）与 **配额池 (`Gemini` / `Claude/GPT`) / `Five Hours` / `Weekly`**（第 2 行），同时保持顶部标签栏、右上角窗口按钮及 `cwd` + 时钟；在普通 Shell Pane 中底部输出为空（`""`，保留透明背景），在原版 WezTerm 上则自动回退为顶部/底部单行 `window:set_right_status(...)`，并与 Antigravity CLI 原生 `statusLine` 及 `settings.json` 完全共存。

---

## 核心特性

- **双项目拆分与原生底部双行栏 (`wezterm-custom`)**：`wezterm-custom` 负责渲染 `config.bottom_status_rows = 2` 底部独立状态槽位及 `window:set_bottom_status(ansi_text)`；插件通过 `has_bottom_status_api(window)` 自动识别，有该 API 时保留顶部标签栏 (`tab_bar_at_bottom = false`) 与右上角集成按钮，将双行指标渲染至底部，不在顶部重复堆叠配额。
- **原版 WezTerm 优雅降级**：若运行在未打补丁的原版 WezTerm（无 `window.set_bottom_status`），`agy_quota.update_bottom_status(...)` 返回 `false`，自动回退到单行 `get_status_cells(...)` + `window:set_right_status(...)`（可按需设 `tab_bar_at_bottom = true` 或留在右上角）。
- **`agy` 专属可见性 (`only_when_agy = true`)**：仅当当前焦点 Pane 前台进程（或其子进程树）为 `agy` / `agy-cli` / `antigravity` 时显示状态并触发刷新；在普通 Shell Pane 中底部状态返回 `""`（透明不占位），顶部状态栏保持干净的 `cwd` + 时钟（也可设 `only_when_agy = false` 在所有 Pane 显示全局配额）。
- **动态模型感知切池 (`Gemini` ↔ `Claude/GPT`)**：实时跟踪用户在 CLI 中通过 `/model`、`--model` 参数或会话切换产生的模型变更——综合读取 `settings.json`（只读 `model` 字段并补偿 Linux `mtime` 滞后）、Antigravity Hooks 与 LS RPC 轨迹元数据时间戳，自动在 `Gemini` (`gemini`) 与 `Claude/GPT` (`3p`) 两个配额池之间切换显示对应百分比与倒计时。
- **跨终端会话键设计**：采集器与 Hook 桥接层 (`bin/lib/cache.mjs` `resolvePaneId`) 按 `显式 --pane` → `WEZTERM_PANE` → `WT_SESSION` (`wt_<id>`) → `default` 解析会话键，为后续扩展至 Windows Terminal 等终端复用同一套采集与缓存机制预留兼容层。
- **零阻塞纯异步架构**：WezTerm 渲染主线程仅节流读取本地缓存 JSON（1s TTL）并在超时时后台派生 `node` 采集器，不阻塞终端渲染。

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

辅助元素固定语义色：标签 `#a9b0c2`、Token 统计 `#8c92a4`、分隔符 `#4e5568`、重置倒计时 `#57caff`、进度条底槽 `#3b4052`、缺失占位 `#6c7386`、Gemini 配额池 `colors.pool_gemini` (`#89b4fa`)、Claude/GPT 配额池 `colors.pool_3p` (`#d4bdf5`)、通用配额池回退色 `colors.pool` (`#e6dcc3`)。

---

## 共存架构与动态切池（Hooks + Settings + LS RPC + SQLite）

本插件**永不修改 `~/.gemini/antigravity-cli/settings.json`**（原生 `statusLine` 完全不被触碰或覆盖），通过外部插件、独立缓存目录与跨终端会话键（`WEZTERM_PANE` → `WT_SESSION` → `default`）实现无冲突协同，并在 `agy` 运行期间实时跟踪 `/model` 切换：

```text
agy CLI 环境
  ├─▶ 1. agy-plugin Hooks (SessionStart / PreInvocation / PostInvocation / PostToolUse / Stop)
  │        └─▶ hook-bridge.mjs ──▶ 按 resolvePaneId(WEZTERM_PANE / WT_SESSION / default) 记录会话与 LS 端点 (0600)
  ├─▶ 2. 只读 Settings 监控 (model-tracking.mjs)
  │        └─▶ 仅读取 settings.json 的 `model` 字段 + mtime 滞后补偿（支持 /model 即时切池）
  └─▶ 3. bin/agy-status-collector.mjs (--refresh)
           ├─▶ Official LS Connect-JSON RPC (/exa.language_server_pb.LanguageServerService/)
           │     ├─ RetrieveUserQuotaSummary / GetUserStatus / GetAvailableModels ──▶ quota.json (gemini + 3p 池)
           │     └─ GetCascadeTrajectoryGeneratorMetadata ──▶ 步数递增时更新 RPC 模型与 usage (ls_rpc)
           └─▶ Read-only SQLite Fallback (node:sqlite)
                 └─ 读取 ~/.gemini/antigravity-cli/conversation_summaries.db 解析 protobuf (sqlite)
                                 │
                                 ▼ (时间戳裁决 hook > rpc > settings)
WezTerm Lua (plugin/init.lua + state.lua + render.lua)
  └─▶ 检测前景进程 (agy 时才渲染) ──▶ 节流读缓存 (1s) / 后台刷新
        ├─▶ wezterm-custom (存在 set_bottom_status) ──▶ window:set_bottom_status(双行 ANSI) + 顶部仅 cwd/时钟
        └─▶ 原版 WezTerm (回退) ──▶ window:set_right_status(单行 FormatItem + cwd/时钟)
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

### 推荐配置（顶部标签栏 + `wezterm-custom` 底部双行槽位 + 原版单行自动回退）

在 `~/.config/wezterm/wezterm.lua` 中保留顶部标签栏 (`config.tab_bar_at_bottom = false`) 与右上角窗口按钮，设置 `config.bottom_status_rows = 2` 并关闭插件内置事件 (`register_status_event = false`)；在统一的 `update-status` 中先调用 `agy_quota.update_bottom_status(window, target_pane)`：
- 当 `used_bottom == true`（`wezterm-custom` 环境）时，双行配额/上下文由底部独立槽位渲染（非 `agy` Pane 返回 `""` 保持透明），右上角仅渲染 `cwd` 与时钟，避免重复；
- 当 `used_bottom == false`（原版 WezTerm 回退）时，右上角自动组合单行 `quota_cells` + `cwd` + 时钟。注意将 `agy_quota.apply_to_config(...)` 放在 `config.keys = { ... }` 之后，避免覆盖按键表：

```lua
local wezterm = require("wezterm")
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
local config = wezterm.config_builder()

-- 顶部标签栏与 wezterm-custom 底部双行状态槽位
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = false
config.show_new_tab_button_in_tab_bar = true
config.bottom_status_rows = 2

-- ... 字体、配色、config.keys、config.mouse_bindings ...

wezterm.on("update-status", function(window, pane)
  local target_pane = pane
  if not target_pane and window and type(window.active_pane) == "function" then
    local ok, active = pcall(function()
      return window:active_pane()
    end)
    if ok then
      target_pane = active
    end
  end

  local used_bottom = agy_quota.update_bottom_status(window, target_pane)
  local quota_cells = nil
  local has_quota = false
  if not used_bottom then
    quota_cells = agy_quota.get_status_cells(window, target_pane)
    has_quota = type(quota_cells) == "table" and #quota_cells > 0
  end

  local tab_cols = window:active_tab():get_size().cols
  local show_cwd = (not has_quota) or (tab_cols >= 135)
  local cells = {}

  if has_quota then
    table.insert(cells, { Text = " " })
    for _, item in ipairs(quota_cells) do
      table.insert(cells, item)
    end
    table.insert(cells, { Foreground = { Color = "#4e5568" } })
    table.insert(cells, { Text = " │ " })
  else
    table.insert(cells, { Text = " " })
  end

  if show_cwd then
    -- 底部槽位启用、普通 Shell Pane 或宽窗口 (>= 135 列) 时附带 cwd
    -- ... 插入 cwd cell ...
  end

  table.insert(cells, { Foreground = { Color = "#e6dcc3" } })
  table.insert(cells, { Text = "󰥔 " .. wezterm.strftime("%H:%M") .. " " })
  window:set_right_status(wezterm.format(cells))
end)

agy_quota.apply_to_config(config, {
  register_status_event = false,
  only_when_agy = true,
  show_pool = true,
  tab_bar_at_bottom = false,
  prefer_bottom_status = true,
  toggle_layout_key = "q",
  refresh_key = "u",
  compact_bar_width = 4,
  minimal_bar_width = 4,
  cols_offset = 18,
})

return config
```

### 独立模式（快速接入）

若无自定义状态栏，可直接由插件托管 `update-status`：在 `wezterm-custom` 下自动写入底部双行并将 `cwd`/时间置于右上角；在原版 WezTerm 下自动回退为单行状态栏（若希望在原版 WezTerm 中将单行栏下置，可将 `tab_bar_at_bottom` 设为 `true`）：

```lua
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
config.bottom_status_rows = 2
agy_quota.apply_to_config(config, {
  only_when_agy = true,
  show_pool = true,
  tab_bar_at_bottom = false,
  prefer_bottom_status = true,
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
| `only_when_agy` | `true` | 仅在 `agy` / `agy-cli` / `antigravity` Pane 中渲染，普通 Shell Pane 完全隐藏 |
| `prefer_bottom_status` | `true` | 当窗口存在 `set_bottom_status`（`wezterm-custom`）时优先渲染到底部双行槽位 |
| `render_mode` | `"auto"` | `"auto"` / `"top"`；设为 `"top"` 可强制使用单行顶部状态栏 |
| `tab_bar_at_bottom` | `nil` | 非 `nil` 时在 `apply_to_config` 中设置 `config.tab_bar_at_bottom`（`wezterm-custom` 推荐 `false`，原版单行可设 `true`） |
| `default_cols` | `105` | 无法取得 Tab/Pane 宽度时的回退列数 |
| `cols_offset` | `0` | 计算布局前扣除的预留列宽（标签页/按钮/时钟占位，推荐 `18`） |
| `full_min_cols` | `140` | 有效列宽 `>= full_min_cols` 启用 `full`（`cols_offset=18` 时即 Tab >= 158 列） |
| `compact_min_cols` | `100` | 有效列宽 `>= compact_min_cols` 启用 `compact`（`cols_offset=18` 时即 Tab >= 118 列） |
| `full_bar_width` | `8` | `full` 模式下进度条字符宽度 |
| `compact_bar_width` | `4` | `compact` 模式下进度条字符宽度 |
| `minimal_bar_width` | `4` | `minimal` 模式下 `5h` / `Wk` 进度条字符宽度（保留进度条展示） |
| `bottom_bar_width` | `10` | `wezterm-custom` 底部双行标准模式进度条宽度 |
| `bottom_compact_bar_width` | `4` | `wezterm-custom` 底部双行紧凑模式（`effective < bottom_compact_cols`）进度条宽度 |
| `bottom_compact_cols` | `85` | 底部双行触发紧凑标签的阈值列数（默认 105 列、`cols_offset=18` 时为 `87 >= 85`，可完整显示） |
| `separator` | `" │ "` | 指标段之间的分隔符 |
| `hide_context_outside_agy` | `true` | `only_when_agy = false` 时，在非 `agy` 进程隐藏 `Cached` 与 `Context` |
| `hide_when_empty` | `false` | 无配额与上下文数据时隐藏整个状态段 |
| `show_pool` | `true` | 前置显示当前配额池（`Gemini` / `Claude/GPT`，`minimal` 下为 `Gem` / `Cld`） |
| `pool` | `nil` | 手动指定配额池 key（如 `"gemini"` / `"3p"`），未设置时按当前模型自动切池 |
| `poll_interval_secs` | `30` | 全局配额缓存刷新周期（秒） |
| `active_poll_interval_secs` | `3` | 活跃 `agy` Pane 上下文与模型切换刷新周期（秒） |
| `cache_read_ttl_secs` | `1` | Lua 内存读盘节流时间（秒） |
| `spawn_cooldown_secs` | `2` | 后台刷新派生最小冷却时间（秒） |
| `register_status_event` | `true` | 是否由插件直接注册 `update-status` |
| `toggle_layout_key` | `nil` | 绑定布局切换快捷键（如 `"q"`） |
| `refresh_key` | `nil` | 绑定手动刷新快捷键（如 `"u"`） |
| `key_mods` | `"CTRL\|SHIFT"` | 上述快捷键修饰键 |
| `append_cwd` / `append_time` | `false` / `false` | 独立模式下是否追加当前目录与时间 |
| `colors` | `{ ... }` | 覆盖 `label` / `tokens` / `separator` / `countdown` / `bar_empty` / `muted` / `pool` / `pool_gemini` (`#89b4fa`) / `pool_3p` (`#d4bdf5`) |

### 自适应布局格式对比

#### `wezterm-custom` 底部双行模式（`window:set_bottom_status`）

```text
# Line 1: Cached 97.6% │ Context 37.7% ████░░░░░░ 395.4k/1.0M
# Line 2: Gemini │ Five Hours 59% ██████░░░░ 3h53m │ Weekly 86% █████████░ 6d0h
```

当 `is_agy == false`（普通 Shell Pane）且 `only_when_agy = true` 时，返回空字符串 `""`，底部 2 行保持透明无文字。

#### 原版 WezTerm 单行回退模式（`window:set_right_status`）

以 `cols_offset = 18`、`show_pool = true`、`compact_bar_width = 4`、`minimal_bar_width = 4` 为例：

| 场景 / 模式 | 触发条件 (`effective = cols - cols_offset`) | 渲染示例 |
| --- | --- | --- |
| 普通 Shell Pane | `is_agy == false` 且 `only_when_agy = true` | *(插件输出为空，仅展示普通目录与时钟：`󰉋 ~/agy-quota.wezterm  󰥔 17:15`)* |
| `full` (`Gemini`) | `effective >= 140`（如 `cols = 165`） | `Gemini │ Cached 97.6% │ Context 37.7% ███░░░░░ 395.4k/1.0M │ Five Hours 59% █████░░░ 3h53m │ Weekly 86% ███████░ 6d0h` |
| `compact` (`Gemini`) | `100 <= effective < 140`（如 `cols = 135`） | `Gemini │ C 98% │ Ctx 37.7% ██░░ 395k/1.0M │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h` |
| `minimal` (`Gemini`) | `effective < 100`（如默认 `cols = 105`） | `Gem │ Ctx 38% │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h` |
| `compact` (`Claude/GPT`) | `/model` 切至 Claude / GPT (`cols = 135`) | `Claude/GPT │ C 98% │ Ctx 37.7% ██░░ 395k/1.0M │ 5h 24% █░░░ 1h59m │ Wk 71% ███░ 4d0h` |
| `minimal` (`Claude/GPT`) | `/model` 切至 Claude / GPT (`cols = 105`) | `Cld │ Ctx 38% │ 5h 24% █░░░ 1h59m │ Wk 71% ███░ 4d0h` |

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
- **普通 Shell Pane 下不显示配额**：默认开启 `only_when_agy = true`，仅在运行 `agy` 的 Pane 展示状态段，普通 Shell 仅显示正常目录与时钟；如需在所有 Pane 显示全局配额，可设置 `only_when_agy = false`。
- **`agy` 中只显示配额池与 `5h` / `Wk`，暂未显示 `Cached` / `Context`**：通常为刚开启会话尚未产生首轮 Token 用量；产生首轮交互后会自动出现，也可按 `Ctrl+Shift+U` 手动强刷。
- **`/model` 切换模型后等待同步**：活跃 `agy` Pane 默认每 `3s`（`active_poll_interval_secs = 3`）同步一次，可等待 `2~3s` 或按 `Ctrl+Shift+U` 立即刷新，并使用 `--dump` 检查 `panes.<id>.pool` 与 `model_tracking`。
- **状态显示 `--`**：检查是否处于 `agy` 运行环境中（或 `~/.gemini/antigravity*/daemon/hub_*.json` 是否存在活跃端点），使用 `--dump` 查看 `quota.source` 与 `panes` 字段。
