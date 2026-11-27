import {
  getStatusDir,
  loadEndpoints,
  loadPane,
  loadQuota,
  sanitizePaneId,
  saveEndpoints,
  savePane,
} from './cache.mjs';
import { classifyPoolByKeywords, normalizeModelKey } from './models.mjs';

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

/**
 * Apply an Antigravity hook payload to `ls_endpoints.json` (0600) and `panes/pane_<id>.json`.
 */
export function applyHookUpdate({
  hookEvent,
  payload = {},
  env = process.env,
  statusDir = getStatusDir(),
  nowEpoch = Math.floor(Date.now() / 1000),
}) {
  const paneId = sanitizePaneId(env.WEZTERM_PANE);
  const existingPane = loadPane(statusDir, paneId);
  const endpointsStore = loadEndpoints(statusDir);
  const existingEp = endpointsStore.endpoints[paneId];
  const existingQuota = loadQuota(statusDir);

  const conversationId = payload.conversationId
    || payload.conversation_id
    || payload.cascadeId
    || env.ANTIGRAVITY_CONVERSATION_ID
    || existingPane?.conversation_id
    || existingEp?.conversation_id
    || null;

  const cwd = payload.cwd
    || (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || existingPane?.cwd
    || process.cwd();

  const lsAddress = env.ANTIGRAVITY_LS_ADDRESS || existingEp?.ls_address || null;
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN || existingEp?.csrf_token || '';

  if (lsAddress) {
    const preferHttps = existingEp?.ls_address === lsAddress
      ? Boolean(existingEp?.prefer_https)
      : false;
    endpointsStore.endpoints[paneId] = {
      ls_address: String(lsAddress),
      csrf_token: String(csrfToken),
      prefer_https: preferHttps,
      conversation_id: conversationId,
      pid: process.ppid || process.pid,
      updated_at: nowEpoch,
    };
    endpointsStore.latest_key = paneId;
    saveEndpoints(statusDir, endpointsStore);
  }

  const sameConversation = conversationId && existingPane?.conversation_id === conversationId;
  const rawModelName = payload.modelName || payload.model || payload.modelId || null;

  let modelId = sameConversation ? (existingPane?.model_id || null) : null;
  let modelDisplayName = sameConversation ? (existingPane?.model_display_name || null) : null;
  if (rawModelName) {
    if (/^MODEL_/i.test(String(rawModelName))) {
      modelId = String(rawModelName);
    } else {
      modelDisplayName = String(rawModelName);
    }
  }

  let pool = sameConversation ? (existingPane?.pool || null) : null;
  if (rawModelName || modelDisplayName || modelId) {
    const modelPools = existingQuota?.model_pools || {};
    for (const candidate of [modelDisplayName, modelId, rawModelName]) {
      const nk = normalizeModelKey(candidate);
      if (nk && modelPools[nk]) {
        pool = modelPools[nk];
        break;
      }
    }
    if (!pool) {
      pool = classifyPoolByKeywords(modelDisplayName || rawModelName || modelId);
    }
  }
  if (!pool) {
    pool = existingQuota?.default_pool || 'gemini';
  }

  const agentState = deriveAgentState(hookEvent, payload, existingPane?.agent_state);

  const panePayload = {
    version: 1,
    pane_id: paneId,
    conversation_id: conversationId,
    cwd,
    model_id: modelId,
    model_display_name: modelDisplayName,
    pool,
    agent_state: agentState,
    context: sameConversation ? (existingPane?.context ?? null) : null,
    updated_at: nowEpoch,
  };

  savePane(statusDir, paneId, panePayload);

  return { paneId, cwd, conversationId, panePayload };
}
