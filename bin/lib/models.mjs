export const POOL_LABELS = {
  gemini: 'Gemini',
  '3p': 'Claude/GPT',
};

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

function formatBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return emptyWindow();
  const rawFrac = bucket.remainingFraction;
  const frac = typeof rawFrac === 'number'
    ? rawFrac
    : (typeof rawFrac === 'string' && rawFrac.trim() !== '' ? Number(rawFrac) : NaN);
  const remaining_pct = Number.isFinite(frac) ? round2(frac * 100) : null;
  const reset_time = typeof bucket.resetTime === 'string' && bucket.resetTime ? bucket.resetTime : null;
  const reset_epoch = parseResetEpoch(reset_time);
  return { remaining_pct, reset_time, reset_epoch };
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

/**
 * Build a searchable model limits & display-name index from GetAvailableModels,
 * GetUserStatus clientModelConfigs, and any cached model_limits.json.
 */
export function buildModelIndex(availableModelsResp, clientModelConfigs = [], cachedLimits = null) {
  const limitsByKey = { ...(cachedLimits?.limitsByKey || {}) };
  const displayByKey = { ...(cachedLimits?.displayByKey || {}) };
  const modelIdByKey = { ...(cachedLimits?.modelIdByKey || {}) };

  const modelsMap = availableModelsResp?.response?.models || availableModelsResp?.models || {};
  for (const [slug, info] of Object.entries(modelsMap)) {
    if (!info || typeof info !== 'object') continue;
    const keys = [slug, info.displayName, info.model].map(normalizeModelKey).filter(Boolean);
    const maxTokens = Number(info.maxTokens);
    for (const k of keys) {
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        limitsByKey[k] = maxTokens;
      }
      if (info.displayName) {
        displayByKey[k] = info.displayName;
      }
      if (info.model) {
        modelIdByKey[k] = info.model;
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

  return { limitsByKey, displayByKey, modelIdByKey };
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
    let poolKey = null;
    for (const b of buckets) {
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

    for (const b of buckets) {
      const win = String(b?.window || '');
      const id = String(b?.bucketId || '');
      if (win === '5h' || /-5h$/i.test(id)) {
        poolObj.five_hour = formatBucket(b);
      } else if (win === 'weekly' || /-weekly$/i.test(id)) {
        poolObj.weekly = formatBucket(b);
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
      const candidate = formatBucket(cfg.quotaInfo);
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

  const planTier = userStatus?.userTier?.name
    || userStatus?.planStatus?.planInfo?.planName
    || existingQuota?.plan_tier
    || null;

  const hasPools = Object.keys(pools).length > 0;
  const defaultPool = pools.gemini ? 'gemini' : (Object.keys(pools)[0] || 'gemini');

  return {
    version: 1,
    fetched_at: nowEpoch,
    source: hasPools ? 'ls_rpc' : (existingQuota?.source || 'unavailable'),
    plan_tier: planTier,
    default_pool: defaultPool,
    pools: hasPools ? pools : (existingQuota?.pools || {}),
    model_pools: Object.keys(modelPools).length > 0 ? modelPools : (existingQuota?.model_pools || {}),
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
 * Resolve model_id, model_display_name, pool, pool_label, and context_window_size from
 * combined RPC / SQLite / cached indices.
 */
export function resolveModelMetadata({
  modelId = null,
  modelDisplayName = null,
  responseModel = null,
  modelEnumInt = null,
  chatStartMetadata = null,
  modelIndex = { limitsByKey: {}, displayByKey: {}, modelIdByKey: {} },
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

  // 2. Resolve context_window_size: GetAvailableModels exact -> prefix -> chatStartMetadata -> family fallback.
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
  if (!contextWindowSize) {
    const metaMax = Number(chatStartMetadata?.contextWindowMetadata?.maxContextTokens);
    if (Number.isFinite(metaMax) && metaMax > 0) {
      contextWindowSize = metaMax;
    }
  }
  if (!contextWindowSize) {
    const combined = `${resolvedDisplay || ''} ${responseModel || ''} ${resolvedModelId || ''}`;
    if (/(claude|opus|sonnet)/i.test(combined)) {
      contextWindowSize = 1000000;
    } else if (/gemini/i.test(combined)) {
      contextWindowSize = 1048576;
    }
  }

  return {
    model_id: resolvedModelId,
    model_display_name: resolvedDisplay,
    pool,
    pool_label: getPoolLabel(pool),
    context_window_size: contextWindowSize,
  };
}
