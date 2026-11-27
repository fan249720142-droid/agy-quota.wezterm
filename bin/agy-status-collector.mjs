#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  debugLog,
  ensureCacheDirs,
  getStatusDir,
  loadEndpoints,
  loadModelLimitsCache,
  loadPane,
  loadQuota,
  readJsonSafe,
  releaseLock,
  sanitizePaneId,
  saveEndpoints,
  saveModelLimitsCache,
  savePane,
  saveQuota,
} from './lib/cache.mjs';
import { applyHookUpdate, readStdinAsync } from './lib/hook-handler.mjs';
import {
  buildEndpointCandidates,
  fetchGeneratorMetadata,
  queryQuotaFromLs,
} from './lib/ls-rpc.mjs';
import {
  buildModelIndex,
  buildQuotaPayload,
  resolveModelMetadata,
} from './lib/models.mjs';
import { readConversationFromSqlite } from './lib/sqlite-fallback.mjs';
import { computeContextMetrics, extractLatestRpcUsage } from './lib/usage.mjs';

export function parseArgs(argv) {
  const opts = {
    mode: 'refresh',
    pane: null,
    cwd: null,
    force: false,
    hookEvent: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') {
      opts.mode = 'refresh';
    } else if (arg === '--dump') {
      opts.mode = 'dump';
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--pane' && i + 1 < argv.length) {
      opts.pane = argv[++i];
    } else if (arg.startsWith('--pane=')) {
      opts.pane = arg.slice('--pane='.length);
    } else if (arg === '--cwd' && i + 1 < argv.length) {
      opts.cwd = argv[++i];
    } else if (arg.startsWith('--cwd=')) {
      opts.cwd = arg.slice('--cwd='.length);
    } else if (arg === '--hook') {
      opts.mode = 'hook';
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts.hookEvent = argv[++i];
      }
    } else if (arg.startsWith('--hook=')) {
      opts.mode = 'hook';
      opts.hookEvent = arg.slice('--hook='.length);
    } else if (arg === '-h' || arg === '--help') {
      opts.mode = 'help';
    }
  }

  return opts;
}

async function acquireLockWithRetry(statusDir, force) {
  let lockDir = acquireLock(statusDir);
  if (lockDir || !force) return lockDir;
  // When --force is requested during a transient lock, wait briefly for active refresh.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    lockDir = acquireLock(statusDir);
    if (lockDir) return lockDir;
  }
  return null;
}

/**
 * Refresh `quota.json` and `panes/pane_<id>.json` using LS RPC with read-only SQLite fallback.
 */
export async function runRefresh({
  statusDir = getStatusDir(),
  pane = null,
  cwd = null,
  force = false,
  env = process.env,
  geminiBaseDir = null,
  appDataDir = null,
  rpcTimeoutMs = 2000,
} = {}) {
  const paneId = sanitizePaneId(pane ?? env.WEZTERM_PANE);
  ensureCacheDirs(statusDir);

  const lockDir = await acquireLockWithRetry(statusDir, force);
  if (!lockDir) {
    debugLog(`refresh skipped for pane ${paneId}: lock held`);
    return { ok: true, skipped: true, reason: 'locked', paneId };
  }

  try {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const endpointsStore = loadEndpoints(statusDir);
    const existingQuota = loadQuota(statusDir);
    const existingPane = loadPane(statusDir, paneId);
    const cachedLimits = loadModelLimitsCache(statusDir);

    const candidates = buildEndpointCandidates({
      paneId,
      endpointsStore,
      env,
      geminiBaseDir,
    });

    const lsQuota = await queryQuotaFromLs(candidates, rpcTimeoutMs);

    let quotaPayload = existingQuota;
    let modelIndex = buildModelIndex(null, [], cachedLimits);

    if (lsQuota.ok) {
      quotaPayload = buildQuotaPayload({
        quotaSummaryResp: lsQuota.quotaSummaryResp,
        userStatusResp: lsQuota.userStatusResp,
        availableModelsResp: lsQuota.availableModelsResp,
        existingQuota,
        nowEpoch,
      });
      saveQuota(statusDir, quotaPayload);

      const clientConfigs = lsQuota.userStatusResp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      modelIndex = buildModelIndex(lsQuota.availableModelsResp, clientConfigs, cachedLimits);
      saveModelLimitsCache(statusDir, modelIndex);

      const activeEp = lsQuota.endpoint;
      if (env.ANTIGRAVITY_LS_ADDRESS) {
        const prev = endpointsStore.endpoints[paneId];
        endpointsStore.endpoints[paneId] = {
          ls_address: String(env.ANTIGRAVITY_LS_ADDRESS),
          csrf_token: String(env.ANTIGRAVITY_CSRF_TOKEN || prev?.csrf_token || ''),
          prefer_https: Boolean(activeEp.prefer_https),
          conversation_id: env.ANTIGRAVITY_CONVERSATION_ID
            || existingPane?.conversation_id
            || prev?.conversation_id
            || null,
          pid: prev?.pid || process.ppid || process.pid,
          updated_at: nowEpoch,
        };
        endpointsStore.latest_key = paneId;
        saveEndpoints(statusDir, endpointsStore);
      } else if (
        activeEp.key
        && endpointsStore.endpoints[activeEp.key]
        && Boolean(endpointsStore.endpoints[activeEp.key].prefer_https) !== Boolean(activeEp.prefer_https)
      ) {
        endpointsStore.endpoints[activeEp.key].prefer_https = Boolean(activeEp.prefer_https);
        endpointsStore.endpoints[activeEp.key].updated_at = nowEpoch;
        saveEndpoints(statusDir, endpointsStore);
      }
    }

    const paneEp = endpointsStore.endpoints[paneId];
    let conversationId = existingPane?.conversation_id
      || paneEp?.conversation_id
      || env.ANTIGRAVITY_CONVERSATION_ID
      || null;
    let effectiveCwd = cwd || existingPane?.cwd || null;
    let agentState = existingPane?.agent_state || null;

    let modelId = null;
    let modelDisplayName = null;
    let pool = null;
    let context = null;

    // 1. Official LS RPC trajectory usage when endpoint and conversation_id are available.
    if (lsQuota.ok && conversationId) {
      const gmRes = await fetchGeneratorMetadata(lsQuota.endpoint, conversationId, rpcTimeoutMs);
      if (gmRes.ok && gmRes.items.length > 0) {
        const latestRpc = extractLatestRpcUsage(gmRes.items);
        if (latestRpc) {
          const resolved = resolveModelMetadata({
            modelId: latestRpc.model,
            modelDisplayName: latestRpc.modelDisplayName,
            responseModel: latestRpc.responseModel,
            chatStartMetadata: latestRpc.chatStartMetadata,
            modelIndex,
            modelPools: quotaPayload?.model_pools || {},
          });
          modelId = resolved.model_id;
          modelDisplayName = resolved.model_display_name;
          pool = resolved.pool;
          if (latestRpc.usage) {
            context = computeContextMetrics({
              ...latestRpc.usage,
              contextWindowSize: resolved.context_window_size,
              source: 'ls_rpc',
            });
          }
        }
      }
    }

    // 2. Read-only SQLite fallback if LS RPC failed, conversation_id missing, or RPC had no usage.
    if (!context) {
      const sqliteData = await readConversationFromSqlite({
        conversationId,
        cwd: effectiveCwd,
        appDataDir,
      });
      if (sqliteData) {
        if (!conversationId && sqliteData.conversation_id) {
          conversationId = sqliteData.conversation_id;
        }
        if (!effectiveCwd && sqliteData.cwd) {
          effectiveCwd = sqliteData.cwd;
        }
        const resolved = resolveModelMetadata({
          modelEnumInt: sqliteData.modelEnumInt,
          modelDisplayName: sqliteData.modelDisplayName,
          responseModel: sqliteData.responseModel,
          chatStartMetadata: sqliteData.maxContextTokens
            ? { contextWindowMetadata: { maxContextTokens: sqliteData.maxContextTokens } }
            : null,
          modelIndex,
          modelPools: quotaPayload?.model_pools || {},
        });
        modelId = modelId || resolved.model_id;
        modelDisplayName = modelDisplayName || resolved.model_display_name;
        pool = pool || resolved.pool;
        if (!agentState && sqliteData.agentState) {
          agentState = sqliteData.agentState;
        }
        if (sqliteData.usage) {
          context = computeContextMetrics({
            ...sqliteData.usage,
            contextWindowSize: resolved.context_window_size,
            source: 'sqlite',
          });
        }
      }
    }

    // Re-read pane state on disk before saving so concurrent hook updates aren't clobbered.
    const latestOnDisk = loadPane(statusDir, paneId);
    if (
      latestOnDisk?.conversation_id
      && conversationId
      && latestOnDisk.conversation_id !== conversationId
      && (latestOnDisk.updated_at || 0) > nowEpoch
    ) {
      return { ok: true, skipped: true, reason: 'superseded', paneId };
    }

    const finalConversationId = conversationId || latestOnDisk?.conversation_id || null;
    const preservedContext = finalConversationId && latestOnDisk?.conversation_id === finalConversationId
      ? (latestOnDisk?.context ?? null)
      : null;

    const finalPane = {
      version: 1,
      pane_id: paneId,
      conversation_id: finalConversationId,
      cwd: effectiveCwd || latestOnDisk?.cwd || null,
      model_id: modelId || latestOnDisk?.model_id || null,
      model_display_name: modelDisplayName || latestOnDisk?.model_display_name || null,
      pool: pool || latestOnDisk?.pool || quotaPayload?.default_pool || 'gemini',
      agent_state: latestOnDisk?.agent_state || agentState || 'idle',
      context: context || preservedContext,
      updated_at: nowEpoch,
    };

    savePane(statusDir, paneId, finalPane);
    return { ok: true, paneId, quota: quotaPayload, pane: finalPane };
  } catch (err) {
    debugLog('runRefresh failed', err);
    return { ok: false, error: err, paneId };
  } finally {
    releaseLock(lockDir);
  }
}

/**
 * Dump current cached `quota.json` and `panes/pane_*.json` (never exposing credentials).
 */
export function runDump(statusDir = getStatusDir()) {
  const quota = loadQuota(statusDir);
  const panesDir = path.join(statusDir, 'panes');
  const panes = {};
  try {
    for (const file of fs.readdirSync(panesDir)) {
      if (!file.startsWith('pane_') || !file.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(panesDir, file));
      if (!data) continue;
      const key = data.pane_id || file.slice('pane_'.length, -'.json'.length);
      panes[key] = data;
    }
  } catch {
    // Empty panes map if directory does not exist yet.
  }
  return { status_dir: statusDir, quota, panes };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const statusDir = getStatusDir();

  if (opts.mode === 'help') {
    process.stderr.write(
      'Usage: agy-status-collector.mjs [--refresh [--pane <id>] [--cwd <dir>] [--force]] [--hook <event>] [--dump]\n'
    );
    return;
  }

  if (opts.mode === 'dump') {
    process.stdout.write(JSON.stringify(runDump(statusDir), null, 2) + '\n');
    return;
  }

  if (opts.mode === 'hook') {
    try {
      const raw = await readStdinAsync(200);
      let payload = {};
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = {};
        }
      }
      const event = opts.hookEvent || payload.hookEventName || 'Unknown';
      const { paneId, cwd } = applyHookUpdate({
        hookEvent: event,
        payload,
        env: process.env,
        statusDir,
      });
      await runRefresh({ statusDir, pane: paneId, cwd, force: false });
    } catch (err) {
      debugLog('hook mode failed', err);
    } finally {
      process.stdout.write('{}\n');
    }
    return;
  }

  await runRefresh({
    statusDir,
    pane: opts.pane,
    cwd: opts.cwd,
    force: opts.force,
  });
}

const isEntrypoint = (() => {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    debugLog('collector fatal error', err);
    process.exitCode = 1;
  });
}
