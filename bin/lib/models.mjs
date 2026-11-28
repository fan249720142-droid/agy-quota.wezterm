export const POOL_LABELS = {
  gemini: 'Gemini',
  '3p': 'Claude/GPT',
};

export const DEFAULT_COMPACTION_THRESHOLD = 256_000;
export const STEP_UP_INTERMEDIATE_THRESHOLD = 512_000;
export const EXPIRED_RESET_GRACE_SECS = 60;
const FIVE_HOUR_WINDOW_THRESHOLD_SECS = 2 * 3600;
const WEEKLY_WINDOW_THRESHOLD_SECS = 24 * 3600;

export function getPoolLabel(pool) {
  return POOL_LABELS[pool] || (pool === '3p' ? 'Claude/GPT' : 'Gemini');
}

export function round2(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export function normalizeModelKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseResetEpoch(resetTime) {
  if (!resetTime || typeof resetTime !== 'string') return null;
  const ms = Date.parse(resetTime);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function enumIntToModelId(enumInt) {
  const n = Number(enumInt);
  if (!Number.isInteger(n) || n < 1000 || n >= 2000) return null;
  return `MODEL_PLACEHOLDER_M${n - 1000}`;
}

export function isArgonBucketId(id) {
  const lower = String(id ?? '').toLowerCase();
  return lower.includes('argon') || lower.endsWith('-wtu') || lower.endsWith('-wtu-weekly');
}

export function classifyPoolByKeywords(name) {
  const s = String(name ?? '');
  if (!s) return null;
  if (/(claude|opus|sonnet|haiku|gpt[\s_-]*oss|chatgpt|gpt|openai|anthropic|(?:^|[^a-z0-9])3p(?:[^a-z0-9]|$))/i.test(s)) {
    return '3p';
  }
  if (/(gemini|orchestrator|hydrogen|neon|argon|carbon|flash)/i.test(s)) {
    return 'gemini';
  }
  return null;
}

function emptyWindow() {
  return { remaining_pct: null, reset_time: null, reset_epoch: null };
}

function formatBucket(bucket, nowEpoch = Math.floor(Date.now() / 1000)) {
  if (!bucket || typeof bucket !== 'object') return emptyWindow();
  const rawFrac = bucket.remainingFraction !== undefined
    ? bucket.remainingFraction
    : (bucket.remaining_fraction !== undefined ? bucket.remaining_fraction : bucket.remaining);
  let frac = typeof rawFrac === 'number'
    ? rawFrac
    : (typeof rawFrac === 'string' && rawFrac.trim() !== '' ? Number(rawFrac) : NaN);

  const rawResetTime = typeof bucket.resetTime === 'string' && bucket.resetTime
    ? bucket.resetTime
    : (typeof bucket.reset_time === 'string' && bucket.reset_time ? bucket.reset_time : null);
  const rawResetSec = bucket.reset_in_seconds !== undefined
    ? bucket.reset_in_seconds
    : bucket.resetInSeconds;
  const resetSec = typeof rawResetSec === 'number'
    ? rawResetSec
    : (typeof rawResetSec === 'string' && rawResetSec.trim() !== '' ? Number(rawResetSec) : NaN);

  let reset_time = rawResetTime;
  let reset_epoch = parseResetEpoch(reset_time);
  if (reset_epoch === null && Number.isFinite(resetSec) && resetSec > 0) {
    reset_epoch = Math.floor(nowEpoch + resetSec);
    reset_time = new Date(reset_epoch * 1000).toISOString();
  }

  if (!Number.isFinite(frac) && (reset_time || Number.isFinite(resetSec))) {
    frac = 0;
  }

  let remaining_pct = null;
  if (Number.isFinite(frac)) {
    const pct = frac > 1 ? frac : frac * 100;
    remaining_pct = round2(Math.max(0, Math.min(100, pct)));
  }

  return { remaining_pct, reset_time, reset_epoch };
}

/**
 * Parse a ceiling override value (`"256k"`, `"512k"`, `"1m"`, `"physical"`, `"full"`, `"0"`, or `"50%"`).
 */
export function parseCeilingValue(rawValue, physicalSize = 0, allowPercent = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue) || rawValue < 0) return null;
    if (rawValue === 0) return physicalSize > 0 ? physicalSize : null;
    return Math.trunc(rawValue);
  }
  if (typeof rawValue === 'string') {
    const s = rawValue.trim().toLowerCase();
    if (!s) return null;
    if (s === 'model' || s === 'physical' || s === 'full' || s === '1m' || s === '0') {
      return physicalSize > 0 ? physicalSize : null;
    }
    if (allowPercent && s.endsWith('%')) {
      const pct = Number(s.slice(0, -1));
      if (Number.isFinite(pct) && pct > 0 && pct <= 100 && physicalSize > 0) {
        return Math.round((physicalSize * pct) / 100);
      }
      return null;
    }
    if (s.endsWith('k')) {
      const n = Number(s.slice(0, -1));
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
      return null;
    }
    if (s.endsWith('m')) {
      const n = Number(s.slice(0, -1));
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1_000_000);
      return null;
    }
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) {
      return n === 0 ? (physicalSize > 0 ? physicalSize : null) : Math.trunc(n);
    }
  }
  return null;
}

/**
 * Compute stepped ceiling (base -> 512k -> physical) so context bars never pin at 100%
 * when a session legitimately crosses the default compaction threshold.
 */
export function computeSteppedCeiling(usedTokens, physicalSize, baseCeiling = DEFAULT_COMPACTION_THRESHOLD) {
  const safeUsed = Math.max(0, Number(usedTokens) || 0);
  const safeBase = baseCeiling > 0 ? baseCeiling : DEFAULT_COMPACTION_THRESHOLD;
  const cap = physicalSize > 0 ? physicalSize : safeBase;
  const clampedBase = Math.min(cap, safeBase);
  if (safeUsed <= clampedBase) {
    return clampedBase;
  }
  if (
    clampedBase < STEP_UP_INTERMEDIATE_THRESHOLD
    && safeUsed <= STEP_UP_INTERMEDIATE_THRESHOLD
    && cap >= STEP_UP_INTERMEDIATE_THRESHOLD
  ) {
    return STEP_UP_INTERMEDIATE_THRESHOLD;
  }
  return Math.max(clampedBase, cap);
}

/**
 * 4-layer effective compaction ceiling resolution:
 * 1a) Native compaction limit (from statusLine context_window)
 * 1b) User settings / env overrides (`AGY_TOKEN_CEILING`, `AGY_CLI_AUTO_COMPACT_OVERRIDE`)
 * 2)  Runtime `maxContextTokens` from GetCascadeTrajectoryGeneratorMetadata
 * 3)  Dynamic model catalog checkpointer limit from GetAvailableModels
 * 4)  256k -> 512k -> physical stepped self-healing fallback
 */
export function resolveEffectiveContextLimit({
  usedTokens = 0,
  physicalWindowSize = 0,
  nativeCompactionLimit = null,
  runtimeMaxContextTokens = 0,
  catalogCompactionLimit = 0,
  settings = null,
  env = process.env,
  rememberedCeiling = 0,
} = {}) {
  const phys = Number(physicalWindowSize) > 0 ? Math.trunc(Number(physicalWindowSize)) : 0;
  const used = Math.max(0, Number(usedTokens) || 0);

  // Layer 1a: Native compaction limit
  const nativeParsed = parseCeilingValue(nativeCompactionLimit, phys, false);
  if (nativeParsed !== null) return nativeParsed;

  // Layer 1b: Settings & environment overrides
  const overrideSources = [
    { raw: settings?.ui?.footer?.tokenCeiling, allowPercent: false },
    { raw: settings?.ui?.tokenCeiling, allowPercent: false },
    { raw: env?.AGY_TOKEN_CEILING, allowPercent: false },
    { raw: env?.AGY_CLI_AUTO_COMPACT_OVERRIDE, allowPercent: true },
  ];
  for (const src of overrideSources) {
    const parsed = parseCeilingValue(src.raw, phys, src.allowPercent);
    if (parsed !== null) return parsed;
  }

  // Layer 2: Runtime maxContextTokens from trajectory metadata
  const runtimeMax = Number(runtimeMaxContextTokens) || 0;
  if (runtimeMax > 0) {
    const base = phys > 0 ? Math.min(phys, runtimeMax) : runtimeMax;
    return computeSteppedCeiling(used, phys, base);
  }

  // Layer 3: Catalog checkpointer max_token_limit from GetAvailableModels
  const catLimit = Number(catalogCompactionLimit) || 0;
  if (catLimit > 0) {
    const base = phys > 0 ? Math.min(phys, catLimit) : catLimit;
    return computeSteppedCeiling(used, phys, base);
  }

  // Layer 4: Stepped fallback (256k -> 512k -> physical)
  if (phys <= 0) return null;
  const baseDefault = Math.min(phys, DEFAULT_COMPACTION_THRESHOLD);
  const remembered = Number(rememberedCeiling) > 0 ? Math.min(phys, Number(rememberedCeiling)) : 0;
  return computeSteppedCeiling(used, phys, Math.max(baseDefault, remembered));
}

/**
 * Extract family prefix -> pool mappings from RetrieveUserQuotaSummary group descriptions.
 */
function parseGroupFamilies(description, poolKey) {
  if (!description || typeof description !== 'string') return [];
  const idx = description.indexOf(':');
  const listPart = idx >= 0 ? description.slice(idx + 1) : description;
  return listPart
    .split(',')
    .map((item) => normalizeModelKey(item))
    .filter(Boolean)
    .map((prefix) => ({ prefix, pool: poolKey }));
}

function matchPoolWithPrefixes(candidates, familyPrefixes) {
  const normalized = candidates.map((c) => normalizeModelKey(c)).filter(Boolean);
  let best = null;
  for (const cand of normalized) {
    for (const entry of familyPrefixes) {
      if (cand === entry.prefix || cand.startsWith(entry.prefix)) {
        if (!best || entry.prefix.length > best.prefix.length) {
          best = entry;
        }
      }
    }
  }
  if (best) return best.pool;
  for (const raw of candidates) {
    const k = classifyPoolByKeywords(raw);
    if (k) return k;
  }
  return null;
}

function parseCheckpointerMaxTokenLimit(modelInfo) {
  const raw = modelInfo?.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enabled !== false) {
      const limit = Number(parsed.max_token_limit);
      if (Number.isFinite(limit) && limit > 0) return Math.trunc(limit);
    }
  } catch {
    // Ignore malformed experiment JSON.
  }
  return 0;
}

/**
 * Build a searchable model limits (physical + compaction checkpointer) & display-name index
 * from GetAvailableModels, GetUserStatus clientModelConfigs, and cached model_limits.json.
 */
export function buildModelIndex(availableModelsResp, clientModelConfigs = [], cachedLimits = null) {
  const limitsByKey = { ...(cachedLimits?.limitsByKey || {}) };
  const compactionByKey = { ...(cachedLimits?.compactionByKey || {}) };
  const displayByKey = { ...(cachedLimits?.displayByKey || {}) };
  const modelIdByKey = { ...(cachedLimits?.modelIdByKey || {}) };

  const primaryCompactionKeys = new Set();
  const ambiguousDisplayKeys = new Set();

  const modelsMap = availableModelsResp?.response?.models || availableModelsResp?.models || {};
  for (const [slug, info] of Object.entries(modelsMap)) {
    if (!info || typeof info !== 'object') continue;
    const normSlug = normalizeModelKey(slug);
    const normEnum = normalizeModelKey(info.model);
    const normDisplay = normalizeModelKey(info.displayName);
    const keys = [normSlug, normDisplay, normEnum].filter(Boolean);
    const maxTokens = Number(info.maxTokens);
    const cpLimit = parseCheckpointerMaxTokenLimit(info);

    for (const k of keys) {
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        limitsByKey[k] = Math.trunc(maxTokens);
      }
      if (info.displayName) {
        displayByKey[k] = info.displayName;
      }
      if (info.model) {
        modelIdByKey[k] = info.model;
      }
    }

    if (cpLimit > 0) {
      if (normSlug) {
        compactionByKey[normSlug] = cpLimit;
        primaryCompactionKeys.add(normSlug);
      }
      if (normEnum && normEnum !== normSlug) {
        compactionByKey[normEnum] = cpLimit;
        primaryCompactionKeys.add(normEnum);
      }
      if (normDisplay && normDisplay !== normSlug && normDisplay !== normEnum && !primaryCompactionKeys.has(normDisplay)) {
        if (ambiguousDisplayKeys.has(normDisplay)) {
          delete compactionByKey[normDisplay];
        } else if (compactionByKey[normDisplay] && compactionByKey[normDisplay] !== cpLimit) {
          ambiguousDisplayKeys.add(normDisplay);
          delete compactionByKey[normDisplay];
        } else {
          compactionByKey[normDisplay] = cpLimit;
        }
      }
    }
  }

  for (const cfg of clientModelConfigs || []) {
    if (!cfg || typeof cfg !== 'object') continue;
    const modelEnum = cfg.modelOrAlias?.model;
    const label = cfg.label;
    const modelId = cfg.modelId;
    const keys = [modelId, label, modelEnum].map(normalizeModelKey).filter(Boolean);
    for (const k of keys) {
      if (label && !displayByKey[k]) {
        displayByKey[k] = label;
      }
      if (modelEnum && !modelIdByKey[k]) {
        modelIdByKey[k] = modelEnum;
      }
    }
  }

  return { limitsByKey, compactionByKey, displayByKey, modelIdByKey };
}

/**
 * Merge a single quota window (5h or weekly) with expired-window yield,
 * cross-window threshold protection (24h weekly / 2h short-term), and same-window anti-oscillation.
 */
export function mergeQuotaWindow(
  existingWin,
  incomingWin,
  { isWeekly = false, nowEpoch = Math.floor(Date.now() / 1000), preferLowerWhenSameReset = true } = {}
) {
  const hasExist = Boolean(existingWin && typeof existingWin === 'object' && existingWin.remaining_pct !== null && existingWin.remaining_pct !== undefined);
  const hasInc = Boolean(incomingWin && typeof incomingWin === 'object' && incomingWin.remaining_pct !== null && incomingWin.remaining_pct !== undefined);
  if (!hasInc) return hasExist ? { ...existingWin } : emptyWindow();
  if (!hasExist) return { ...incomingWin };

  const existReset = typeof existingWin.reset_epoch === 'number' && Number.isFinite(existingWin.reset_epoch)
    ? existingWin.reset_epoch
    : parseResetEpoch(existingWin.reset_time);
  const incReset = typeof incomingWin.reset_epoch === 'number' && Number.isFinite(incomingWin.reset_epoch)
    ? incomingWin.reset_epoch
    : parseResetEpoch(incomingWin.reset_time);

  const hasExistReset = existReset !== null && existReset > 0;
  const hasIncReset = incReset !== null && incReset > 0;

  // 1. Expired existing window yields to newer incoming window (or un-clocked 100% reset).
  if (hasExistReset && existReset <= nowEpoch && (!hasIncReset || incReset > existReset)) {
    return { ...incomingWin };
  }
  // 2. Reject expired incoming window when existing window is still valid in the future.
  if (hasIncReset && incReset <= nowEpoch && hasExistReset && existReset > nowEpoch) {
    return { ...existingWin };
  }

  // 3. Cross-window jump (24h for weekly, 2h for 5h): newer reset window wins.
  const threshold = isWeekly ? WEEKLY_WINDOW_THRESHOLD_SECS : FIVE_HOUR_WINDOW_THRESHOLD_SECS;
  if (hasExistReset && hasIncReset && Math.abs(incReset - existReset) > threshold) {
    return incReset > existReset ? { ...incomingWin } : { ...existingWin };
  }

  // 4. Same reset window.
  if (!preferLowerWhenSameReset) {
    return { ...incomingWin };
  }

  const existPct = Number(existingWin.remaining_pct);
  const incPct = Number(incomingWin.remaining_pct);
  if (Number.isFinite(existPct) && Number.isFinite(incPct)) {
    const lower = existPct <= incPct ? existingWin : incomingWin;
    const higher = existPct <= incPct ? incomingWin : existingWin;
    return {
      remaining_pct: round2(Math.min(existPct, incPct)),
      reset_time: lower.reset_time || higher.reset_time || null,
      reset_epoch: lower.reset_epoch ?? higher.reset_epoch ?? null,
    };
  }

  return { ...incomingWin };
}

/**
 * Merge two pool maps (`{ gemini: { label, five_hour, weekly }, '3p': ... }`).
 */
export function mergeQuotaPools(
  existingPools = {},
  incomingPools = {},
  { nowEpoch = Math.floor(Date.now() / 1000), preferLowerWhenSameReset = true } = {}
) {
  const merged = {};
  const allKeys = new Set([
    ...Object.keys(existingPools || {}),
    ...Object.keys(incomingPools || {}),
  ]);

  for (const key of allKeys) {
    const existPool = existingPools?.[key];
    const incPool = incomingPools?.[key];
    if (!incPool && existPool) {
      merged[key] = {
        label: existPool.label || getPoolLabel(key),
        five_hour: existPool.five_hour ? { ...existPool.five_hour } : emptyWindow(),
        weekly: existPool.weekly ? { ...existPool.weekly } : emptyWindow(),
      };
      continue;
    }
    if (!existPool && incPool) {
      merged[key] = {
        label: incPool.label || getPoolLabel(key),
        five_hour: incPool.five_hour ? { ...incPool.five_hour } : emptyWindow(),
        weekly: incPool.weekly ? { ...incPool.weekly } : emptyWindow(),
      };
      continue;
    }
    merged[key] = {
      label: incPool.label || existPool.label || getPoolLabel(key),
      five_hour: mergeQuotaWindow(existPool.five_hour, incPool.five_hour, {
        isWeekly: false,
        nowEpoch,
        preferLowerWhenSameReset,
      }),
      weekly: mergeQuotaWindow(existPool.weekly, incPool.weekly, {
        isWeekly: true,
        nowEpoch,
        preferLowerWhenSameReset,
      }),
    };
  }

  return merged;
}

/**
 * Parse Antigravity CLI native `statusLine` `meta.quota` object into canonical pools.
 */
export function parseMetaQuotaToPools(metaQuota, nowEpoch = Math.floor(Date.now() / 1000)) {
  if (!metaQuota || typeof metaQuota !== 'object' || Array.isArray(metaQuota)) {
    return {};
  }

  const pools = {};
  for (const [rawKey, bucket] of Object.entries(metaQuota)) {
    if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) continue;
    if (isArgonBucketId(rawKey)) continue;

    const lowerKey = rawKey.toLowerCase();
    const winVal = String(bucket.window || bucket.windowVal || '').toLowerCase();
    const isShortSuffix = /-(5h|3h|hourly|shortterm)$/i.test(rawKey);
    const isWeekly = winVal === 'weekly' || (!winVal && lowerKey.endsWith('-weekly') && !isShortSuffix);

    const stripped = rawKey.replace(/-(5h|3h|hourly|shortterm|weekly)$/i, '');
    const poolKey = stripped.startsWith('gemini')
      ? 'gemini'
      : (stripped.startsWith('3p') ? '3p' : (classifyPoolByKeywords(stripped) || stripped));
    if (!poolKey || isArgonBucketId(poolKey)) continue;

    const formatted = formatBucket(bucket, nowEpoch);
    if (formatted.remaining_pct === null) continue;

    if (!pools[poolKey]) {
      pools[poolKey] = {
        label: getPoolLabel(poolKey),
        five_hour: emptyWindow(),
        weekly: emptyWindow(),
      };
    }

    if (isWeekly) {
      pools[poolKey].weekly = mergeQuotaWindow(pools[poolKey].weekly, formatted, {
        isWeekly: true,
        nowEpoch,
        preferLowerWhenSameReset: true,
      });
    } else {
      pools[poolKey].five_hour = mergeQuotaWindow(pools[poolKey].five_hour, formatted, {
        isWeekly: false,
        nowEpoch,
        preferLowerWhenSameReset: true,
      });
    }
  }

  return pools;
}

/**
 * Cross-infer model -> pool mappings by matching GetUserStatus per-model `resetTime`
 * against unique `five_hour.reset_epoch` values across quota pools.
 */
export function inferModelPoolsFromResetTime(clientModelConfigs = [], pools = {}) {
  const inferred = {};
  if (!Array.isArray(clientModelConfigs) || !pools || typeof pools !== 'object') return inferred;

  const resetToPools = new Map();
  for (const [poolKey, poolObj] of Object.entries(pools)) {
    if (isArgonBucketId(poolKey)) continue;
    const rEpoch = poolObj?.five_hour?.reset_epoch;
    if (typeof rEpoch !== 'number' || !Number.isFinite(rEpoch) || rEpoch <= 0) continue;
    const list = resetToPools.get(rEpoch) || [];
    if (!list.includes(poolKey)) {
      list.push(poolKey);
      resetToPools.set(rEpoch, list);
    }
  }

  if (resetToPools.size === 0) return inferred;

  for (const cfg of clientModelConfigs) {
    if (!cfg || typeof cfg !== 'object' || !cfg.quotaInfo) continue;
    const rEpoch = parseResetEpoch(cfg.quotaInfo.resetTime);
    if (!rEpoch) continue;
    const matchedPools = resetToPools.get(rEpoch);
    if (!matchedPools || matchedPools.length !== 1) continue;

    const poolKey = matchedPools[0];
    const poolPct = pools[poolKey]?.five_hour?.remaining_pct;
    const cand = formatBucket(cfg.quotaInfo);
    if (poolPct !== null && cand.remaining_pct !== null && Math.abs(cand.remaining_pct - poolPct) > 5) {
      continue;
    }

    for (const rawKey of [cfg.modelId, cfg.label, cfg.modelOrAlias?.model]) {
      const nk = normalizeModelKey(rawKey);
      if (nk) inferred[nk] = poolKey;
    }
  }

  return inferred;
}

/**
 * Build quota.json payload from Official LS RPC responses.
 */
export function buildQuotaPayload({
  quotaSummaryResp,
  userStatusResp,
  availableModelsResp,
  existingQuota = null,
  nowEpoch = Math.floor(Date.now() / 1000),
}) {
  const userStatus = userStatusResp?.userStatus || userStatusResp || {};
  const clientModelConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const groups = quotaSummaryResp?.response?.groups || quotaSummaryResp?.groups || [];

  const pools = {};
  const familyPrefixes = [];
  const modelPools = {};

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const activeBuckets = buckets.filter((b) => !isArgonBucketId(b?.bucketId));
    if (activeBuckets.length === 0) continue;

    let poolKey = null;
    for (const b of activeBuckets) {
      const id = String(b?.bucketId || '');
      if (id.startsWith('gemini')) { poolKey = 'gemini'; break; }
      if (id.startsWith('3p')) { poolKey = '3p'; break; }
      const byBucket = classifyPoolByKeywords(id);
      if (byBucket) { poolKey = byBucket; break; }
    }
    if (!poolKey) {
      poolKey = classifyPoolByKeywords(group.displayName)
        || classifyPoolByKeywords(group.description)
        || 'gemini';
    }

    const poolObj = pools[poolKey] || {
      label: POOL_LABELS[poolKey] || group.displayName || poolKey,
      five_hour: emptyWindow(),
      weekly: emptyWindow(),
    };

    for (const b of activeBuckets) {
      const win = String(b?.window || '').toLowerCase();
      const id = String(b?.bucketId || '');
      if (win === '5h' || /-(5h|3h|hourly|shortterm)$/i.test(id)) {
        poolObj.five_hour = formatBucket(b, nowEpoch);
      } else if (win === 'weekly' || /-weekly$/i.test(id)) {
        poolObj.weekly = formatBucket(b, nowEpoch);
      }
    }
    pools[poolKey] = poolObj;

    for (const fam of parseGroupFamilies(group.description, poolKey)) {
      familyPrefixes.push(fam);
      modelPools[fam.prefix] = poolKey;
    }
  }

  const modelsMap = availableModelsResp?.response?.models || availableModelsResp?.models || {};
  for (const [slug, info] of Object.entries(modelsMap)) {
    if (!info || typeof info !== 'object') continue;
    if (/^tab_/i.test(slug)) continue;
    const pool = matchPoolWithPrefixes([info.displayName, slug, info.model], familyPrefixes);
    if (!pool) continue;
    for (const rawKey of [slug, info.displayName, info.model]) {
      const nk = normalizeModelKey(rawKey);
      if (nk) modelPools[nk] = pool;
    }
  }

  for (const cfg of clientModelConfigs) {
    if (!cfg || typeof cfg !== 'object') continue;
    const modelEnum = cfg.modelOrAlias?.model;
    const pool = matchPoolWithPrefixes([cfg.label, cfg.modelId, modelEnum], familyPrefixes);
    if (pool) {
      for (const rawKey of [cfg.modelId, cfg.label, modelEnum]) {
        const nk = normalizeModelKey(rawKey);
        if (nk) modelPools[nk] = pool;
      }
    }
    if (pool && cfg.quotaInfo) {
      const candidate = formatBucket(cfg.quotaInfo, nowEpoch);
      if (!pools[pool]) {
        pools[pool] = {
          label: POOL_LABELS[pool] || pool,
          five_hour: candidate,
          weekly: emptyWindow(),
        };
      } else if (pools[pool].five_hour.remaining_pct === null && candidate.remaining_pct !== null) {
        pools[pool].five_hour = candidate;
      }
    }
  }

  // Cross-infer any remaining unknown models via unique reset_time matching.
  const inferred = inferModelPoolsFromResetTime(clientModelConfigs, pools);
  for (const [nk, pool] of Object.entries(inferred)) {
    if (!modelPools[nk]) modelPools[nk] = pool;
  }

  const planTier = userStatus?.userTier?.name
    || userStatus?.planStatus?.planInfo?.planName
    || existingQuota?.plan_tier
    || null;

  const hasPools = Object.keys(pools).length > 0;
  // Fresh authoritative LS RPC pools overwrite same-window values while guarding against expired snapshots.
  const mergedPools = hasPools
    ? mergeQuotaPools(existingQuota?.pools || {}, pools, {
      nowEpoch,
      preferLowerWhenSameReset: false,
    })
    : (existingQuota?.pools || {});
  const defaultPool = mergedPools.gemini ? 'gemini' : (Object.keys(mergedPools)[0] || 'gemini');

  return {
    version: 1,
    fetched_at: nowEpoch,
    ls_fetched_at: nowEpoch,
    last_poll_attempt_at: nowEpoch,
    source: hasPools ? 'ls_rpc' : (existingQuota?.source || 'unavailable'),
    plan_tier: planTier,
    default_pool: defaultPool,
    pools: mergedPools,
    model_pools: Object.keys(modelPools).length > 0
      ? { ...(existingQuota?.model_pools || {}), ...modelPools }
      : (existingQuota?.model_pools || {}),
  };
}

function lookupByKeyOrPrefix(map, keys, accept = (v) => Boolean(v)) {
  if (!map || typeof map !== 'object') return null;
  for (const k of keys) {
    if (accept(map[k])) return map[k];
  }
  let bestLen = 0;
  let bestVal = null;
  for (const k of keys) {
    for (const [mk, mv] of Object.entries(map)) {
      if (!accept(mv)) continue;
      if ((mk.startsWith(k) || k.startsWith(mk)) && Math.min(mk.length, k.length) > bestLen) {
        bestLen = Math.min(mk.length, k.length);
        bestVal = mv;
      }
    }
  }
  return bestVal;
}

/**
 * Resolve model_id, model_display_name, pool, pool_label, physical context_window_size,
 * and catalog compaction_limit from combined RPC / SQLite / cached indices.
 */
export function resolveModelMetadata({
  modelId = null,
  modelDisplayName = null,
  responseModel = null,
  modelEnumInt = null,
  chatStartMetadata = null,
  modelIndex = { limitsByKey: {}, compactionByKey: {}, displayByKey: {}, modelIdByKey: {} },
  modelPools = {},
  defaultPool = 'gemini',
}) {
  const enumPlaceholder = enumIntToModelId(modelEnumInt);
  const candidates = [modelDisplayName, modelId, enumPlaceholder, responseModel]
    .map(normalizeModelKey)
    .filter(Boolean);

  let resolvedModelId = modelId || null;
  if (!resolvedModelId) {
    resolvedModelId = lookupByKeyOrPrefix(modelIndex.modelIdByKey, candidates);
  }
  if (!resolvedModelId && enumPlaceholder) {
    resolvedModelId = enumPlaceholder;
  }

  let resolvedDisplay = modelDisplayName || null;
  if (!resolvedDisplay) {
    const displayKeys = [resolvedModelId, ...candidates].map(normalizeModelKey).filter(Boolean);
    resolvedDisplay = lookupByKeyOrPrefix(modelIndex.displayByKey, displayKeys);
  }

  const allKeys = [resolvedDisplay, resolvedModelId, responseModel, modelDisplayName, modelId]
    .map(normalizeModelKey)
    .filter(Boolean);

  // 1. Resolve pool from model_pools (exact then longest prefix) then keyword fallback.
  let pool = null;
  for (const k of allKeys) {
    if (modelPools?.[k]) {
      pool = modelPools[k];
      break;
    }
  }
  if (!pool && modelPools) {
    let bestLen = 0;
    for (const k of allKeys) {
      for (const [mpKey, mpPool] of Object.entries(modelPools)) {
        if (k.startsWith(mpKey) && mpKey.length > bestLen) {
          bestLen = mpKey.length;
          pool = mpPool;
        }
      }
    }
  }
  if (!pool) {
    pool = classifyPoolByKeywords(resolvedDisplay)
      || classifyPoolByKeywords(responseModel)
      || classifyPoolByKeywords(resolvedModelId)
      || defaultPool
      || 'gemini';
  }

  // 2. Resolve physical context_window_size: GetAvailableModels -> family fallback -> chatStartMetadata.
  const limits = modelIndex.limitsByKey || {};
  let contextWindowSize = lookupByKeyOrPrefix(limits, allKeys, (v) => typeof v === 'number' && v > 0);
  if (!contextWindowSize) {
    const combined = `${resolvedDisplay || ''} ${responseModel || ''} ${resolvedModelId || ''}`;
    if (/(claude|opus|sonnet)[\s_-]*5[\s._-]*5/i.test(combined)) {
      contextWindowSize = 1000000;
    } else if (/gpt[\s_-]*oss[\s_-]*120b/i.test(combined)) {
      contextWindowSize = 131072;
    } else if (/gemini[\s_-]*(4|3\.8|3\.5|3\.1|3|2\.5)|orchestrator|hydrogen|neon|argon|carbon/i.test(combined)) {
      contextWindowSize = 1048576;
    }
  }
  const metaMax = Number(chatStartMetadata?.contextWindowMetadata?.maxContextTokens);
  const runtimeMaxContextTokens = Number.isFinite(metaMax) && metaMax > 0 ? Math.trunc(metaMax) : null;
  if (!contextWindowSize && runtimeMaxContextTokens) {
    contextWindowSize = runtimeMaxContextTokens;
  }
  if (!contextWindowSize) {
    const combined = `${resolvedDisplay || ''} ${responseModel || ''} ${resolvedModelId || ''}`;
    if (/(claude|opus|sonnet)/i.test(combined)) {
      contextWindowSize = 1000000;
    } else if (/gemini/i.test(combined)) {
      contextWindowSize = 1048576;
    }
  }

  // 3. Resolve catalog compaction_limit from GetAvailableModels checkpointer experiments.
  const compactionMap = modelIndex.compactionByKey || {};
  const catalogCompactionLimit = lookupByKeyOrPrefix(
    compactionMap,
    allKeys,
    (v) => typeof v === 'number' && v > 0
  );

  return {
    model_id: resolvedModelId,
    model_display_name: resolvedDisplay,
    pool,
    pool_label: getPoolLabel(pool),
    context_window_size: contextWindowSize,
    compaction_limit: catalogCompactionLimit || null,
    runtime_max_context_tokens: runtimeMaxContextTokens,
  };
}
