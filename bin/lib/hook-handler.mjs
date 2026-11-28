import {
  getStatusDir,
  loadEndpoints,
  loadModelLimitsCache,
  loadPane,
  loadQuota,
  resolvePaneId,
  saveEndpoints,
  savePane,
} from './cache.mjs';
import { buildModelIndex } from './models.mjs';
import { computeModelTracking, resolveActiveModelState } from './model-tracking.mjs';

export function readStdinAsync(timeoutMs = 200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onErr);
      try {
        process.stdin.pause();
      } catch {
        // Ignore pause errors.
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => finish();
    const onErr = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
    process.stdin.resume();
  });
}

export function deriveAgentState(hookEvent, payload, previousState) {
  switch (hookEvent) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreInvocation':
    case 'PostToolUse':
      return 'working';
    case 'PostInvocation':
    case 'Stop':
      if (payload?.error) return 'error';
      if (payload?.fullyIdle === false) return 'working';
      return 'idle';
    default:
      return previousState || 'idle';
  }
}

function extractHookModel(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nested = payload.model && typeof payload.model === 'object'
    ? (payload.model.name || payload.model.displayName || payload.model.id)
    : payload.model;
  for (const cand of [payload.modelName, payload.model_name, nested, payload.modelId, payload.model_id]) {
    if (typeof cand === 'string' && cand.trim()) {
      return cand.trim();
    }
  }
  return null;
}

/**
 * Apply an Antigravity hook payload to `ls_endpoints.json` (0600) and `panes/pane_<id>.json`.
 */
export function applyHookUpdate({
  hookEvent,
  payload = {},
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
  const endpointsStore = loadEndpoints(statusDir);
  const existingEp = endpointsStore.endpoints[paneId];
  const existingQuota = loadQuota(statusDir);
  const cachedLimits = loadModelLimitsCache(statusDir);
  const modelIndex = buildModelIndex(null, [], cachedLimits);

  const parsedAgyPid = agyPid !== null && agyPid !== undefined && String(agyPid).trim() !== ''
    ? Number(agyPid)
    : NaN;
  const resolvedAgyPid = Number.isInteger(parsedAgyPid) && parsedAgyPid > 0 ? parsedAgyPid : null;
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
  const endpointStale = pidChanged || epPidChanged;

  const explicitConvId = payload.conversationId
    || payload.conversation_id
    || payload.cascadeId
    || env.ANTIGRAVITY_CONVERSATION_ID
    || null;
  const conversationId = explicitConvId
    || (pidChanged ? null : (existingPane?.conversation_id || (!epPidChanged ? existingEp?.conversation_id : null)))
    || null;

  const cwd = payload.cwd
    || (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (pidChanged ? null : existingPane?.cwd)
    || process.cwd();

  const lsAddress = env.ANTIGRAVITY_LS_ADDRESS || (!endpointStale ? existingEp?.ls_address : null) || null;
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN || (!endpointStale ? existingEp?.csrf_token : '') || '';

  if (lsAddress) {
    const preferHttps = existingEp?.ls_address === lsAddress
      ? Boolean(existingEp?.prefer_https)
      : false;
    endpointsStore.endpoints[paneId] = {
      ls_address: String(lsAddress),
      csrf_token: String(csrfToken),
      prefer_https: preferHttps,
      conversation_id: conversationId,
      pid: resolvedAgyPid || process.ppid || process.pid,
      updated_at: effectiveNowEpoch,
    };
    endpointsStore.latest_key = paneId;
    saveEndpoints(statusDir, endpointsStore);
  } else if (endpointStale && existingEp) {
    delete endpointsStore.endpoints[paneId];
    if (endpointsStore.latest_key === paneId) {
      const remaining = Object.entries(endpointsStore.endpoints)
        .sort((a, b) => (b[1]?.updated_at || 0) - (a[1]?.updated_at || 0));
      endpointsStore.latest_key = remaining.length > 0 ? remaining[0][0] : null;
    }
    saveEndpoints(statusDir, endpointsStore);
  }

  const sameConversation = Boolean(
    !pidChanged
    && (!conversationId || !existingPane?.conversation_id || existingPane.conversation_id === conversationId)
  );
  const rawModelName = extractHookModel(payload);

  const modelTracking = computeModelTracking({
    prevPane: existingPane,
    conversationId,
    settingsInfo: undefined,
    hookInput: rawModelName ? { model: rawModelName, at: effectiveNowMs } : null,
    stepInput: null,
    sessionReset: pidChanged,
    nowMs: effectiveNowMs,
  });

  const activeModel = resolveActiveModelState({
    modelTracking,
    prevPane: existingPane,
    sameConversation,
    modelIndex,
    modelPools: existingQuota?.model_pools || {},
    defaultPool: existingQuota?.default_pool || 'gemini',
  });

  const agentState = deriveAgentState(hookEvent, payload, existingPane?.agent_state);

  const panePayload = {
    version: 1,
    pane_id: paneId,
    agy_pid: resolvedAgyPid || (!pidChanged ? (existingPane?.agy_pid ?? null) : null),
    conversation_id: conversationId,
    cwd,
    model_id: activeModel.model_id,
    model_display_name: activeModel.model_display_name,
    pool: activeModel.pool,
    pool_label: activeModel.pool_label,
    model_tracking: modelTracking,
    agent_state: agentState,
    context: sameConversation ? (existingPane?.context ?? null) : null,
    updated_at: effectiveNowEpoch,
  };

  savePane(statusDir, paneId, panePayload);

  return { paneId, cwd, conversationId, panePayload };
}
