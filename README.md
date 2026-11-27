# agy-quota.wezterm

面向 WezTerm 的 Google Antigravity (`agy`) 实时配额与上下文状态栏插件：支持**底部状态/标签栏 (`tab_bar_at_bottom = true`)**，在当前 Pane 运行 `agy` 时动态展示 **配额池 (`Gemini` / `Claude/GPT`)**、**Prompt 缓存命中率 (`Cached`)**、**上下文用量 (`Context`)**、**5 小时配额 (`5h`)** 与 **每周配额 (`Wk`)**，在普通 Shell Pane 中**完全隐藏**（仅保留用户原有的目录与时钟），并与 Antigravity CLI 原生界面及 `settings.json` 完全共存。

---

## 核心特性

- **底部状态栏集成**：支持通过 `tab_bar_at_bottom = true` 将标签栏与右侧配额状态栏统一下置到底部，与 NieR 等深色主题配色自然融合。
- **`agy` 专属可见性 (`only_when_agy = true`)**：仅当当前焦点 Pane 前台进程（或其子进程树）为 `agy` / `agy-cli` / `antigravity` 时显示状态段并触发刷新；在普通 Shell Pane 中插件输出为空，状态栏保持干净的 `cwd` + 时钟（也可设 `only_when_agy = false` 在所有 Pane 显示全局配额）。
- **动态模型感知切池 (`Gemini` ↔ `Claude/GPT`)**：实时跟踪用户在 CLI 中通过 `/model`、`--model` 参数或会话切换产生的模型变更——综合读取 `settings.json`（只读 `model` 字段并补偿 Linux `mtime` 滞后）、Antigravity Hooks 与 LS RPC 轨迹元数据时间戳，自动在 `Gemini` (`gemini`) 与 `Claude/GPT` (`3p`) 两个配额池之间切换显示对应百分比与倒计时。
- **全档位保留进度条的三档自适应布局**：根据当前 Tab 宽度 (`tab:get_size().cols - cols_offset`) 在 `full` / `compact` / `minimal` 间自动切换；即便是默认的 105 列 `minimal` 模式下，仍保留 `5h` 与 `Wk` 的可视化进度条 (`minimal_bar_width = 4`)。
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

本插件**永不修改 `~/.gemini/antigravity-cli/settings.json`**（`statusLine` 保持原样），通过外部插件与独立缓存目录实现无冲突协同，并在 `agy` 运行期间实时跟踪 `/model` 切换：

```text
agy CLI 环境
  ├─▶ 1. agy-plugin Hooks (SessionStart / PreInvocation / PostInvocation / PostToolUse / Stop)
  │        └─▶ hook-bridge.mjs ──▶ 记录会话 ID / Hook 模型 / LS 端点 (0600)
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
  └─▶ 检测前景进程 (agy 时才渲染) ──▶ 节流读缓存 (1s) / 后台刷新 ──▶ 底部状态栏 window:set_right_status(...)
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

### 推荐配置（底部状态栏 + 仅 `agy` 显示 + 自定义 `cwd` / 时钟）

在 `~/.config/wezterm/wezterm.lua` 中设置 `config.tab_bar_at_bottom = true`、关闭插件内置事件 (`register_status_event = false`)，并在统一的 `update-status` 中组合 `agy_quota.get_status_cells(window, pane)` 与个人状态段。当处于普通 Shell Pane（`#quota_cells == 0`）时，仅渲染正常 `cwd` 与时钟，不附带任何 `agy` 文字或多余分隔符。注意将 `agy_quota.apply_to_config(...)` 放在 `config.keys = { ... }` 之后，避免覆盖按键表：

```lua
local wezterm = require("wezterm")
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
local config = wezterm.config_builder()

-- 底部标签栏与状态栏
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true

-- ... 字体、配色、config.keys、config.mouse_bindings ...

wezterm.on("update-status", function(window, pane)
  local tab_cols = window:active_tab():get_size().cols
  local quota_cells = agy_quota.get_status_cells(window, pane)
  local has_quota = type(quota_cells) == "table" and #quota_cells > 0

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
    -- 普通 Shell Pane 或宽窗口 (>= 135 列) 时附带 cwd
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
  tab_bar_at_bottom = true,
  toggle_layout_key = "q",
  refresh_key = "u",
  compact_bar_width = 4,
  minimal_bar_width = 4,
  cols_offset = 18,
})

return config
```

### 独立模式（快速接入）

若无自定义状态栏，可直接由插件托管 `update-status` 与底部放置：

```lua
local agy_quota = wezterm.plugin.require("https://github.com/fan249720142-droid/agy-quota.wezterm")
agy_quota.apply_to_config(config, {
  only_when_agy = true,
  show_pool = true,
  tab_bar_at_bottom = true,
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
| `tab_bar_at_bottom` | `nil` | 非 `nil` 时在 `apply_to_config` 中设置 `config.tab_bar_at_bottom`（推荐 `true`） |
| `default_cols` | `105` | 无法取得 Tab/Pane 宽度时的回退列数 |
| `cols_offset` | `0` | 计算布局前扣除的预留列宽（标签页/按钮/时钟占位，推荐 `18`） |
| `full_min_cols` | `140` | 有效列宽 `>= full_min_cols` 启用 `full`（`cols_offset=18` 时即 Tab >= 158 列） |
| `compact_min_cols` | `100` | 有效列宽 `>= compact_min_cols` 启用 `compact`（`cols_offset=18` 时即 Tab >= 118 列） |
| `full_bar_width` | `8` | `full` 模式下进度条字符宽度 |
| `compact_bar_width` | `4` | `compact` 模式下进度条字符宽度 |
| `minimal_bar_width` | `4` | `minimal` 模式下 `5h` / `Wk` 进度条字符宽度（保留进度条展示） |
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
