import { round2 } from './models.mjs';

export function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * Compute standardized context usage (physical + effective compaction ceiling) & cache hit-rate metrics.
 */
export function computeContextMetrics({
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  usedTokensOverride = null,
  cachedPctOverride = null,
  contextWindowSize = null,
  effectiveContextLimit = null,
  source = 'ls_rpc',
}) {
  const input_tokens = toNonNegInt(inputTokens);
  const output_tokens = toNonNegInt(outputTokens);
  const cache_read_tokens = toNonNegInt(cacheReadTokens);
  const cache_creation_tokens = toNonNegInt(cacheCreationTokens);

  const used_tokens = (typeof usedTokensOverride === 'number' && Number.isFinite(usedTokensOverride) && usedTokensOverride >= 0)
    ? Math.trunc(usedTokensOverride)
    : (input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens);

  const promptTokens = input_tokens + cache_creation_tokens + cache_read_tokens;
  let cached_pct = 0;
  if (promptTokens > 0) {
    cached_pct = round2((cache_read_tokens / promptTokens) * 100);
  } else if (typeof cachedPctOverride === 'number' && Number.isFinite(cachedPctOverride)) {
    cached_pct = round2(Math.max(0, Math.min(100, cachedPctOverride)));
  }

  const win = Number(contextWindowSize);
  const hasWin = Number.isFinite(win) && win > 0;
  const used_pct = hasWin ? round2(Math.min(100, (used_tokens / win) * 100)) : null;
  const remaining_pct = used_pct !== null ? round2(Math.max(0, 100 - used_pct)) : null;

  const eff = Number(effectiveContextLimit);
  const hasEff = Number.isFinite(eff) && eff > 0;
  const effective_context_limit = hasEff ? Math.trunc(eff) : (hasWin ? Math.trunc(win) : null);
  const effective_used_pct = effective_context_limit
    ? round2(Math.min(100, (used_tokens / effective_context_limit) * 100))
    : used_pct;
  const effective_remaining_pct = effective_used_pct !== null
    ? round2(Math.max(0, 100 - effective_used_pct))
    : remaining_pct;

  return {
    used_tokens,
    context_window_size: hasWin ? Math.trunc(win) : null,
    effective_context_limit,
    used_pct,
    remaining_pct,
    effective_used_pct,
    effective_remaining_pct,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    cached_pct,
    source,
  };
}

function pickUsageFromChatModel(chatModel) {
  if (!chatModel || typeof chatModel !== 'object') return null;
  const candidates = [];
  if (chatModel.usage && typeof chatModel.usage === 'object') {
    candidates.push(chatModel.usage);
  }
  if (Array.isArray(chatModel.retryInfos)) {
    for (let i = chatModel.retryInfos.length - 1; i >= 0; i--) {
      const ru = chatModel.retryInfos[i]?.usage;
      if (ru && typeof ru === 'object') candidates.push(ru);
    }
  }
  for (const u of candidates) {
    const inputTokens = toNonNegInt(u.inputTokens);
    const outputTokens = toNonNegInt(u.outputTokens);
    const cacheReadTokens = toNonNegInt(u.cacheReadTokens);
    const cacheCreationTokens = toNonNegInt(u.cacheCreationTokens ?? u.cacheCreationInputTokens);
    if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens > 0) {
      return {
        model: u.model || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
    }
  }
  return null;
}

/**
 * Extract the latest chatModel metadata + token usage from GetCascadeTrajectoryGeneratorMetadata entries,
 * backfilling each field independently from newest to oldest so streaming steps never wipe prior usage.
 */
export function extractLatestRpcUsage(generatorMetadataList) {
  if (!Array.isArray(generatorMetadataList) || generatorMetadataList.length === 0) {
    return null;
  }

  let latestModel = null;
  let latestDisplayName = null;
  let latestResponseModel = null;
  let latestChatStart = null;
  let latestUsage = null;

  for (let i = generatorMetadataList.length - 1; i >= 0; i--) {
    const cm = generatorMetadataList[i]?.chatModel;
    if (!cm || typeof cm !== 'object') continue;
    if (!latestModel && cm.model) latestModel = cm.model;
    if (!latestDisplayName && cm.modelDisplayName) latestDisplayName = cm.modelDisplayName;
    if (!latestResponseModel && cm.responseModel) latestResponseModel = cm.responseModel;
    if (!latestChatStart && cm.chatStartMetadata?.contextWindowMetadata?.maxContextTokens) {
      latestChatStart = cm.chatStartMetadata;
    } else if (!latestChatStart && cm.chatStartMetadata) {
      latestChatStart = cm.chatStartMetadata;
    }

    if (!latestUsage) {
      const u = pickUsageFromChatModel(cm);
      if (u) {
        latestUsage = u;
        if (!latestModel && u.model) latestModel = u.model;
      }
    }

    if (
      latestUsage
      && latestModel
      && latestDisplayName
      && latestChatStart?.contextWindowMetadata?.maxContextTokens
    ) {
      break;
    }
  }

  if (!latestUsage && !latestModel && !latestDisplayName && !latestChatStart) return null;
  return {
    model: latestModel,
    modelDisplayName: latestDisplayName,
    responseModel: latestResponseModel,
    chatStartMetadata: latestChatStart,
    usage: latestUsage,
  };
}
