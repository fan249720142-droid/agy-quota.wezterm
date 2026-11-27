import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STALE_LOCK_MS = 20_000;

/**
 * Resolve the cache directory for WezTerm Antigravity status files.
 */
export function getStatusDir() {
  const override = process.env.WEZTERM_AGY_STATUS_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const cacheHome = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim()
    ? process.env.XDG_CACHE_HOME.trim()
    : path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'wezterm-agy-status');
}

/**
 * Normalize a WezTerm pane identifier for safe filename usage.
 */
export function sanitizePaneId(paneId) {
  const cleaned = String(paneId ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'default';
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
 * Atomically write JSON via `<target>.tmp.<pid>` + rename.
 */
export function atomicWriteJson(filePath, data, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const payload = JSON.stringify(data, null, 2) + '\n';
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
 * Read and parse JSON from disk, returning null on missing or invalid JSON.
 */
export function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
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
