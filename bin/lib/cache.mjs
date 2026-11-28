import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STALE_LOCK_MS = 20_000;

/**
 * Resolve the user's home directory across POSIX (HOME) and Windows (USERPROFILE).
 */
export function resolveHomeDir(env = process.env, platform = process.platform) {
  const safeEnv = env && typeof env === 'object' ? env : {};
  if (platform === 'win32') {
    const winHome = (safeEnv.USERPROFILE && safeEnv.USERPROFILE.trim())
      || (safeEnv.HOME && safeEnv.HOME.trim())
      || (safeEnv.HOMEDRIVE && safeEnv.HOMEPATH ? `${safeEnv.HOMEDRIVE}${safeEnv.HOMEPATH}`.trim() : '');
    if (winHome) return winHome;
  } else if (safeEnv.HOME && safeEnv.HOME.trim()) {
    return safeEnv.HOME.trim();
  }
  return os.homedir();
}

/**
 * Resolve the cache directory for WezTerm / Windows Terminal Antigravity status files.
 */
export function getStatusDir(env = process.env, platform = process.platform) {
  const safeEnv = env && typeof env === 'object' ? env : {};
  const override = safeEnv.WEZTERM_AGY_STATUS_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const xdg = safeEnv.XDG_CACHE_HOME && safeEnv.XDG_CACHE_HOME.trim();
  if (xdg) {
    return path.join(xdg, 'wezterm-agy-status');
  }
  if (platform === 'win32') {
    const localAppData = (safeEnv.LOCALAPPDATA && safeEnv.LOCALAPPDATA.trim())
      || path.join(resolveHomeDir(safeEnv, platform), 'AppData', 'Local');
    return path.join(localAppData, 'wezterm-agy-status');
  }
  return path.join(resolveHomeDir(safeEnv, platform), '.cache', 'wezterm-agy-status');
}

/**
 * Normalize a pane/session identifier for safe filename usage.
 */
export function sanitizePaneId(paneId) {
  const cleaned = String(paneId ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'default';
}

/**
 * Resolve the terminal pane/session key with priority:
 * 1) explicit pane argument
 * 2) env.WEZTERM_PANE
 * 3) env.WT_SESSION -> wt_<sanitized_id>
 * 4) 'default'
 */
export function resolvePaneId(explicitPane, env = process.env) {
  const safeEnv = env && typeof env === 'object' ? env : {};
  if (explicitPane !== null && explicitPane !== undefined && String(explicitPane).trim() !== '') {
    return sanitizePaneId(explicitPane);
  }
  if (safeEnv.WEZTERM_PANE !== null && safeEnv.WEZTERM_PANE !== undefined && String(safeEnv.WEZTERM_PANE).trim() !== '') {
    return sanitizePaneId(safeEnv.WEZTERM_PANE);
  }
  if (safeEnv.WT_SESSION !== null && safeEnv.WT_SESSION !== undefined && String(safeEnv.WT_SESSION).trim() !== '') {
    return `wt_${sanitizePaneId(safeEnv.WT_SESSION)}`;
  }
  return 'default';
}

/**
 * Ensure the status directory and panes subdirectory exist with mode 0o700.
 */
export function ensureCacheDirs(statusDir = getStatusDir()) {
  const panesDir = path.join(statusDir, 'panes');
  fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(statusDir, 0o700);
  } catch {
    // Ignore chmod failures on non-owned parent mounts.
  }
  fs.mkdirSync(panesDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(panesDir, 0o700);
  } catch {
    // Ignore chmod failures on non-owned parent mounts.
  }
  return { statusDir, panesDir };
}

/**
 * Strip UTF-8 BOM if present.
 */
export function stripUtf8Bom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
}

/**
 * Atomically write JSON via `<target>.tmp.<pid>.<ts>.<rand>` + rename (strictly BOM-free).
 */
export function atomicWriteJson(filePath, data, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rand = Math.random().toString(36).slice(2, 8);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`;
  const payload = stripUtf8Bom(JSON.stringify(data, null, 2) + '\n');
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error.
    }
    throw err;
  }
}

/**
 * Read and parse JSON from disk (stripping any UTF-8 BOM), returning null on missing or invalid JSON.
 */
export function readJsonSafe(filePath) {
  try {
    const raw = stripUtf8Bom(fs.readFileSync(filePath, 'utf8'));
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read a JSON object file with BOM defense:
 * - missing or empty file -> `{}`
 * - invalid JSON or non-object -> `null` (so callers can refuse to overwrite corrupted settings)
 */
export function readJsonObjectWithBomDefense(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = stripUtf8Bom(fs.readFileSync(filePath, 'utf8'));
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Acquire `.refresh.lock` directory lock with stale lock recovery (> staleMs).
 * Returns the lock directory path on success, or null if held by an active process.
 */
export function acquireLock(statusDir, staleMs = DEFAULT_STALE_LOCK_MS) {
  ensureCacheDirs(statusDir);
  const lockDir = path.join(statusDir, '.refresh.lock');
  const ownerFile = path.join(lockDir, 'owner.json');

  const tryCreate = () => {
    fs.mkdirSync(lockDir, { mode: 0o700 });
    try {
      fs.writeFileSync(
        ownerFile,
        JSON.stringify({ pid: process.pid, created_at: Date.now() }),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch {
      // Owner metadata is advisory only.
    }
    return lockDir;
  };

  try {
    return tryCreate();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let isStale = false;
  try {
    const stat = fs.statSync(lockDir);
    const owner = readJsonSafe(ownerFile);
    const createdAt = typeof owner?.created_at === 'number' ? owner.created_at : stat.mtimeMs;
    if (Date.now() - createdAt > staleMs) {
      isStale = true;
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      isStale = true;
    }
  }

  if (!isStale) {
    return null;
  }

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return tryCreate();
  } catch (err) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Release the `.refresh.lock` directory.
 */
export function releaseLock(lockDir) {
  if (!lockDir) return;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

/**
 * Emit debug diagnostics to stderr only when WEZTERM_AGY_DEBUG=1 (never stdout).
 */
export function debugLog(message, err = null) {
  if (process.env.WEZTERM_AGY_DEBUG !== '1') return;
  const suffix = err ? `: ${err.stack || err.message || String(err)}` : '';
  process.stderr.write(`[agy-status] ${message}${suffix}\n`);
}

export function getEndpointsPath(statusDir) {
  return path.join(statusDir, 'ls_endpoints.json');
}

export function getQuotaPath(statusDir) {
  return path.join(statusDir, 'quota.json');
}

export function getPanePath(statusDir, paneId) {
  return path.join(statusDir, 'panes', `pane_${sanitizePaneId(paneId)}.json`);
}

export function getModelLimitsPath(statusDir) {
  return path.join(statusDir, 'model_limits.json');
}

export function loadEndpoints(statusDir) {
  const data = readJsonSafe(getEndpointsPath(statusDir));
  if (!data || typeof data.endpoints !== 'object' || data.endpoints === null) {
    return { endpoints: {}, latest_key: null };
  }
  return {
    endpoints: data.endpoints,
    latest_key: typeof data.latest_key === 'string' ? data.latest_key : null,
  };
}

/**
 * Persist LS endpoints with strict mode 0o600 inside 0o700 cache dir.
 */
export function saveEndpoints(statusDir, data) {
  ensureCacheDirs(statusDir);
  atomicWriteJson(getEndpointsPath(statusDir), data, 0o600);
}

/**
 * Remove a stale or dead LS endpoint entry by key and update `latest_key`.
 */
export function pruneEndpoint(statusDir, key) {
  if (!key) return false;
  const store = loadEndpoints(statusDir);
  if (!store.endpoints || !Object.prototype.hasOwnProperty.call(store.endpoints, key)) {
    return false;
  }
  delete store.endpoints[key];
  if (store.latest_key === key) {
    const remaining = Object.entries(store.endpoints)
      .sort((a, b) => (b[1]?.updated_at || 0) - (a[1]?.updated_at || 0));
    store.latest_key = remaining.length > 0 ? remaining[0][0] : null;
  }
  saveEndpoints(statusDir, store);
  return true;
}

export function loadPane(statusDir, paneId) {
  return readJsonSafe(getPanePath(statusDir, paneId));
}

/**
 * Persist pane state while strictly stripping any credential fields (csrf_token).
 */
export function savePane(statusDir, paneId, data) {
  ensureCacheDirs(statusDir);
  const sanitized = { ...data };
  delete sanitized.csrf_token;
  delete sanitized.csrfToken;
  atomicWriteJson(getPanePath(statusDir, paneId), sanitized, 0o644);
}

export function loadQuota(statusDir) {
  return readJsonSafe(getQuotaPath(statusDir));
}

export function saveQuota(statusDir, data) {
  ensureCacheDirs(statusDir);
  const sanitized = { ...data };
  delete sanitized.csrf_token;
  delete sanitized.csrfToken;
  atomicWriteJson(getQuotaPath(statusDir), sanitized, 0o644);
}

export function loadModelLimitsCache(statusDir) {
  return readJsonSafe(getModelLimitsPath(statusDir));
}

export function saveModelLimitsCache(statusDir, data) {
  ensureCacheDirs(statusDir);
  atomicWriteJson(getModelLimitsPath(statusDir), data, 0o644);
}
