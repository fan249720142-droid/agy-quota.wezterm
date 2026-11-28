local wezterm = require("wezterm")

local M = {}

M.DEFAULTS = {
  cache_dir = nil,
  node_bin = nil,
  collector_script = nil,
  plugin_dir = nil,
  cache_read_ttl_secs = 1,
  poll_interval_secs = 30,
  active_poll_interval_secs = 3,
  spawn_cooldown_secs = 2,
  failed_poll_backoff_secs = 15,
  expired_reset_grace_secs = 60,
  context_limit_mode = "effective", -- "effective" (compaction ceiling) | "physical" (model max window)
  proc_cache_ttl_secs = 2,
  pane_prune_ttl_secs = 60,
  only_when_agy = true,
  hide_context_outside_agy = true,
  pool = nil,
  agy_process_names = { "agy", "agy-cli", "antigravity" },
  is_agy_matcher = nil,
  spawn_fn = nil,
  env_fn = nil,
}

local RUNTIME_WRAPPERS = {
  node = true,
  nodejs = true,
  bun = true,
  sh = true,
  bash = true,
  zsh = true,
  fish = true,
  dash = true,
  env = true,
  python = true,
  python3 = true,
}

local runtime_state = {
  quota_cache = nil, -- { path, read_at, data }
  pane_cache = {},   -- [pane_id] = { path, read_at, data }
  proc_cache = {},   -- [pane_id] = { is_agy, checked_at }
  last_prune_at = 0,
  last_spawn_at = -1e9,
  node_cache = nil,  -- { key, value, resolved_at }
  collector_cache = nil, -- { key, value, resolved_at }
}

local function trim_trailing_slash(path)
  if type(path) ~= "string" then
    return ""
  end
  if #path > 1 then
    return (path:gsub("[/\\]+$", ""))
  end
  return path
end

local function get_env(name, opts)
  local fn = (opts and opts.env_fn) or os.getenv
  local ok, val = pcall(fn, name)
  if ok and type(val) == "string" and val ~= "" then
    return val
  end
  return nil
end

local function home_dir(opts)
  local env_home = get_env("HOME", opts)
  if env_home then
    return trim_trailing_slash(env_home)
  end
  if type(wezterm.home_dir) == "string" and wezterm.home_dir ~= "" then
    return trim_trailing_slash(wezterm.home_dir)
  end
  return ""
end

function M.expand_home(path, opts)
  if type(path) ~= "string" or path == "" then
    return nil
  end
  if path == "~" then
    return home_dir(opts)
  end
  if path:sub(1, 2) == "~/" or path:sub(1, 2) == "~\\" then
    local h = home_dir(opts)
    if h ~= "" then
      return h .. "/" .. path:sub(3)
    end
  end
  return path
end

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

local function read_file(path)
  if type(path) ~= "string" or path == "" then
    return nil
  end
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local content = f:read("*a")
  f:close()
  if type(content) ~= "string" or content == "" then
    return nil
  end
  return content
end

local function read_json(path)
  local content = read_file(path)
  if not content then
    return nil
  end
  local ok, parsed = pcall(wezterm.json_parse, content)
  if ok and type(parsed) == "table" then
    return parsed
  end
  return nil
end

local function to_number(val)
  if type(val) == "number" then
    if val ~= val or val == math.huge or val == -math.huge then
      return nil
    end
    return val
  end
  return nil
end

local function clamp(val, min_v, max_v)
  if val < min_v then
    return min_v
  end
  if val > max_v then
    return max_v
  end
  return val
end

local function parse_iso8601(str)
  local y, m, d, H, M, S, rest =
    str:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)[T ](%d%d):(%d%d):(%d%d)(.*)$")
  if not y then
    return nil
  end
  local tz = rest:match("^%.%d+(.*)$") or rest
  local local_ts = os.time({
    year = tonumber(y),
    month = tonumber(m),
    day = tonumber(d),
    hour = tonumber(H),
    min = tonumber(M),
    sec = tonumber(S),
    isdst = false,
  })
  if not local_ts then
    return nil
  end
  local utc_dt = os.date("!*t", local_ts)
  local utc_as_local = os.time({
    year = utc_dt.year,
    month = utc_dt.month,
    day = utc_dt.day,
    hour = utc_dt.hour,
    min = utc_dt.min,
    sec = utc_dt.sec,
    isdst = false,
  })
  local local_offset = local_ts - utc_as_local
  local target_offset = 0
  if tz ~= "" and tz ~= "Z" and tz ~= "z" then
    local sign, oh, om = tz:match("^([+-])(%d%d):?(%d%d)$")
    if not sign then
      return nil
    end
    target_offset = (tonumber(oh) * 3600 + tonumber(om) * 60) * (sign == "-" and -1 or 1)
  end
  return local_ts + local_offset - target_offset
end

--- Parse epoch seconds from seconds, milliseconds (>1e12), or ISO-8601 strings.
function M.parse_epoch(val)
  if type(val) == "number" then
    local num = to_number(val)
    if not num then
      return nil
    end
    if num > 1e12 then
      return num / 1000
    end
    return num
  end
  if type(val) == "string" and val ~= "" then
    local num = tonumber(val)
    if num then
      return M.parse_epoch(num)
    end
    return parse_iso8601(val)
  end
  return nil
end

function M.merge_opts(opts)
  local merged = {}
  for k, v in pairs(M.DEFAULTS) do
    merged[k] = v
  end
  if type(opts) == "table" then
    for k, v in pairs(opts) do
      merged[k] = v
    end
    if opts.show_context_outside_agy ~= nil then
      merged.hide_context_outside_agy = not opts.show_context_outside_agy
    end
  end
  return merged
end

function M.resolve_cache_dir(opts)
  opts = opts or M.DEFAULTS
  if type(opts.cache_dir) == "string" and opts.cache_dir ~= "" then
    return trim_trailing_slash(M.expand_home(opts.cache_dir, opts))
  end
  local env_dir = get_env("WEZTERM_AGY_STATUS_DIR", opts)
  if env_dir then
    return trim_trailing_slash(M.expand_home(env_dir, opts))
  end
  local xdg = get_env("XDG_CACHE_HOME", opts)
  if xdg then
    return trim_trailing_slash(M.expand_home(xdg, opts)) .. "/wezterm-agy-status"
  end
  local h = home_dir(opts)
  if h ~= "" then
    return h .. "/.cache/wezterm-agy-status"
  end
  return ".cache/wezterm-agy-status"
end

function M.resolve_node_bin(opts, now)
  opts = opts or M.DEFAULTS
  now = now or os.time()
  if type(opts.node_bin) == "string" and opts.node_bin ~= "" then
    return M.expand_home(opts.node_bin, opts)
  end
  local h = home_dir(opts)
  local cache_key = h
  local cached = runtime_state.node_cache
  if cached and cached.key == cache_key and (now - cached.resolved_at) < 60 then
    return cached.value
  end
  local candidates = {}
  if h ~= "" then
    table.insert(candidates, h .. "/.local/bin/node")
  end
  table.insert(candidates, "/usr/local/bin/node")
  table.insert(candidates, "/usr/bin/node")

  local resolved = "node"
  for _, candidate in ipairs(candidates) do
    if file_exists(candidate) then
      resolved = candidate
      break
    end
  end
  runtime_state.node_cache = {
    key = cache_key,
    value = resolved,
    resolved_at = now,
  }
  return resolved
end

local function plugin_collector_from_dir(dir)
  if type(dir) ~= "string" or dir == "" then
    return nil
  end
  local clean = trim_trailing_slash(dir)
  local root = clean:match("^(.*)[/\\]plugin$")
  if root and root ~= "" then
    return root .. "/bin/agy-status-collector.mjs"
  end
  return clean .. "/../bin/agy-status-collector.mjs"
end

function M.resolve_collector_script(opts, now)
  opts = opts or M.DEFAULTS
  now = now or os.time()
  if type(opts.collector_script) == "string" and opts.collector_script ~= "" then
    return M.expand_home(opts.collector_script, opts), true
  end

  local h = home_dir(opts)
  local pdir = type(opts.plugin_dir) == "string" and opts.plugin_dir or ""
  local cache_key = pdir .. "|" .. h
  local cached = runtime_state.collector_cache
  if cached and cached.key == cache_key then
    local ttl = cached.value and 60 or 10
    if (now - cached.resolved_at) < ttl then
      return cached.value, false
    end
  end

  local candidates = {}
  local from_pdir = plugin_collector_from_dir(pdir)
  if from_pdir then
    table.insert(candidates, from_pdir)
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
          table.insert(candidates, trim_trailing_slash(entry.plugin_dir) .. "/bin/agy-status-collector.mjs")
        end
      end
    end
  end

  if h ~= "" then
    table.insert(candidates, h .. "/agy-quota.wezterm/bin/agy-status-collector.mjs")
  end

  local found = nil
  for _, candidate in ipairs(candidates) do
    if file_exists(candidate) then
      found = candidate
      break
    end
  end

  runtime_state.collector_cache = {
    key = cache_key,
    value = found,
    resolved_at = now,
  }
  return found, false
end

local function path_basename(path)
  if type(path) ~= "string" or path == "" then
    return ""
  end
  local base = path:match("([^/\\]+)$") or path
  return base:lower()
end

local function build_agy_name_set(opts)
  local names = (opts and opts.agy_process_names) or M.DEFAULTS.agy_process_names
  local set = {}
  for _, name in ipairs(names) do
    if type(name) == "string" and name ~= "" then
      set[name:lower()] = true
    end
  end
  return set
end

local function is_excluded_script(arg)
  return type(arg) == "string" and arg:lower():find("agy%-status%-collector", 1, false) ~= nil
end

local function matches_agy_name_or_arg(raw, agy_set)
  if type(raw) ~= "string" or raw == "" or is_excluded_script(raw) then
    return false
  end
  local base = path_basename(raw)
  if agy_set[base] then
    return true
  end
  local no_ext = base:gsub("%.[cm]?js$", ""):gsub("%.ts$", "")
  if no_ext ~= base and agy_set[no_ext] then
    return true
  end
  return false
end

local function proc_tree_matches_agy(info, agy_set, visited, depth)
  if type(info) ~= "table" or depth > 16 or visited[info] then
    return false, nil
  end
  visited[info] = true

  local node_pid = type(info.pid) == "number" and info.pid or nil

  if matches_agy_name_or_arg(info.name, agy_set) or matches_agy_name_or_arg(info.executable, agy_set) then
    return true, node_pid
  end

  local base_name = path_basename(info.name or "")
  local base_exec = path_basename(info.executable or "")
  local check_argv = RUNTIME_WRAPPERS[base_name] or RUNTIME_WRAPPERS[base_exec]
  if check_argv and type(info.argv) == "table" then
    local limit = math.min(#info.argv, 6)
    for i = 1, limit do
      local arg = info.argv[i]
      if type(arg) == "string" and not is_excluded_script(arg) then
        if matches_agy_name_or_arg(arg, agy_set) then
          return true, node_pid
        end
      end
    end
  end

  if type(info.children) == "table" then
    for _, child in pairs(info.children) do
      local matched, child_pid = proc_tree_matches_agy(child, agy_set, visited, depth + 1)
      if matched then
        return true, child_pid
      end
    end
  end

  return false, nil
end

local function prune_stale_panes(now, ttl)
  if (now - runtime_state.last_prune_at) < 30 then
    return
  end
  runtime_state.last_prune_at = now
  for pid, entry in pairs(runtime_state.proc_cache) do
    if (now - entry.checked_at) > ttl then
      runtime_state.proc_cache[pid] = nil
    end
  end
  for pid, entry in pairs(runtime_state.pane_cache) do
    if (now - entry.read_at) > ttl then
      runtime_state.pane_cache[pid] = nil
    end
  end
end

function M.get_pane_id(pane)
  if pane == nil then
    return nil
  end
  local ok, pid = pcall(function()
    if type(pane.pane_id) == "function" then
      return pane:pane_id()
    end
    return pane.pane_id
  end)
  if ok and pid ~= nil then
    return pid
  end
  return nil
end

function M.get_pane_cwd(pane)
  if pane == nil then
    return ""
  end
  local ok, cwd_uri = pcall(function()
    if type(pane.get_current_working_dir) == "function" then
      return pane:get_current_working_dir()
    end
    return nil
  end)
  if not ok or cwd_uri == nil then
    return ""
  end
  if type(cwd_uri) == "string" then
    local path = cwd_uri:match("^file://[^/]*(/.*)$")
    return path or cwd_uri
  end
  local ok_fp, fp = pcall(function()
    return cwd_uri.file_path
  end)
  if ok_fp and type(fp) == "string" then
    return fp
  end
  return ""
end

--- Read TTY device path of `pane` if supported by WezTerm.
function M.get_pane_tty(pane)
  if pane == nil then
    return nil
  end
  local ok, tty = pcall(function()
    if type(pane.get_tty_name) == "function" then
      return pane:get_tty_name()
    end
    return nil
  end)
  if ok and type(tty) == "string" and tty ~= "" then
    return tty
  end
  return nil
end

--- Detect whether the foreground process tree of `pane` is running `agy`, returning `(is_agy, agy_pid)`.
function M.detect_is_agy(pane, opts, now)
  opts = opts or M.DEFAULTS
  now = now or os.time()
  if pane == nil then
    return false, nil
  end

  local pane_id = M.get_pane_id(pane)
  local ttl = opts.proc_cache_ttl_secs or 2
  prune_stale_panes(now, opts.pane_prune_ttl_secs or 60)

  if pane_id ~= nil then
    local cached = runtime_state.proc_cache[pane_id]
    if cached and (now - cached.checked_at) < ttl then
      return cached.is_agy, cached.agy_pid
    end
  end

  local ok_info, proc_info = pcall(function()
    if type(pane.get_foreground_process_info) == "function" then
      return pane:get_foreground_process_info()
    end
    return nil
  end)
  if not ok_info then
    proc_info = nil
  end

  local is_agy = false
  local matched_pid = nil
  if type(opts.is_agy_matcher) == "function" then
    local ok_m, matched = pcall(opts.is_agy_matcher, pane, proc_info)
    if ok_m then
      is_agy = not not matched
    end
  else
    local agy_set = build_agy_name_set(opts)
    if type(proc_info) == "table" then
      is_agy, matched_pid = proc_tree_matches_agy(proc_info, agy_set, {}, 1)
    end
    if not is_agy then
      local ok_name, proc_name = pcall(function()
        if type(pane.get_foreground_process_name) == "function" then
          return pane:get_foreground_process_name()
        end
        return nil
      end)
      if ok_name and type(proc_name) == "string" then
        is_agy = matches_agy_name_or_arg(proc_name, agy_set)
      end
    end
  end

  local agy_pid = is_agy and matched_pid or nil
  if pane_id ~= nil then
    runtime_state.proc_cache[pane_id] = {
      is_agy = is_agy,
      agy_pid = agy_pid,
      checked_at = now,
    }
  end
  return is_agy, agy_pid
end

--- Return the cached or detected `agy` process PID in `pane`, or `nil` if inactive/unavailable.
function M.get_agy_pid(pane, opts, now)
  local is_agy, agy_pid = M.detect_is_agy(pane, opts, now)
  if not is_agy then
    return nil
  end
  return agy_pid
end

local function read_quota_cached(cache_dir, opts, now, force)
  local path = cache_dir .. "/quota.json"
  local ttl = opts.cache_read_ttl_secs or 1
  local cached = runtime_state.quota_cache
  if not force and cached and cached.path == path and (now - cached.read_at) < ttl then
    return cached.data
  end
  local data = read_json(path)
  runtime_state.quota_cache = {
    path = path,
    read_at = now,
    data = data,
  }
  return data
end

local function read_pane_cached(cache_dir, pane_id, opts, now, force)
  if pane_id == nil then
    return nil
  end
  local path = cache_dir .. "/panes/pane_" .. tostring(pane_id) .. ".json"
  local ttl = opts.cache_read_ttl_secs or 1
  local cached = runtime_state.pane_cache[pane_id]
  if not force and cached and cached.path == path and (now - cached.read_at) < ttl then
    return cached.data
  end
  local data = read_json(path)
  runtime_state.pane_cache[pane_id] = {
    path = path,
    read_at = now,
    data = data,
  }
  return data
end

local function normalize_model_key(str)
  if type(str) ~= "string" then
    return ""
  end
  return (str:lower():gsub("[^%w]", ""))
end

local function match_model_pool(model_id, model_pools, pools)
  if type(model_id) ~= "string" or model_id == "" or type(pools) ~= "table" then
    return nil
  end
  if type(model_pools) == "table" then
    local exact = model_pools[model_id]
    if type(exact) == "string" and type(pools[exact]) == "table" then
      return exact
    end
    local lower_id = model_id:lower()
    local norm_id = normalize_model_key(model_id)
    local best_key_len = -1
    local best_pool = nil
    for k, pool_name in pairs(model_pools) do
      if type(k) == "string" and type(pool_name) == "string" and type(pools[pool_name]) == "table" then
        local lk = k:lower()
        local nk = normalize_model_key(k)
        if lk == lower_id or (norm_id ~= "" and nk == norm_id) then
          return pool_name
        end
        if lower_id:find(lk, 1, true) and #lk > best_key_len then
          best_key_len = #lk
          best_pool = pool_name
        elseif norm_id ~= "" and nk ~= "" and norm_id:find(nk, 1, true) and #nk > best_key_len then
          best_key_len = #nk
          best_pool = pool_name
        end
      end
    end
    if best_pool then
      return best_pool
    end
  end
  local lower_id = model_id:lower()
  local keys = {}
  for k, v in pairs(pools) do
    if type(k) == "string" and type(v) == "table" then
      table.insert(keys, k)
    end
  end
  table.sort(keys)
  for _, k in ipairs(keys) do
    if lower_id:find(k:lower(), 1, true) then
      return k
    end
  end
  return nil
end

--- Choose the active quota pool using explicit override, pane data, model map, and default pool.
function M.resolve_pool(quota_data, pane_data, opts)
  if type(quota_data) ~= "table" or type(quota_data.pools) ~= "table" then
    local fallback_key = (opts and type(opts.pool) == "string" and opts.pool ~= "" and opts.pool)
      or (type(pane_data) == "table" and type(pane_data.pool) == "string" and pane_data.pool ~= "" and pane_data.pool)
      or nil
    return fallback_key, nil
  end
  local pools = quota_data.pools
  local function valid_pool(key)
    return type(key) == "string" and key ~= "" and type(pools[key]) == "table"
  end

  if opts and valid_pool(opts.pool) then
    return opts.pool, pools[opts.pool]
  end
  if type(pane_data) == "table" and valid_pool(pane_data.pool) then
    return pane_data.pool, pools[pane_data.pool]
  end
  if type(pane_data) == "table" then
    local mapped = match_model_pool(pane_data.model_id, quota_data.model_pools, pools)
      or match_model_pool(pane_data.model_display_name, quota_data.model_pools, pools)
    if valid_pool(mapped) then
      return mapped, pools[mapped]
    end
  end
  if valid_pool(quota_data.default_pool) then
    return quota_data.default_pool, pools[quota_data.default_pool]
  end

  local keys = {}
  for k, v in pairs(pools) do
    if type(k) == "string" and type(v) == "table" then
      table.insert(keys, k)
    end
  end
  table.sort(keys)
  local first = keys[1]
  if first then
    return first, pools[first]
  end
  return nil, nil
end

local function normalize_window(win, now, grace_secs)
  if type(win) ~= "table" then
    return nil
  end
  local reset_time = type(win.reset_time) == "string" and win.reset_time or nil
  local reset_epoch = M.parse_epoch(win.reset_epoch) or M.parse_epoch(reset_time)
  if type(reset_epoch) == "number" and reset_epoch <= 0 then
    reset_epoch = nil
    reset_time = nil
  end
  local remaining_pct = to_number(win.remaining_pct)
  if remaining_pct then
    remaining_pct = clamp(remaining_pct, 0, 100)
  end

  local grace = type(grace_secs) == "number" and grace_secs or 60
  if type(now) == "number" and type(reset_epoch) == "number" and reset_epoch > 0 and grace >= 0 then
    if (reset_epoch + grace) <= now then
      return {
        remaining_pct = 100,
        reset_time = nil,
        reset_epoch = nil,
        expired_reset = true,
      }
    end
  end

  return {
    remaining_pct = remaining_pct,
    reset_time = reset_time,
    reset_epoch = reset_epoch,
  }
end

local function normalize_context(pane_data, opts)
  local ctx = type(pane_data) == "table" and type(pane_data.context) == "table" and pane_data.context or nil
  if not ctx then
    return nil
  end
  local used_tokens = to_number(ctx.used_tokens)
  local window_size = to_number(ctx.context_window_size)
  local effective_limit = to_number(ctx.effective_context_limit)
  local used_pct = to_number(ctx.used_pct)
  local remaining_pct = to_number(ctx.remaining_pct)
  local effective_used_pct = to_number(ctx.effective_used_pct)
  local effective_remaining_pct = to_number(ctx.effective_remaining_pct)
  local cached_pct = to_number(ctx.cached_pct)

  if used_pct == nil and used_tokens ~= nil and window_size ~= nil and window_size > 0 then
    used_pct = (used_tokens / window_size) * 100
  end
  if used_pct == nil and remaining_pct ~= nil then
    used_pct = 100 - remaining_pct
  end
  if used_pct ~= nil then
    used_pct = clamp(used_pct, 0, 100)
  end
  if remaining_pct == nil and used_pct ~= nil then
    remaining_pct = clamp(100 - used_pct, 0, 100)
  elseif remaining_pct ~= nil then
    remaining_pct = clamp(remaining_pct, 0, 100)
  end

  if effective_used_pct == nil and used_tokens ~= nil and effective_limit ~= nil and effective_limit > 0 then
    effective_used_pct = clamp((used_tokens / effective_limit) * 100, 0, 100)
  elseif effective_used_pct ~= nil then
    effective_used_pct = clamp(effective_used_pct, 0, 100)
  end
  if effective_remaining_pct == nil and effective_used_pct ~= nil then
    effective_remaining_pct = clamp(100 - effective_used_pct, 0, 100)
  elseif effective_remaining_pct ~= nil then
    effective_remaining_pct = clamp(effective_remaining_pct, 0, 100)
  end

  if cached_pct ~= nil then
    cached_pct = clamp(cached_pct, 0, 100)
  end

  local limit_mode = (type(opts) == "table" and type(opts.context_limit_mode) == "string" and opts.context_limit_mode)
    or M.DEFAULTS.context_limit_mode
  local use_effective = (limit_mode ~= "physical") and (effective_limit ~= nil and effective_limit > 0)
  local display_window_size = use_effective and effective_limit or window_size
  local display_used_pct = use_effective and (effective_used_pct or used_pct) or used_pct
  local display_remaining_pct = use_effective and (effective_remaining_pct or remaining_pct) or remaining_pct

  return {
    used_tokens = used_tokens,
    context_window_size = window_size,
    effective_context_limit = effective_limit,
    used_pct = used_pct,
    remaining_pct = remaining_pct,
    effective_used_pct = effective_used_pct,
    effective_remaining_pct = effective_remaining_pct,
    display_window_size = display_window_size,
    display_used_pct = display_used_pct,
    display_remaining_pct = display_remaining_pct,
    cached_pct = cached_pct,
    input_tokens = to_number(ctx.input_tokens),
    output_tokens = to_number(ctx.output_tokens),
    cache_read_tokens = to_number(ctx.cache_read_tokens),
    cache_creation_tokens = to_number(ctx.cache_creation_tokens),
    source = type(ctx.source) == "string" and ctx.source or nil,
  }
end

function M.spawn_refresh(pane_id, cwd, opts, now, force, extra)
  opts = opts or M.DEFAULTS
  now = now or os.time()

  local cooldown = force and 0 or math.max(2, opts.spawn_cooldown_secs or 2)
  if (now - runtime_state.last_spawn_at) < cooldown then
    return false
  end

  local collector, is_explicit = M.resolve_collector_script(opts, now)
  if not collector or collector == "" then
    return false
  end
  local use_custom_spawner = type(opts.spawn_fn) == "function"
  if not use_custom_spawner and not file_exists(collector) then
    return false
  end

  local node_bin = M.resolve_node_bin(opts, now)
  local argv = { node_bin, collector, "--refresh" }
  if pane_id ~= nil then
    table.insert(argv, "--pane")
    table.insert(argv, tostring(pane_id))
  end
  if type(cwd) == "string" and cwd ~= "" then
    table.insert(argv, "--cwd")
    table.insert(argv, cwd)
  end
  if type(extra) == "table" then
    if extra.agy_pid ~= nil then
      table.insert(argv, "--agy-pid")
      table.insert(argv, tostring(extra.agy_pid))
    end
    if type(extra.tty) == "string" and extra.tty ~= "" then
      table.insert(argv, "--tty")
      table.insert(argv, extra.tty)
    end
  end

  runtime_state.last_spawn_at = now
  local spawner = use_custom_spawner and opts.spawn_fn or wezterm.background_child_process
  local ok = pcall(spawner, argv)
  return ok
end

--- Read throttled cache files, check staleness, trigger async refresh if needed, and return snapshot.
function M.get_snapshot(pane, opts, now, force)
  opts = M.merge_opts(opts)
  now = now or os.time()

  local cache_dir = M.resolve_cache_dir(opts)
  local pane_id = M.get_pane_id(pane)
  local cwd = M.get_pane_cwd(pane)
  local is_agy, agy_pid = M.detect_is_agy(pane, opts, now)
  local tty = M.get_pane_tty(pane)

  local quota_data = read_quota_cached(cache_dir, opts, now, force)
  local pane_data = read_pane_cached(cache_dir, pane_id, opts, now, force)

  local pid_changed = false
  if is_agy and agy_pid ~= nil and type(pane_data) == "table" and pane_data.agy_pid ~= nil then
    if tonumber(pane_data.agy_pid) ~= tonumber(agy_pid) then
      pid_changed = true
      if pane_id ~= nil then
        runtime_state.pane_cache[pane_id] = nil
      end
    end
  end

  local quota_ts = quota_data and M.parse_epoch(quota_data.fetched_at) or nil
  local quota_attempt_ts = quota_data and M.parse_epoch(quota_data.last_poll_attempt_at) or nil
  local poll_interval = opts.poll_interval_secs or 30
  local failed_backoff = opts.failed_poll_backoff_secs or 15
  local quota_stale = (quota_data == nil) or (quota_ts == nil) or ((now - quota_ts) >= poll_interval)
  local quota_attempt_recent = (quota_attempt_ts ~= nil) and ((now - quota_attempt_ts) < failed_backoff)

  local pane_ts = pane_data and M.parse_epoch(pane_data.updated_at) or nil
  local active_interval = opts.active_poll_interval_secs or 3
  local pane_stale = false
  if is_agy and pane_id ~= nil then
    pane_stale = pid_changed or (pane_data == nil) or (pane_ts == nil) or ((now - pane_ts) >= active_interval)
  end

  local should_spawn_for_quota = quota_stale and (not quota_attempt_recent)
  local allow_spawn = (force == true) or (is_agy == true) or (opts.only_when_agy == false)
  if allow_spawn and (force or should_spawn_for_quota or pane_stale) then
    M.spawn_refresh(pane_id, cwd, opts, now, force or pid_changed, { agy_pid = agy_pid, tty = tty })
  end

  local grace_secs = opts.expired_reset_grace_secs
  if grace_secs == nil then
    grace_secs = M.DEFAULTS.expired_reset_grace_secs
  end
  local pool_key, pool_data = M.resolve_pool(quota_data, pane_data, opts)
  local pane_pool_label = type(pane_data) == "table"
    and (pane_data.pool == nil or pane_data.pool == pool_key)
    and type(pane_data.pool_label) == "string"
    and pane_data.pool_label ~= ""
    and pane_data.pool_label
    or nil
  local data_pool_label = pool_data
    and type(pool_data.label) == "string"
    and pool_data.label ~= ""
    and pool_data.label
    or nil
  local pool_label = pane_pool_label or data_pool_label or pool_key

  return {
    now = now,
    cache_dir = cache_dir,
    pane_id = pane_id,
    cwd = cwd,
    is_agy = is_agy,
    agy_pid = pane_data and pane_data.agy_pid or agy_pid,
    conversation_id = pane_data and pane_data.conversation_id or nil,
    has_quota = (quota_data ~= nil),
    has_pane = (pane_data ~= nil),
    quota_stale = quota_stale,
    pane_stale = pane_stale,
    fetched_at = quota_ts,
    updated_at = pane_ts,
    source = quota_data and quota_data.source or nil,
    plan_tier = quota_data and quota_data.plan_tier or nil,
    pool_key = pool_key,
    pool_label = pool_label,
    model_id = pane_data and pane_data.model_id or nil,
    model_display_name = pane_data and pane_data.model_display_name or nil,
    agent_state = pane_data and pane_data.agent_state or nil,
    five_hour = pool_data and normalize_window(pool_data.five_hour, now, grace_secs) or nil,
    weekly = pool_data and normalize_window(pool_data.weekly, now, grace_secs) or nil,
    context = normalize_context(pane_data, opts),
    raw_quota = quota_data,
    raw_pane = pane_data,
  }
end

function M.trigger_refresh(pane, opts, now)
  opts = M.merge_opts(opts)
  now = now or os.time()
  local pane_id = M.get_pane_id(pane)
  local cwd = M.get_pane_cwd(pane)
  local agy_pid = M.get_agy_pid(pane, opts, now)
  local tty = M.get_pane_tty(pane)
  runtime_state.quota_cache = nil
  if pane_id ~= nil then
    runtime_state.pane_cache[pane_id] = nil
  end
  return M.spawn_refresh(pane_id, cwd, opts, now, true, { agy_pid = agy_pid, tty = tty })
end

function M.reset()
  runtime_state.quota_cache = nil
  runtime_state.pane_cache = {}
  runtime_state.proc_cache = {}
  runtime_state.last_prune_at = 0
  runtime_state.last_spawn_at = -1e9
  runtime_state.node_cache = nil
  runtime_state.collector_cache = nil
end

return M
