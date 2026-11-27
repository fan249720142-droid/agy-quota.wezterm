import { round2 } from './models.mjs';

export function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * Compute standardized context usage & cache hit-rate metrics.
 */
export function computeContextMetrics({
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  contextWindowSize = null,
  source = 'ls_rpc',
}) {
  const input_tokens = toNonNegInt(inputTokens);
  const output_tokens = toNonNegInt(outputTokens);
  const cache_read_tokens = toNonNegInt(cacheReadTokens);
  const used_tokens = input_tokens + cache_read_tokens + output_tokens;

  const promptTokens = input_tokens + cache_read_tokens;
  const cached_pct = promptTokens > 0
    ? round2((cache_read_tokens / promptTokens) * 100)
    : 0;

  const win = Number(contextWindowSize);
  const hasWin = Number.isFinite(win) && win > 0;
  const used_pct = hasWin ? round2((used_tokens / win) * 100) : null;
  const remaining_pct = used_pct !== null ? round2(Math.max(0, 100 - used_pct)) : null;

  return {
    used_tokens,
    context_window_size: hasWin ? Math.trunc(win) : null,
    used_pct,
    remaining_pct,
    input_tokens,
    output_tokens,
    cache_read_tokens,
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
    if (inputTokens + outputTokens + cacheReadTokens > 0) {
      return {
        model: u.model || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
      };
    }
  }
  return null;
}

/**
 * Extract the latest chatModel metadata + token usage from GetCascadeTrajectoryGeneratorMetadata entries.
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
    if (!latestChatStart && cm.chatStartMetadata) latestChatStart = cm.chatStartMetadata;

    const u = pickUsageFromChatModel(cm);
    if (u) {
      latestUsage = u;
      if (!latestModel && u.model) latestModel = u.model;
      break;
    }
  }

  if (!latestUsage && !latestModel && !latestDisplayName) return null;
  return {
    model: latestModel,
    modelDisplayName: latestDisplayName,
    responseModel: latestResponseModel,
    chatStartMetadata: latestChatStart,
    usage: latestUsage,
  };
}
