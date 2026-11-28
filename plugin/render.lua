local ok_wezterm, wezterm = pcall(require, "wezterm")
if not ok_wezterm then
  wezterm = nil
end

local M = {}

M.DEFAULTS = {
  layout = "auto", -- "auto" | "full" | "compact" | "minimal"
  only_when_agy = true,
  default_cols = 105,
  cols_offset = 0,
  full_min_cols = 140,
  compact_min_cols = 100,
  full_bar_width = 8,
  compact_bar_width = 4,
  minimal_bar_width = 4,
  bottom_bar_width = 10,
  bottom_compact_bar_width = 4,
  bottom_compact_cols = 85,
  bottom_right_padding = 1,
  bar_style = "subpixel", -- "subpixel" (1/8 blocks + track bg) | "block" (classic █/░)
  bottom_bar_filled_char = "█",
  bottom_bar_empty_char = "░",
  bar_filled_char = "█",
  bar_empty_char = "░",
  separator = " │ ",
  hide_context_outside_agy = true,
  hide_when_empty = false,
  show_pool = true,
  colors = {
    label = "#a9b0c2",
    tokens = "#8c92a4",
    token_limit = "#d6dae6",
    separator = "#4e5568",
    countdown = "#57caff",
    bar_empty = "#3b4052",
    bar_track = "#2b303c",
    muted = "#6c7386",
    pool = "#e6dcc3",
    pool_gemini = "#89b4fa",
    pool_3p = "#d4bdf5",
  },
}

local PARTIAL_BLOCKS = { "", "▏", "▎", "▍", "▌", "▋", "▊", "▉" }

local STOPS = {
  red = { 255, 85, 85 },     -- #ff5555 @ 0%
  yellow = { 255, 212, 39 }, -- #ffd427 @ 50%
  green = { 92, 219, 109 },  -- #5cdb6d @ 100%
}

local LAYOUT_SPECS = {
  full = {
    mode = "full",
    show_cache = true,
    cache_label = "Cached",
    cache_decimals = 1,
    ctx_label = "Context",
    ctx_decimals = 1,
    show_ctx_bar = true,
    five_hour_label = "Five Hours",
    weekly_label = "Weekly",
    bar_width_key = "full_bar_width",
    default_bar_width = 8,
    show_tokens = true,
    token_mode = "full",
  },
  compact = {
    mode = "compact",
    show_cache = true,
    cache_label = "C",
    cache_decimals = 0,
    ctx_label = "Ctx",
    ctx_decimals = 1,
    show_ctx_bar = true,
    five_hour_label = "5h",
    weekly_label = "Wk",
    bar_width_key = "compact_bar_width",
    default_bar_width = 4,
    show_tokens = true,
    token_mode = "compact",
  },
  minimal = {
    mode = "minimal",
    show_cache = false,
    cache_label = "C",
    cache_decimals = 0,
    ctx_label = "Ctx",
    ctx_decimals = 0,
    show_ctx_bar = false,
    five_hour_label = "5h",
    weekly_label = "Wk",
    bar_width_key = "minimal_bar_width",
    default_bar_width = 4,
    show_tokens = false,
    token_mode = nil,
  },
}

function M.clamp(val, min_v, max_v)
  if val < min_v then
    return min_v
  end
  if val > max_v then
    return max_v
  end
  return val
end

function M.round(val)
  return math.floor(val + 0.5)
end

local function lerp_channel(a, b, t)
  return M.round(a + (b - a) * t)
end

--- Continuous 3-stop RGB gradient: 0% red -> 50% yellow -> 100% green.
function M.gradient_color(pct)
  if type(pct) ~= "number" or pct ~= pct then
    return M.DEFAULTS.colors.muted
  end
  local p = M.clamp(pct, 0, 100)
  local c1, c2, t
  if p <= 50 then
    c1 = STOPS.red
    c2 = STOPS.yellow
    t = p / 50
  else
    c1 = STOPS.yellow
    c2 = STOPS.green
    t = (p - 50) / 50
  end
  local r = lerp_channel(c1[1], c2[1], t)
  local g = lerp_channel(c1[2], c2[2], t)
  local b = lerp_channel(c1[3], c2[3], t)
  return string.format("#%02x%02x%02x", r, g, b)
end

function M.cached_color(cached_pct)
  if type(cached_pct) ~= "number" or cached_pct ~= cached_pct then
    return M.DEFAULTS.colors.muted
  end
  local score = M.clamp((cached_pct - 80) / 20 * 100, 0, 100)
  return M.gradient_color(score)
end

function M.context_color(used_pct)
  if type(used_pct) ~= "number" or used_pct ~= used_pct then
    return M.DEFAULTS.colors.muted
  end
  local remaining = M.clamp(100 - used_pct, 0, 100)
  return M.gradient_color(remaining)
end

function M.quota_color(remaining_pct)
  if type(remaining_pct) ~= "number" or remaining_pct ~= remaining_pct then
    return M.DEFAULTS.colors.muted
  end
  return M.gradient_color(M.clamp(remaining_pct, 0, 100))
end

--- Format dynamic reset countdown from reset_epoch - now.
function M.format_countdown(reset_epoch, now)
  if type(reset_epoch) ~= "number" or reset_epoch ~= reset_epoch then
    return nil
  end
  now = now or os.time()
  local diff = math.floor(reset_epoch - now)
  if diff <= 0 then
    return "now"
  end
  if diff < 60 then
    return "<1m"
  end
  if diff < 3600 then
    return string.format("%dm", math.floor(diff / 60))
  end
  if diff < 86400 then
    local hours = math.floor(diff / 3600)
    local mins = math.floor((diff % 3600) / 60)
    return string.format("%dh%dm", hours, mins)
  end
  local days = math.floor(diff / 86400)
  local hours = math.floor((diff % 86400) / 3600)
  return string.format("%dd%dh", days, hours)
end

function M.format_tokens(count, mode)
  if type(count) ~= "number" or count ~= count then
    return nil
  end
  if count < 0 then
    count = 0
  end
  if count >= 1000000 then
    return string.format("%.1fM", count / 1000000)
  end
  if count >= 1000 then
    if mode == "full" then
      return string.format("%.1fk", count / 1000)
    end
    return string.format("%.0fk", count / 1000)
  end
  return string.format("%d", M.round(count))
end

function M.format_token_fraction(used, total, mode)
  local used_s = M.format_tokens(used, mode)
  local total_s = M.format_tokens(total, mode)
  if not used_s or not total_s then
    return nil, nil
  end
  if mode == "compact" then
    local u_unit = used_s:sub(-1)
    local t_unit = total_s:sub(-1)
    if (u_unit == "k" or u_unit == "M") and u_unit == t_unit then
      used_s = used_s:sub(1, -2)
    end
  end
  return used_s, total_s
end

local function format_pct(val, decimals)
  if type(val) ~= "number" or val ~= val then
    return "--"
  end
  local clamped = M.clamp(val, 0, 100)
  if decimals == 0 then
    return string.format("%d%%", M.round(clamped))
  end
  return string.format("%." .. tostring(decimals) .. "f%%", clamped)
end

local function resolve_colors(opts)
  local colors = {}
  for k, v in pairs(M.DEFAULTS.colors) do
    colors[k] = v
  end
  if type(opts) == "table" and type(opts.colors) == "table" then
    for k, v in pairs(opts.colors) do
      if type(v) == "string" and v ~= "" then
        colors[k] = v
      elseif v == false then
        colors[k] = nil
      end
    end
  end
  return colors
end

local function classify_pool_kind(pool_key, pool_label)
  local key = type(pool_key) == "string" and pool_key:lower() or ""
  local lbl = type(pool_label) == "string" and pool_label:lower() or ""
  if key == "3p"
    or key:find("claude", 1, true)
    or key:find("gpt", 1, true)
    or key:find("3p", 1, true)
    or lbl:find("claude", 1, true)
    or lbl:find("gpt", 1, true)
    or lbl:find("3p", 1, true)
  then
    return "3p"
  end
  if key == "gemini"
    or key:find("gemini", 1, true)
    or lbl:find("gemini", 1, true)
  then
    return "gemini"
  end
  return "other"
end

local function resolve_pool_presentation(snapshot, mode, colors)
  local raw_key = type(snapshot.pool_key) == "string" and snapshot.pool_key ~= "" and snapshot.pool_key or nil
  local raw_label = type(snapshot.pool_label) == "string" and snapshot.pool_label ~= "" and snapshot.pool_label or nil
  if not raw_key and not raw_label then
    return nil, nil
  end

  local kind = classify_pool_kind(raw_key, raw_label)
  if kind == "3p" then
    local text = (mode == "minimal") and "Cld" or "Claude/GPT"
    return text, colors.pool_3p or colors.pool
  end
  if kind == "gemini" then
    local text = (mode == "minimal") and "Gem" or "Gemini"
    return text, colors.pool_gemini or colors.pool
  end
  return raw_label or raw_key, colors.pool
end

function M.resolve_layout_mode(cols, opts)
  opts = opts or M.DEFAULTS
  local layout = opts.layout or M.DEFAULTS.layout
  if LAYOUT_SPECS[layout] then
    return layout
  end
  local raw_cols = type(cols) == "number" and cols or (opts.default_cols or M.DEFAULTS.default_cols)
  local effective = raw_cols - (opts.cols_offset or 0)
  local full_min = opts.full_min_cols or M.DEFAULTS.full_min_cols
  local compact_min = opts.compact_min_cols or M.DEFAULTS.compact_min_cols
  if effective >= full_min then
    return "full"
  end
  if effective >= compact_min then
    return "compact"
  end
  return "minimal"
end

local function push_text(cells, color, text)
  if type(text) ~= "string" or text == "" then
    return
  end
  if type(color) == "string" and color ~= "" then
    table.insert(cells, { Foreground = { Color = color } })
  end
  table.insert(cells, { Text = text })
end

local function should_use_subpixel_bar(opts)
  if type(opts) == "table" then
    if opts.bar_style == "block" then
      return false
    end
    if opts.bar_style == "subpixel" then
      return true
    end
    local custom_filled = opts.bar_filled_char ~= nil and opts.bar_filled_char ~= M.DEFAULTS.bar_filled_char
    local custom_empty = opts.bar_empty_char ~= nil and opts.bar_empty_char ~= M.DEFAULTS.bar_empty_char
    if custom_filled or custom_empty then
      return false
    end
  end
  return M.DEFAULTS.bar_style == "subpixel"
end

local function push_bar(cells, pct, width, fill_color, opts, colors)
  if width <= 0 or type(pct) ~= "number" then
    return
  end
  local clamped = M.clamp(pct, 0, 100)
  if should_use_subpixel_bar(opts) then
    local total_eighths = M.round(clamped / 100 * width * 8)
    local full = math.floor(total_eighths / 8)
    local rem = total_eighths % 8
    local empty = width - full - (rem > 0 and 1 or 0)
    local track_bg = colors.bar_track or M.DEFAULTS.colors.bar_track

    if full > 0 then
      push_text(cells, fill_color, string.rep("█", full))
    end
    if rem > 0 then
      if type(track_bg) == "string" and track_bg ~= "" then
        table.insert(cells, { Background = { Color = track_bg } })
      end
      push_text(cells, fill_color, PARTIAL_BLOCKS[rem + 1])
    end
    if empty > 0 then
      if type(track_bg) == "string" and track_bg ~= "" then
        table.insert(cells, { Background = { Color = track_bg } })
      end
      table.insert(cells, { Text = string.rep(" ", empty) })
    end
    if (rem > 0 or empty > 0) and type(track_bg) == "string" and track_bg ~= "" then
      table.insert(cells, { Background = { Color = "Default" } })
    end
    return
  end

  local filled = M.round(clamped / 100 * width)
  local empty = width - filled
  local filled_char = (opts and opts.bar_filled_char) or M.DEFAULTS.bar_filled_char
  local empty_char = (opts and opts.bar_empty_char) or M.DEFAULTS.bar_empty_char
  if filled > 0 then
    push_text(cells, fill_color, string.rep(filled_char, filled))
  end
  if empty > 0 then
    push_text(cells, colors.bar_empty, string.rep(empty_char, empty))
  end
end

local function add_segment(segments, build_fn)
  local seg_cells = {}
  build_fn(seg_cells)
  if #seg_cells > 0 then
    table.insert(segments, seg_cells)
  end
end

local function render_quota_segment(segments, label, win, bar_width, now, opts, colors)
  if type(win) ~= "table" or win.remaining_pct == nil then
    return
  end
  add_segment(segments, function(seg)
    local pct = win.remaining_pct
    local col = M.quota_color(pct)
    push_text(seg, colors.label, label .. " ")
    push_text(seg, col, format_pct(pct, 0))
    if bar_width > 0 then
      push_text(seg, nil, " ")
      push_bar(seg, pct, bar_width, col, opts, colors)
    end
    local cd = M.format_countdown(win.reset_epoch, now)
    if cd then
      push_text(seg, colors.countdown, " " .. cd)
    end
  end)
end

local function resolve_bool_opt(opts, key, default_val)
  local val = opts and opts[key]
  if val == nil then
    return default_val
  end
  return val ~= false
end

local function should_show_context(snapshot, opts)
  local hide_outside = resolve_bool_opt(opts, "hide_context_outside_agy", M.DEFAULTS.hide_context_outside_agy)
  if opts and opts.show_context_outside_agy ~= nil then
    hide_outside = not opts.show_context_outside_agy
  end
  return (snapshot.is_agy == true) or (not hide_outside)
end

local function add_quota_placeholders(segments, five_hour_label, weekly_label, colors)
  add_segment(segments, function(seg)
    push_text(seg, colors.label, five_hour_label .. " ")
    push_text(seg, colors.muted, "--")
  end)
  add_segment(segments, function(seg)
    push_text(seg, colors.label, weekly_label .. " ")
    push_text(seg, colors.muted, "--")
  end)
end

local function join_segments(segments, sep, sep_color)
  local cells = {}
  for idx, seg in ipairs(segments) do
    if idx > 1 then
      push_text(cells, sep_color, sep)
    end
    for _, item in ipairs(seg) do
      table.insert(cells, item)
    end
  end
  return cells
end

local function add_context_segments(segments, ctx, cfg, bar_width, bar_opts, colors)
  if cfg.show_cache and ctx.cached_pct ~= nil then
    add_segment(segments, function(seg)
      local is_initial_zero = (ctx.source == "initial")
        and (ctx.cached_pct == 0)
        and ((ctx.used_tokens or 0) == 0)
      local cache_col = is_initial_zero and colors.muted or M.cached_color(ctx.cached_pct)
      push_text(seg, colors.label, cfg.cache_label .. " ")
      push_text(seg, cache_col, format_pct(ctx.cached_pct, cfg.cache_decimals))
    end)
  end

  local disp_pct = ctx.display_used_pct ~= nil and ctx.display_used_pct or ctx.used_pct
  local disp_win = ctx.display_window_size ~= nil and ctx.display_window_size or ctx.context_window_size

  if disp_pct ~= nil then
    add_segment(segments, function(seg)
      local col = M.context_color(disp_pct)
      push_text(seg, colors.label, cfg.ctx_label .. " ")
      push_text(seg, col, format_pct(disp_pct, cfg.ctx_decimals))
      if cfg.show_ctx_bar and bar_width > 0 then
        push_text(seg, nil, " ")
        push_bar(seg, disp_pct, bar_width, col, bar_opts, colors)
      end
      if cfg.show_tokens and ctx.used_tokens ~= nil and disp_win ~= nil then
        local used_s, total_s = M.format_token_fraction(ctx.used_tokens, disp_win, cfg.token_mode)
        if used_s and total_s then
          push_text(seg, col, " " .. used_s)
          push_text(seg, colors.token_limit or colors.tokens, "/" .. total_s)
        end
      end
    end)
  end
end

--- Render WezTerm FormatItem cells for `snapshot` at pane width `cols`.
function M.render_cells(snapshot, cols, opts)
  opts = opts or M.DEFAULTS
  snapshot = snapshot or {}

  if resolve_bool_opt(opts, "only_when_agy", M.DEFAULTS.only_when_agy) and snapshot.is_agy ~= true then
    return {}
  end

  local mode = M.resolve_layout_mode(cols, opts)
  local spec = LAYOUT_SPECS[mode]
  local colors = resolve_colors(opts)
  local now = snapshot.now or os.time()

  local bar_width = spec.default_bar_width
  if spec.bar_width_key and type(opts[spec.bar_width_key]) == "number" then
    bar_width = math.max(0, math.floor(opts[spec.bar_width_key]))
  end

  local show_pool = resolve_bool_opt(opts, "show_pool", M.DEFAULTS.show_pool)
  local hide_when_empty = resolve_bool_opt(opts, "hide_when_empty", M.DEFAULTS.hide_when_empty)
  local show_context = should_show_context(snapshot, opts)
  local ctx = snapshot.context
  local segments = {}

  if show_pool then
    local pool_text, pool_color = resolve_pool_presentation(snapshot, mode, colors)
    if pool_text then
      add_segment(segments, function(seg)
        push_text(seg, pool_color, pool_text)
      end)
    end
  end

  if show_context and type(ctx) == "table" then
    add_context_segments(segments, ctx, spec, bar_width, opts, colors)
  end

  render_quota_segment(segments, spec.five_hour_label, snapshot.five_hour, bar_width, now, opts, colors)
  render_quota_segment(segments, spec.weekly_label, snapshot.weekly, bar_width, now, opts, colors)

  if #segments == 0 then
    if hide_when_empty then
      return {}
    end
    add_quota_placeholders(segments, spec.five_hour_label, spec.weekly_label, colors)
  end

  local sep = opts.separator or M.DEFAULTS.separator
  return join_segments(segments, sep, colors.separator)
end

--- Render two-line FormatItem arrays (`{ line1 = ..., line2 = ... }`) for `window:set_bottom_status`.
function M.render_bottom_lines(snapshot, cols, opts)
  opts = opts or M.DEFAULTS
  snapshot = snapshot or {}

  if resolve_bool_opt(opts, "only_when_agy", M.DEFAULTS.only_when_agy) and snapshot.is_agy ~= true then
    return { line1 = {}, line2 = {} }
  end

  local colors = resolve_colors(opts)
  local now = snapshot.now or os.time()
  local raw_cols = type(cols) == "number" and cols or (opts.default_cols or M.DEFAULTS.default_cols)
  local effective = raw_cols - (opts.cols_offset or 0)
  local compact_below = opts.bottom_compact_cols or M.DEFAULTS.bottom_compact_cols
  local is_compact
  if opts.layout == "compact" or opts.layout == "minimal" then
    is_compact = true
  elseif opts.layout == "full" then
    is_compact = false
  else
    is_compact = effective < compact_below
  end

  local bar_width
  if is_compact then
    bar_width = type(opts.bottom_compact_bar_width) == "number"
      and math.max(0, math.floor(opts.bottom_compact_bar_width))
      or M.DEFAULTS.bottom_compact_bar_width
  else
    bar_width = type(opts.bottom_bar_width) == "number"
      and math.max(0, math.floor(opts.bottom_bar_width))
      or M.DEFAULTS.bottom_bar_width
  end

  local bar_opts = {
    bar_style = opts.bar_style,
    bar_filled_char = opts.bottom_bar_filled_char or opts.bar_filled_char,
    bar_empty_char = opts.bottom_bar_empty_char or opts.bar_empty_char,
  }

  local show_pool = resolve_bool_opt(opts, "show_pool", M.DEFAULTS.show_pool)
  local hide_when_empty = resolve_bool_opt(opts, "hide_when_empty", M.DEFAULTS.hide_when_empty)
  local show_context = should_show_context(snapshot, opts)

  local cfg = is_compact and {
    show_cache = true,
    cache_label = "C",
    cache_decimals = 0,
    ctx_label = "Ctx",
    ctx_decimals = 0,
    show_ctx_bar = true,
    show_tokens = true,
    token_mode = "compact",
  } or {
    show_cache = true,
    cache_label = "Cached",
    cache_decimals = 1,
    ctx_label = "Context",
    ctx_decimals = 1,
    show_ctx_bar = true,
    show_tokens = true,
    token_mode = "full",
  }
  local five_hour_label = is_compact and "5h" or "Five Hours"
  local weekly_label = is_compact and "Wk" or "Weekly"
  local pool_mode = is_compact and "minimal" or "full"

  local line1_segments = {}
  local ctx = snapshot.context
  if show_context then
    local has_ctx = type(ctx) == "table" and (ctx.cached_pct ~= nil or ctx.display_used_pct ~= nil or ctx.used_pct ~= nil)
    if has_ctx then
      add_context_segments(line1_segments, ctx, cfg, bar_width, bar_opts, colors)
    elseif not hide_when_empty then
      add_segment(line1_segments, function(seg)
        push_text(seg, colors.label, cfg.cache_label .. " ")
        push_text(seg, colors.muted, "--")
      end)
      add_segment(line1_segments, function(seg)
        push_text(seg, colors.label, cfg.ctx_label .. " ")
        push_text(seg, colors.muted, "--")
      end)
    end
  end

  local line2_segments = {}
  local has_pool = false
  if show_pool then
    local pool_text, pool_color = resolve_pool_presentation(snapshot, pool_mode, colors)
    if pool_text then
      has_pool = true
      add_segment(line2_segments, function(seg)
        push_text(seg, pool_color, pool_text)
      end)
    end
  end

  local before_quotas = #line2_segments
  render_quota_segment(line2_segments, five_hour_label, snapshot.five_hour, bar_width, now, bar_opts, colors)
  render_quota_segment(line2_segments, weekly_label, snapshot.weekly, bar_width, now, bar_opts, colors)

  if #line2_segments == before_quotas and not hide_when_empty then
    if not has_pool or snapshot.is_agy == true then
      add_quota_placeholders(line2_segments, five_hour_label, weekly_label, colors)
    end
  end

  local sep = opts.separator or M.DEFAULTS.separator
  return {
    line1 = join_segments(line1_segments, sep, colors.separator),
    line2 = join_segments(line2_segments, sep, colors.separator),
  }
end

local function format_items(cells)
  if #cells == 0 then
    return ""
  end
  if wezterm and type(wezterm.format) == "function" then
    return wezterm.format(cells)
  end
  return M.cells_to_plain_text(cells)
end

--- Render two-line ANSI string for `window:set_bottom_status`, or `""` when empty.
function M.render_bottom_text(snapshot, cols, opts)
  local lines = M.render_bottom_lines(snapshot, cols, opts)
  if #lines.line1 == 0 and #lines.line2 == 0 then
    return ""
  end
  local pad_count = (type(opts) == "table" and type(opts.bottom_right_padding) == "number")
    and math.max(0, math.floor(opts.bottom_right_padding))
    or M.DEFAULTS.bottom_right_padding
  local pad = pad_count > 0 and string.rep(" ", pad_count) or ""
  local l1 = format_items(lines.line1)
  local l2 = format_items(lines.line2)
  if l1 ~= "" and pad ~= "" then
    l1 = l1 .. pad
  end
  if l2 ~= "" and pad ~= "" then
    l2 = l2 .. pad
  end
  return l1 .. "\n" .. l2
end

function M.cells_to_plain_text(cells)
  if type(cells) ~= "table" then
    return ""
  end
  local parts = {}
  for _, item in ipairs(cells) do
    if type(item) == "table" and type(item.Text) == "string" then
      table.insert(parts, item.Text)
    end
  end
  return table.concat(parts)
end

return M
