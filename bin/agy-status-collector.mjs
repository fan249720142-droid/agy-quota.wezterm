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
  pruneEndpoint,
  readJsonSafe,
  releaseLock,
  resolvePaneId,
  saveEndpoints,
  saveModelLimitsCache,
  savePane,
  saveQuota,
} from './lib/cache.mjs';
import { findAgyPidByTty, findAncestorAgyPid, inspectAgyProcess } from './lib/agy-live.mjs';
import { applyHookUpdate, readStdinAsync } from './lib/hook-handler.mjs';
import {
  buildEndpointCandidates,
  fetchGeneratorMetadata,
  queryQuotaFromLs,
} from './lib/ls-rpc.mjs';
import {
  buildModelIndex,
  buildQuotaPayload,
  resolveEffectiveContextLimit,
  resolveModelMetadata,
} from './lib/models.mjs';
import {
  computeModelTracking,
  readActiveSettingsModel,
  resolveActiveModelState,
} from './lib/model-tracking.mjs';
import { readConversationFromSqlite } from './lib/sqlite-fallback.mjs';
import { computeContextMetrics, extractLatestRpcUsage } from './lib/usage.mjs';

export function parseArgs(argv) {
  const opts = {
    mode: 'refresh',
    pane: null,
    cwd: null,
    agyPid: null,
    tty: null,
    conversationId: null,
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
    } else if (arg === '--agy-pid' && i + 1 < argv.length) {
      opts.agyPid = argv[++i];
    } else if (arg.startsWith('--agy-pid=')) {
      opts.agyPid = arg.slice('--agy-pid='.length);
    } else if (arg === '--tty' && i + 1 < argv.length) {
      opts.tty = argv[++i];
    } else if (arg.startsWith('--tty=')) {
      opts.tty = arg.slice('--tty='.length);
    } else if (arg === '--conversation-id' && i + 1 < argv.length) {
      opts.conversationId = argv[++i];
    } else if (arg.startsWith('--conversation-id=')) {
      opts.conversationId = arg.slice('--conversation-id='.length);
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
  statusDir = null,
  pane = null,
  cwd = null,
  conversationId: explicitConversationId = null,
  force = false,
  env = process.env,
  geminiBaseDir = null,
  appDataDir = null,
  cliSettingsPath = null,
  rpcTimeoutMs = 2000,
  nowMs = Date.now(),
  agyPid = null,
  tty = null,
  inspectProcessFn = null,
  procRoot = '/proc',
} = {}) {
  const effectiveStatusDir = statusDir || getStatusDir(env);
  const paneId = resolvePaneId(pane, env);
  ensureCacheDirs(effectiveStatusDir);

  const lockDir = await acquireLockWithRetry(effectiveStatusDir, force);
  if (!lockDir) {
    debugLog(`refresh skipped for pane ${paneId}: lock held`);
    return { ok: true, skipped: true, reason: 'locked', paneId };
  }

  try {
    const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const nowEpoch = Math.floor(effectiveNowMs / 1000);
    const endpointsStore = loadEndpoints(effectiveStatusDir);
    const existingQuota = loadQuota(effectiveStatusDir);
    const existingPane = loadPane(effectiveStatusDir, paneId);
    const cachedLimits = loadModelLimitsCache(effectiveStatusDir);

    const parsedAgyPid = agyPid !== null && agyPid !== undefined && String(agyPid).trim() !== ''
      ? Number(agyPid)
      : NaN;
    const explicitPid = Number.isInteger(parsedAgyPid) && parsedAgyPid > 0 ? parsedAgyPid : null;
    const ttyPid = !explicitPid && tty ? findAgyPidByTty(tty, procRoot) : null;
    const resolvedAgyPid = explicitPid || ttyPid || (!tty ? existingPane?.agy_pid : null) || null;

    const inspector = inspectProcessFn || inspectAgyProcess;
    const liveProc = resolvedAgyPid ? inspector(resolvedAgyPid, { procRoot }) : null;
    const activeLivePid = liveProc?.alive
      ? (liveProc.pid || resolvedAgyPid)
      : (explicitPid || ttyPid || null);
    const pidChanged = Boolean(
      activeLivePid
      && existingPane?.agy_pid
      && Number(activeLivePid) !== Number(existingPane.agy_pid)
    );

    // Evict dead cached endpoint for this pane when PID changed without fresh env credentials.
    if (
      pidChanged
      && !env.ANTIGRAVITY_LS_ADDRESS
      && endpointsStore.endpoints[paneId]
      && (!endpointsStore.endpoints[paneId].pid || Number(endpointsStore.endpoints[paneId].pid) !== Number(activeLivePid))
    ) {
      pruneEndpoint(effectiveStatusDir, paneId);
      delete endpointsStore.endpoints[paneId];
    }

    const candidates = buildEndpointCandidates({
      paneId,
      endpointsStore,
      env,
      geminiBaseDir,
    });

    const lsQuota = await queryQuotaFromLs(candidates, rpcTimeoutMs);
    if (Array.isArray(lsQuota.deadKeys) && lsQuota.deadKeys.length > 0) {
      for (const deadKey of lsQuota.deadKeys) {
        pruneEndpoint(effectiveStatusDir, deadKey);
        delete endpointsStore.endpoints[deadKey];
      }
    }

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
      saveQuota(effectiveStatusDir, quotaPayload);

      const clientConfigs = lsQuota.userStatusResp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      modelIndex = buildModelIndex(lsQuota.availableModelsResp, clientConfigs, cachedLimits);
      saveModelLimitsCache(effectiveStatusDir, modelIndex);

      const activeEp = lsQuota.endpoint;
      if (env.ANTIGRAVITY_LS_ADDRESS) {
        const prev = endpointsStore.endpoints[paneId];
        endpointsStore.endpoints[paneId] = {
          ls_address: String(env.ANTIGRAVITY_LS_ADDRESS),
          csrf_token: String(env.ANTIGRAVITY_CSRF_TOKEN || prev?.csrf_token || ''),
          prefer_https: Boolean(activeEp.prefer_https),
          conversation_id: explicitConversationId
            || liveProc?.conversationId
            || (pidChanged ? null : (existingPane?.conversation_id || prev?.conversation_id))
            || env.ANTIGRAVITY_CONVERSATION_ID
            || null,
          pid: activeLivePid || (pidChanged ? null : prev?.pid) || process.ppid || process.pid,
          updated_at: nowEpoch,
        };
        endpointsStore.latest_key = paneId;
        saveEndpoints(effectiveStatusDir, endpointsStore);
      } else if (
        activeEp.key
        && endpointsStore.endpoints[activeEp.key]
        && Boolean(endpointsStore.endpoints[activeEp.key].prefer_https) !== Boolean(activeEp.prefer_https)
      ) {
        endpointsStore.endpoints[activeEp.key].prefer_https = Boolean(activeEp.prefer_https);
        endpointsStore.endpoints[activeEp.key].updated_at = nowEpoch;
        saveEndpoints(effectiveStatusDir, endpointsStore);
      }
    } else if (existingQuota) {
      // Record failed attempt timestamp so WezTerm backs off instead of respawning every 2s.
      quotaPayload = { ...existingQuota, last_poll_attempt_at: nowEpoch };
      saveQuota(effectiveStatusDir, quotaPayload);
    }

    const paneEp = endpointsStore.endpoints[paneId];
    let conversationId = liveProc?.inspected
      ? (explicitConversationId || liveProc.conversationId || null)
      : (explicitConversationId
        || (pidChanged ? null : existingPane?.conversation_id)
        || (!pidChanged ? paneEp?.conversation_id : null)
        || env.ANTIGRAVITY_CONVERSATION_ID
        || null);
    let effectiveCwd = cwd || liveProc?.cwd || (pidChanged ? null : existingPane?.cwd) || null;
    let sqliteAgentState = null;

    let stepResolved = null;
    let stepCount = 0;
    let stepUsage = null;
    let nextGenOffset = 0;
    let runtimeMaxContextTokens = 0;

    const canReuseOffset = Boolean(
      !pidChanged
      && conversationId
      && existingPane?.conversation_id === conversationId
      && typeof existingPane?.generator_metadata_offset === 'number'
      && existingPane.generator_metadata_offset > 0
    );
    const startOffset = canReuseOffset ? existingPane.generator_metadata_offset : 0;

    // 1. Official LS RPC trajectory usage when endpoint and conversation_id are available.
    if (lsQuota.ok && conversationId) {
      const gmRes = await fetchGeneratorMetadata(lsQuota.endpoint, conversationId, rpcTimeoutMs, { startOffset });
      if (gmRes.ok) {
        nextGenOffset = gmRes.nextOffset || 0;
        if (gmRes.items.length > 0) {
          const latestRpc = extractLatestRpcUsage(gmRes.items);
          if (latestRpc) {
            stepResolved = resolveModelMetadata({
              modelId: latestRpc.model,
              modelDisplayName: latestRpc.modelDisplayName,
              responseModel: latestRpc.responseModel,
              chatStartMetadata: latestRpc.chatStartMetadata,
              modelIndex,
              modelPools: quotaPayload?.model_pools || {},
              defaultPool: quotaPayload?.default_pool || 'gemini',
            });
            stepCount = Math.max(gmRes.nextOffset || 0, gmRes.items.length);
            runtimeMaxContextTokens = stepResolved.runtime_max_context_tokens || 0;
            if (latestRpc.usage) {
              stepUsage = {
                usage: latestRpc.usage,
                windowSize: stepResolved.context_window_size,
                compactionLimit: stepResolved.compaction_limit,
                runtimeMaxContextTokens,
                source: 'ls_rpc',
              };
            }
          }
        }
      }
    }

    // 2. Read-only SQLite fallback if LS RPC failed or had no usage.
    // Never fall back to arbitrary cwd DBs when live inspection confirms no conversation is open or PID changed without conversationId.
    const allowSqliteFallback = Boolean(
      conversationId
      || (!(liveProc?.inspected && !liveProc.conversationId) && !pidChanged)
    );
    if (!stepUsage && allowSqliteFallback) {
      const sqliteData = await readConversationFromSqlite({
        conversationId,
        cwd: effectiveCwd,
        appDataDir,
        env,
      });
      if (sqliteData) {
        if (!conversationId && sqliteData.conversation_id) {
          conversationId = sqliteData.conversation_id;
        }
        if (!effectiveCwd && sqliteData.cwd) {
          effectiveCwd = sqliteData.cwd;
        }
        if (sqliteData.agentState) {
          sqliteAgentState = sqliteData.agentState;
        }
        const sqliteResolved = resolveModelMetadata({
          modelEnumInt: sqliteData.modelEnumInt,
          modelDisplayName: sqliteData.modelDisplayName,
          responseModel: sqliteData.responseModel,
          chatStartMetadata: sqliteData.maxContextTokens
            ? { contextWindowMetadata: { maxContextTokens: sqliteData.maxContextTokens } }
            : null,
          modelIndex,
          modelPools: quotaPayload?.model_pools || {},
          defaultPool: quotaPayload?.default_pool || 'gemini',
        });
        if (!stepResolved && (sqliteData.modelEnumInt || sqliteData.modelDisplayName || sqliteData.responseModel)) {
          stepResolved = sqliteResolved;
          stepCount = sqliteData.stepCount || 0;
        }
        if (!runtimeMaxContextTokens && sqliteResolved.runtime_max_context_tokens) {
          runtimeMaxContextTokens = sqliteResolved.runtime_max_context_tokens;
        }
        if (sqliteData.usage) {
          stepUsage = {
            usage: sqliteData.usage,
            windowSize: sqliteResolved.context_window_size,
            compactionLimit: sqliteResolved.compaction_limit,
            runtimeMaxContextTokens: sqliteResolved.runtime_max_context_tokens || runtimeMaxContextTokens,
            source: 'sqlite',
          };
        }
      }
    }

    // Re-read pane state on disk before saving so concurrent hook / statusline updates aren't clobbered.
    const latestOnDisk = loadPane(effectiveStatusDir, paneId);
    if (
      latestOnDisk?.conversation_id
      && conversationId
      && latestOnDisk.conversation_id !== conversationId
      && (latestOnDisk.updated_at || 0) > nowEpoch
    ) {
      return { ok: true, skipped: true, reason: 'superseded', paneId };
    }

    const prevConvId = latestOnDisk?.conversation_id ?? existingPane?.conversation_id ?? null;
    const finalConversationId = liveProc?.inspected
      ? (conversationId || null)
      : (conversationId || (pidChanged ? null : latestOnDisk?.conversation_id) || null);
    const finalCwd = effectiveCwd || (pidChanged ? null : latestOnDisk?.cwd) || null;

    const sessionReset = Boolean(
      pidChanged
      || (prevConvId !== null && (finalConversationId || null) !== prevConvId)
    );
    const sameConversation = Boolean(
      !sessionReset
      && (finalConversationId
        ? (!latestOnDisk?.conversation_id || latestOnDisk.conversation_id === finalConversationId)
        : !latestOnDisk?.conversation_id)
    );
    const baselinePane = (!sessionReset && latestOnDisk && sameConversation)
      ? latestOnDisk
      : existingPane;

    const settingsInfo = readActiveSettingsModel({
      cwd: finalCwd,
      cliSettingsPath,
      appDataDir,
      geminiBaseDir,
      env,
    });

    const stepModelName = stepResolved
      ? (stepResolved.model_display_name || stepResolved.model_id)
      : null;

    const modelTracking = computeModelTracking({
      prevPane: baselinePane,
      conversationId: finalConversationId,
      settingsInfo,
      hookInput: null,
      stepInput: stepModelName && stepCount > 0 ? { model: stepModelName, stepCount } : null,
      sessionReset,
      nowMs: effectiveNowMs,
    });

    const activeModel = resolveActiveModelState({
      modelTracking,
      stepResolved,
      prevPane: baselinePane,
      sameConversation,
      modelIndex,
      modelPools: quotaPayload?.model_pools || {},
      defaultPool: quotaPayload?.default_pool || 'gemini',
    });

    const preservedContext = (
      sameConversation
      && finalConversationId
      && latestOnDisk?.conversation_id === finalConversationId
      && latestOnDisk?.context
      && latestOnDisk.context.source !== 'initial'
    )
      ? latestOnDisk.context
      : null;

    const effectiveRuntimeMax = runtimeMaxContextTokens
      || activeModel.runtime_max_context_tokens
      || (sameConversation ? (baselinePane?.runtime_max_context_tokens || 0) : 0);
    const catalogCompactionLimit = stepUsage?.compactionLimit || activeModel.compaction_limit || 0;
    const prevCachedPct = (
      sameConversation
      && baselinePane?.context
      && baselinePane.context.source !== 'initial'
      && typeof baselinePane.context.cached_pct === 'number'
    )
      ? baselinePane.context.cached_pct
      : null;

    let context = null;
    if (stepUsage) {
      const physWin = stepUsage.windowSize || activeModel.context_window_size || null;
      const usedEst = (stepUsage.usage.inputTokens || 0)
        + (stepUsage.usage.cacheCreationTokens || 0)
        + (stepUsage.usage.cacheReadTokens || 0)
        + (stepUsage.usage.outputTokens || 0);
      const effLimit = resolveEffectiveContextLimit({
        usedTokens: usedEst,
        physicalWindowSize: physWin,
        runtimeMaxContextTokens: stepUsage.runtimeMaxContextTokens || effectiveRuntimeMax,
        catalogCompactionLimit,
        env,
        rememberedCeiling: sameConversation ? (baselinePane?.context?.effective_context_limit || 0) : 0,
      });
      context = computeContextMetrics({
        ...stepUsage.usage,
        cachedPctOverride: prevCachedPct,
        contextWindowSize: physWin,
        effectiveContextLimit: effLimit,
        source: stepUsage.source,
      });
    } else if (preservedContext) {
      const physWin = preservedContext.context_window_size || activeModel.context_window_size || null;
      const effLimit = resolveEffectiveContextLimit({
        usedTokens: preservedContext.used_tokens || 0,
        physicalWindowSize: physWin,
        runtimeMaxContextTokens: effectiveRuntimeMax,
        catalogCompactionLimit,
        env,
        rememberedCeiling: preservedContext.effective_context_limit || 0,
      });
      context = computeContextMetrics({
        inputTokens: preservedContext.input_tokens || 0,
        outputTokens: preservedContext.output_tokens || 0,
        cacheReadTokens: preservedContext.cache_read_tokens || 0,
        cacheCreationTokens: preservedContext.cache_creation_tokens || 0,
        usedTokensOverride: preservedContext.used_tokens,
        cachedPctOverride: preservedContext.cached_pct,
        contextWindowSize: physWin,
        effectiveContextLimit: effLimit,
        source: preservedContext.source,
      });
    } else {
      const physWin = activeModel.context_window_size || null;
      const effLimit = resolveEffectiveContextLimit({
        usedTokens: 0,
        physicalWindowSize: physWin,
        runtimeMaxContextTokens: effectiveRuntimeMax,
        catalogCompactionLimit,
        env,
      });
      context = computeContextMetrics({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindowSize: physWin,
        effectiveContextLimit: effLimit,
        source: 'initial',
      });
    }

    const agentStateOnDisk = (!sessionReset && latestOnDisk?.conversation_id === finalConversationId)
      ? latestOnDisk?.agent_state
      : null;
    const finalAgentState = agentStateOnDisk
      || (sameConversation ? (existingPane?.agent_state || sqliteAgentState) : sqliteAgentState)
      || 'idle';

    const finalGenOffset = sameConversation
      ? Math.max(nextGenOffset, baselinePane?.generator_metadata_offset || 0)
      : nextGenOffset;

    const finalPane = {
      version: 1,
      pane_id: paneId,
      agy_pid: activeLivePid || (!pidChanged ? (latestOnDisk?.agy_pid ?? existingPane?.agy_pid ?? null) : null),
      conversation_id: finalConversationId,
      cwd: finalCwd,
      model_id: activeModel.model_id,
      model_display_name: activeModel.model_display_name,
      pool: activeModel.pool,
      pool_label: activeModel.pool_label,
      model_tracking: modelTracking,
      agent_state: finalAgentState,
      generator_metadata_offset: finalGenOffset,
      runtime_max_context_tokens: effectiveRuntimeMax || null,
      context,
      updated_at: nowEpoch,
    };

    savePane(effectiveStatusDir, paneId, finalPane);
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
      'Usage: agy-status-collector.mjs [--refresh [--pane <id>] [--cwd <dir>] [--agy-pid <pid>] [--tty <path>] [--conversation-id <cid>] [--force]] [--hook <event>] [--dump]\n'
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
      const agyPid = findAncestorAgyPid();
      const { paneId, cwd, conversationId } = applyHookUpdate({
        hookEvent: event,
        payload,
        agyPid,
        env: process.env,
        statusDir,
      });
      await runRefresh({
        statusDir,
        pane: paneId,
        cwd,
        conversationId,
        agyPid,
        force: true,
      });
    } catch (err) {
      debugLog('hook mode failed', err);
    } finally {
      process.stdout.write('{}\n');
    }
    return;
  }

  const agyPid = opts.agyPid || (!opts.tty ? findAncestorAgyPid() : null);
  await runRefresh({
    statusDir,
    pane: opts.pane,
    cwd: opts.cwd,
    conversationId: opts.conversationId,
    agyPid,
    tty: opts.tty,
    force: opts.force,
  });
}

const isEntrypoint = (() => {
  try {
    if (!process.argv[1]) return false;
    const realArgv = fs.realpathSync(process.argv[1]);
    const realSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? realArgv.toLowerCase() === realSelf.toLowerCase()
      : realArgv === realSelf;
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
