import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const PAGE_SIZE = 256;
const MAX_PAGES = 5;

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isProtocolMismatchError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  if (code.startsWith('ERR_SSL_') || code.startsWith('HPE_')) return true;
  if (/wrong version number|socket hang up|Parse Error|TLS|SSL/i.test(msg)) return true;
  return false;
}

function sendSingleRpc(urlStr, csrfToken, body, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      resolve({ ok: false, error: err, transportError: true });
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = JSON.stringify(body ?? {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Connect-Protocol-Version': '1',
    };
    if (csrfToken) {
      headers['x-codeium-csrf-token'] = csrfToken;
    }

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    };
    if (isHttps) {
      options.rejectUnauthorized = !isLoopbackHost(parsed.hostname);
    }

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          try {
            const data = text.trim() ? JSON.parse(text) : {};
            resolve({ ok: true, statusCode: status, data });
          } catch (err) {
            resolve({ ok: false, statusCode: status, error: err, transportError: false });
          }
          return;
        }
        resolve({
          ok: false,
          statusCode: status,
          error: new Error(`LS RPC HTTP ${status}`),
          transportError: false,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('LS RPC timeout'), { code: 'ETIMEDOUT' }));
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err, transportError: true });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Call an official Antigravity LanguageServerService Connect-JSON RPC method.
 * Never flips HTTP<->HTTPS on HTTP status errors; only retries alternate scheme
 * on pre-response TLS/HTTP protocol mismatch errors.
 */
export async function callLsRpc(endpoint, method, body = {}, timeoutMs = 2000) {
  const addr = String(endpoint?.ls_address || '').trim();
  if (!addr) {
    return { ok: false, error: new Error('Missing ls_address') };
  }

  const hasScheme = /^https?:\/\//i.test(addr);
  if (hasScheme) {
    const cleanBase = addr.replace(/\/+$/, '');
    const res = await sendSingleRpc(`${cleanBase}${SERVICE_PREFIX}${method}`, endpoint.csrf_token, body, timeoutMs);
    return { ...res, prefer_https: cleanBase.toLowerCase().startsWith('https://') };
  }

  const firstScheme = endpoint.prefer_https ? 'https' : 'http';
  const secondScheme = endpoint.prefer_https ? 'http' : 'https';

  const first = await sendSingleRpc(`${firstScheme}://${addr}${SERVICE_PREFIX}${method}`, endpoint.csrf_token, body, timeoutMs);
  if (first.ok || !first.transportError || !isProtocolMismatchError(first.error)) {
    return { ...first, prefer_https: firstScheme === 'https' };
  }

  const second = await sendSingleRpc(`${secondScheme}://${addr}${SERVICE_PREFIX}${method}`, endpoint.csrf_token, body, timeoutMs);
  return { ...second, prefer_https: secondScheme === 'https' };
}

/**
 * Paginate GetCascadeTrajectoryGeneratorMetadata (max 5 pages of 256).
 */
export async function fetchGeneratorMetadata(endpoint, cascadeId, timeoutMs = 2000) {
  if (!cascadeId) return { ok: false, items: [] };
  const items = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await callLsRpc(
      endpoint,
      'GetCascadeTrajectoryGeneratorMetadata',
      { cascadeId, generatorMetadataOffset: offset },
      timeoutMs
    );
    if (!res.ok) {
      if (page === 0) return { ok: false, items: [], error: res.error, statusCode: res.statusCode };
      break;
    }
    const batch = Array.isArray(res.data?.generatorMetadata) ? res.data.generatorMetadata : [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += batch.length;
  }

  return { ok: true, items };
}

/**
 * Scan ~/.gemini/antigravity*\/daemon/hub_*.json for daemon LS endpoints.
 */
export function discoverDaemonHubEndpoints(geminiBaseDir = null) {
  const base = geminiBaseDir
    || process.env.WEZTERM_AGY_GEMINI_DIR
    || path.join(os.homedir(), '.gemini');
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || !/^antigravity/i.test(ent.name)) continue;
    const daemonDir = path.join(base, ent.name, 'daemon');
    let files;
    try {
      files = fs.readdirSync(daemonDir);
    } catch {
      continue;
    }
    const hubFiles = files
      .filter((f) => /^hub_.*\.json$/i.test(f))
      .map((f) => {
        const full = path.join(daemonDir, f);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return { full, mtimeMs: 0 };
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const hf of hubFiles) {
      try {
        const obj = JSON.parse(fs.readFileSync(hf.full, 'utf8'));
        if (!obj || typeof obj !== 'object') continue;
        const lsAddress = obj.ls_address
          || obj.lsAddress
          || obj.address
          || (obj.httpsPort ? `localhost:${obj.httpsPort}` : null)
          || (obj.httpPort ? `localhost:${obj.httpPort}` : null)
          || (obj.port ? `localhost:${obj.port}` : null);
        if (!lsAddress) continue;
        results.push({
          key: `daemon:${path.basename(hf.full)}`,
          ls_address: String(lsAddress),
          csrf_token: String(obj.csrf_token || obj.csrfToken || obj.token || ''),
          prefer_https: Boolean(obj.prefer_https ?? obj.preferHttps ?? (obj.httpsPort && !obj.httpPort)),
          conversation_id: obj.conversation_id || obj.conversationId || null,
          updated_at: Math.floor(hf.mtimeMs / 1000),
          fromDaemon: true,
        });
      } catch {
        // Skip unreadable or invalid hub file.
      }
    }
  }
  return results;
}

/**
 * Collect ordered candidate LS endpoints from env, ls_endpoints.json, and daemon hub files.
 */
export function buildEndpointCandidates({
  paneId,
  endpointsStore,
  env = process.env,
  geminiBaseDir = null,
}) {
  const candidates = [];
  const seen = new Set();

  const add = (item) => {
    if (!item?.ls_address) return;
    const sig = `${item.ls_address}|${item.csrf_token || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    candidates.push(item);
  };

  if (env.ANTIGRAVITY_LS_ADDRESS) {
    const existingPaneEp = endpointsStore?.endpoints?.[paneId];
    add({
      key: paneId,
      ls_address: env.ANTIGRAVITY_LS_ADDRESS,
      csrf_token: env.ANTIGRAVITY_CSRF_TOKEN || existingPaneEp?.csrf_token || '',
      prefer_https: existingPaneEp?.ls_address === env.ANTIGRAVITY_LS_ADDRESS
        ? Boolean(existingPaneEp?.prefer_https)
        : false,
      conversation_id: env.ANTIGRAVITY_CONVERSATION_ID || existingPaneEp?.conversation_id || null,
    });
  }

  const map = endpointsStore?.endpoints || {};
  if (paneId && map[paneId]) {
    add({ key: paneId, ...map[paneId] });
  }
  if (endpointsStore?.latest_key && map[endpointsStore.latest_key]) {
    add({ key: endpointsStore.latest_key, ...map[endpointsStore.latest_key] });
  }

  const others = Object.entries(map)
    .map(([key, ep]) => ({ key, ...ep }))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  for (const ep of others) {
    add(ep);
  }

  for (const daemonEp of discoverDaemonHubEndpoints(geminiBaseDir)) {
    add(daemonEp);
  }

  return candidates;
}

/**
 * Fetch quota summary, user status, and available models from the first reachable endpoint.
 */
export async function queryQuotaFromLs(candidates, timeoutMs = 2000) {
  for (const ep of candidates) {
    const [quotaRes, statusRes, modelsRes] = await Promise.all([
      callLsRpc(ep, 'RetrieveUserQuotaSummary', {}, timeoutMs),
      callLsRpc(ep, 'GetUserStatus', {}, timeoutMs),
      callLsRpc(ep, 'GetAvailableModels', {}, timeoutMs),
    ]);

    if (quotaRes.ok || statusRes.ok || modelsRes.ok) {
      const preferHttps = quotaRes.ok
        ? quotaRes.prefer_https
        : (statusRes.ok ? statusRes.prefer_https : modelsRes.prefer_https);
      return {
        ok: true,
        endpoint: { ...ep, prefer_https: Boolean(preferHttps) },
        quotaSummaryResp: quotaRes.ok ? quotaRes.data : null,
        userStatusResp: statusRes.ok ? statusRes.data : null,
        availableModelsResp: modelsRes.ok ? modelsRes.data : null,
      };
    }
  }
  return { ok: false, endpoint: null };
}
