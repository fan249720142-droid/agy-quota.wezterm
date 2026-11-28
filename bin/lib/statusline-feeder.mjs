import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getStatusDir,
  loadEndpoints,
  loadModelLimitsCache,
  loadPane,
  loadQuota,
  resolvePaneId,
  saveEndpoints,
  savePane,
  saveQuota,
} from './cache.mjs';
import {
  buildModelIndex,
  getPoolLabel,
  mergeQuotaPools,
  parseMetaQuotaToPools,
  resolveEffectiveContextLimit,
  resolveModelMetadata,
} from './models.mjs';
import { computeModelTracking, resolveActiveModelState } from './model-tracking.mjs';
import { computeContextMetrics, toNonNegInt } from './usage.mjs';

const LS_REFRESH_INTERVAL_SECS = 15;
const LS_EVENT_MIN_AGE_SECS = 2;

function sanitizeConversationId(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\.\./g, '').replace(/[\\/]/g, '');
  if (!cleaned || cleaned === 'default') return null;
  return cleaned;
}

function resolveMetaCwd(meta) {
  const candidates = [
    meta?.workspace?.current_dir,
    meta?.workspace?.project_dir,
    meta?.project?.path,
    meta?.cwd,
  ];
  for (const cand of candidates) {
    if (typeof cand !== 'string' || !cand.trim()) continue;
    const trimmed = cand.trim();
    if (trimmed.startsWith('file://')) {
      try {
        return fileURLToPath(trimmed);
      } catch {
        continue;
      }
    }
    return trimmed;
  }
  return null;
}

function extractMetaModel(meta) {
  if (!meta?.model) return { modelId: null, displayName: null, raw: null };
  if (typeof meta.model === 'string') {
    const s = meta.model.trim();
    return { modelId: /^MODEL_/i.test(s) ? s : null, displayName: /^MODEL_/i.test(s) ? null : s, raw: s || null };
  }
  if (typeof meta.model === 'object') {
    const displayName = typeof meta.model.display_name === 'string' && meta.model.display_name.trim()
      ? meta.model.display_name.trim()
      : (typeof meta.model.name === 'string' && meta.model.name.trim() ? meta.model.name.trim() : null);
    const id = typeof meta.model.id === 'string' && meta.model.id.trim()
      ? meta.model.id.trim()
      : null;
    return {
      modelId: id && /^MODEL_/i.test(id) ? id : null,
      displayName: displayName || (id && !/^MODEL_/i.test(id) ? id : null),
      raw: displayName || id || null,
    };
  }
  return { modelId: null, displayName: null, raw: null };
}

function normalizeAgentState(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'idle' || s === 'ready') return 'idle';
  if (s === 'error' || s === 'failed') return 'error';
  return 'working';
}

function isWindowExpired(win, nowEpoch) {
  if (!win || typeof win !== 'object') return false;
  return typeof win.reset_epoch === 'number' && win.reset_epoch > 0 && win.reset_epoch <= nowEpoch;
}

/**
 * Ingest Antigravity CLI native `statusLine` JSON (`meta`) and environment credentials into
 * the WezTerm per-pane status cache (`ls_endpoints.json`, `quota.json`, `panes/pane_<id>.json`).
 *
 * Returns `{ paneId, cwd, conversationId, shouldRefreshLs, quota, pane }`.
 */
export function applyStatusLineMeta({
  meta = {},
  pane = null,
  agyPid = null,
  env = process.env,
  statusDir = getStatusDir(env),
  nowMs = Date.now(),
  nowEpoch = Math.floor(nowMs / 1000),
} = {}) {
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const effectiveNowEpoch = Number.isFinite(nowEpoch) ? nowEpoch : Math.floor(effectiveNowMs / 1000);
  const paneId = resolvePaneId(pane, env);

  const existingPane = loadPane(statusDir, paneId);
  const existingQuota = loadQuota(statusDir);
  const endpointsStore = loadEndpoints(statusDir);
  const existingEp = endpointsStore.endpoints[paneId];
  const cachedLimits = loadModelLimitsCache(statusDir);
  const modelIndex = buildModelIndex(null, [], cachedLimits);

  const parsedPid = agyPid !== null && agyPid !== undefined && String(agyPid).trim() !== ''
    ? Number(agyPid)
    : NaN;
  const resolvedAgyPid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
  const pidChanged = Boolean(
    resolvedAgyPid
    && existingPane?.agy_pid
    && Number(resolvedAgyPid) !== Number(existingPane.agy_pid)
  );
  const epPidChanged = Boolean(
    resolvedAgyPid
    && existingEp?.pid
    && Number(resolvedAgyPid) !== Number(existingEp.pid)
  );

  // Strictly block empty / 'default' conversation_id from inheriting stale conversation data.
  const hasConvField = Object.prototype.hasOwnProperty.call(meta || {}, 'conversation_id')
    || Object.prototype.hasOwnProperty.call(meta || {}, 'session_id');
  const conversationId = sanitizeConversationId(meta?.conversation_id || meta?.session_id || '');
  const prevConvId = existingPane?.conversation_id || null;
  const sessionReset = Boolean(
    pidChanged
    || (hasConvField && !conversationId && prevConvId !== null)
    || (conversationId && prevConvId && conversationId !== prevConvId)
  );
  const sameConversation = Boolean(
    !sessionReset
    && (conversationId ? (!prevConvId || prevConvId === conversationId) : !prevConvId)
  );

  const cwd = resolveMetaCwd(meta) || (pidChanged ? null : existingPane?.cwd) || null;

  // 1. Capture live LS endpoint credentials whenever Antigravity CLI injects them.
  const lsAddress = env?.ANTIGRAVITY_LS_ADDRESS || null;
  const csrfToken = env?.ANTIGRAVITY_CSRF_TOKEN || '';
  if (lsAddress) {
    const preferHttps = existingEp?.ls_address === lsAddress
      ? Boolean(existingEp?.prefer_https)
      : false;
    endpointsStore.endpoints[paneId] = {
      ls_address: String(lsAddress),
      csrf_token: String(csrfToken || (existingEp?.ls_address === lsAddress ? existingEp?.csrf_token : '') || ''),
      prefer_https: preferHttps,
      conversation_id: conversationId,
      pid: resolvedAgyPid || process.ppid || process.pid,
      updated_at: effectiveNowEpoch,
    };
    endpointsStore.latest_key = paneId;
    saveEndpoints(statusDir, endpointsStore);
  } else if ((pidChanged || epPidChanged) && existingEp) {
    delete endpointsStore.endpoints[paneId];
    if (endpointsStore.latest_key === paneId) {
      const remaining = Object.entries(endpointsStore.endpoints)
        .sort((a, b) => (b[1]?.updated_at || 0) - (a[1]?.updated_at || 0));
      endpointsStore.latest_key = remaining.length > 0 ? remaining[0][0] : null;
    }
    saveEndpoints(statusDir, endpointsStore);
  }

  // 2. Merge native `meta.quota` into `quota.json` with anti-oscillation and expiry yield.
  const metaPools = parseMetaQuotaToPools(meta?.quota, effectiveNowEpoch);
  const hasMetaPools = Object.keys(metaPools).length > 0;
  let quotaPayload = existingQuota;

  if (hasMetaPools || meta?.plan_tier) {
    const mergedPools = hasMetaPools
      ? mergeQuotaPools(existingQuota?.pools || {}, metaPools, {
        nowEpoch: effectiveNowEpoch,
        preferLowerWhenSameReset: true,
      })
      : (existingQuota?.pools || {});
    const defaultPool = mergedPools.gemini ? 'gemini' : (Object.keys(mergedPools)[0] || 'gemini');
    const prevSource = existingQuota?.source;
    const source = hasMetaPools
      ? (prevSource === 'ls_rpc' || prevSource === 'statusline+ls_rpc' ? 'statusline+ls_rpc' : 'statusline')
      : (prevSource || 'statusline');

    quotaPayload = {
      version: 1,
      fetched_at: hasMetaPools ? effectiveNowEpoch : (existingQuota?.fetched_at || effectiveNowEpoch),
      last_poll_attempt_at: existingQuota?.last_poll_attempt_at || effectiveNowEpoch,
      ls_fetched_at: existingQuota?.ls_fetched_at || (prevSource === 'ls_rpc' ? existingQuota?.fetched_at : null) || null,
      source,
      plan_tier: meta?.plan_tier || meta?.account?.plan_tier || existingQuota?.plan_tier || null,
      default_pool: defaultPool,
      pools: mergedPools,
      model_pools: existingQuota?.model_pools || {},
    };
    saveQuota(statusDir, quotaPayload);
  }

  // 3. Resolve active model & quota pool.
  const metaModel = extractMetaModel(meta);
  const modelTracking = computeModelTracking({
    prevPane: sessionReset ? null : existingPane,
    conversationId,
    settingsInfo: undefined,
    hookInput: metaModel.raw ? { model: metaModel.raw, at: effectiveNowMs } : null,
    stepInput: null,
    sessionReset,
    nowMs: effectiveNowMs,
  });

  const activeModel = resolveActiveModelState({
    modelTracking,
    prevPane: sessionReset ? null : existingPane,
    sameConversation,
    modelIndex,
    modelPools: quotaPayload?.model_pools || {},
    defaultPool: quotaPayload?.default_pool || 'gemini',
  });

  // 4. Compute context & prompt cache metrics from `meta.context_window`.
  const cw = meta?.context_window && typeof meta.context_window === 'object' ? meta.context_window : null;
  const cu = cw?.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;

  const totalInput = toNonNegInt(cw?.total_input_tokens);
  const totalOutput = toNonNegInt(cw?.total_output_tokens);
  const cuInput = toNonNegInt(cu?.input_tokens);
  const cuOutput = toNonNegInt(cu?.output_tokens);
  const cuCacheRead = toNonNegInt(cu?.cache_read_input_tokens);
  const cuCacheCreate = toNonNegInt(cu?.cache_creation_input_tokens);

  const metaPhysWin = Number(cw?.context_window_size) > 0 ? Math.trunc(Number(cw.context_window_size)) : null;
  const physicalWindowSize = metaPhysWin || activeModel.context_window_size || null;
  const nativeCompactionLimit = cw?.compaction_threshold
    ?? cw?.compaction_token_limit
    ?? cw?.compact_threshold
    ?? cw?.effective_context_window_size
    ?? null;

  const prevCtx = sameConversation && existingPane?.context && existingPane.context.source !== 'initial'
    ? existingPane.context
    : null;
  const prevCachedPct = (prevCtx && typeof prevCtx.cached_pct === 'number')
    ? prevCtx.cached_pct
    : null;
  const runtimeMaxContextTokens = sameConversation
    ? (existingPane?.runtime_max_context_tokens || 0)
    : 0;

  let context;
  if (!conversationId) {
    // Blank welcome screen: never inherit old conversation tokens.
    const effLimit = resolveEffectiveContextLimit({
      usedTokens: 0,
      physicalWindowSize,
      nativeCompactionLimit,
      catalogCompactionLimit: activeModel.compaction_limit || 0,
      env,
    });
    context = computeContextMetrics({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindowSize: physicalWindowSize,
      effectiveContextLimit: effLimit,
      source: 'initial',
    });
  } else if (totalInput > 0 || totalOutput > 0 || (cuInput + cuCacheRead + cuCacheCreate + cuOutput) > 0) {
    // Use total_input_tokens when provided (matches Antigravity CLI compaction tracking),
    // falling back to current_usage sum if total_input_tokens is 0.
    const cuSum = cuInput + cuCacheCreate + cuCacheRead + cuOutput;
    const usedTokens = totalInput > 0 ? totalInput : cuSum;
    const effLimit = resolveEffectiveContextLimit({
      usedTokens,
      physicalWindowSize,
      nativeCompactionLimit,
      runtimeMaxContextTokens,
      catalogCompactionLimit: activeModel.compaction_limit || 0,
      env,
      rememberedCeiling: prevCtx?.effective_context_limit || 0,
    });
    const cuPrompt = cuInput + cuCacheCreate + cuCacheRead;
    context = computeContextMetrics({
      inputTokens: cuPrompt > 0 ? cuInput : 0,
      outputTokens: cu ? cuOutput : totalOutput,
      cacheReadTokens: cuPrompt > 0 ? cuCacheRead : 0,
      cacheCreationTokens: cuPrompt > 0 ? cuCacheCreate : 0,
      usedTokensOverride: usedTokens,
      cachedPctOverride: prevCachedPct,
      contextWindowSize: physicalWindowSize,
      effectiveContextLimit: effLimit,
      source: 'statusline',
    });
  } else if (prevCtx) {
    const effLimit = resolveEffectiveContextLimit({
      usedTokens: prevCtx.used_tokens || 0,
      physicalWindowSize: physicalWindowSize || prevCtx.context_window_size,
      nativeCompactionLimit,
      runtimeMaxContextTokens,
      catalogCompactionLimit: activeModel.compaction_limit || 0,
      env,
      rememberedCeiling: prevCtx.effective_context_limit || 0,
    });
    context = computeContextMetrics({
      inputTokens: prevCtx.input_tokens || 0,
      outputTokens: prevCtx.output_tokens || 0,
      cacheReadTokens: prevCtx.cache_read_tokens || 0,
      cacheCreationTokens: prevCtx.cache_creation_tokens || 0,
      usedTokensOverride: prevCtx.used_tokens,
      cachedPctOverride: prevCtx.cached_pct,
      contextWindowSize: physicalWindowSize || prevCtx.context_window_size,
      effectiveContextLimit: effLimit,
      source: prevCtx.source,
    });
  } else {
    const effLimit = resolveEffectiveContextLimit({
      usedTokens: 0,
      physicalWindowSize,
      nativeCompactionLimit,
      runtimeMaxContextTokens,
      catalogCompactionLimit: activeModel.compaction_limit || 0,
      env,
    });
    context = computeContextMetrics({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindowSize: physicalWindowSize,
      effectiveContextLimit: effLimit,
      source: 'initial',
    });
  }

  const prevAgentState = sameConversation ? existingPane?.agent_state : null;
  const agentState = normalizeAgentState(meta?.agent_state) || prevAgentState || 'idle';

  const panePayload = {
    version: 1,
    pane_id: paneId,
    agy_pid: resolvedAgyPid || (!pidChanged ? (existingPane?.agy_pid ?? null) : null),
    conversation_id: conversationId,
    cwd,
    model_id: activeModel.model_id,
    model_display_name: activeModel.model_display_name,
    pool: activeModel.pool,
    pool_label: activeModel.pool_label || getPoolLabel(activeModel.pool),
    model_tracking: modelTracking,
    agent_state: agentState,
    generator_metadata_offset: sameConversation ? (existingPane?.generator_metadata_offset || 0) : 0,
    runtime_max_context_tokens: runtimeMaxContextTokens || null,
    context,
    updated_at: effectiveNowEpoch,
  };

  savePane(statusDir, paneId, panePayload);

  // 5. Decide whether to spawn a detached LS RPC collector refresh (to enrich dual-pool quotas,
  //    checkpointer model_limits.json, and runtime maxContextTokens).
  const activePoolObj = quotaPayload?.pools?.[activeModel.pool];
  const missingPoolWindow = !activePoolObj
    || activePoolObj.five_hour?.remaining_pct === null
    || activePoolObj.five_hour?.remaining_pct === undefined
    || activePoolObj.weekly?.remaining_pct === null
    || activePoolObj.weekly?.remaining_pct === undefined;
  const hasExpiredActive = isWindowExpired(activePoolObj?.five_hour, effectiveNowEpoch)
    || isWindowExpired(activePoolObj?.weekly, effectiveNowEpoch);
  const missingCompactionCatalog = Boolean(
    activeModel.model_display_name && !activeModel.compaction_limit && !runtimeMaxContextTokens
  );
  const stateBecameIdle = agentState === 'idle' && prevAgentState && prevAgentState !== 'idle';
  const tokensChanged = Boolean(
    context?.used_tokens > 0
    && prevCtx
    && context.used_tokens !== prevCtx.used_tokens
  );

  const lastLsAt = quotaPayload?.ls_fetched_at
    || (quotaPayload?.source === 'ls_rpc' ? quotaPayload?.fetched_at : 0)
    || 0;
  const lastAttemptAt = quotaPayload?.last_poll_attempt_at || 0;
  const lsAge = effectiveNowEpoch - lastLsAt;
  const attemptAge = effectiveNowEpoch - lastAttemptAt;
  const hasEndpoint = Boolean(lsAddress || endpointsStore.endpoints[paneId] || endpointsStore.latest_key);

  let shouldRefreshLs = false;
  if (hasEndpoint) {
    if (!lastLsAt || lsAge >= LS_REFRESH_INTERVAL_SECS) {
      if (!lastAttemptAt || attemptAge >= LS_REFRESH_INTERVAL_SECS) {
        shouldRefreshLs = true;
      }
    } else if (hasExpiredActive && attemptAge >= 5) {
      shouldRefreshLs = true;
    } else if ((stateBecameIdle || tokensChanged || missingPoolWindow || missingCompactionCatalog) && attemptAge >= LS_EVENT_MIN_AGE_SECS) {
      shouldRefreshLs = true;
    }
  }

  return {
    paneId,
    cwd,
    conversationId,
    agyPid: resolvedAgyPid,
    shouldRefreshLs,
    quota: quotaPayload,
    pane: panePayload,
  };
}

/**
 * Build a cross-platform `statusLine.command` string for Antigravity CLI settings.json.
 */
export function buildStatusLineCommand(
  feederScriptPath,
  platform = process.platform,
  execPath = process.execPath
) {
  const cleanPath = String(feederScriptPath || '').replace(/^"(.*)"$/, '$1');
  if (platform === 'win32') {
    if (cleanPath.includes(' ')) {
      const normalized = cleanPath.replace(/\\/g, '/').replace(/^\//, '').replace(/ /g, '%20');
      return `node --import file:///${normalized} -e 0`;
    }
    return `node ${cleanPath}`;
  }
  const nodeBin = execPath.includes(' ') ? `"${execPath}"` : execPath;
  const scriptArg = cleanPath.includes(' ') ? `"${cleanPath}"` : cleanPath;
  return `${nodeBin} ${scriptArg}`;
}
