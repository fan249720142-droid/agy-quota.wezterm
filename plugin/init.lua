local wezterm = require("wezterm")
local LOAD_ARG1, LOAD_ARG2 = ...

local function file_exists(path)
  if type(path) ~= "string" or path == "" then
    return false
  end
  local f = io.open(path, "r")
  if f then
    f:close()
    return true
  end
  return false
end

local function dir_of(path)
  if type(path) ~= "string" or path == "" then
    return nil
  end
  local dir = path:match("^(.*)[/\\][^/\\]+$")
  if dir and dir ~= "" then
    return dir
  end
  return "."
end

local function has_plugin_siblings(dir)
  return type(dir) == "string"
    and dir ~= ""
    and file_exists(dir .. "/state.lua")
    and file_exists(dir .. "/render.lua")
end

local function detect_plugin_dir()
  if type(debug) == "table" and type(debug.getinfo) == "function" then
    local info = debug.getinfo(1, "S")
    if info and type(info.source) == "string" and info.source:sub(1, 1) == "@" then
      local dir = dir_of(info.source:sub(2))
      if has_plugin_siblings(dir) then
        return dir
      end
    end
  end

  if type(LOAD_ARG2) == "string" and LOAD_ARG2 ~= "" and LOAD_ARG2 ~= ":preload:" then
    local dir = dir_of(LOAD_ARG2)
    if has_plugin_siblings(dir) then
      return dir
    end
  end

  if type(LOAD_ARG1) == "string" and LOAD_ARG1 ~= "" then
    local ok_sp, resolved = pcall(package.searchpath, LOAD_ARG1, package.path)
    if ok_sp and type(resolved) == "string" then
      local dir = dir_of(resolved)
      if has_plugin_siblings(dir) then
        return dir
      end
    end
  end

  if type(wezterm.plugin) == "table" and type(wezterm.plugin.list) == "function" then
    local ok, list = pcall(wezterm.plugin.list)
    if ok and type(list) == "table" then
      for _, entry in ipairs(list) do
        local hay = tostring(entry.url or "")
          .. " "
          .. tostring(entry.component or "")
          .. " "
          .. tostring(entry.plugin_dir or "")
        if hay:match("agy%-quota") and type(entry.plugin_dir) == "string" and entry.plugin_dir ~= "" then
          local dir = entry.plugin_dir:gsub("[/\\]+$", "") .. "/plugin"
          if has_plugin_siblings(dir) then
            return dir
          end
        end
      end
    end
  end

  local candidates = {}
  if type(wezterm.config_dir) == "string" and wezterm.config_dir ~= "" then
    local cdir = wezterm.config_dir:gsub("[/\\]+$", "")
    table.insert(candidates, cdir .. "/plugin")
    table.insert(candidates, cdir .. "/agy-quota.wezterm/plugin")
    table.insert(candidates, cdir .. "/plugins/agy-quota.wezterm/plugin")
  end
  local home = (type(wezterm.home_dir) == "string" and wezterm.home_dir ~= "" and wezterm.home_dir)
    or os.getenv("HOME")
    or ""
  if home ~= "" then
    table.insert(candidates, home:gsub("[/\\]+$", "") .. "/agy-quota.wezterm/plugin")
  end
  table.insert(candidates, "plugin")
  table.insert(candidates, ".")

  for _, dir in ipairs(candidates) do
    if has_plugin_siblings(dir) then
      return dir
    end
  end
  return nil
end

local PLUGIN_DIR = detect_plugin_dir()

local function load_sibling(name)
  local cache_key = "agy_quota." .. name
  if package.loaded[cache_key] then
    return package.loaded[cache_key]
  end
  if PLUGIN_DIR then
    local path = PLUGIN_DIR .. "/" .. name .. ".lua"
    if file_exists(path) then
      local chunk, err = loadfile(path)
      if not chunk then
        error("agy-quota.wezterm failed to load " .. path .. ": " .. tostring(err))
      end
      local mod = chunk()
      package.loaded[cache_key] = mod
      return mod
    end
  end
  local mod = require(name)
  package.loaded[cache_key] = mod
  return mod
end

local state = load_sibling("state")
local render = load_sibling("render")

local M = {
  state = state,
  render = render,
  plugin_dir = PLUGIN_DIR,
}

local LAYOUT_CYCLE = { "auto", "full", "compact", "minimal" }

local INIT_DEFAULTS = {
  only_when_agy = true,
  tab_bar_at_bottom = nil,
  register_status_event = true,
  toggle_layout_key = nil,
  refresh_key = nil,
  key_mods = "CTRL|SHIFT",
  append_cwd = false,
  append_time = false,
  cwd_max_len = 28,
  time_format = "%H:%M",
  cwd_icon = "󰉋 ",
  time_icon = "󰥔 ",
  cwd_color = "#a9b0c2",
  time_color = "#e6dcc3",
}

local function merge_tables(...)
  local result = {}
  for i = 1, select("#", ...) do
    local t = select(i, ...)
    if type(t) == "table" then
      for k, v in pairs(t) do
        if k == "colors" and type(v) == "table" then
          local merged_colors = result.colors or {}
          local next_colors = {}
          for ck, cv in pairs(merged_colors) do
            next_colors[ck] = cv
          end
          for ck, cv in pairs(v) do
            next_colors[ck] = cv
          end
          result.colors = next_colors
        else
          result[k] = v
        end
      end
    end
  end
  return result
end

local active_opts = merge_tables(state.DEFAULTS, render.DEFAULTS, INIT_DEFAULTS, {
  plugin_dir = PLUGIN_DIR,
})

local window_layouts = {}
local global_layout_override = nil
local status_handler_registered = false

local function resolve_effective_opts(opts_override, window)
  local merged = merge_tables(active_opts, opts_override)
  if merged.show_context_outside_agy ~= nil then
    merged.hide_context_outside_agy = not merged.show_context_outside_agy
  end
  if not (opts_override and opts_override.layout) then
    local layout_override = M.get_layout(window)
    if layout_override then
      merged.layout = layout_override
    end
  end
  return merged
end

local function get_window_id(window)
  if window == nil then
    return nil
  end
  local ok, wid = pcall(function()
    if type(window.window_id) == "function" then
      return window:window_id()
    end
    return window.window_id
  end)
  if ok and wid ~= nil then
    return wid
  end
  return nil
end

local function resolve_pane(window, pane)
  if pane ~= nil then
    return pane
  end
  if window == nil then
    return nil
  end
  local ok, active = pcall(function()
    if type(window.active_pane) == "function" then
      return window:active_pane()
    end
    return nil
  end)
  if ok then
    return active
  end
  return nil
end

local function resolve_pane_cols(window, pane, opts)
  if window ~= nil then
    local ok_tab, tab = pcall(function()
      if type(window.active_tab) == "function" then
        return window:active_tab()
      end
      return nil
    end)
    if ok_tab and tab ~= nil then
      local ok_sz, sz = pcall(function()
        if type(tab.get_size) == "function" then
          return tab:get_size()
        end
        return nil
      end)
      if ok_sz and type(sz) == "table" and type(sz.cols) == "number" and sz.cols > 0 then
        return sz.cols
      end
    end
  end
  if pane ~= nil then
    local ok, dims = pcall(function()
      if type(pane.get_dimensions) == "function" then
        return pane:get_dimensions()
      end
      return pane.dimensions
    end)
    if ok and type(dims) == "table" and type(dims.cols) == "number" then
      return dims.cols
    end
  end
  return opts.default_cols or render.DEFAULTS.default_cols
end

function M.setup(opts)
  active_opts = merge_tables(state.DEFAULTS, render.DEFAULTS, INIT_DEFAULTS, {
    plugin_dir = PLUGIN_DIR,
  }, opts)
  if opts and opts.show_context_outside_agy ~= nil then
    active_opts.hide_context_outside_agy = not opts.show_context_outside_agy
  end
  if opts and opts.layout ~= nil then
    global_layout_override = nil
    window_layouts = {}
  end
  return M
end

function M.get_opts()
  return active_opts
end

function M.get_layout(window)
  local wid = get_window_id(window)
  if wid ~= nil and window_layouts[wid] ~= nil then
    return window_layouts[wid]
  end
  return global_layout_override or active_opts.layout
end

function M.set_layout(layout, window)
  local wid = get_window_id(window)
  if wid ~= nil then
    window_layouts[wid] = layout
  else
    global_layout_override = layout
  end
  return layout
end

function M.cycle_layout(window)
  local current = M.get_layout(window)
  local next_layout = LAYOUT_CYCLE[1]
  for i, mode in ipairs(LAYOUT_CYCLE) do
    if mode == current then
      next_layout = LAYOUT_CYCLE[(i % #LAYOUT_CYCLE) + 1]
      break
    end
  end
  return M.set_layout(next_layout, window)
end

function M.get_snapshot(pane, opts_override, now)
  local opts = resolve_effective_opts(opts_override, nil)
  return state.get_snapshot(pane, opts, now)
end

function M.trigger_refresh(pane, opts_override, now)
  local opts = resolve_effective_opts(opts_override, nil)
  return state.trigger_refresh(pane, opts, now)
end

--- Composable status cells (`FormatItem[]`) for `window` / `pane`.
function M.get_status_cells(window, pane, opts_override, now)
  local target_pane = resolve_pane(window, pane)
  local opts = resolve_effective_opts(opts_override, window)
  local cols = resolve_pane_cols(window, target_pane, opts)
  local snapshot = state.get_snapshot(target_pane, opts, now)
  return render.render_cells(snapshot, cols, opts)
end

function M.get_status_text(window, pane, opts_override, now)
  local cells = M.get_status_cells(window, pane, opts_override, now)
  if #cells == 0 then
    return ""
  end
  return wezterm.format(cells)
end

local function format_short_cwd(pane, max_len, opts)
  local path = state.get_pane_cwd(pane)
  if path == "" then
    return ""
  end
  local home = state.expand_home("~", opts or active_opts) or ""
  if home ~= "" and path:sub(1, #home) == home then
    path = "~" .. path:sub(#home + 1)
  end
  max_len = max_len or 28
  if #path > max_len and max_len > 3 then
    path = "…" .. path:sub(-(max_len - 1))
  end
  return path
end

local function build_standalone_cells(window, pane)
  local target_pane = resolve_pane(window, pane)
  local opts = resolve_effective_opts(nil, window)
  local cells = M.get_status_cells(window, target_pane)
  local out = {}

  if #cells > 0 then
    table.insert(out, { Text = " " })
    for _, item in ipairs(cells) do
      table.insert(out, item)
    end
  end

  local show_cwd = opts.append_cwd or opts.show_cwd
  local show_time = opts.append_time or opts.show_time
  local cwd = show_cwd and format_short_cwd(target_pane, opts.cwd_max_len, opts) or ""
  local has_extra = (cwd ~= "") or show_time

  if has_extra and #cells > 0 then
    local colors = opts.colors or render.DEFAULTS.colors
    table.insert(out, { Foreground = { Color = colors.separator or "#4e5568" } })
    table.insert(out, { Text = opts.separator or " │ " })
  elseif has_extra then
    table.insert(out, { Text = " " })
  end

  if cwd ~= "" then
    table.insert(out, { Foreground = { Color = opts.cwd_color or "#a9b0c2" } })
    table.insert(out, { Text = (opts.cwd_icon or "") .. cwd })
    if show_time then
      table.insert(out, { Text = "  " })
    end
  end

  if show_time then
    local time_str = wezterm.strftime(opts.time_format or "%H:%M")
    table.insert(out, { Foreground = { Color = opts.time_color or "#e6dcc3" } })
    table.insert(out, { Text = (opts.time_icon or "") .. time_str })
  end

  if #out > 0 then
    table.insert(out, { Text = " " })
  end
  return out
end

local function update_status_handler(window, pane)
  local cells = build_standalone_cells(window, pane)
  if #cells == 0 then
    window:set_right_status("")
  else
    window:set_right_status(wezterm.format(cells))
  end
end

local function bind_optional_key(config, key_spec, default_mods, callback)
  if not key_spec then
    return
  end
  local key, mods
  if type(key_spec) == "string" and key_spec ~= "" then
    key = key_spec
    mods = default_mods
  elseif type(key_spec) == "table" and type(key_spec.key) == "string" and key_spec.key ~= "" then
    key = key_spec.key
    mods = key_spec.mods or default_mods
  else
    return
  end
  config.keys = config.keys or {}
  for _, existing in ipairs(config.keys) do
    if existing.key == key and existing.mods == mods then
      return
    end
  end
  table.insert(config.keys, {
    key = key,
    mods = mods,
    action = wezterm.action_callback(callback),
  })
end

function M.apply_to_config(config, opts)
  M.setup(opts)

  if active_opts.register_status_event ~= false and not status_handler_registered then
    wezterm.on("update-status", update_status_handler)
    status_handler_registered = true
  end

  if type(config) == "table" then
    if active_opts.tab_bar_at_bottom ~= nil then
      config.tab_bar_at_bottom = active_opts.tab_bar_at_bottom
    end
    local default_mods = active_opts.key_mods or "CTRL|SHIFT"
    bind_optional_key(config, active_opts.toggle_layout_key, default_mods, function(window, pane)
      M.cycle_layout(window)
      if active_opts.register_status_event ~= false then
        update_status_handler(window, pane)
      end
    end)
    bind_optional_key(config, active_opts.refresh_key, default_mods, function(window, pane)
      M.trigger_refresh(pane)
      if active_opts.register_status_event ~= false then
        update_status_handler(window, pane)
      end
    end)
  end

  return config
end

return M
