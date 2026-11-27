import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, resolveHomeDir } from './cache.mjs';
import { getPoolLabel, resolveModelMetadata } from './models.mjs';
import { toNonNegInt } from './usage.mjs';

function readSettingsFileModel(filePath) {
  if (!filePath) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const parsed = readJsonSafe(filePath);
  if (!parsed) return null;

  // Strictly read only the `model` field; never read or write `statusLine`.
  let model = null;
  if (typeof parsed.model === 'string' && parsed.model.trim()) {
    model = parsed.model.trim();
  } else if (parsed.model && typeof parsed.model === 'object') {
    const nested = parsed.model.name || parsed.model.displayName || parsed.model.id;
    if (typeof nested === 'string' && nested.trim()) {
      model = nested.trim();
    }
  }
  if (!model) return null;

  return {
    path: filePath,
    model,
    mtimeMs: Number.isFinite(stat.mtimeMs) ? Math.floor(stat.mtimeMs) : 0,
  };
}

/**
 * Resolve the path to Antigravity CLI's settings.json (read-only).
 */
export function resolveCliSettingsPath({
  cliSettingsPath = null,
  appDataDir = null,
  geminiBaseDir = null,
  env = process.env,
} = {}) {
  if (cliSettingsPath && typeof cliSettingsPath === 'string' && cliSettingsPath.trim()) {
    return path.resolve(cliSettingsPath.trim());
  }
  if (env?.WEZTERM_AGY_CLI_SETTINGS_PATH && env.WEZTERM_AGY_CLI_SETTINGS_PATH.trim()) {
    return path.resolve(env.WEZTERM_AGY_CLI_SETTINGS_PATH.trim());
  }
  if (appDataDir && typeof appDataDir === 'string' && appDataDir.trim()) {
    return path.join(path.resolve(appDataDir.trim()), 'settings.json');
  }
  if (env?.WEZTERM_AGY_APP_DATA_DIR && env.WEZTERM_AGY_APP_DATA_DIR.trim()) {
    return path.join(path.resolve(env.WEZTERM_AGY_APP_DATA_DIR.trim()), 'settings.json');
  }
  if (env?.ANTIGRAVITY_APP_DATA_DIR && env.ANTIGRAVITY_APP_DATA_DIR.trim()) {
    return path.join(path.resolve(env.ANTIGRAVITY_APP_DATA_DIR.trim()), 'settings.json');
  }
  if (geminiBaseDir && typeof geminiBaseDir === 'string' && geminiBaseDir.trim()) {
    return path.join(path.resolve(geminiBaseDir.trim()), 'antigravity-cli', 'settings.json');
  }
  if (env?.WEZTERM_AGY_GEMINI_DIR && env.WEZTERM_AGY_GEMINI_DIR.trim()) {
    return path.join(path.resolve(env.WEZTERM_AGY_GEMINI_DIR.trim()), 'antigravity-cli', 'settings.json');
  }
  return path.join(resolveHomeDir(env), '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Read active `model` and `mtimeMs` from Antigravity CLI settings.json and optional `<cwd>/.gemini/settings.json`.
 */
export function readActiveSettingsModel({
  cwd = null,
  cliSettingsPath = null,
  appDataDir = null,
  geminiBaseDir = null,
  env = process.env,
} = {}) {
  const globalPath = resolveCliSettingsPath({ cliSettingsPath, appDataDir, geminiBaseDir, env });
  const globalInfo = readSettingsFileModel(globalPath);

  let localInfo = null;
  if (cwd && typeof cwd === 'string' && cwd.trim()) {
    const localPath = path.join(path.resolve(cwd.trim()), '.gemini', 'settings.json');
    const samePath = process.platform === 'win32'
      ? localPath.toLowerCase() === globalPath.toLowerCase()
      : localPath === globalPath;
    if (!samePath) {
      localInfo = readSettingsFileModel(localPath);
    }
  }

  if (localInfo && globalInfo) {
    return localInfo.mtimeMs >= globalInfo.mtimeMs ? localInfo : globalInfo;
  }
  return localInfo || globalInfo || { path: globalPath, model: null, mtimeMs: 0 };
}

/**
 * Update deterministic timestamped `model_tracking` state for a pane.
 */
export function computeModelTracking({
  prevPane = null,
  conversationId = null,
  settingsInfo = undefined,
  hookInput = null,
  stepInput = null,
  nowMs = Date.now(),
} = {}) {
  const prevTracking = prevPane?.model_tracking && typeof prevPane.model_tracking === 'object'
    ? prevPane.model_tracking
    : null;
  const hasPrevTracking = Boolean(prevTracking);

  const prevConvId = prevPane?.conversation_id || null;
  const conversationChanged = Boolean(conversationId && prevConvId && prevConvId !== conversationId);

  const prevRpcModel = conversationChanged ? null : (prevTracking?.rpc_model || null);
  const prevRpcStepCount = conversationChanged ? 0 : toNonNegInt(prevTracking?.rpc_step_count);
  const prevRpcModelAt = conversationChanged ? 0 : toNonNegInt(prevTracking?.rpc_model_at);

  const prevHookModel = conversationChanged ? null : (prevTracking?.hook_model || null);
  const prevHookModelAt = conversationChanged ? 0 : toNonNegInt(prevTracking?.hook_model_at);

  let settingsModel = prevTracking?.settings_model ?? null;
  let settingsModelChangedAt = toNonNegInt(prevTracking?.settings_model_changed_at);

  if (settingsInfo !== undefined) {
    const newSettingsModel = settingsInfo?.model ? String(settingsInfo.model).trim() : null;
    const mtimeMs = toNonNegInt(settingsInfo?.mtimeMs);

    if (!newSettingsModel) {
      settingsModel = null;
      settingsModelChangedAt = 0;
    } else if (!hasPrevTracking) {
      settingsModel = newSettingsModel;
      settingsModelChangedAt = mtimeMs || nowMs;
    } else if (newSettingsModel !== prevTracking.settings_model) {
      settingsModel = newSettingsModel;
      let ts = mtimeMs || nowMs;
      // Compensate for Linux coarse inode mtime lag (<50ms) when settings.json changes immediately after RPC refresh.
      if (mtimeMs > 0 && prevRpcModelAt > 0 && ts <= prevRpcModelAt && (nowMs - ts) < 50) {
        ts = prevRpcModelAt + 1;
      }
      settingsModelChangedAt = ts;
    } else {
      settingsModel = newSettingsModel;
      settingsModelChangedAt = settingsModelChangedAt || mtimeMs || 0;
    }
  }

  let hookModel = prevHookModel;
  let hookModelAt = prevHookModelAt;
  if (hookInput?.model && String(hookInput.model).trim()) {
    hookModel = String(hookInput.model).trim();
    hookModelAt = toNonNegInt(hookInput.at) || nowMs;
  }

  let rpcModel = prevRpcModel;
  let rpcStepCount = prevRpcStepCount;
  let rpcModelAt = prevRpcModelAt;

  if (stepInput && stepInput.stepCount > 0 && stepInput.model) {
    const count = toNonNegInt(stepInput.stepCount);
    const model = String(stepInput.model).trim();
    if (count > prevRpcStepCount) {
      rpcModel = model;
      rpcStepCount = count;
      rpcModelAt = Math.max(nowMs, prevRpcModelAt > 0 ? prevRpcModelAt + 1 : nowMs);
    } else {
      rpcModel = prevRpcModel || model;
      rpcStepCount = prevRpcStepCount;
      rpcModelAt = prevRpcModelAt;
    }
  }

  return {
    settings_model: settingsModel,
    settings_model_changed_at: settingsModelChangedAt,
    hook_model: hookModel,
    hook_model_at: hookModelAt,
    rpc_model: rpcModel,
    rpc_step_count: rpcStepCount,
    rpc_model_at: rpcModelAt,
  };
}

/**
 * Pick the non-empty model among settings, hook, and rpc with the largest timestamp.
 * Ties break in order: hook > rpc > settings (so --model CLI flag beats settings.json on tie).
 */
export function selectWinningModel(tracking) {
  if (!tracking || typeof tracking !== 'object') return null;

  const candidates = [
    { source: 'hook', model: tracking.hook_model, at: toNonNegInt(tracking.hook_model_at), rank: 3 },
    { source: 'rpc', model: tracking.rpc_model, at: toNonNegInt(tracking.rpc_model_at), rank: 2 },
    { source: 'settings', model: tracking.settings_model, at: toNonNegInt(tracking.settings_model_changed_at), rank: 1 },
  ].filter((c) => typeof c.model === 'string' && c.model.trim() !== '');

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    return b.rank - a.rank;
  });

  return candidates[0];
}

/**
 * Resolve final `model_id`, `model_display_name`, `pool`, `pool_label`, and `context_window_size`
 * from `model_tracking` and cached/RPC model indices.
 */
export function resolveActiveModelState({
  modelTracking,
  stepResolved = null,
  prevPane = null,
  sameConversation = true,
  modelIndex = { limitsByKey: {}, displayByKey: {}, modelIdByKey: {} },
  modelPools = {},
  defaultPool = 'gemini',
}) {
  const winning = selectWinningModel(modelTracking);
  if (!winning) {
    const pool = (sameConversation ? prevPane?.pool : null) || defaultPool || 'gemini';
    return {
      model_id: sameConversation ? (prevPane?.model_id || null) : null,
      model_display_name: sameConversation ? (prevPane?.model_display_name || null) : null,
      pool,
      pool_label: getPoolLabel(pool),
      context_window_size: null,
      winning_source: null,
    };
  }

  if (winning.source === 'rpc' && stepResolved) {
    const pool = stepResolved.pool || defaultPool || 'gemini';
    return {
      model_id: stepResolved.model_id || null,
      model_display_name: stepResolved.model_display_name || null,
      pool,
      pool_label: stepResolved.pool_label || getPoolLabel(pool),
      context_window_size: stepResolved.context_window_size || null,
      winning_source: 'rpc',
    };
  }

  const raw = winning.model;
  const isModelId = /^MODEL_/i.test(raw);
  const resolved = resolveModelMetadata({
    modelId: isModelId ? raw : null,
    modelDisplayName: isModelId ? null : raw,
    modelIndex,
    modelPools,
    defaultPool,
  });

  return {
    model_id: resolved.model_id || null,
    model_display_name: resolved.model_display_name || (isModelId ? null : raw),
    pool: resolved.pool,
    pool_label: resolved.pool_label || getPoolLabel(resolved.pool),
    context_window_size: resolved.context_window_size || null,
    winning_source: winning.source,
  };
}
