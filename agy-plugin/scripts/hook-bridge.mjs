#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function resolveRepoPaths() {
  let selfPath;
  try {
    selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    selfPath = fileURLToPath(import.meta.url);
  }
  const realRepoRoot = path.resolve(path.dirname(selfPath), '..', '..');
  const fallbackRepoRoot = path.join(os.homedir(), 'agy-quota.wezterm');
  const repoRoot = fs.existsSync(path.join(realRepoRoot, 'bin', 'lib', 'hook-handler.mjs'))
    ? realRepoRoot
    : fallbackRepoRoot;

  const defaultCollector = path.join(repoRoot, 'bin', 'agy-status-collector.mjs');
  const collectorOverride = process.env.WEZTERM_AGY_COLLECTOR_BIN;
  const collectorPath = collectorOverride && fs.existsSync(collectorOverride)
    ? collectorOverride
    : defaultCollector;

  return {
    hookHandlerPath: path.join(repoRoot, 'bin', 'lib', 'hook-handler.mjs'),
    cachePath: path.join(repoRoot, 'bin', 'lib', 'cache.mjs'),
    agyLivePath: path.join(repoRoot, 'bin', 'lib', 'agy-live.mjs'),
    collectorPath,
  };
}

async function run() {
  const { hookHandlerPath, cachePath, agyLivePath, collectorPath } = resolveRepoPaths();
  let debugLog = (msg, err) => {
    if (process.env.WEZTERM_AGY_DEBUG === '1') {
      process.stderr.write(`[agy-hook] ${msg}: ${err?.message || err}\n`);
    }
  };

  try {
    const [{ applyHookUpdate, readStdinAsync }, cacheMod, agyLiveMod] = await Promise.all([
      import(pathToFileURL(hookHandlerPath).href),
      import(pathToFileURL(cachePath).href),
      fs.existsSync(agyLivePath)
        ? import(pathToFileURL(agyLivePath).href).catch(() => null)
        : Promise.resolve(null),
    ]);
    debugLog = cacheMod.debugLog;

    const raw = await readStdinAsync(150);
    let payload = {};
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') payload = parsed;
      } catch (err) {
        debugLog('invalid hook stdin JSON', err);
      }
    }

    let agyPid = null;
    try {
      agyPid = agyLiveMod?.findAncestorAgyPid?.() || null;
    } catch {
      agyPid = null;
    }

    const hookEvent = process.argv[2] || payload.hookEventName || 'Unknown';
    const statusDir = cacheMod.getStatusDir();
    const { paneId, cwd } = applyHookUpdate({
      hookEvent,
      payload,
      env: process.env,
      statusDir,
      agyPid,
    });

    const explicitConvId = payload.conversationId
      || payload.conversation_id
      || payload.cascadeId
      || process.env.ANTIGRAVITY_CONVERSATION_ID
      || null;

    if (fs.existsSync(collectorPath)) {
      const args = [collectorPath, '--refresh', '--force', '--pane', paneId];
      if (cwd) {
        args.push('--cwd', cwd);
      }
      if (agyPid) {
        args.push('--agy-pid', String(agyPid));
      }
      if (explicitConvId) {
        args.push('--conversation-id', String(explicitConvId));
      }
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
      });
      child.on('error', (err) => debugLog('collector spawn error', err));
      child.unref();
    }
  } catch (err) {
    debugLog('hook-bridge failure', err);
  } finally {
    process.stdout.write('{}\n');
    process.exitCode = 0;
  }
}

await run();
