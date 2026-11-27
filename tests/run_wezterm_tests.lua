local wezterm = require("wezterm")

local function file_exists(path)
  local f = io.open(path, "r")
  if f then
    f:close()
    return true
  end
  return false
end

local function detect_repo_root()
  if type(debug) == "table" and type(debug.getinfo) == "function" then
    local info = debug.getinfo(1, "S")
    if info and type(info.source) == "string" and info.source:sub(1, 1) == "@" then
      local tdir = info.source:sub(2):match("^(.*)[/\\][^/\\]+$") or "."
      local root = tdir:match("^(.*)[/\\]tests$") or (tdir .. "/..")
      if file_exists(root .. "/plugin/init.lua") then
        return root
      end
    end
  end
  if type(wezterm.config_dir) == "string" and wezterm.config_dir ~= "" then
    local cdir = wezterm.config_dir:gsub("[/\\]+$", "")
    if file_exists(cdir .. "/plugin/init.lua") then
      return cdir
    end
    local parent = cdir:match("^(.*)[/\\]tests$")
    if parent and file_exists(parent .. "/plugin/init.lua") then
      return parent
    end
  end
  if file_exists("plugin/init.lua") then
    return "."
  end
  if file_exists("../plugin/init.lua") then
    return ".."
  end
  error("Unable to locate repo root containing plugin/init.lua")
end

local REPO_ROOT = detect_repo_root()

local passed = 0
local failed = 0
local function test(name, fn)
  local ok, err = xpcall(fn, function(e)
    if type(debug) == "table" and type(debug.traceback) == "function" then
      return debug.traceback(e, 2)
    end
    return tostring(e)
  end)
  if ok then
    passed = passed + 1
    io.stderr:write(string.format("[PASS] %s\n", name))
  else
    failed = failed + 1
    io.stderr:write(string.format("[FAIL] %s: %s\n", name, tostring(err)))
  end
end

local function assert_eq(actual, expected, msg)
  if actual ~= expected then
    error(
      string.format(
        "%s: expected %s (%s), got %s (%s)",
        msg or "assert_eq failed",
        tostring(expected),
        type(expected),
        tostring(actual),
        type(actual)
      ),
      2
    )
  end
end

local function assert_true(cond, msg)
  if not cond then
    error(msg or "assert_true failed", 2)
  end
end

local function make_temp_dir()
  local dir = string.format("/tmp/agy-quota-wezterm-test-%d-%d", os.time(), math.random(100000, 999999))
  assert_true(os.execute('mkdir -p "' .. dir .. '/panes"'), "failed to create temp dir")
  return dir
end

local function remove_dir(dir)
  os.execute('rm -rf "' .. dir .. '"')
end

local function write_file(path, content)
  local f, err = io.open(path, "w")
  assert_true(f ~= nil, "failed to write " .. path .. ": " .. tostring(err))
  f:write(content)
  f:close()
end

local function make_mock_pane(opts)
  opts = opts or {}
  local pane = {}
  function pane:pane_id()
    return opts.id or 0
  end
  function pane:get_dimensions()
    return { cols = opts.cols or 105, rows = opts.rows or 25 }
  end
  function pane:get_current_working_dir()
    if opts.cwd == nil then
      return nil
    end
    return { file_path = opts.cwd }
  end
  function pane:get_foreground_process_info()
    return opts.proc_info
  end
  function pane:get_foreground_process_name()
    return opts.proc_name
  end
  function pane:get_tty_name()
    return opts.tty_name
  end
  return pane
end

local function make_mock_window(id, active_pane, tab_cols)
  local win = { _last_right_status = nil }
  function win:window_id()
    return id or 1
  end
  function win:active_pane()
    return active_pane
  end
  function win:active_tab()
    if tab_cols == nil then
      return nil
    end
    return {
      get_size = function()
        return { cols = tab_cols, rows = 25 }
      end,
    }
  end
  function win:set_right_status(s)
    self._last_right_status = s
  end
  return win
end

local function make_mock_bottom_window(id, active_pane, tab_cols)
  local win = make_mock_window(id, active_pane, tab_cols)
  win._last_bottom_status = nil
  function win:set_bottom_status(s)
    self._last_bottom_status = s
  end
  return win
end

-- Load plugin via dofile and verify require compatibility
local plugin = dofile(REPO_ROOT .. "/plugin/init.lua")
local render = plugin.render
local state = plugin.state

test("module loading via dofile and package.path require", function()
  assert_eq(type(plugin.apply_to_config), "function", "apply_to_config")
  assert_eq(type(plugin.setup), "function", "setup")
  assert_eq(type(plugin.get_status_cells), "function", "get_status_cells")
  assert_eq(type(plugin.get_status_text), "function", "get_status_text")
  assert_eq(type(plugin.get_snapshot), "function", "get_snapshot")
  assert_eq(type(plugin.trigger_refresh), "function", "trigger_refresh")
  assert_eq(type(plugin.cycle_layout), "function", "cycle_layout")

  local saved_path = package.path
  package.path = REPO_ROOT .. "/?.lua;" .. saved_path
  package.loaded["plugin.init"] = nil
  local req_plugin = require("plugin.init")
  assert_eq(type(req_plugin.get_status_cells), "function", "require(plugin.init)")

  -- Also verify loading as `require("init")` via `<plugin_dir>/plugin/?.lua` (how wezterm.plugin.require loads plugins)
  package.path = REPO_ROOT .. "/plugin/?.lua;" .. saved_path
  package.loaded["init"] = nil
  package.loaded["agy_quota.state"] = nil
  package.loaded["agy_quota.render"] = nil
  local init_plugin = require("init")
  package.path = saved_path
  assert_eq(type(init_plugin.apply_to_config), "function", "require(init) via plugin/?.lua")
  assert_true(type(init_plugin.plugin_dir) == "string" and init_plugin.plugin_dir ~= "", "plugin_dir detected")
end)

test("3-stop continuous RGB gradient interpolation", function()
  assert_eq(render.gradient_color(0), "#ff5555", "0% red")
  assert_eq(render.gradient_color(50), "#ffd427", "50% yellow")
  assert_eq(render.gradient_color(100), "#5cdb6d", "100% green")
  assert_eq(render.gradient_color(-15), "#ff5555", "clamped <0")
  assert_eq(render.gradient_color(120), "#5cdb6d", "clamped >100")
  assert_eq(render.gradient_color(25), "#ff953e", "25% orange midpoint")
  assert_eq(render.gradient_color(75), "#aed84a", "75% yellow-green midpoint")

  -- Cached percentage mapping: clamp((pct - 80) / 20 * 100, 0, 100)
  assert_eq(render.cached_color(100), "#5cdb6d", "cached 100%")
  assert_eq(render.cached_color(90), "#ffd427", "cached 90%")
  assert_eq(render.cached_color(80), "#ff5555", "cached 80%")
  assert_eq(render.cached_color(45), "#ff5555", "cached <=80%")

  -- Context color uses remaining % (100 - used_pct)
  assert_eq(render.context_color(0), "#5cdb6d", "context 0% used -> green")
  assert_eq(render.context_color(50), "#ffd427", "context 50% used -> yellow")
  assert_eq(render.context_color(100), "#ff5555", "context 100% used -> red")

  -- Quota color uses remaining %
  assert_eq(render.quota_color(100), "#5cdb6d", "quota 100%")
  assert_eq(render.quota_color(50), "#ffd427", "quota 50%")
  assert_eq(render.quota_color(0), "#ff5555", "quota 0%")
end)

test("dynamic countdown formatting", function()
  local now = 1730000000
  assert_eq(render.format_countdown(now - 5, now), "now", "past epoch")
  assert_eq(render.format_countdown(now, now), "now", "exact epoch")
  assert_eq(render.format_countdown(now + 1, now), "<1m", "1s")
  assert_eq(render.format_countdown(now + 59, now), "<1m", "59s")
  assert_eq(render.format_countdown(now + 60, now), "1m", "60s")
  assert_eq(render.format_countdown(now + 3599, now), "59m", "59m59s")
  assert_eq(render.format_countdown(now + 4860, now), "1h21m", "1h21m")
  assert_eq(render.format_countdown(now + 590400, now), "6d20h", "6d20h")
  assert_eq(render.format_countdown(nil, now), nil, "nil epoch")
end)

test("token formatting in full and compact modes", function()
  assert_eq(render.format_tokens(376200, "full"), "376.2k", "full k")
  assert_eq(render.format_tokens(376200, "compact"), "376k", "compact k")
  assert_eq(render.format_tokens(1000000, "full"), "1.0M", "full M")
  assert_eq(render.format_tokens(1048576, "compact"), "1.0M", "compact M")
  assert_eq(render.format_tokens(740, "full"), "740", "under 1k")
end)

test("responsive full / compact / minimal rendering and colors", function()
  local now = 1730000000
  local snap = {
    now = now,
    is_agy = true,
    has_quota = true,
    has_pane = true,
    pool_key = "gemini",
    pool_label = "Gemini",
    context = {
      cached_pct = 99.1,
      used_pct = 35.9,
      used_tokens = 376200,
      context_window_size = 1000000,
    },
    five_hour = {
      remaining_pct = 49,
      reset_epoch = now + 4860, -- 1h21m
    },
    weekly = {
      remaining_pct = 86,
      reset_epoch = now + 590400, -- 6d20h
    },
  }

  local function has_fg_color(cells, color)
    for i = 1, #cells do
      local item = cells[i]
      if item.Foreground and item.Foreground.Color == color then
        return true
      end
    end
    return false
  end

  local full_cells = render.render_cells(snap, 160, { layout = "auto" })
  local full_text = render.cells_to_plain_text(full_cells)
  assert_eq(
    full_text,
    "Gemini │ Cached 99.1% │ Context 35.9% ███░░░░░ 376.2k/1.0M │ Five Hours 49% ████░░░░ 1h21m │ Weekly 86% ███████░ 6d20h",
    "full layout text"
  )
  assert_eq(
    render.cells_to_plain_text(render.render_cells(snap, 140, { layout = "auto" })),
    full_text,
    "full layout threshold at 140 cols"
  )

  -- Verify countdown color #57caff, bar empty color #3b4052, and gemini pool color #89b4fa
  assert_true(has_fg_color(full_cells, "#57caff"), "countdown uses #57caff")
  assert_true(has_fg_color(full_cells, "#3b4052"), "empty bar uses #3b4052")
  assert_true(has_fg_color(full_cells, "#89b4fa"), "gemini pool uses #89b4fa")

  local compact_cells = render.render_cells(snap, 105, { layout = "auto" })
  local compact_text = render.cells_to_plain_text(compact_cells)
  assert_eq(
    compact_text,
    "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
    "compact layout text at 105 cols"
  )

  local minimal_cells = render.render_cells(snap, 80, { layout = "auto" })
  assert_eq(
    render.cells_to_plain_text(minimal_cells),
    "Gem │ Ctx 36% │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
    "minimal layout text at 80 cols keeps 5h/Wk progress bars"
  )

  -- 3p / Claude & GPT pool rendering, short label in minimal, and pool color overrides/fallback
  local snap_3p = {
    now = now,
    is_agy = true,
    has_quota = true,
    has_pane = true,
    pool_key = "3p",
    pool_label = "Claude & GPT",
    context = {
      cached_pct = 97.6,
      used_pct = 37.7,
      used_tokens = 395400,
      context_window_size = 1000000,
    },
    five_hour = {
      remaining_pct = 59,
      reset_epoch = now + 13980, -- 3h53m
    },
    weekly = {
      remaining_pct = 86,
      reset_epoch = now + 518400, -- 6d0h
    },
  }
  local compact_3p = render.render_cells(snap_3p, 105, { layout = "auto" })
  assert_eq(
    render.cells_to_plain_text(compact_3p),
    "Claude/GPT │ C 98% │ Ctx 37.7% ██░░ 395k/1.0M │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h",
    "3p compact layout text"
  )
  assert_true(has_fg_color(compact_3p, "#d4bdf5"), "3p pool uses #d4bdf5")

  local minimal_3p = render.render_cells(snap_3p, 80, { layout = "auto" })
  assert_eq(
    render.cells_to_plain_text(minimal_3p),
    "Cld │ Ctx 38% │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h",
    "3p minimal layout text"
  )

  local fallback_3p = render.render_cells(snap_3p, 105, {
    colors = { pool_3p = false, pool = "#f5c2e7" },
  })
  assert_true(has_fg_color(fallback_3p, "#f5c2e7"), "3p falls back to colors.pool when pool_3p unset")

  -- Completely hidden outside agy by default (only_when_agy = true)
  snap.is_agy = false
  local outside_hidden = render.render_cells(snap, 105, {})
  assert_eq(#outside_hidden, 0, "completely hidden outside agy when only_when_agy is default true")

  -- Context hiding outside agy when only_when_agy = false
  local outside_default = render.render_cells(snap, 105, {
    only_when_agy = false,
    hide_context_outside_agy = true,
  })
  assert_eq(
    render.cells_to_plain_text(outside_default),
    "Gemini │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
    "context hidden outside agy when only_when_agy=false"
  )

  local outside_shown = render.render_cells(snap, 105, {
    only_when_agy = false,
    show_context_outside_agy = true,
  })
  assert_eq(
    render.cells_to_plain_text(outside_shown),
    "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
    "context shown outside agy when configured with only_when_agy=false"
  )
end)

test("pool selection priority and timestamp parsing", function()
  local quota = {
    default_pool = "gemini",
    pools = {
      gemini = { label = "Gemini", five_hour = { remaining_pct = 49 } },
      claude = { label = "Claude", five_hour = { remaining_pct = 75 } },
    },
    model_pools = {
      ["claude-sonnet-4-5"] = "claude",
    },
  }

  local k1 = state.resolve_pool(quota, { pool = "claude", model_id = "gemini-3-pro" }, {})
  assert_eq(k1, "claude", "pane.pool takes precedence over model_id")

  local k2 = state.resolve_pool(quota, { model_id = "claude-sonnet-4-5" }, {})
  assert_eq(k2, "claude", "model_pools lookup")

  local k3 = state.resolve_pool(quota, {}, {})
  assert_eq(k3, "gemini", "default_pool fallback")

  local k4 = state.resolve_pool(quota, { pool = "claude" }, { pool = "gemini" })
  assert_eq(k4, "gemini", "opts.pool override")

  assert_eq(state.parse_epoch(1730000000), 1730000000, "epoch seconds")
  assert_eq(state.parse_epoch(1730000000000), 1730000000, "epoch milliseconds")
  local iso_z = state.parse_epoch("2026-11-27T08:00:00Z")
  local iso_plus8 = state.parse_epoch("2026-11-27T16:00:00+08:00")
  assert_true(type(iso_z) == "number", "ISO-8601 Z parsed")
  assert_eq(iso_z, iso_plus8, "ISO-8601 timezone offset equivalence")
end)

test("cache dir env resolution and pane process detection", function()
  local env1 = state.resolve_cache_dir({
    env_fn = function(k)
      if k == "WEZTERM_AGY_STATUS_DIR" then
        return "/custom/agy-dir/"
      end
      return nil
    end,
  })
  assert_eq(env1, "/custom/agy-dir", "WEZTERM_AGY_STATUS_DIR precedence")

  local env2 = state.resolve_cache_dir({
    env_fn = function(k)
      if k == "XDG_CACHE_HOME" then
        return "/tmp/xdg-cache/"
      end
      return nil
    end,
  })
  assert_eq(env2, "/tmp/xdg-cache/wezterm-agy-status", "XDG_CACHE_HOME fallback")

  state.reset()
  local agy_direct = make_mock_pane({
    id = 10,
    proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
  })
  assert_true(state.detect_is_agy(agy_direct, {}, 1000), "direct agy binary")

  local agy_child = make_mock_pane({
    id = 11,
    proc_info = {
      executable = "/bin/bash",
      name = "bash",
      children = {
        [999] = { executable = "/usr/bin/node", name = "node", argv = { "node", "/opt/bin/agy" }, children = {} },
      },
    },
  })
  assert_true(state.detect_is_agy(agy_child, {}, 1000), "nested agy child process")

  local collector_proc = make_mock_pane({
    id = 12,
    proc_info = {
      executable = "/usr/bin/node",
      name = "node",
      argv = { "node", "/home/xiaolu/agy-quota.wezterm/bin/agy-status-collector.mjs", "--refresh" },
      children = {},
    },
  })
  assert_eq(state.detect_is_agy(collector_proc, {}, 1000), false, "collector does not false-positive")

  -- Process cache TTL 2s verification
  local dynamic_pane = make_mock_pane({
    id = 13,
    proc_info = { executable = "/bin/bash", name = "bash", children = {} },
  })
  assert_eq(state.detect_is_agy(dynamic_pane, {}, 1000), false, "initially bash")
  local agy_switched = make_mock_pane({
    id = 13,
    proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
  })
  assert_eq(state.detect_is_agy(agy_switched, {}, 1001), false, "cached within 2s TTL")
  assert_eq(state.detect_is_agy(agy_switched, {}, 1002.1), true, "refreshed after 2s TTL")
end)

test("JSON cache reading, memory throttling, malformed JSON safety, and stale refresh gating", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    local spawns = {}
    local opts = {
      cache_dir = tmp_dir,
      node_bin = "/usr/local/bin/node",
      collector_script = "/opt/agy/bin/agy-status-collector.mjs",
      spawn_fn = function(argv)
        table.insert(spawns, argv)
      end,
    }

    local pane = make_mock_pane({
      id = 42,
      cols = 105,
      cwd = "/home/xiaolu/project",
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })

    -- 1. Missing quota.json & pane_42.json -> triggers spawn once, cooldown blocks rapid second spawn
    local s1 = state.get_snapshot(pane, opts, 1000)
    assert_eq(s1.has_quota, false, "missing quota.json")
    assert_eq(#spawns, 1, "spawned when cache missing")
    assert_eq(spawns[1][1], "/usr/local/bin/node", "argv node_bin")
    assert_eq(spawns[1][2], "/opt/agy/bin/agy-status-collector.mjs", "argv collector")
    assert_eq(spawns[1][3], "--refresh", "argv --refresh")
    assert_eq(spawns[1][4], "--pane", "argv --pane")
    assert_eq(spawns[1][5], "42", "argv pane id")
    assert_eq(spawns[1][6], "--cwd", "argv --cwd")
    assert_eq(spawns[1][7], "/home/xiaolu/project", "argv cwd")

    state.get_snapshot(pane, opts, 1001)
    assert_eq(#spawns, 1, "spawn cooldown (>=2s) prevents rapid respawn")

    -- Even if user passes spawn_cooldown_secs = 1, non-forced spawns clamp cooldown >= 2s
    local opts_low_cd = {
      cache_dir = tmp_dir,
      node_bin = "/usr/local/bin/node",
      collector_script = "/opt/agy/bin/agy-status-collector.mjs",
      spawn_cooldown_secs = 1,
      spawn_fn = opts.spawn_fn,
    }
    state.get_snapshot(pane, opts_low_cd, 1001.5)
    assert_eq(#spawns, 1, "spawn_cooldown_secs clamped >= 2s when not forced")

    -- 2. Malformed JSON never throws
    write_file(tmp_dir .. "/quota.json", "{broken json")
    local s_bad = state.get_snapshot(pane, opts, 1005)
    assert_eq(s_bad.has_quota, false, "malformed json returns nil cleanly")
    assert_eq(#spawns, 2, "spawned again after cooldown")

    -- 3. Valid quota.json & pane_42.json with JSON nulls
    write_file(
      tmp_dir .. "/quota.json",
      [[{
        "version": 1,
        "fetched_at": 1006,
        "source": "cloudcode",
        "plan_tier": "pro",
        "default_pool": "gemini",
        "pools": {
          "gemini": {
            "label": "Gemini",
            "five_hour": { "remaining_pct": 49, "reset_time": null, "reset_epoch": 5866 },
            "weekly": { "remaining_pct": 86, "reset_time": null, "reset_epoch": 591406 }
          }
        },
        "model_pools": { "gemini-3-pro": "gemini" }
      }]]
    )
    write_file(
      tmp_dir .. "/panes/pane_42.json",
      [[{
        "version": 1,
        "pane_id": 42,
        "model_id": "gemini-3-pro",
        "pool": "gemini",
        "context": {
          "used_tokens": 376200,
          "context_window_size": 1000000,
          "used_pct": 35.9,
          "remaining_pct": 64.1,
          "cached_pct": 99.1
        },
        "updated_at": 1006
      }]]
    )

    -- Within 1s read throttle from 1005 -> still cached bad nil until 1006
    local s_throttled = state.get_snapshot(pane, opts, 1005.5)
    assert_eq(s_throttled.has_quota, false, "1s cache read throttle holds previous read")

    -- Verify dynamic countdown ticks between polls without rewriting quota.json!
    local cells_t0 = render.render_cells(
      state.get_snapshot(pane, opts, 1006),
      105,
      {}
    )
    assert_eq(
      render.cells_to_plain_text(cells_t0),
      "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
      "countdown at now=1006"
    )

    -- One second later (1007), countdowns tick down cleanly without re-polling!
    local s_fresh = state.get_snapshot(pane, opts, 1007)
    assert_eq(s_fresh.has_quota, true, "reads fresh quota.json after 1s")
    assert_eq(s_fresh.has_pane, true, "reads fresh pane_42.json after 1s")
    assert_eq(#spawns, 2, "fresh cache does not spawn")

    local cells_t1 = render.render_cells(s_fresh, 105, {})
    assert_eq(
      render.cells_to_plain_text(cells_t1),
      "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h20m │ Wk 86% ███░ 6d19h",
      "countdown ticks dynamically at now=1007"
    )

    -- At 1008 (1006 + 2s < 3s), active pane not yet stale
    local s_pane_fresh = state.get_snapshot(pane, opts, 1008)
    assert_eq(s_pane_fresh.pane_stale, false, "active pane fresh before 3s")
    assert_eq(#spawns, 2, "no spawn before 3s active poll interval")

    -- At 1009 (1006 + 3s = active_poll_interval_secs), active agy pane triggers spawn!
    local s_pane_stale = state.get_snapshot(pane, opts, 1009)
    assert_eq(s_pane_stale.pane_stale, true, "active pane stale after 3s")
    assert_eq(#spawns, 3, "active agy pane triggers refresh at 3s")

    -- Manual trigger_refresh forces spawn & clears read cache
    local triggered = state.trigger_refresh(pane, opts, 1009)
    assert_true(triggered, "trigger_refresh succeeds")
    assert_eq(#spawns, 4, "trigger_refresh spawned")

    -- Non-agy bash pane: when only_when_agy = true (default), even stale quota (>=30s)
    -- does NOT spawn unless force == true or only_when_agy == false.
    local bash_pane = make_mock_pane({
      id = 77,
      cols = 105,
      cwd = "/home/xiaolu",
      proc_info = { executable = "/bin/bash", name = "bash", children = {} },
    })
    local count_before_bash = #spawns
    local sb1 = state.get_snapshot(bash_pane, opts, 1020) -- 1020 - 1006 = 14s < 30s
    assert_eq(sb1.is_agy, false, "bash pane is not agy")
    assert_eq(sb1.quota_stale, false, "quota fresh at 14s")
    assert_eq(sb1.pane_stale, false, "non-agy pane does not require pane json")
    assert_eq(#spawns, count_before_bash, "no spawn for fresh quota in bash pane")

    local sb2 = state.get_snapshot(bash_pane, opts, 1036) -- 1036 - 1006 = 30s >= 30s
    assert_eq(sb2.quota_stale, true, "quota stale at 30s")
    assert_eq(#spawns, count_before_bash, "stale quota does NOT spawn in bash pane when only_when_agy=true")

    local opts_show_always = {
      cache_dir = tmp_dir,
      node_bin = "/usr/local/bin/node",
      collector_script = "/opt/agy/bin/agy-status-collector.mjs",
      only_when_agy = false,
      spawn_fn = opts.spawn_fn,
    }
    state.get_snapshot(bash_pane, opts_show_always, 1036)
    assert_eq(#spawns, count_before_bash + 1, "stale quota spawns in bash pane when only_when_agy=false")

    -- Derived used_pct when pane json omits used_pct
    write_file(
      tmp_dir .. "/panes/pane_88.json",
      [[{
        "version": 1,
        "pane_id": 88,
        "context": {
          "used_tokens": 250000,
          "context_window_size": 1000000
        },
        "updated_at": 1036
      }]]
    )
    local derived_pane = make_mock_pane({
      id = 88,
      cols = 105,
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })
    local sd = state.get_snapshot(derived_pane, opts, 1037)
    assert_eq(sd.context.used_pct, 25, "derived used_pct from tokens/window")
    assert_eq(sd.context.remaining_pct, 75, "derived remaining_pct")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

test("node_bin and collector_script auto-resolution and empty/placeholder rendering", function()
  state.reset()
  local node = state.resolve_node_bin({})
  assert_true(type(node) == "string" and node ~= "", "node_bin resolved")

  local collector = state.resolve_collector_script({ plugin_dir = REPO_ROOT .. "/plugin" })
  assert_true(type(collector) == "string" and collector:find("agy%-status%-collector%.mjs$") ~= nil, "collector_script auto-resolved")

  local outside_empty = render.render_cells({ is_agy = false, has_quota = false }, 105, {})
  assert_eq(#outside_empty, 0, "outside agy renders empty cells by default")

  local empty_cells = render.render_cells({ is_agy = true, has_quota = false }, 105, {})
  assert_eq(render.cells_to_plain_text(empty_cells), "5h -- │ Wk --", "placeholder when empty inside agy")

  local hidden_cells = render.render_cells({ is_agy = true, has_quota = false }, 105, { hide_when_empty = true })
  assert_eq(#hidden_cells, 0, "hide_when_empty returns empty cell list")

  local outside_placeholder = render.render_cells(
    { is_agy = false, has_quota = false },
    105,
    { only_when_agy = false }
  )
  assert_eq(render.cells_to_plain_text(outside_placeholder), "5h -- │ Wk --", "placeholder when only_when_agy=false")
end)

test("composable API, layout cycling, and apply_to_config integration", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    write_file(
      tmp_dir .. "/quota.json",
      [[{
        "version": 1,
        "fetched_at": 2000,
        "default_pool": "gemini",
        "pools": {
          "gemini": {
            "label": "Gemini",
            "five_hour": { "remaining_pct": 49, "reset_epoch": 6860 },
            "weekly": { "remaining_pct": 86, "reset_epoch": 592400 }
          }
        }
      }]]
    )
    write_file(
      tmp_dir .. "/panes/pane_7.json",
      [[{
        "version": 1,
        "pane_id": 7,
        "pool": "gemini",
        "context": {
          "used_tokens": 376200,
          "context_window_size": 1000000,
          "used_pct": 35.9,
          "cached_pct": 99.1
        },
        "updated_at": 2000
      }]]
    )

    local pane = make_mock_pane({
      id = 7,
      cols = 105,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })
    local win = make_mock_window(99, pane)

    plugin.setup({
      cache_dir = tmp_dir,
      spawn_fn = function() end,
    })

    local cells = plugin.get_status_cells(win, pane, nil, 2000)
    assert_eq(
      render.cells_to_plain_text(cells),
      "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
      "get_status_cells output"
    )

    local formatted = plugin.get_status_text(win, pane, nil, 2000)
    assert_true(formatted:find("\x1b%[38:2:") ~= nil, "get_status_text emits ANSI truecolor")

    -- Composing with user cwd + time cells
    table.insert(cells, { Foreground = { Color = "#a9b0c2" } })
    table.insert(cells, { Text = "  ~/work  " })
    table.insert(cells, { Foreground = { Color = "#e6dcc3" } })
    table.insert(cells, { Text = "16:37 " })
    local combined = wezterm.format(cells)
    assert_true(#combined > #formatted, "composable cells integrate cleanly with wezterm.format")

    local narrow_split_pane = make_mock_pane({
      id = 7,
      cols = 52,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })
    local wide_win = make_mock_window(100, narrow_split_pane, 150)
    assert_eq(
      render.cells_to_plain_text(plugin.get_status_cells(wide_win, narrow_split_pane, nil, 2000)),
      "Gemini │ Cached 99.1% │ Context 35.9% ███░░░░░ 376.2k/1.0M │ Five Hours 49% ████░░░░ 1h21m │ Weekly 86% ███████░ 6d20h",
      "tab:get_size().cols determines full-bar layout even on narrow split pane"
    )

    -- Layout cycling
    assert_eq(plugin.get_layout(win), "auto", "initial layout auto")
    assert_eq(plugin.cycle_layout(win), "full", "cycle -> full")
    assert_eq(
      render.cells_to_plain_text(plugin.get_status_cells(win, pane, nil, 2000)),
      "Gemini │ Cached 99.1% │ Context 35.9% ███░░░░░ 376.2k/1.0M │ Five Hours 49% ████░░░░ 1h21m │ Weekly 86% ███████░ 6d20h",
      "overridden full layout on 105-col pane"
    )
    assert_eq(plugin.cycle_layout(win), "compact", "cycle -> compact")
    assert_eq(
      render.cells_to_plain_text(plugin.get_status_cells(win, pane, nil, 2000)),
      "Gemini │ C 99% │ Ctx 35.9% █░░░ 376k/1.0M │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
      "overridden compact layout"
    )
    assert_eq(plugin.cycle_layout(win), "minimal", "cycle -> minimal")
    assert_eq(
      render.cells_to_plain_text(plugin.get_status_cells(win, pane, nil, 2000)),
      "Gem │ Ctx 36% │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
      "overridden minimal layout"
    )
    assert_eq(plugin.cycle_layout(win), "auto", "cycle -> auto")

    -- apply_to_config on a real wezterm.config_builder() preserving existing keys
    local real_now = os.time()
    write_file(
      tmp_dir .. "/quota.json",
      string.format(
        '{"version":1,"fetched_at":%d,"default_pool":"gemini","pools":{"gemini":{"label":"Gemini","five_hour":{"remaining_pct":49,"reset_epoch":%d},"weekly":{"remaining_pct":86,"reset_epoch":%d}}}}',
        real_now,
        real_now + 4860,
        real_now + 590400
      )
    )
    write_file(
      tmp_dir .. "/panes/pane_7.json",
      string.format(
        '{"version":1,"pane_id":7,"pool":"gemini","context":{"used_tokens":376200,"context_window_size":1000000,"used_pct":35.9,"cached_pct":99.1},"updated_at":%d}',
        real_now
      )
    )
    state.reset()

    local cfg = wezterm.config_builder()
    cfg.keys = {
      { key = "b", mods = "CTRL|SHIFT", action = wezterm.action.ReloadConfiguration },
    }
    plugin.apply_to_config(cfg, {
      cache_dir = tmp_dir,
      toggle_layout_key = "q",
      refresh_key = { key = "r", mods = "CTRL|SHIFT" },
      append_cwd = true,
      append_time = true,
      spawn_fn = function() end,
    })
    assert_eq(#cfg.keys, 3, "existing keys preserved plus 2 optional keybinds")
    assert_eq(cfg.keys[1].key, "b", "existing key preserved")
    assert_eq(cfg.keys[2].key, "q", "toggle_layout_key bound")
    assert_eq(cfg.keys[2].mods, "CTRL|SHIFT", "default key_mods applied")
    assert_eq(cfg.keys[3].key, "r", "refresh_key bound")

    -- Trigger registered update-status event and verify window:set_right_status output
    wezterm.emit("update-status", win, pane)
    assert_true(type(win._last_right_status) == "string" and #win._last_right_status > 0, "update-status sets right status")
    assert_true(win._last_right_status:find("Gemini") ~= nil, "right status includes Gemini pool label")
    assert_true(win._last_right_status:find("35%.9%%") ~= nil, "right status includes context pct")
    assert_true(win._last_right_status:find("~/work") ~= nil, "right status includes appended cwd")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

test("only_when_agy hides shell panes, skips spawn_fn, and omits standalone separator", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    local spawn_count = 0
    local bash_pane = make_mock_pane({
      id = 55,
      cols = 105,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/bin/bash", name = "bash", children = {} },
    })
    local win = make_mock_window(201, bash_pane)

    plugin.setup({
      cache_dir = tmp_dir,
      append_cwd = false,
      append_time = false,
      spawn_fn = function()
        spawn_count = spawn_count + 1
      end,
    })

    local cells = plugin.get_status_cells(win, bash_pane, nil, 3000)
    assert_eq(#cells, 0, "is_agy=false returns empty cells")
    assert_eq(plugin.get_status_text(win, bash_pane, nil, 3000), "", "is_agy=false returns empty text")
    assert_eq(spawn_count, 0, "is_agy=false does NOT call spawn_fn")

    wezterm.emit("update-status", win, bash_pane)
    assert_eq(win._last_right_status, "", "update-status sets empty string outside agy when no extras")
    assert_eq(spawn_count, 0, "update-status on bash pane does NOT call spawn_fn")

    plugin.setup({
      cache_dir = tmp_dir,
      append_cwd = true,
      append_time = true,
      spawn_fn = function()
        spawn_count = spawn_count + 1
      end,
    })
    wezterm.emit("update-status", win, bash_pane)
    assert_true(type(win._last_right_status) == "string" and win._last_right_status:find("~/work") ~= nil, "cwd still rendered when append_cwd=true")
    assert_true(win._last_right_status:find("│") == nil, "no leading separator emitted when quota cells are empty")
    assert_eq(spawn_count, 0, "still zero spawn_fn calls on bash pane")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

test("switching pane_<id>.json from gemini to 3p immediately updates pool label, quotas, and colors", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    write_file(
      tmp_dir .. "/quota.json",
      [[{
        "version": 1,
        "fetched_at": 4000,
        "default_pool": "gemini",
        "pools": {
          "gemini": {
            "label": "Gemini",
            "five_hour": { "remaining_pct": 59, "reset_epoch": 17980 },
            "weekly": { "remaining_pct": 86, "reset_epoch": 522400 }
          },
          "3p": {
            "label": "Claude & GPT",
            "five_hour": { "remaining_pct": 24, "reset_epoch": 11200 },
            "weekly": { "remaining_pct": 71, "reset_epoch": 350000 }
          }
        }
      }]]
    )
    write_file(
      tmp_dir .. "/panes/pane_9.json",
      [[{
        "version": 1,
        "pane_id": 9,
        "model_id": "gemini-3-pro",
        "pool": "gemini",
        "context": {
          "used_tokens": 395400,
          "context_window_size": 1000000,
          "used_pct": 37.7,
          "cached_pct": 97.6
        },
        "updated_at": 4000
      }]]
    )

    local pane = make_mock_pane({
      id = 9,
      cols = 105,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })
    local win = make_mock_window(202, pane)

    plugin.setup({
      cache_dir = tmp_dir,
      spawn_fn = function() end,
    })

    local function has_color(cells, hex)
      for i = 1, #cells do
        local item = cells[i]
        if item.Foreground and item.Foreground.Color == hex then
          return true
        end
      end
      return false
    end

    local gem_cells = plugin.get_status_cells(win, pane, nil, 4000)
    local gem_text = render.cells_to_plain_text(gem_cells)
    assert_eq(
      gem_text,
      "Gemini │ C 98% │ Ctx 37.7% ██░░ 395k/1.0M │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h",
      "initial gemini pool bar"
    )
    assert_true(has_color(gem_cells, "#89b4fa"), "gemini pool uses #89b4fa")
    assert_true(utf8.len(gem_text) <= 85, "compact gemini width fits comfortably on 105 cols")

    local gem_min_text = render.cells_to_plain_text(plugin.get_status_cells(win, pane, { layout = "minimal" }, 4000))
    assert_eq(
      gem_min_text,
      "Gem │ Ctx 38% │ 5h 59% ██░░ 3h53m │ Wk 86% ███░ 6d0h",
      "initial gemini minimal bar"
    )
    assert_eq(utf8.len(gem_min_text), 52, "minimal layout is exactly 52 display chars")

    -- Switch model/pool in pane_9.json from gemini to 3p (Claude/GPT)
    write_file(
      tmp_dir .. "/panes/pane_9.json",
      [[{
        "version": 1,
        "pane_id": 9,
        "model_id": "claude-sonnet-4-5",
        "pool": "3p",
        "context": {
          "used_tokens": 395400,
          "context_window_size": 1000000,
          "used_pct": 37.7,
          "cached_pct": 97.6
        },
        "updated_at": 4001
      }]]
    )

    local claude_cells = plugin.get_status_cells(win, pane, nil, 4001.5)
    local claude_text = render.cells_to_plain_text(claude_cells)
    assert_eq(
      claude_text,
      "Claude/GPT │ C 98% │ Ctx 37.7% ██░░ 395k/1.0M │ 5h 24% █░░░ 1h59m │ Wk 71% ███░ 4d0h",
      "switched immediately to Claude/GPT pool and 3p quota percentages"
    )
    assert_true(has_color(claude_cells, "#d4bdf5"), "3p pool uses #d4bdf5")
    assert_true(utf8.len(claude_text) <= 90, "compact Claude/GPT width fits comfortably on 105 cols")

    local claude_min_text = render.cells_to_plain_text(plugin.get_status_cells(win, pane, { layout = "minimal" }, 4001.5))
    assert_eq(
      claude_min_text,
      "Cld │ Ctx 38% │ 5h 24% █░░░ 1h59m │ Wk 71% ███░ 4d0h",
      "switched minimal bar to Cld and 3p percentages"
    )
    assert_eq(utf8.len(claude_min_text), 52, "minimal Cld layout is exactly 52 display chars")

    -- Verify custom pane_data.pool_label is preserved in snapshot for non-3p/gemini custom pools
    write_file(
      tmp_dir .. "/panes/pane_9.json",
      [[{
        "version": 1,
        "pane_id": 9,
        "pool": "3p",
        "pool_label": "My Custom Label",
        "updated_at": 4003
      }]]
    )
    local snap_custom = plugin.get_snapshot(pane, nil, 4003)
    assert_eq(snap_custom.pool_label, "My Custom Label", "state keeps pane_data.pool_label")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

test("apply_to_config supports tab_bar_at_bottom option", function()
  local cfg_true = wezterm.config_builder()
  plugin.apply_to_config(cfg_true, {
    register_status_event = false,
    tab_bar_at_bottom = true,
  })
  assert_eq(cfg_true.tab_bar_at_bottom, true, "sets tab_bar_at_bottom = true")

  local cfg_false = wezterm.config_builder()
  plugin.apply_to_config(cfg_false, {
    register_status_event = false,
    tab_bar_at_bottom = false,
  })
  assert_eq(cfg_false.tab_bar_at_bottom, false, "sets tab_bar_at_bottom = false")

  local cfg_untouched = wezterm.config_builder()
  cfg_untouched.tab_bar_at_bottom = false
  plugin.apply_to_config(cfg_untouched, {
    register_status_event = false,
  })
  assert_eq(cfg_untouched.tab_bar_at_bottom, false, "leaves tab_bar_at_bottom untouched when nil")
end)

test("render_bottom_lines and render_bottom_text render 2-line Gemini/3p/compact/empty states", function()
  local now = 1730000000
  local function has_fg_color(cells, color)
    for i = 1, #cells do
      local item = cells[i]
      if item.Foreground and item.Foreground.Color == color then
        return true
      end
    end
    return false
  end

  local snap_gemini = {
    now = now,
    is_agy = true,
    pool_key = "gemini",
    pool_label = "Gemini",
    context = {
      cached_pct = 99.1,
      used_pct = 35.9,
      used_tokens = 376200,
      context_window_size = 1000000,
    },
    five_hour = {
      remaining_pct = 49,
      reset_epoch = now + 4860, -- 1h21m
    },
    weekly = {
      remaining_pct = 86,
      reset_epoch = now + 590400, -- 6d20h
    },
  }

  local lines_full = render.render_bottom_lines(snap_gemini, 120, {})
  assert_eq(
    render.cells_to_plain_text(lines_full.line1),
    "Cached 99.1% │ Context 35.9% ████░░░░░░ 376.2k/1.0M",
    "bottom line 1 full Gemini"
  )
  assert_eq(
    render.cells_to_plain_text(lines_full.line2),
    "Gemini │ Five Hours 49% █████░░░░░ 1h21m │ Weekly 86% █████████░ 6d20h",
    "bottom line 2 full Gemini"
  )
  assert_true(has_fg_color(lines_full.line2, "#89b4fa"), "bottom Gemini pool uses #89b4fa")
  assert_true(has_fg_color(lines_full.line2, "#57caff"), "bottom countdown uses #57caff")
  assert_true(has_fg_color(lines_full.line2, "#3b4052"), "bottom empty bar uses #3b4052")

  local bottom_ansi = render.render_bottom_text(snap_gemini, 120, {})
  assert_true(bottom_ansi:find("\n", 1, true) ~= nil, "render_bottom_text joins line1 and line2 with newline")
  assert_true(bottom_ansi:find("Cached ", 1, true) ~= nil and bottom_ansi:find("99%.1%%") ~= nil, "ANSI text has Cached 99.1%")
  assert_true(bottom_ansi:find("Five Hours ", 1, true) ~= nil and bottom_ansi:find("49%%") ~= nil, "ANSI text has Five Hours 49%")

  -- 3p / Claude & GPT pool
  local snap_3p = {
    now = now,
    is_agy = true,
    pool_key = "3p",
    pool_label = "Claude & GPT",
    context = snap_gemini.context,
    five_hour = { remaining_pct = 59, reset_epoch = now + 13980 },
    weekly = { remaining_pct = 71, reset_epoch = now + 350000 },
  }
  local lines_3p = render.render_bottom_lines(snap_3p, 105, {})
  assert_eq(
    render.cells_to_plain_text(lines_3p.line2),
    "Claude/GPT │ Five Hours 59% ██████░░░░ 3h53m │ Weekly 71% ███████░░░ 4d1h",
    "bottom line 2 full 3p"
  )
  assert_true(has_fg_color(lines_3p.line2, "#d4bdf5"), "bottom 3p pool uses #d4bdf5")

  -- Compact bottom layout when cols < 85
  local lines_narrow = render.render_bottom_lines(snap_gemini, 80, {})
  assert_eq(
    render.cells_to_plain_text(lines_narrow.line1),
    "C 99% │ Ctx 36% █░░░ 376k/1.0M",
    "bottom line 1 compact when cols < 85"
  )
  assert_eq(
    render.cells_to_plain_text(lines_narrow.line2),
    "Gem │ 5h 49% ██░░ 1h21m │ Wk 86% ███░ 6d20h",
    "bottom line 2 compact when cols < 85"
  )
  local lines_narrow_3p = render.render_bottom_lines(snap_3p, 80, {})
  assert_eq(
    render.cells_to_plain_text(lines_narrow_3p.line2),
    "Cld │ 5h 59% ██░░ 3h53m │ Wk 71% ███░ 4d1h",
    "bottom line 2 compact 3p when cols < 85"
  )

  -- Unpopulated context inside agy
  local snap_no_ctx = {
    now = now,
    is_agy = true,
    pool_key = "gemini",
    five_hour = snap_gemini.five_hour,
    weekly = snap_gemini.weekly,
  }
  local lines_no_ctx = render.render_bottom_lines(snap_no_ctx, 120, {})
  assert_eq(
    render.cells_to_plain_text(lines_no_ctx.line1),
    "Cached -- │ Context --",
    "unpopulated context renders Cached -- | Context --"
  )

  -- Custom bar width/chars & show_pool = false
  local lines_custom = render.render_bottom_lines(snap_gemini, 120, {
    show_pool = false,
    bottom_bar_width = 5,
    bottom_bar_filled_char = "#",
    bottom_bar_empty_char = "-",
  })
  assert_eq(
    render.cells_to_plain_text(lines_custom.line1),
    "Cached 99.1% │ Context 35.9% ##--- 376.2k/1.0M",
    "custom bottom_bar_width and chars on line 1"
  )
  assert_eq(
    render.cells_to_plain_text(lines_custom.line2),
    "Five Hours 49% ##--- 1h21m │ Weekly 86% ####- 6d20h",
    "show_pool=false and custom bar chars on line 2"
  )

  -- Outside agy (is_agy = false) returns empty tables and ""
  local snap_shell = {
    now = now,
    is_agy = false,
    pool_key = "gemini",
    context = snap_gemini.context,
    five_hour = snap_gemini.five_hour,
    weekly = snap_gemini.weekly,
  }
  local lines_shell = render.render_bottom_lines(snap_shell, 120, {})
  assert_eq(#lines_shell.line1, 0, "is_agy=false line1 empty")
  assert_eq(#lines_shell.line2, 0, "is_agy=false line2 empty")
  assert_eq(render.render_bottom_text(snap_shell, 120, {}), "", "is_agy=false render_bottom_text returns empty string")
end)

test("feature-detected dual mode routes to set_bottom_status on wezterm-custom and falls back on stock wezterm", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    local real_now = os.time()
    write_file(
      tmp_dir .. "/quota.json",
      string.format(
        '{"version":1,"fetched_at":%d,"default_pool":"gemini","pools":{"gemini":{"label":"Gemini","five_hour":{"remaining_pct":49,"reset_epoch":%d},"weekly":{"remaining_pct":86,"reset_epoch":%d}}}}',
        real_now,
        real_now + 4860,
        real_now + 590400
      )
    )
    write_file(
      tmp_dir .. "/panes/pane_21.json",
      string.format(
        '{"version":1,"pane_id":21,"pool":"gemini","context":{"used_tokens":376200,"context_window_size":1000000,"used_pct":35.9,"cached_pct":99.1},"updated_at":%d}',
        real_now
      )
    )

    local agy_pane = make_mock_pane({
      id = 21,
      cols = 120,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/home/xiaolu/.local/bin/agy", name = "agy", children = {} },
    })
    local bash_pane = make_mock_pane({
      id = 22,
      cols = 120,
      cwd = "/home/xiaolu/work",
      proc_info = { executable = "/bin/bash", name = "bash", children = {} },
    })

    local bottom_win = make_mock_bottom_window(301, agy_pane, 120)
    local stock_win = make_mock_window(302, agy_pane, 120)
    local throwing_userdata_proxy = setmetatable({}, {
      __index = function(_, key)
        error("unknown field: " .. tostring(key))
      end,
    })

    assert_eq(plugin.has_bottom_status_api(nil), false, "nil window has no bottom API")
    assert_eq(plugin.has_bottom_status_api("win"), false, "string has no bottom API")
    assert_eq(plugin.has_bottom_status_api(stock_win), false, "stock window has no bottom API")
    assert_eq(plugin.has_bottom_status_api(throwing_userdata_proxy), false, "throwing proxy safely returns false")
    assert_eq(plugin.has_bottom_status_api(bottom_win), true, "bottom_win detected as supporting set_bottom_status")

    local cfg = wezterm.config_builder()
    plugin.apply_to_config(cfg, {
      cache_dir = tmp_dir,
      append_cwd = true,
      append_time = true,
      refresh_key = "r",
      spawn_fn = function() end,
    })

    -- prefer_bottom_status = true keeps top-bar get_status_cells empty on bottom_win, unless overridden
    assert_eq(#plugin.get_status_cells(bottom_win, agy_pane, nil, real_now), 0, "get_status_cells empty when prefer_bottom_status=true on bottom_win")
    assert_true(
      #plugin.get_status_cells(bottom_win, agy_pane, { prefer_bottom_status = false }, real_now) > 0,
      "prefer_bottom_status=false overrides to top cells"
    )
    assert_true(
      #plugin.get_status_cells(bottom_win, agy_pane, { render_mode = "top" }, real_now) > 0,
      "render_mode='top' overrides to top cells"
    )
    assert_true(
      #plugin.get_status_cells(stock_win, agy_pane, nil, real_now) > 0,
      "stock_win returns single-line top cells"
    )

    -- update_bottom_status returns true on bottom_win, false on stock_win
    assert_eq(plugin.update_bottom_status(stock_win, agy_pane, nil, real_now), false, "update_bottom_status returns false on stock_win")
    assert_eq(plugin.update_bottom_status(bottom_win, agy_pane, nil, real_now), true, "update_bottom_status returns true on bottom_win")
    assert_true(type(bottom_win._last_bottom_status) == "string" and bottom_win._last_bottom_status:find("\n", 1, true) ~= nil, "bottom_win received 2-line status")

    -- get_bottom_status_text on agy vs bash pane
    local bottom_text_agy = plugin.get_bottom_status_text(bottom_win, agy_pane, nil, real_now)
    assert_true(bottom_text_agy:find("Cached ", 1, true) ~= nil and bottom_text_agy:find("99%.1%%") ~= nil, "get_bottom_status_text includes Cached 99.1%")
    assert_eq(plugin.get_bottom_status_text(bottom_win, bash_pane, nil, real_now), "", "get_bottom_status_text empty on bash pane")

    -- update-status on bottom_win: 2-line bottom bar + ONLY cwd/time in right status
    wezterm.emit("update-status", bottom_win, agy_pane)
    assert_true(bottom_win._last_bottom_status:find("Cached ", 1, true) ~= nil and bottom_win._last_bottom_status:find("99%.1%%") ~= nil, "bottom status contains line 1")
    assert_true(bottom_win._last_bottom_status:find("Gemini", 1, true) ~= nil, "bottom status contains line 2")
    assert_true(bottom_win._last_right_status:find("~/work", 1, true) ~= nil, "right status still has cwd")
    assert_true(bottom_win._last_right_status:find("Gemini", 1, true) == nil, "right status omits quota when bottom bar active")
    assert_true(bottom_win._last_right_status:find("│", 1, true) == nil, "right status omits leading separator")

    -- update-status on bash pane clears bottom status to ""
    wezterm.emit("update-status", bottom_win, bash_pane)
    assert_eq(bottom_win._last_bottom_status, "", "bash pane clears bottom status to empty string")
    assert_true(bottom_win._last_right_status:find("~/work", 1, true) ~= nil, "right status still renders cwd on bash pane")

    -- update-status on bottom_win without append_cwd/append_time sets right status to ""
    plugin.setup({
      cache_dir = tmp_dir,
      append_cwd = false,
      append_time = false,
      spawn_fn = function() end,
    })
    wezterm.emit("update-status", bottom_win, agy_pane)
    assert_eq(bottom_win._last_right_status, "", "right status cleared when no cwd/time and bottom bar active")
    assert_true(bottom_win._last_bottom_status:find("Five Hours ", 1, true) ~= nil, "bottom status populated")

    -- update-status on stock_win falls back to single-line right status (120 cols -> compact single-line)
    wezterm.emit("update-status", stock_win, agy_pane)
    assert_true(stock_win._last_right_status:find("Gemini", 1, true) ~= nil, "stock_win falls back to single-line right status")
    assert_true(stock_win._last_right_status:find("5h ", 1, true) ~= nil and stock_win._last_right_status:find("49%%") ~= nil, "stock_win right status includes 5h 49%")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

test("agy_pid, tty forwarding, PID-change forced refresh, and initial 0-usage rendering", function()
  local tmp_dir = make_temp_dir()
  local ok, err = pcall(function()
    state.reset()
    local spawns = {}
    local opts = {
      cache_dir = tmp_dir,
      node_bin = "/usr/local/bin/node",
      collector_script = "/opt/agy/bin/agy-status-collector.mjs",
      spawn_fn = function(argv)
        table.insert(spawns, argv)
      end,
    }

    local live_proc = {
      pid = 1000,
      executable = "/bin/zsh",
      name = "zsh",
      children = {
        [1] = {
          pid = 372482,
          executable = "/home/xiaolu/.local/bin/agy",
          name = "agy",
          children = {},
        },
      },
    }
    local pane = make_mock_pane({
      id = 91,
      cols = 120,
      cwd = "/home/xiaolu/project",
      tty_name = "/dev/pts/4",
      proc_info = live_proc,
    })

    assert_eq(state.get_pane_tty(pane), "/dev/pts/4", "get_pane_tty reads tty_name")
    assert_eq(state.get_agy_pid(pane, opts, 5000), 372482, "get_agy_pid captures nested agy pid")

    -- Initial spawn passes --agy-pid and --tty
    local s1 = state.get_snapshot(pane, opts, 5000)
    assert_eq(s1.agy_pid, 372482, "snapshot falls back to live agy_pid when pane json absent")
    assert_eq(#spawns, 1, "initial missing cache spawns refresh")
    local joined = table.concat(spawns[1], " ")
    assert_true(joined:find("--agy-pid 372482", 1, true) ~= nil, "argv includes --agy-pid 372482")
    assert_true(joined:find("--tty /dev/pts/4", 1, true) ~= nil, "argv includes --tty /dev/pts/4")

    -- Write fresh quota.json and pane_91.json with agy_pid = 100 (different from live 200)
    write_file(
      tmp_dir .. "/quota.json",
      '{"version":1,"fetched_at":5001,"default_pool":"gemini","pools":{"gemini":{"label":"Gemini","five_hour":{"remaining_pct":49,"reset_epoch":9861},"weekly":{"remaining_pct":86,"reset_epoch":595401}}}}'
    )
    write_file(
      tmp_dir .. "/panes/pane_91.json",
      '{"version":1,"pane_id":91,"agy_pid":100,"conversation_id":"conv-old","pool":"gemini","context":{"source":"initial","used_tokens":0,"context_window_size":1048576,"used_pct":0,"cached_pct":0},"updated_at":5001}'
    )

    -- Update live pid to 100 first (matching disk agy_pid = 100) after proc_cache TTL expires
    live_proc.children[1].pid = 100
    local s_same = state.get_snapshot(pane, opts, 5002.5)
    assert_eq(s_same.pane_stale, false, "matching agy_pid and fresh updated_at is not stale")
    assert_eq(s_same.agy_pid, 100, "snapshot carries pane_data.agy_pid")
    assert_eq(s_same.conversation_id, "conv-old", "snapshot carries pane_data.conversation_id")
    assert_eq(#spawns, 1, "no spawn when pid matches and fresh")

    -- Now simulate /resume or restarting agy in the same pane with new pid 200 within 1s (< cooldown & < active_poll_interval)
    live_proc.children[1].pid = 200
    -- Expire proc_cache TTL (2s from 5002.5 -> 5004.5, while updated_at=5001? Wait: make updated_at=5004 so NOT time-stale!)
    write_file(
      tmp_dir .. "/panes/pane_91.json",
      '{"version":1,"pane_id":91,"agy_pid":100,"conversation_id":"conv-old","pool":"gemini","context":{"source":"initial","used_tokens":0,"context_window_size":1048576,"used_pct":0,"cached_pct":0},"updated_at":5004}'
    )
    -- Seed pane_cache at 5004 with pid=100
    live_proc.children[1].pid = 100
    -- Reset last_spawn_at via a forced refresh at 5003.5 so cooldown (2s) would block normal spawn at 5004.5!
    state.trigger_refresh(pane, opts, 5003.5)
    assert_eq(#spawns, 2, "trigger_refresh spawned")
    local s_seeded = state.get_snapshot(pane, opts, 5004)
    assert_eq(s_seeded.pane_stale, false, "seeded fresh pane cache at 5004")

    -- At 5004.5, reset proc_cache only (via time >= proc_cache_ttl=2? Wait: seeded proc_cache at 5002.5, so at 5004.5 proc_cache expired, while pane_cache from 5004 is < 1s old and updated_at=5004 is < 3s old, AND last_spawn_at=5003.5 is < 2s cooldown!)
    live_proc.children[1].pid = 200
    local s_pid_changed = state.get_snapshot(pane, opts, 5004.5)
    assert_eq(s_pid_changed.pane_stale, true, "PID change marks pane_stale = true immediately")
    assert_eq(#spawns, 3, "PID change forces immediate refresh bypassing cooldown")
    local joined_pid200 = table.concat(spawns[3], " ")
    assert_true(joined_pid200:find("--agy-pid 200", 1, true) ~= nil, "forced spawn forwards new --agy-pid 200")

    -- Write updated pane_91.json and confirm invalidated pane_cache allows immediate read even within 1s (5004.8)
    write_file(
      tmp_dir .. "/panes/pane_91.json",
      '{"version":1,"pane_id":91,"agy_pid":200,"conversation_id":"conv-new","pool":"gemini","context":{"source":"initial","used_tokens":0,"context_window_size":1048576,"used_pct":0,"cached_pct":0},"updated_at":5004.8}'
    )
    local s_reloaded = state.get_snapshot(pane, opts, 5004.8)
    assert_eq(s_reloaded.agy_pid, 200, "invalidated pane_cache immediately reloads new agy_pid")
    assert_eq(s_reloaded.conversation_id, "conv-new", "invalidated pane_cache immediately reloads new conversation_id")

    -- Initial 0-usage context rendering in bottom lines & text
    local lines_init = render.render_bottom_lines(s_reloaded, 120, {})
    assert_eq(
      render.cells_to_plain_text(lines_init.line1),
      "Cached 0.0% │ Context 0.0% ░░░░░░░░░░ 0/1.0M",
      "initial 0-usage context renders Cached 0.0% | Context 0.0% empty bar 0/1.0M"
    )
    local bottom_init_text = render.render_bottom_text(s_reloaded, 120, {})
    assert_true(bottom_init_text:find("Cached ", 1, true) ~= nil and bottom_init_text:find("0.0%", 1, true) ~= nil, "render_bottom_text contains initial 0.0%")

    -- Verify Cached 0.0% uses colors.muted (#6c7386) when source=='initial' & 0 tokens, while cached_color(0) stays #ff5555
    local cached_val_color = nil
    for i = 1, #lines_init.line1 - 1 do
      local item = lines_init.line1[i]
      if item.Foreground and lines_init.line1[i + 1].Text == "0.0%" then
        cached_val_color = item.Foreground.Color
        break
      end
    end
    assert_eq(cached_val_color, render.DEFAULTS.colors.muted, "initial 0-usage Cached 0.0% uses muted color")
    assert_eq(render.cached_color(0), "#ff5555", "render.cached_color(0) remains #ff5555")
  end)
  remove_dir(tmp_dir)
  if not ok then
    error(err)
  end
end)

if failed > 0 then
  io.stderr:write(string.format("\n%d test(s) failed, %d passed.\n", failed, passed))
  os.exit(1)
end

io.stderr:write(string.format("\nAll %d WezTerm Lua tests passed!\n", passed))
return {}
