#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog, getStatusDir, stripUtf8Bom } from './lib/cache.mjs';
import { findAncestorAgyPid } from './lib/agy-live.mjs';
import { readStdinAsync } from './lib/hook-handler.mjs';
import { applyStatusLineMeta } from './lib/statusline-feeder.mjs';

function resolveCollectorPath() {
  const override = process.env.WEZTERM_AGY_COLLECTOR_BIN;
  if (override && fs.existsSync(override)) {
    return override;
  }
  let selfPath;
  try {
    selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    selfPath = fileURLToPath(import.meta.url);
  }
  return path.join(path.dirname(selfPath), 'agy-status-collector.mjs');
}

async function main() {
  if (process.env.DISABLE_QUOTA_HOOK === '1' || process.env.WEZTERM_AGY_FEEDER_DISABLED === '1') {
    return;
  }

  try {
    const raw = stripUtf8Bom(await readStdinAsync(150));
    let meta = {};
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          meta = parsed;
        }
      } catch (err) {
        debugLog('statusline-feeder invalid stdin JSON', err);
      }
    }

    let agyPid = null;
    try {
      agyPid = findAncestorAgyPid();
    } catch {
      agyPid = null;
    }

    const statusDir = getStatusDir();
    const res = applyStatusLineMeta({
      meta,
      agyPid,
      env: process.env,
      statusDir,
    });

    if (res.shouldRefreshLs) {
      const collectorPath = resolveCollectorPath();
      if (fs.existsSync(collectorPath)) {
        const args = [collectorPath, '--refresh', '--pane', res.paneId];
        if (res.cwd) {
          args.push('--cwd', res.cwd);
        }
        if (res.agyPid) {
          args.push('--agy-pid', String(res.agyPid));
        }
        if (res.conversationId) {
          args.push('--conversation-id', res.conversationId);
        }
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, DISABLE_QUOTA_HOOK: '1' },
          windowsHide: true,
        });
        child.on('error', (err) => debugLog('statusline-feeder collector spawn error', err));
        child.unref();
      }
    }
  } catch (err) {
    debugLog('statusline-feeder failure', err);
  } finally {
    // Silent output: keep Antigravity CLI's built-in single-line status bar clean while
    // WezTerm's native bottom status bar renders the full 2-line TrueColor telemetry.
    process.exitCode = 0;
  }
}

await main();
