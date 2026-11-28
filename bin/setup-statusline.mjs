#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteJson,
  getStatusDir,
  readJsonObjectWithBomDefense,
  readJsonSafe,
  resolveHomeDir,
} from './lib/cache.mjs';
import { buildStatusLineCommand } from './lib/statusline-feeder.mjs';

const FEEDER_BASENAME = 'agy-statusline-feeder.mjs';
const BACKUP_FILENAME = '.statusline-backup.json';

function parseArgs(argv) {
  const opts = {
    uninstall: false,
    dryRun: false,
    homeDir: null,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--home' && i + 1 < argv.length) opts.homeDir = path.resolve(argv[++i]);
    else if (arg.startsWith('--home=')) opts.homeDir = path.resolve(arg.slice('--home='.length));
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

export function runFeederSmokeCheck(feederScriptPath) {
  execFileSync(process.execPath, ['--check', feederScriptPath], { stdio: 'pipe' });
  const collectorPath = path.join(path.dirname(feederScriptPath), 'agy-status-collector.mjs');
  if (fs.existsSync(collectorPath)) {
    execFileSync(process.execPath, ['--check', collectorPath], { stdio: 'pipe' });
  }

  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-feeder-probe-'));
  try {
    const sampleMeta = JSON.stringify({
      conversation_id: 'probe-conv-1',
      cwd: probeDir,
      model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' },
      agent_state: 'idle',
      plan_tier: 'Google AI Pro',
      context_window: {
        total_input_tokens: 120000,
        total_output_tokens: 4000,
        context_window_size: 1048576,
        current_usage: {
          input_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 95000,
        },
      },
      quota: {
        'gemini-5h': { remaining_fraction: 0.85, reset_in_seconds: 5400 },
        'gemini-weekly': { remaining_fraction: 0.72, reset_in_seconds: 400000 },
      },
    });

    const probeEnv = {
      ...process.env,
      WEZTERM_AGY_STATUS_DIR: probeDir,
      WEZTERM_PANE: 'probe0',
    };
    delete probeEnv.DISABLE_QUOTA_HOOK;
    delete probeEnv.WEZTERM_AGY_FEEDER_DISABLED;
    delete probeEnv.ANTIGRAVITY_LS_ADDRESS;
    delete probeEnv.ANTIGRAVITY_CSRF_TOKEN;

    const res = spawnSync(process.execPath, [feederScriptPath], {
      input: sampleMeta,
      encoding: 'utf8',
      env: probeEnv,
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status !== 0) {
      throw new Error(`Feeder smoke test failed (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
    if ((res.stdout || '').trim() !== '') {
      throw new Error(`Feeder smoke test expected silent stdout, got: ${JSON.stringify(res.stdout)}`);
    }
    const quota = readJsonSafe(path.join(probeDir, 'quota.json'));
    const pane = readJsonSafe(path.join(probeDir, 'panes', 'pane_probe0.json'));
    if (!quota?.pools?.gemini?.five_hour || quota.pools.gemini.five_hour.remaining_pct !== 85) {
      throw new Error('Feeder smoke test failed to persist quota.json');
    }
    if (!pane?.context || pane.context.used_tokens !== 120000 || pane.context.cached_pct !== 95) {
      throw new Error('Feeder smoke test failed to persist pane cache');
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

export function installStatusLineFeeder({
  homeDir = null,
  statusDir = null,
  feederScriptPath = null,
  dryRun = false,
  quiet = false,
} = {}) {
  const effectiveHome = homeDir ? path.resolve(homeDir) : resolveHomeDir(process.env);
  const effectiveStatusDir = statusDir
    ? path.resolve(statusDir)
    : getStatusDir({ ...process.env, HOME: effectiveHome, USERPROFILE: effectiveHome });
  const scriptPath = feederScriptPath
    ? path.resolve(feederScriptPath)
    : path.join(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), FEEDER_BASENAME);

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Feeder script not found: ${scriptPath}`);
  }

  const cliSettingsPath = path.join(effectiveHome, '.gemini', 'antigravity-cli', 'settings.json');
  const backupPath = path.join(effectiveStatusDir, BACKUP_FILENAME);
  const statusLineCmd = buildStatusLineCommand(scriptPath);

  const existingSettings = readJsonObjectWithBomDefense(cliSettingsPath);
  if (existingSettings === null) {
    throw new Error(`Refusing to modify invalid JSON in ${cliSettingsPath}`);
  }

  runFeederSmokeCheck(scriptPath);

  if (dryRun) {
    return { dryRun: true, cliSettingsPath, statusLineCmd, backupPath };
  }

  // Backup pre-existing non-feeder statusLine once for clean uninstall.
  const prevSl = existingSettings.statusLine;
  if (
    prevSl
    && typeof prevSl === 'object'
    && !Array.isArray(prevSl)
    && typeof prevSl.command === 'string'
    && !prevSl.command.includes(FEEDER_BASENAME)
    && !fs.existsSync(backupPath)
  ) {
    atomicWriteJson(backupPath, {
      previousStatusLine: prevSl,
      savedAt: new Date().toISOString(),
    }, 0o600);
  }

  const baseSl = (prevSl && typeof prevSl === 'object' && !Array.isArray(prevSl)) ? { ...prevSl } : {};
  delete baseSl.padding;

  const nextSettings = {
    ...existingSettings,
    statusLine: {
      ...baseSl,
      enabled: true,
      type: 'command',
      command: statusLineCmd,
      stack_with_default: true,
    },
  };

  atomicWriteJson(cliSettingsPath, nextSettings, 0o600);

  if (!quiet) {
    console.log(`[OK] Configured silent statusLine feeder (BOM-free): ${cliSettingsPath}`);
    console.log(`     command: ${statusLineCmd}`);
    console.log('     stack_with_default: true (native single-line status bar preserved)');
    console.log('     To activate in a running agy session without restarting, run:');
    console.log(`       /statusline ${statusLineCmd}`);
  }

  return { dryRun: false, cliSettingsPath, statusLineCmd, backupPath };
}

export function uninstallStatusLineFeeder({
  homeDir = null,
  statusDir = null,
  dryRun = false,
  quiet = false,
} = {}) {
  const effectiveHome = homeDir ? path.resolve(homeDir) : resolveHomeDir(process.env);
  const effectiveStatusDir = statusDir
    ? path.resolve(statusDir)
    : getStatusDir({ ...process.env, HOME: effectiveHome, USERPROFILE: effectiveHome });
  const cliSettingsPath = path.join(effectiveHome, '.gemini', 'antigravity-cli', 'settings.json');
  const backupPath = path.join(effectiveStatusDir, BACKUP_FILENAME);

  if (!fs.existsSync(cliSettingsPath)) {
    if (!quiet) console.log(`[OK] settings.json absent: ${cliSettingsPath}`);
    return { changed: false, cliSettingsPath };
  }

  const existingSettings = readJsonObjectWithBomDefense(cliSettingsPath);
  if (existingSettings === null) {
    throw new Error(`Refusing to modify invalid JSON in ${cliSettingsPath}`);
  }

  const curCmd = existingSettings?.statusLine?.command;
  if (typeof curCmd !== 'string' || !curCmd.includes(FEEDER_BASENAME)) {
    if (!quiet) console.log('[OK] settings.json statusLine does not reference agy-statusline-feeder (left untouched)');
    return { changed: false, cliSettingsPath };
  }

  const backup = readJsonSafe(backupPath);
  const nextSettings = { ...existingSettings };
  let action = 'removed';
  if (backup?.previousStatusLine && typeof backup.previousStatusLine === 'object') {
    nextSettings.statusLine = backup.previousStatusLine;
    action = 'restored';
  } else {
    delete nextSettings.statusLine;
  }

  if (dryRun) {
    return { dryRun: true, changed: true, action, cliSettingsPath };
  }

  atomicWriteJson(cliSettingsPath, nextSettings, 0o600);
  if (fs.existsSync(backupPath)) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }

  if (!quiet) {
    console.log(`[OK] statusLine ${action} in ${cliSettingsPath}`);
  }
  return { dryRun: false, changed: true, action, cliSettingsPath };
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: setup-statusline.mjs [--uninstall] [--home <dir>] [--dry-run] [--quiet]');
      process.exit(0);
    }
    if (opts.uninstall) {
      uninstallStatusLineFeeder(opts);
    } else {
      installStatusLineFeeder(opts);
    }
  } catch (err) {
    console.error(`[ERROR] setup-statusline failed: ${err.message}`);
    process.exit(1);
  }
}
