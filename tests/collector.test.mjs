import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireLock,
  getEndpointsPath,
  getPanePath,
  getQuotaPath,
  getStatusDir,
  readJsonSafe,
  releaseLock,
  resolveHomeDir,
  resolvePaneId,
} from '../bin/lib/cache.mjs';
import {
  findAgyPidByTty,
  findAncestorAgyPid,
  inspectAgyProcess,
  parseLsPortFromLogFile,
} from '../bin/lib/agy-live.mjs';
import { callLsRpc, discoverDaemonHubEndpoints } from '../bin/lib/ls-rpc.mjs';
import { applyHookUpdate, deriveAgentState } from '../bin/lib/hook-handler.mjs';
import { resolveCliSettingsPath } from '../bin/lib/model-tracking.mjs';
import {
  buildModelIndex,
  buildQuotaPayload,
  classifyPoolByKeywords,
  mergeQuotaPools,
  mergeQuotaWindow,
  parseMetaQuotaToPools,
  resolveEffectiveContextLimit,
} from '../bin/lib/models.mjs';
import { applyStatusLineMeta } from '../bin/lib/statusline-feeder.mjs';
import { installStatusLineFeeder, uninstallStatusLineFeeder } from '../bin/setup-statusline.mjs';
import {
  decodeGeneratorMetadataProto,
  getCandidateAppDataDirs,
  loadSqlite,
  readConversationFromSqlite,
} from '../bin/lib/sqlite-fallback.mjs';
import { runDump, runRefresh } from '../bin/agy-status-collector.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_BRIDGE_PATH = path.join(REPO_ROOT, 'agy-plugin', 'scripts', 'hook-bridge.mjs');
const COLLECTOR_PATH = path.join(REPO_ROOT, 'bin', 'agy-status-collector.mjs');

function makeTempDir(prefix = 'agy-quota-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function encodeVarint(num) {
  let n = BigInt(num);
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeFieldVarint(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function encodeFieldBytes(fn, bufOrStr) {
  const buf = typeof bufOrStr === 'string' ? Buffer.from(bufOrStr, 'utf8') : bufOrStr;
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(buf.length), buf]);
}

function buildSyntheticGenMetadataBlob({
  modelEnumInt = 1528,
  inputTokens = 7559,
  outputTokens = 2686,
  cacheReadTokens = 269079,
  responseModel = 'gemini-4-hydrogen',
  modelDisplayName = 'Gemini 4 Hydrogen (XHigh)',
  maxContextTokens = 512000,
  useRetryFallback = false,
} = {}) {
  const usageBuf = Buffer.concat([
    encodeFieldVarint(1, modelEnumInt),
    encodeFieldVarint(2, inputTokens),
    encodeFieldVarint(3, outputTokens),
    encodeFieldVarint(5, cacheReadTokens),
  ]);
  const cwBuf = Buffer.concat([
    encodeFieldVarint(1, 10000),
    encodeFieldVarint(4, maxContextTokens),
  ]);
  const chatStartBuf = encodeFieldBytes(10, cwBuf);

  const cmParts = [
    encodeFieldVarint(3, modelEnumInt),
    encodeFieldBytes(9, chatStartBuf),
    encodeFieldBytes(19, responseModel),
    encodeFieldBytes(21, modelDisplayName),
  ];
  if (useRetryFallback) {
    const retryBuf = encodeFieldBytes(2, usageBuf);
    cmParts.push(encodeFieldBytes(17, retryBuf));
  } else {
    cmParts.push(encodeFieldBytes(4, usageBuf));
  }

  return encodeFieldBytes(1, Buffer.concat(cmParts));
}

async function startMockLsServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    const method = req.url.split('/').pop();
    const reply = await handler({ method, body, headers: req.headers, req });
    const status = reply.status ?? 200;
    const payload = reply.body !== undefined ? JSON.stringify(reply.body) : '{}';
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    address: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function buildMockModelsPayload() {
  return {
    response: {
      models: {
        'gemini-4-hydrogen-xhigh': {
          displayName: 'Gemini 4 Hydrogen (XHigh)',
          model: 'MODEL_PLACEHOLDER_M528',
          maxTokens: 1048576,
          maxOutputTokens: 262144,
        },
        'claude-opus-5-5-high': {
          displayName: 'Claude Opus 5.5 (High)',
          model: 'MODEL_PLACEHOLDER_M402',
          maxTokens: 1000000,
          maxOutputTokens: 128000,
        },
        'gpt-oss-120b-medium': {
          displayName: 'GPT-OSS 120B (Medium)',
          model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
          maxTokens: 131072,
          maxOutputTokens: 32768,
        },
      },
    },
  };
}

function buildMockQuotaSummaryPayload() {
  return {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Hydrogen, Gemini 4 Neon',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.8066,
              resetTime: '2026-11-27T12:46:30Z',
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.9194,
              resetTime: '2026-12-03T09:27:12Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 1,
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.95,
              resetTime: '2026-12-04T00:00:00Z',
            },
          ],
        },
      ],
    },
  };
}

function buildMockUserStatusPayload() {
  return {
    userStatus: {
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Hydrogen (XHigh)',
            modelId: 'gemini-4-hydrogen-xhigh',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
            quotaInfo: { remainingFraction: 0.8066, resetTime: '2026-11-27T12:46:30Z' },
          },
          {
            label: 'Claude Opus 5.5 (High)',
            modelId: 'claude-opus-5-5-high',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
            quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-27T13:34:46Z' },
          },
        ],
      },
    },
  };
}

test('LS RPC collector parses quota, model_pools, pagination, used_pct & cached_pct math, and 3p vs gemini pools', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seenTokens = [];
  const offsetsSeen = [];
  let activeModelMode = 'gemini';

  const mock = await startMockLsServer(({ method, body, headers }) => {
    seenTokens.push(headers['x-codeium-csrf-token']);
    if (method === 'RetrieveUserQuotaSummary') {
      return { body: buildMockQuotaSummaryPayload() };
    }
    if (method === 'GetUserStatus') {
      return { body: buildMockUserStatusPayload() };
    }
    if (method === 'GetAvailableModels') {
      return { body: buildMockModelsPayload() };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      offsetsSeen.push(body.generatorMetadataOffset);
      if (activeModelMode === 'gemini') {
        if (body.generatorMetadataOffset === 0) {
          // Return full 256-item page to verify pagination fetches page 2.
          const firstPage = Array.from({ length: 256 }, (_, idx) => ({
            stepIndices: [idx],
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M528',
              modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
              usage: { inputTokens: '100', outputTokens: '10', cacheReadTokens: '0' },
            },
          }));
          return { body: { generatorMetadata: firstPage } };
        }
        return {
          body: {
            generatorMetadata: [
              {
                stepIndices: [256],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M528',
                  modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
                  usage: {
                    inputTokens: '7559',
                    outputTokens: '2686',
                    cacheReadTokens: '269079',
                  },
                },
              },
            ],
          },
        };
      }
      // 3p pool scenario (Claude Opus 5.5)
      return {
        body: {
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M402',
                modelDisplayName: 'Claude Opus 5.5 (High)',
                usage: {
                  inputTokens: '10000',
                  outputTokens: '5000',
                  cacheReadTokens: '85000',
                },
              },
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  const statusDir = path.join(tmpDir, 'status');
  const res1 = await runRefresh({
    statusDir,
    pane: '2',
    cwd: '/home/xiaolu',
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'secret-token-xyz',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-gemini-1',
    },
  });

  assert.equal(res1.ok, true);
  assert.deepEqual(offsetsSeen, [0, 256]);
  assert.ok(seenTokens.every((tok) => tok === 'secret-token-xyz'));

  const quota = readJsonSafe(getQuotaPath(statusDir));
  assert.equal(quota.version, 1);
  assert.equal(quota.source, 'ls_rpc');
  assert.equal(quota.plan_tier, 'Google AI Pro');
  assert.equal(quota.default_pool, 'gemini');
  assert.equal(quota.pools.gemini.label, 'Gemini');
  assert.equal(quota.pools.gemini.five_hour.remaining_pct, 80.66);
  assert.equal(quota.pools.gemini.five_hour.reset_epoch, Math.floor(Date.parse('2026-11-27T12:46:30Z') / 1000));
  assert.equal(quota.pools.gemini.weekly.remaining_pct, 91.94);
  assert.equal(quota.pools['3p'].label, 'Claude/GPT');
  assert.equal(quota.pools['3p'].five_hour.remaining_pct, 100);
  assert.equal(quota.pools['3p'].five_hour.reset_time, null);
  assert.equal(quota.model_pools.gemini4hydrogenxhigh, 'gemini');
  assert.equal(quota.model_pools.claudeopus55high, '3p');

  const pane2 = readJsonSafe(getPanePath(statusDir, '2'));
  assert.equal(pane2.pane_id, '2');
  assert.equal(pane2.conversation_id, 'conv-gemini-1');
  assert.equal(pane2.model_id, 'MODEL_PLACEHOLDER_M528');
  assert.equal(pane2.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(pane2.pool, 'gemini');
  assert.equal(pane2.context.used_tokens, 279324);
  assert.equal(pane2.context.context_window_size, 1048576);
  assert.equal(pane2.context.used_pct, 26.64);
  assert.equal(pane2.context.remaining_pct, 73.36);
  assert.equal(pane2.context.cached_pct, 97.27);
  assert.equal(pane2.context.source, 'ls_rpc');

  // Verify no csrf_token leaked to quota.json or pane_2.json, and ls_endpoints.json is 0600.
  assert.equal(fs.readFileSync(getQuotaPath(statusDir), 'utf8').includes('secret-token-xyz'), false);
  assert.equal(fs.readFileSync(getPanePath(statusDir, '2'), 'utf8').includes('secret-token-xyz'), false);
  assert.equal(fs.statSync(statusDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(getEndpointsPath(statusDir)).mode & 0o777, 0o600);

  // Switch to 3p Claude Opus 5.5 in pane 3.
  activeModelMode = '3p';
  const res2 = await runRefresh({
    statusDir,
    pane: '3',
    cwd: '/home/xiaolu/other',
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'secret-token-xyz',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-claude-1',
    },
  });
  assert.equal(res2.ok, true);
  const pane3 = readJsonSafe(getPanePath(statusDir, '3'));
  assert.equal(pane3.pool, '3p');
  assert.equal(pane3.model_id, 'MODEL_PLACEHOLDER_M402');
  assert.equal(pane3.context.context_window_size, 1000000);
  assert.equal(pane3.context.used_tokens, 100000);
  assert.equal(pane3.context.used_pct, 10);
  assert.equal(pane3.context.remaining_pct, 90);
  assert.equal(pane3.context.cached_pct, 89.47);
});

test('LS RPC falls back to GetUserStatus clientModelConfigs, discovers daemon hub_*.json, and never flips HTTP->HTTPS on HTTP errors', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let rpcCalls = 0;
  const mock = await startMockLsServer(({ method }) => {
    rpcCalls += 1;
    if (method === 'RetrieveUserQuotaSummary') {
      return { status: 500, body: { error: 'internal' } };
    }
    if (method === 'GetUserStatus') {
      return { body: buildMockUserStatusPayload() };
    }
    if (method === 'GetAvailableModels') {
      return { body: buildMockModelsPayload() };
    }
    return { status: 401, body: { error: 'unauthorized' } };
  });
  t.after(() => mock.close());

  // Direct callLsRpc check: HTTP 401 must NOT flip scheme or retry.
  rpcCalls = 0;
  const authFail = await callLsRpc(
    { ls_address: mock.address, csrf_token: 'bad', prefer_https: false },
    'GetCascadeTrajectoryGeneratorMetadata',
    { cascadeId: 'x' },
    1000
  );
  assert.equal(authFail.ok, false);
  assert.equal(authFail.statusCode, 401);
  assert.equal(authFail.prefer_https, false);
  assert.equal(rpcCalls, 1);

  // Daemon hub_*.json discovery check when ls_endpoints.json and env are absent.
  const geminiDir = path.join(tmpDir, 'gemini');
  const daemonDir = path.join(geminiDir, 'antigravity-cli', 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(
    path.join(daemonDir, 'hub_1234.json'),
    JSON.stringify({ ls_address: mock.address, csrf_token: 'daemon-tok', prefer_https: false })
  );

  const statusDir = path.join(tmpDir, 'status');
  const res = await runRefresh({
    statusDir,
    pane: '9',
    env: {},
    geminiBaseDir: geminiDir,
    appDataDir: path.join(tmpDir, 'no-sqlite'),
  });

  assert.equal(res.ok, true);
  const quota = readJsonSafe(getQuotaPath(statusDir));
  assert.equal(quota.source, 'ls_rpc');
  assert.equal(quota.plan_tier, 'Google AI Pro');
  assert.equal(quota.pools.gemini.five_hour.remaining_pct, 80.66);
  assert.equal(quota.pools['3p'].five_hour.remaining_pct, 65);
  assert.equal(quota.pools['3p'].weekly.remaining_pct, null);
});

test('agy-plugin manifests and hook-bridge.mjs adhere to contract, symlink safety, 0600 permissions, and {} stdout', async (t) => {
  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'agy-plugin', 'plugin.json'), 'utf8')
  );
  assert.equal(pluginJson.name, 'agy-quota-wezterm-bridge');
  assert.equal(pluginJson.version, '0.1.0');

  const hooksJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'agy-plugin', 'hooks.json'), 'utf8')
  );
  const hookEvents = hooksJson['agy-quota-bridge'];
  assert.ok(hookEvents, 'expected top-level agy-quota-bridge hook group');
  assert.equal('PreToolUse' in hookEvents, false, 'must NOT hook PreToolUse');
  for (const ev of ['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop']) {
    assert.ok(Array.isArray(hookEvents[ev]) && hookEvents[ev].length > 0, `missing ${ev}`);
  }

  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Symlink agy-plugin into a temp directory to verify realpath resolution.
  const symlinkPluginDir = path.join(tmpDir, 'linked-plugin');
  fs.symlinkSync(path.join(REPO_ROOT, 'agy-plugin'), symlinkPluginDir);
  const symlinkedHookBridge = path.join(symlinkPluginDir, 'scripts', 'hook-bridge.mjs');

  const statusDir = path.join(tmpDir, 'status');
  const fakeCollector = path.join(tmpDir, 'noop-collector.mjs');
  fs.writeFileSync(fakeCollector, 'process.exit(0);\n');

  const hookEnv = {
    ...process.env,
    WEZTERM_AGY_STATUS_DIR: statusDir,
    WEZTERM_AGY_COLLECTOR_BIN: fakeCollector,
    WEZTERM_PANE: '5',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:41999',
    ANTIGRAVITY_CSRF_TOKEN: 'hook-secret-csrf',
    ANTIGRAVITY_CONVERSATION_ID: 'conv-hook-1',
  };

  const t0 = Date.now();
  const proc = spawnSync(process.execPath, [symlinkedHookBridge, 'PreInvocation'], {
    input: JSON.stringify({
      conversationId: 'conv-hook-1',
      modelName: 'Gemini 4 Hydrogen (XHigh)',
      cwd: '/home/xiaolu/proj',
      hookEventName: 'PreInvocation',
    }),
    env: hookEnv,
    encoding: 'utf8',
    timeout: 5000,
  });
  const elapsedMs = Date.now() - t0;

  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '{}\n');
  assert.equal(proc.stderr, '');
  assert.ok(elapsedMs < 2000, `hook-bridge took too long: ${elapsedMs}ms`);

  const endpointsPath = getEndpointsPath(statusDir);
  assert.equal(fs.statSync(endpointsPath).mode & 0o777, 0o600);
  const endpoints = readJsonSafe(endpointsPath);
  assert.equal(endpoints.latest_key, '5');
  assert.equal(endpoints.endpoints['5'].ls_address, '127.0.0.1:41999');
  assert.equal(endpoints.endpoints['5'].csrf_token, 'hook-secret-csrf');

  const panePath = getPanePath(statusDir, '5');
  const paneRaw = fs.readFileSync(panePath, 'utf8');
  assert.equal(paneRaw.includes('hook-secret-csrf'), false, 'csrf_token must NEVER appear in pane_*.json');
  const pane = JSON.parse(paneRaw);
  assert.equal(pane.pane_id, '5');
  assert.equal(pane.conversation_id, 'conv-hook-1');
  assert.equal(pane.cwd, '/home/xiaolu/proj');
  assert.equal(pane.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(pane.agent_state, 'working');

  // Test Stop hook with malformed stdin and missing WEZTERM_PANE -> fallback pane_default.json.
  const envNoPane = { ...hookEnv };
  delete envNoPane.WEZTERM_PANE;
  const procStop = spawnSync(process.execPath, [symlinkedHookBridge, 'Stop'], {
    input: 'not-valid-json{{{',
    env: envNoPane,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(procStop.status, 0);
  assert.equal(procStop.stdout, '{}\n');
  const defaultPane = readJsonSafe(getPanePath(statusDir, 'default'));
  assert.equal(defaultPane.pane_id, 'default');
  assert.equal(defaultPane.agent_state, 'idle');
});

test('SQLite read-only fallback decodes synthetic gen_metadata protobuf, retryInfos, and workspace matching', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { DatabaseSync } = await loadSqlite();
  const appDataDir = path.join(tmpDir, 'app-data');
  const convDir = path.join(appDataDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  // Create conversation_summaries.db
  const sumDb = new DatabaseSync(path.join(appDataDir, 'conversation_summaries.db'));
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      last_user_input_time TEXT NOT NULL
    );
  `);
  sumDb.prepare(`
    INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'cid-older',
    '["file:///home/xiaolu/other"]',
    'CASCADE_RUN_STATUS_IDLE',
    0,
    '2026-11-27 07:00:00.000+00:00',
    '2026-11-27 07:00:00.000+00:00'
  );
  sumDb.prepare(`
    INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'cid-target',
    '["file:///home/xiaolu/agy-quota.wezterm"]',
    'CASCADE_RUN_STATUS_RUNNING',
    1,
    '2026-11-27 08:30:00.000+00:00',
    '2026-11-27 08:29:00.000+00:00'
  );
  sumDb.close();

  // Create conversations/cid-target.db with retryInfos fallback usage in latest row
  const convDb = new DatabaseSync(path.join(convDir, 'cid-target.db'));
  convDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);');
  const blob0 = buildSyntheticGenMetadataBlob({
    modelEnumInt: 1528,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 5000,
  });
  const blob1 = buildSyntheticGenMetadataBlob({
    modelEnumInt: 1528,
    inputTokens: 7559,
    outputTokens: 2686,
    cacheReadTokens: 269079,
    useRetryFallback: true,
  });
  convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, blob0);
  convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, blob1);
  convDb.close();

  // Verify direct protobuf decoder first.
  const decoded = decodeGeneratorMetadataProto(blob1);
  assert.equal(decoded.modelEnumInt, 1528);
  assert.equal(decoded.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(decoded.usage.inputTokens, 7559);
  assert.equal(decoded.usage.outputTokens, 2686);
  assert.equal(decoded.usage.cacheReadTokens, 269079);

  // Verify full SQLite fallback via collector with no LS reachable.
  const statusDir = path.join(tmpDir, 'status');
  const res = await runRefresh({
    statusDir,
    pane: '11',
    cwd: '/home/xiaolu/agy-quota.wezterm/bin',
    env: {},
    geminiBaseDir: path.join(tmpDir, 'no-gemini'),
    appDataDir,
  });

  assert.equal(res.ok, true);
  const pane = readJsonSafe(getPanePath(statusDir, '11'));
  assert.equal(pane.conversation_id, 'cid-target');
  assert.equal(pane.model_id, 'MODEL_PLACEHOLDER_M528');
  assert.equal(pane.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(pane.agent_state, 'working');
  assert.equal(pane.context.source, 'sqlite');
  assert.equal(pane.context.used_tokens, 279324);
  assert.equal(pane.context.context_window_size, 1048576);
  assert.equal(pane.context.used_pct, 26.64);
  assert.equal(pane.context.cached_pct, 97.27);
});

test('SQLite read-only probe succeeds on local Antigravity conversation DBs when present', async () => {
  const realDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
  if (!fs.existsSync(path.join(realDir, 'conversation_summaries.db'))) {
    return;
  }
  const result = await readConversationFromSqlite({ cwd: '/home/xiaolu', appDataDir: realDir });
  assert.ok(result, 'expected a conversation record from local SQLite');
  assert.ok(typeof result.conversation_id === 'string' && result.conversation_id.length > 0);
  if (result.usage) {
    assert.ok(result.usage.inputTokens + result.usage.outputTokens + result.usage.cacheReadTokens > 0);
  }
});

test('Lock directory .refresh.lock skips active lock, recovers stale lock (>20s), and --dump hides credentials', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const statusDir = path.join(tmpDir, 'status');
  const lockDir = acquireLock(statusDir, 20_000);
  assert.ok(lockDir);

  // Active lock causes non-forced refresh to skip cleanly.
  const skipped = await runRefresh({
    statusDir,
    pane: '1',
    force: false,
    env: {},
    geminiBaseDir: path.join(tmpDir, 'none'),
    appDataDir: path.join(tmpDir, 'none-app'),
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'locked');

  // Make lock stale (> 20s old).
  const staleTime = new Date(Date.now() - 25_000);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: 999999, created_at: Date.now() - 25_000 })
  );
  fs.utimesSync(lockDir, staleTime, staleTime);

  const recovered = await runRefresh({
    statusDir,
    pane: '1',
    force: false,
    env: {},
    geminiBaseDir: path.join(tmpDir, 'none'),
    appDataDir: path.join(tmpDir, 'none-app'),
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.skipped, undefined);
  assert.equal(fs.existsSync(lockDir), false, 'lock should be released after refresh');

  // Verify releaseLock handles null cleanly.
  releaseLock(null);

  // Write ls_endpoints.json with a secret and ensure --dump never leaks it.
  fs.writeFileSync(
    getEndpointsPath(statusDir),
    JSON.stringify({ endpoints: { '1': { ls_address: '127.0.0.1:1', csrf_token: 'do-not-dump' } } }),
    { mode: 0o600 }
  );
  const dumped = runDump(statusDir);
  assert.ok(dumped.panes['1']);
  assert.equal(JSON.stringify(dumped).includes('do-not-dump'), false);

  const cliDump = spawnSync(process.execPath, [COLLECTOR_PATH, '--dump'], {
    env: { ...process.env, WEZTERM_AGY_STATUS_DIR: statusDir },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(cliDump.status, 0);
  assert.equal(cliDump.stdout.includes('do-not-dump'), false);
  const parsedDump = JSON.parse(cliDump.stdout);
  assert.equal(parsedDump.panes['1'].pane_id, '1');
});

test('SQLite fallback decodes steps.metadata when gen_metadata has no rows', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { DatabaseSync } = await loadSqlite();
  const appDataDir = path.join(tmpDir, 'app-data');
  const convDir = path.join(appDataDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const convDb = new DatabaseSync(path.join(convDir, 'cid-steps-only.db'));
  convDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);');
  convDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);');

  const usageBuf = Buffer.concat([
    encodeFieldVarint(1, 1525),
    encodeFieldVarint(2, 2000),
    encodeFieldVarint(3, 500),
    encodeFieldVarint(5, 8000),
  ]);
  const stepMeta = Buffer.concat([
    encodeFieldVarint(11, 1525),
    encodeFieldBytes(9, usageBuf),
  ]);
  convDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 15, 3, stepMeta);
  convDb.close();

  const result = await readConversationFromSqlite({ conversationId: 'cid-steps-only', appDataDir });
  assert.equal(result.conversation_id, 'cid-steps-only');
  assert.equal(result.modelEnumInt, 1525);
  assert.equal(result.usage.inputTokens, 2000);
  assert.equal(result.usage.outputTokens, 500);
  assert.equal(result.usage.cacheReadTokens, 8000);
});

function runChildAsync(cmd, args, { input = '', env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

test('Collector --hook mode and hook-bridge detached collector integration work end-to-end', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mock = await startMockLsServer(({ method }) => {
    if (method === 'RetrieveUserQuotaSummary') return { body: buildMockQuotaSummaryPayload() };
    if (method === 'GetUserStatus') return { body: buildMockUserStatusPayload() };
    if (method === 'GetAvailableModels') return { body: buildMockModelsPayload() };
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      return {
        body: {
          generatorMetadata: [
            {
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M528',
                modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                usage: { inputTokens: '7559', outputTokens: '2686', cacheReadTokens: '269079' },
              },
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  // 1. Direct collector --hook PostToolUse (async spawn so in-process mock HTTP server responds)
  const statusDir1 = path.join(tmpDir, 'status-hook');
  const cliHook = await runChildAsync(process.execPath, [COLLECTOR_PATH, '--hook', 'PostToolUse'], {
    input: JSON.stringify({
      conversationId: 'conv-e2e-1',
      cwd: '/home/xiaolu/work',
      hookEventName: 'PostToolUse',
    }),
    env: {
      ...process.env,
      WEZTERM_AGY_STATUS_DIR: statusDir1,
      WEZTERM_PANE: '12',
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'e2e-token',
    },
  });
  assert.equal(cliHook.status, 0);
  assert.equal(cliHook.stdout, '{}\n');
  assert.equal(readJsonSafe(getQuotaPath(statusDir1)).source, 'ls_rpc');
  const pane12 = readJsonSafe(getPanePath(statusDir1, '12'));
  assert.equal(pane12.agent_state, 'working');
  assert.equal(pane12.context.used_tokens, 279324);

  // 2. Real hook-bridge spawning detached real collector
  const statusDir2 = path.join(tmpDir, 'status-detached');
  const envDetached = {
    ...process.env,
    WEZTERM_AGY_STATUS_DIR: statusDir2,
    WEZTERM_PANE: '14',
    ANTIGRAVITY_LS_ADDRESS: mock.address,
    ANTIGRAVITY_CSRF_TOKEN: 'e2e-token-2',
  };
  delete envDetached.WEZTERM_AGY_COLLECTOR_BIN;

  const hookProc = await runChildAsync(process.execPath, [HOOK_BRIDGE_PATH, 'Stop'], {
    input: JSON.stringify({ conversationId: 'conv-e2e-2', cwd: '/home/xiaolu/work', fullyIdle: true }),
    env: envDetached,
  });
  assert.equal(hookProc.status, 0);
  assert.equal(hookProc.stdout, '{}\n');

  // Poll up to 2s for detached background collector to finish writing quota.json and context
  let pane14 = null;
  for (let i = 0; i < 40; i++) {
    const q = readJsonSafe(getQuotaPath(statusDir2));
    const p = readJsonSafe(getPanePath(statusDir2, '14'));
    if (q?.source === 'ls_rpc' && p?.context?.source === 'ls_rpc') {
      pane14 = p;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(pane14, 'detached collector should populate quota.json and pane context');
  assert.equal(pane14.agent_state, 'idle');
  assert.equal(pane14.context.used_pct, 26.64);
});

test('Pool classification completeness and buildQuotaPayload preserve 3p/gemini labels and buckets without resetTime', () => {
  const threePExamples = [
    'Claude Opus 5.5 (High)',
    'Sonnet 4.5',
    'Haiku 4',
    'GPT-5',
    'GPT-OSS 120B (Medium)',
    'ChatGPT Plus',
    'OpenAI o3',
    'Anthropic Claude',
    '3p',
    'pool-3p-5h',
  ];
  for (const name of threePExamples) {
    assert.equal(classifyPoolByKeywords(name), '3p', `expected 3p for "${name}"`);
  }

  const geminiExamples = [
    'Gemini 4 Hydrogen (XHigh)',
    'Orchestrator',
    'Hydrogen',
    'Neon',
    'Argon',
    'Carbon',
    'Flash',
  ];
  for (const name of geminiExamples) {
    assert.equal(classifyPoolByKeywords(name), 'gemini', `expected gemini for "${name}"`);
  }

  const quota = buildQuotaPayload({
    quotaSummaryResp: {
      response: {
        groups: [
          {
            displayName: 'Gemini',
            description: 'Models within this group: Hydrogen, Neon, Argon, Carbon, Flash',
            buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 }],
          },
          {
            displayName: 'Anthropic / OpenAI',
            description: 'Models within this group: Claude, Opus, Sonnet, Haiku, GPT-OSS, ChatGPT',
            buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1 }],
          },
        ],
      },
    },
    userStatusResp: {},
    availableModelsResp: {},
    nowEpoch: 1700000000,
  });

  assert.equal(quota.pools.gemini.label, 'Gemini');
  assert.equal(quota.pools.gemini.five_hour.remaining_pct, 100);
  assert.equal(quota.pools.gemini.five_hour.reset_time, null);
  assert.equal(quota.pools['3p'].label, 'Claude/GPT');
  assert.equal(quota.pools['3p'].five_hour.remaining_pct, 100);
  assert.equal(quota.pools['3p'].five_hour.reset_time, null);
  assert.equal(quota.model_pools.hydrogen, 'gemini');
  assert.equal(quota.model_pools.neon, 'gemini');
  assert.equal(quota.model_pools.argon, 'gemini');
  assert.equal(quota.model_pools.carbon, 'gemini');
  assert.equal(quota.model_pools.flash, 'gemini');
  assert.equal(quota.model_pools.chatgpt, '3p');
  assert.equal(quota.model_pools.haiku, '3p');
});

test('settings.json /model switch immediately overrides stale RPC step and reverts when new RPC turn runs', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const appDataDir = path.join(tmpDir, 'app-data');
  fs.mkdirSync(appDataDir, { recursive: true });
  const settingsPath = path.join(appDataDir, 'settings.json');
  const initialSettingsText = JSON.stringify(
    { model: 'Gemini 4 Hydrogen (XHigh)', statusLine: { command: 'existing-user-statusline' } },
    null,
    2
  );
  fs.writeFileSync(settingsPath, initialSettingsText);
  // Ensure initial settings.json predates RPC refresh.
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(settingsPath, past, past);

  let steps = [
    {
      stepIndices: [0],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        usage: { inputTokens: '7559', outputTokens: '2686', cacheReadTokens: '269079' },
      },
    },
  ];

  const mock = await startMockLsServer(({ method }) => {
    if (method === 'RetrieveUserQuotaSummary') return { body: buildMockQuotaSummaryPayload() };
    if (method === 'GetUserStatus') return { body: buildMockUserStatusPayload() };
    if (method === 'GetAvailableModels') return { body: buildMockModelsPayload() };
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      return { body: { generatorMetadata: steps } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  const statusDir = path.join(tmpDir, 'status');
  const projectDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(projectDir, { recursive: true });

  // 1. Cold start: RPC step 1 (Gemini) is newer than old settings.json mtime.
  const t1 = Date.now();
  const res1 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    appDataDir,
    nowMs: t1,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-switch-1',
    },
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.pane.pool, 'gemini');
  assert.equal(res1.pane.pool_label, 'Gemini');
  assert.equal(res1.pane.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(res1.pane.model_tracking.rpc_step_count, 1);
  const rpcAt1 = res1.pane.model_tracking.rpc_model_at;
  assert.ok(rpcAt1 > res1.pane.model_tracking.settings_model_changed_at);

  // 2. Refresh again with unchanged rpc_step_count -> rpc_model_at MUST NOT bump.
  const res2 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    appDataDir,
    nowMs: t1 + 500,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-switch-1',
    },
  });
  assert.equal(res2.pane.model_tracking.rpc_model_at, rpcAt1);

  // 3. (4a) User runs /model in agy CLI -> settings.json switches to Claude Opus 5.5 (High),
  // while GetCascadeTrajectoryGeneratorMetadata still has the previous Gemini step (rpc_step_count = 1).
  const updatedSettingsText = JSON.stringify(
    { model: 'Claude Opus 5.5 (High)', statusLine: { command: 'existing-user-statusline' } },
    null,
    2
  );
  fs.writeFileSync(settingsPath, updatedSettingsText);
  const switchTime = new Date(t1 + 1000);
  fs.utimesSync(settingsPath, switchTime, switchTime);

  const res3 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    appDataDir,
    nowMs: t1 + 1200,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-switch-1',
    },
  });
  assert.equal(res3.pane.pool, '3p');
  assert.equal(res3.pane.pool_label, 'Claude/GPT');
  assert.equal(res3.pane.model_id, 'MODEL_PLACEHOLDER_M402');
  assert.equal(res3.pane.model_display_name, 'Claude Opus 5.5 (High)');
  assert.equal(res3.pane.model_tracking.settings_model, 'Claude Opus 5.5 (High)');
  assert.equal(res3.pane.model_tracking.rpc_model_at, rpcAt1);
  // Trajectory context from the last completed Gemini step remains accurate.
  assert.equal(res3.pane.context.used_tokens, 279324);
  assert.equal(res3.pane.context.context_window_size, 1048576);
  // Verify settings.json was strictly read-only (statusLine & content untouched).
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), updatedSettingsText);

  // 4. (4b) User later executes a Gemini turn -> rpc_step_count increases (1 -> 2),
  // rpc_model_at advances and switches pane.pool back to "gemini".
  steps = [
    ...steps,
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        usage: { inputTokens: '8000', outputTokens: '3000', cacheReadTokens: '280000' },
      },
    },
  ];
  const res4 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    appDataDir,
    nowMs: t1 + 3000,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-switch-1',
    },
  });
  assert.equal(res4.pane.pool, 'gemini');
  assert.equal(res4.pane.pool_label, 'Gemini');
  assert.equal(res4.pane.model_id, 'MODEL_PLACEHOLDER_M528');
  assert.equal(res4.pane.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(res4.pane.model_tracking.rpc_step_count, 2);
  assert.ok(res4.pane.model_tracking.rpc_model_at > res3.pane.model_tracking.settings_model_changed_at);

  // 5. Optional <cwd>/.gemini/settings.json and WEZTERM_AGY_CLI_SETTINGS_PATH override.
  const localGeminiDir = path.join(projectDir, '.gemini');
  fs.mkdirSync(localGeminiDir, { recursive: true });
  const localSettingsPath = path.join(localGeminiDir, 'settings.json');
  fs.writeFileSync(localSettingsPath, JSON.stringify({ model: 'GPT-OSS 120B (Medium)' }));
  const localTime = new Date(t1 + 4000);
  fs.utimesSync(localSettingsPath, localTime, localTime);

  const res5 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    cliSettingsPath: settingsPath,
    nowMs: t1 + 4500,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-switch-1',
    },
  });
  assert.equal(res5.pane.pool, '3p');
  assert.equal(res5.pane.pool_label, 'Claude/GPT');
  assert.equal(res5.pane.model_id, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(res5.pane.model_display_name, 'GPT-OSS 120B (Medium)');

  // 6. New conversation_id (via SessionStart hook or explicit conversationId) resets rpc_step_count = 0 and rpc_model_at = 0.
  steps = [];
  applyHookUpdate({
    hookEvent: 'SessionStart',
    payload: { conversationId: 'conv-new-session-2', cwd: projectDir },
    env: { WEZTERM_PANE: '20', ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch' },
    statusDir,
    nowMs: t1 + 4900,
  });
  const res6 = await runRefresh({
    statusDir,
    pane: '20',
    cwd: projectDir,
    appDataDir,
    nowMs: t1 + 5000,
    env: {
      WEZTERM_AGY_CLI_SETTINGS_PATH: settingsPath,
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch',
    },
  });
  assert.equal(res6.pane.conversation_id, 'conv-new-session-2');
  assert.equal(res6.pane.model_tracking.rpc_step_count, 0);
  assert.equal(res6.pane.model_tracking.rpc_model_at, 0);
  assert.equal(res6.pane.model_tracking.rpc_model, null);
  assert.equal(res6.pane.context.source, 'initial');
  assert.equal(res6.pane.context.used_tokens, 0);
  assert.equal(res6.pane.context.used_pct, 0);
  assert.equal(res6.pane.context.cached_pct, 0);
  assert.equal(res6.pane.context.context_window_size, 131072);
  // Active settings model applies to fresh session immediately.
  assert.equal(res6.pane.pool, '3p');
  assert.equal(res6.pane.pool_label, 'Claude/GPT');

  // 7. Fast real-clock /model switch right after an RPC turn (guards against Linux coarse inode mtime lag).
  const fastAppDir = path.join(tmpDir, 'fast-app');
  fs.mkdirSync(fastAppDir, { recursive: true });
  const fastSettings = path.join(fastAppDir, 'settings.json');
  fs.writeFileSync(fastSettings, JSON.stringify({ model: 'Gemini 4 Hydrogen (XHigh)' }));
  steps = [
    {
      stepIndices: [0],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        usage: { inputTokens: '1000', outputTokens: '200', cacheReadTokens: '3000' },
      },
    },
  ];
  const fast1 = await runRefresh({
    statusDir,
    pane: '23',
    cwd: tmpDir,
    appDataDir: fastAppDir,
    conversationId: 'conv-fast-1',
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch' },
  });
  assert.equal(fast1.pane.pool, 'gemini');
  fs.writeFileSync(fastSettings, JSON.stringify({ model: 'Claude Opus 5.5 (High)' }));
  const fast2 = await runRefresh({
    statusDir,
    pane: '23',
    cwd: tmpDir,
    appDataDir: fastAppDir,
    conversationId: 'conv-fast-1',
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-model-switch' },
  });
  assert.equal(fast2.pane.pool, '3p');
  assert.equal(fast2.pane.pool_label, 'Claude/GPT');
  assert.equal(fast2.pane.model_display_name, 'Claude Opus 5.5 (High)');
});

test('PreInvocation hook modelName updates hook_model_at and preserves 3p across unchanged RPC refreshes', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const appDataDir = path.join(tmpDir, 'app-data');
  fs.mkdirSync(appDataDir, { recursive: true });
  const settingsPath = path.join(appDataDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Hydrogen (XHigh)' }));
  const oldTime = new Date(Date.now() - 20_000);
  fs.utimesSync(settingsPath, oldTime, oldTime);

  const steps = [
    {
      stepIndices: [0],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        usage: { inputTokens: '5000', outputTokens: '1000', cacheReadTokens: '100000' },
      },
    },
  ];

  const mock = await startMockLsServer(({ method, body }) => {
    if (method === 'RetrieveUserQuotaSummary') return { body: buildMockQuotaSummaryPayload() };
    if (method === 'GetUserStatus') return { body: buildMockUserStatusPayload() };
    if (method === 'GetAvailableModels') return { body: buildMockModelsPayload() };
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      return { body: { generatorMetadata: body.cascadeId === 'conv-tie' ? [] : steps } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  const statusDir = path.join(tmpDir, 'status');
  const t0 = Date.now();

  // 1. Initial refresh sees 1 Gemini step.
  const r1 = await runRefresh({
    statusDir,
    pane: '21',
    cwd: tmpDir,
    appDataDir,
    nowMs: t0,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-hook-preserve',
    },
  });
  assert.equal(r1.pane.pool, 'gemini');
  assert.equal(r1.pane.pool_label, 'Gemini');
  assert.equal(r1.pane.model_tracking.rpc_step_count, 1);

  // 2. (4c) PreInvocation hook fires with GPT-OSS 120B (Medium).
  const hookRes = applyHookUpdate({
    hookEvent: 'PreInvocation',
    payload: {
      conversationId: 'conv-hook-preserve',
      modelName: 'GPT-OSS 120B (Medium)',
      cwd: tmpDir,
    },
    env: {
      WEZTERM_PANE: '21',
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve',
    },
    statusDir,
    nowMs: t0 + 1000,
  });
  assert.equal(hookRes.panePayload.pool, '3p');
  assert.equal(hookRes.panePayload.pool_label, 'Claude/GPT');
  assert.equal(hookRes.panePayload.model_id, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(hookRes.panePayload.model_display_name, 'GPT-OSS 120B (Medium)');
  assert.equal(hookRes.panePayload.model_tracking.hook_model_at, t0 + 1000);
  assert.equal(hookRes.panePayload.model_tracking.rpc_step_count, 1);

  // 3. Subsequent runRefresh with unchanged rpc_step_count MUST preserve 3p instead of reverting to Gemini.
  const r2 = await runRefresh({
    statusDir,
    pane: '21',
    cwd: tmpDir,
    appDataDir,
    nowMs: t0 + 1500,
    env: {
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-hook-preserve',
    },
  });
  assert.equal(r2.pane.pool, '3p');
  assert.equal(r2.pane.pool_label, 'Claude/GPT');
  assert.equal(r2.pane.model_id, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(r2.pane.model_display_name, 'GPT-OSS 120B (Medium)');
  assert.equal(r2.pane.model_tracking.rpc_model_at, t0);

  // 4. Tie-break: hook_model_at (--model CLI flag) beats settings_model_changed_at when timestamps tie.
  const tieTime = t0 + 2000;
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Hydrogen (XHigh)' }));
  fs.utimesSync(settingsPath, new Date(tieTime), new Date(tieTime));
  applyHookUpdate({
    hookEvent: 'PreInvocation',
    payload: { conversationId: 'conv-tie', model: 'Claude Opus 5.5 (High)', cwd: tmpDir },
    env: { WEZTERM_PANE: '22', ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve' },
    statusDir,
    nowMs: tieTime,
  });
  const rTie = await runRefresh({
    statusDir,
    pane: '22',
    cwd: tmpDir,
    appDataDir,
    nowMs: tieTime + 50,
    env: {
      WEZTERM_AGY_CLI_SETTINGS_PATH: settingsPath,
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-tie',
    },
  });
  assert.equal(rTie.pane.model_tracking.hook_model_at, tieTime);
  assert.equal(rTie.pane.model_tracking.settings_model_changed_at, tieTime);
  assert.equal(rTie.pane.pool, '3p');
  assert.equal(rTie.pane.model_display_name, 'Claude Opus 5.5 (High)');

  // 5. End-to-end --hook PreInvocation CLI preserves 3p when RPC still has prior Gemini step.
  const cliPre = await runChildAsync(process.execPath, [COLLECTOR_PATH, '--hook', 'PreInvocation'], {
    input: JSON.stringify({
      conversationId: 'conv-hook-preserve',
      modelName: 'GPT-OSS 120B (Medium)',
      cwd: tmpDir,
      hookEventName: 'PreInvocation',
    }),
    env: {
      ...process.env,
      WEZTERM_AGY_STATUS_DIR: statusDir,
      WEZTERM_AGY_CLI_SETTINGS_PATH: settingsPath,
      WEZTERM_PANE: '21',
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-hook-preserve',
    },
  });
  assert.equal(cliPre.status, 0);
  assert.equal(cliPre.stdout, '{}\n');
  const pane21AfterCli = readJsonSafe(getPanePath(statusDir, '21'));
  assert.equal(pane21AfterCli.pool, '3p');
  assert.equal(pane21AfterCli.pool_label, 'Claude/GPT');
  assert.equal(pane21AfterCli.model_display_name, 'GPT-OSS 120B (Medium)');
});

test('resolvePaneId follows priority explicit > WEZTERM_PANE > WT_SESSION (wt_<id>) > default', () => {
  const fullEnv = {
    WEZTERM_PANE: '2',
    WT_SESSION: '9a1b2c3d-4e5f-6789-abcd-ef0123456789',
  };

  // 1. Explicit pane beats WEZTERM_PANE and WT_SESSION (including numeric '0')
  assert.equal(resolvePaneId('7', fullEnv), '7');
  assert.equal(resolvePaneId(0, fullEnv), '0');
  assert.equal(resolvePaneId('wt_custom/1', fullEnv), 'wt_custom_1');

  // 2. Empty/whitespace explicit pane falls through to WEZTERM_PANE
  assert.equal(resolvePaneId(null, fullEnv), '2');
  assert.equal(resolvePaneId('   ', fullEnv), '2');

  // 3. Missing/empty WEZTERM_PANE falls through to WT_SESSION with wt_ prefix (never colliding with numeric WezTerm IDs)
  assert.equal(
    resolvePaneId(null, { WT_SESSION: '9a1b2c3d-4e5f-6789-abcd-ef0123456789' }),
    'wt_9a1b2c3d-4e5f-6789-abcd-ef0123456789'
  );
  assert.equal(
    resolvePaneId(undefined, { WEZTERM_PANE: '  ', WT_SESSION: '{abc-123}' }),
    'wt__abc-123_'
  );
  assert.equal(resolvePaneId(null, { WT_SESSION: '2' }), 'wt_2');

  // 4. Fallback to 'default' when all candidates are absent or whitespace
  assert.equal(resolvePaneId(null, {}), 'default');
  assert.equal(resolvePaneId(undefined, { WEZTERM_PANE: '', WT_SESSION: '   ' }), 'default');
  assert.equal(resolvePaneId(null, null), 'default');
});

test('Windows Terminal WT_SESSION isolates hook state and refresh from WezTerm numeric panes', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mock = await startMockLsServer(({ method, body }) => {
    if (method === 'RetrieveUserQuotaSummary') return { body: buildMockQuotaSummaryPayload() };
    if (method === 'GetUserStatus') return { body: buildMockUserStatusPayload() };
    if (method === 'GetAvailableModels') return { body: buildMockModelsPayload() };
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      if (body.cascadeId === 'conv-wt-1') {
        return {
          body: {
            generatorMetadata: [
              {
                stepIndices: [0],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M402',
                  modelDisplayName: 'Claude Opus 5.5 (High)',
                  usage: { inputTokens: '1000', outputTokens: '500', cacheReadTokens: '8500' },
                },
              },
            ],
          },
        };
      }
      return {
        body: {
          generatorMetadata: [
            {
              stepIndices: [0],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M528',
                modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                usage: { inputTokens: '2000', outputTokens: '500', cacheReadTokens: '7500' },
              },
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  const statusDir = path.join(tmpDir, 'status');
  const wtSessionA = '11111111-2222-3333-4444-555555555555';
  const wtSessionNumeric = '2';

  // 1. WezTerm pane 2 hook + refresh
  const wezHook = applyHookUpdate({
    hookEvent: 'PreInvocation',
    payload: { conversationId: 'conv-wez-2', cwd: '/home/xiaolu/wez-proj' },
    env: {
      WEZTERM_PANE: '2',
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-wez',
    },
    statusDir,
  });
  assert.equal(wezHook.paneId, '2');

  const wezRefresh = await runRefresh({
    statusDir,
    cwd: '/home/xiaolu/wez-proj',
    appDataDir: path.join(tmpDir, 'no-sqlite'),
    geminiBaseDir: path.join(tmpDir, 'no-gemini'),
    env: {
      WEZTERM_PANE: '2',
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-wez',
    },
  });
  assert.equal(wezRefresh.ok, true);
  assert.equal(wezRefresh.paneId, '2');
  assert.equal(wezRefresh.pane.pool, 'gemini');

  // 2. WT_SESSION='2' must write to pane_wt_2.json and NEVER collide with pane_2.json
  const wtNumHook = applyHookUpdate({
    hookEvent: 'PreInvocation',
    payload: { conversationId: 'conv-wt-1', cwd: '/home/xiaolu/wt-num' },
    env: {
      WT_SESSION: wtSessionNumeric,
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-wt-num',
    },
    statusDir,
  });
  assert.equal(wtNumHook.paneId, 'wt_2');

  const wtNumRefresh = await runRefresh({
    statusDir,
    cwd: '/home/xiaolu/wt-num',
    appDataDir: path.join(tmpDir, 'no-sqlite'),
    geminiBaseDir: path.join(tmpDir, 'no-gemini'),
    env: {
      WT_SESSION: wtSessionNumeric,
      ANTIGRAVITY_LS_ADDRESS: mock.address,
      ANTIGRAVITY_CSRF_TOKEN: 'tok-wt-num',
    },
  });
  assert.equal(wtNumRefresh.ok, true);
  assert.equal(wtNumRefresh.paneId, 'wt_2');
  assert.equal(wtNumRefresh.pane.pool, '3p');
  assert.equal(wtNumRefresh.pane.conversation_id, 'conv-wt-1');

  // Verify pane_2.json stayed isolated with Gemini / conv-wez-2
  const pane2 = readJsonSafe(getPanePath(statusDir, '2'));
  assert.equal(pane2.pane_id, '2');
  assert.equal(pane2.conversation_id, 'conv-wez-2');
  assert.equal(pane2.pool, 'gemini');

  // 3. End-to-end hook-bridge.mjs with WT_SESSION UUID spawns collector with --pane wt_<uuid>
  const envWtBridge = {
    ...process.env,
    WEZTERM_AGY_STATUS_DIR: statusDir,
    WT_SESSION: wtSessionA,
    ANTIGRAVITY_LS_ADDRESS: mock.address,
    ANTIGRAVITY_CSRF_TOKEN: 'tok-wt-uuid',
  };
  delete envWtBridge.WEZTERM_PANE;
  delete envWtBridge.WEZTERM_AGY_COLLECTOR_BIN;

  const hookProc = await runChildAsync(process.execPath, [HOOK_BRIDGE_PATH, 'Stop'], {
    input: JSON.stringify({ conversationId: 'conv-wt-1', cwd: '/home/xiaolu/wt-uuid', fullyIdle: true }),
    env: envWtBridge,
  });
  assert.equal(hookProc.status, 0);
  assert.equal(hookProc.stdout, '{}\n');

  const expectedWtKey = `wt_${wtSessionA}`;
  let wtPane = null;
  for (let i = 0; i < 40; i++) {
    const p = readJsonSafe(getPanePath(statusDir, expectedWtKey));
    if (p?.context?.source === 'ls_rpc') {
      wtPane = p;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(wtPane, 'hook-bridge + detached collector should populate pane_wt_<uuid>.json');
  assert.equal(wtPane.pane_id, expectedWtKey);
  assert.equal(wtPane.pool, '3p');
  assert.equal(wtPane.agent_state, 'idle');

  const endpoints = readJsonSafe(getEndpointsPath(statusDir));
  assert.equal(endpoints.endpoints['2'].csrf_token, 'tok-wez');
  assert.equal(endpoints.endpoints['wt_2'].csrf_token, 'tok-wt-num');
  assert.equal(endpoints.endpoints[expectedWtKey].csrf_token, 'tok-wt-uuid');
});

test('Cross-platform path helpers preserve Linux paths and support Windows HOME/USERPROFILE/LOCALAPPDATA', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Linux paths remain identical
  assert.equal(resolveHomeDir({ HOME: '/home/alice' }, 'linux'), '/home/alice');
  assert.equal(
    getStatusDir({ HOME: '/home/alice' }, 'linux'),
    path.join('/home/alice', '.cache', 'wezterm-agy-status')
  );
  assert.equal(
    getStatusDir({ HOME: '/home/alice', XDG_CACHE_HOME: '/tmp/xdg' }, 'linux'),
    path.join('/tmp/xdg', 'wezterm-agy-status')
  );
  assert.equal(
    getStatusDir({ WEZTERM_AGY_STATUS_DIR: path.join(tmpDir, 'override') }, 'linux'),
    path.resolve(path.join(tmpDir, 'override'))
  );

  // Windows path resolution
  assert.equal(resolveHomeDir({ USERPROFILE: '/win/users/alice' }, 'win32'), '/win/users/alice');
  assert.equal(
    resolveHomeDir({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\alice' }, 'win32'),
    'C:\\Users\\alice'
  );
  assert.equal(
    getStatusDir({ LOCALAPPDATA: '/win/localappdata', USERPROFILE: '/win/users/alice' }, 'win32'),
    path.join('/win/localappdata', 'wezterm-agy-status')
  );
  assert.equal(
    getStatusDir({ USERPROFILE: '/win/users/alice' }, 'win32'),
    path.join('/win/users/alice', 'AppData', 'Local', 'wezterm-agy-status')
  );
  assert.equal(
    getStatusDir({ XDG_CACHE_HOME: '/win/xdg', LOCALAPPDATA: '/win/localappdata' }, 'win32'),
    path.join('/win/xdg', 'wezterm-agy-status')
  );

  // resolveCliSettingsPath, getCandidateAppDataDirs, and discoverDaemonHubEndpoints respect injected env HOME
  const fakeHome = path.join(tmpDir, 'fake-home');
  const daemonDir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(
    path.join(daemonDir, 'hub_1.json'),
    JSON.stringify({ ls_address: '127.0.0.1:50001', csrf_token: 'hub-tok' })
  );

  const envWithHome = { HOME: fakeHome };
  assert.equal(
    resolveCliSettingsPath({ env: envWithHome }),
    path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json')
  );
  assert.deepEqual(getCandidateAppDataDirs(null, envWithHome, 'linux'), [
    path.join(fakeHome, '.gemini', 'antigravity-cli'),
    path.join(fakeHome, '.gemini', 'antigravity'),
  ]);
  const hubs = discoverDaemonHubEndpoints(null, envWithHome);
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].ls_address, '127.0.0.1:50001');
});

test('/resume live process inspection switches conversation metrics immediately and resets on empty or fresh agy boot', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const appDataDir = path.join(tmpDir, 'app-data');
  const convDir = path.join(appDataDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const settingsPath = path.join(appDataDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Claude Opus 5.5 (High)' }));

  // Create a stale conversation DB on disk that must NEVER be grabbed on fresh agy boot.
  const { DatabaseSync } = await loadSqlite();
  const sumDb = new DatabaseSync(path.join(appDataDir, 'conversation_summaries.db'));
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      last_user_input_time TEXT NOT NULL
    );
  `);
  const workspaceDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    'conv-stale-db',
    JSON.stringify([workspaceDir]),
    'CASCADE_RUN_STATUS_IDLE',
    0,
    '2026-11-27 08:00:00.000+00:00',
    '2026-11-27 08:00:00.000+00:00'
  );
  sumDb.close();
  const staleConvDb = new DatabaseSync(path.join(convDir, 'conv-stale-db.db'));
  staleConvDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);');
  staleConvDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
    0,
    buildSyntheticGenMetadataBlob({ inputTokens: 99999, outputTokens: 1000, cacheReadTokens: 0 })
  );
  staleConvDb.close();

  const mock = await startMockLsServer(({ method, body }) => {
    if (method === 'RetrieveUserQuotaSummary') return { body: buildMockQuotaSummaryPayload() };
    if (method === 'GetUserStatus') return { body: buildMockUserStatusPayload() };
    if (method === 'GetAvailableModels') return { body: buildMockModelsPayload() };
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      if (body.cascadeId === 'conv-A') {
        return {
          body: {
            generatorMetadata: [
              {
                stepIndices: [0],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M402',
                  modelDisplayName: 'Claude Opus 5.5 (High)',
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
                  usage: { inputTokens: '10000', outputTokens: '5000', cacheReadTokens: '85000' },
                },
              },
            ],
          },
        };
      }
      if (body.cascadeId === 'conv-B') {
        return {
          body: {
            generatorMetadata: [
              {
                stepIndices: [0],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M528',
                  modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                  // Option 1.B: catalog maxTokens (1048576) MUST take priority over chatStartMetadata (512000)
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
                  usage: { inputTokens: '7559', outputTokens: '2686', cacheReadTokens: '269079' },
                },
              },
            ],
          },
        };
      }
      return { body: { generatorMetadata: [] } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => mock.close());

  const statusDir = path.join(tmpDir, 'status');
  const t0 = Date.now();

  // 1. Initial conversation conv-A on agyPid 555 (100k tokens, Claude 5.5 -> 1,000,000 maxTokens)
  const rA = await runRefresh({
    statusDir,
    pane: '1',
    cwd: workspaceDir,
    appDataDir,
    agyPid: 555,
    nowMs: t0,
    inspectProcessFn: () => ({ alive: true, inspected: true, pid: 555, conversationId: 'conv-A', cwd: workspaceDir }),
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-resume' },
  });
  assert.equal(rA.ok, true);
  assert.equal(rA.pane.agy_pid, 555);
  assert.equal(rA.pane.conversation_id, 'conv-A');
  assert.equal(rA.pane.pool, '3p');
  assert.equal(rA.pane.context.used_tokens, 100000);
  assert.equal(rA.pane.context.context_window_size, 1000000);
  assert.equal(rA.pane.context.used_pct, 10);

  // 2. User runs /resume to conv-B inside same agy process 555 (no explicit conversationId or agyPid passed!)
  const rB = await runRefresh({
    statusDir,
    pane: '1',
    cwd: workspaceDir,
    appDataDir,
    nowMs: t0 + 1000,
    inspectProcessFn: (pid) => {
      assert.equal(pid, 555);
      return { alive: true, inspected: true, pid: 555, conversationId: 'conv-B', cwd: workspaceDir };
    },
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-resume' },
  });
  assert.equal(rB.ok, true);
  assert.equal(rB.pane.conversation_id, 'conv-B');
  assert.equal(rB.pane.pool, 'gemini');
  assert.equal(rB.pane.model_display_name, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(rB.pane.context.source, 'ls_rpc');
  assert.equal(rB.pane.context.used_tokens, 279324);
  assert.equal(rB.pane.context.context_window_size, 1048576);
  assert.equal(rB.pane.context.used_pct, 26.64);
  assert.equal(rB.pane.context.cached_pct, 97.27);

  // 3. /resume to an empty 0-step conversation -> clears conv-B's tokens and initializes 0-usage context
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Hydrogen (High)' }));
  const rEmpty = await runRefresh({
    statusDir,
    pane: '1',
    cwd: workspaceDir,
    appDataDir,
    nowMs: t0 + 2000,
    inspectProcessFn: () => ({ alive: true, inspected: true, pid: 555, conversationId: 'conv-empty', cwd: workspaceDir }),
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-resume' },
  });
  assert.equal(rEmpty.ok, true);
  assert.equal(rEmpty.pane.conversation_id, 'conv-empty');
  assert.equal(rEmpty.pane.model_tracking.rpc_step_count, 0);
  assert.equal(rEmpty.pane.model_tracking.rpc_model, null);
  assert.equal(rEmpty.pane.context.source, 'initial');
  assert.equal(rEmpty.pane.context.used_tokens, 0);
  assert.equal(rEmpty.pane.context.used_pct, 0);
  assert.equal(rEmpty.pane.context.cached_pct, 0);
  assert.equal(rEmpty.pane.context.remaining_pct, 100);
  assert.equal(rEmpty.pane.context.context_window_size, 1048576);

  // 4. Fresh agy boot (new pid 777, conversationId: null) -> never inherits conv-A/B or stale SQLite DB
  // First switch pane back to conv-A with 100k tokens, then boot fresh agy 777
  await runRefresh({
    statusDir,
    pane: '1',
    cwd: workspaceDir,
    appDataDir,
    agyPid: 555,
    nowMs: t0 + 2500,
    inspectProcessFn: () => ({ alive: true, inspected: true, pid: 555, conversationId: 'conv-A', cwd: workspaceDir }),
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-resume' },
  });
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Claude Opus 5.5 (High)' }));
  const rFresh = await runRefresh({
    statusDir,
    pane: '1',
    cwd: workspaceDir,
    appDataDir,
    agyPid: 777,
    nowMs: t0 + 3000,
    inspectProcessFn: () => ({ alive: true, inspected: true, pid: 777, conversationId: null, cwd: workspaceDir }),
    env: { ANTIGRAVITY_LS_ADDRESS: mock.address, ANTIGRAVITY_CSRF_TOKEN: 'tok-resume' },
  });
  assert.equal(rFresh.ok, true);
  assert.equal(rFresh.pane.agy_pid, 777);
  assert.equal(rFresh.pane.conversation_id, null);
  assert.equal(rFresh.pane.pool, '3p');
  assert.equal(rFresh.pane.model_display_name, 'Claude Opus 5.5 (High)');
  assert.equal(rFresh.pane.model_tracking.rpc_step_count, 0);
  assert.equal(rFresh.pane.model_tracking.rpc_model, null);
  assert.equal(rFresh.pane.context.source, 'initial');
  assert.equal(rFresh.pane.context.used_tokens, 0);
  assert.equal(rFresh.pane.context.used_pct, 0);
  assert.equal(rFresh.pane.context.cached_pct, 0);
  assert.equal(rFresh.pane.context.context_window_size, 1000000);
});

test('UserPromptSubmit state derivation and hook-bridge --force argument passing work cleanly', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  assert.equal(deriveAgentState('UserPromptSubmit', {}, 'idle'), 'working');

  const statusDir = path.join(tmpDir, 'status');
  const argsOut = path.join(tmpDir, 'spawned-args.json');
  const mockCollector = path.join(tmpDir, 'record-collector.mjs');
  fs.writeFileSync(
    mockCollector,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argsOut)}, JSON.stringify(process.argv.slice(2)));\n`
  );

  // Seed existing pane with an old conversation_id to verify hook-bridge does NOT forward stale existingPane.conversation_id
  applyHookUpdate({
    hookEvent: 'Stop',
    payload: { conversationId: 'conv-stale-old', cwd: '/home/xiaolu/old' },
    agyPid: 111,
    env: { WEZTERM_PANE: '33' },
    statusDir,
  });

  const bridgeEnv = {
    ...process.env,
    WEZTERM_AGY_STATUS_DIR: statusDir,
    WEZTERM_AGY_COLLECTOR_BIN: mockCollector,
    WEZTERM_PANE: '33',
  };
  delete bridgeEnv.ANTIGRAVITY_CONVERSATION_ID;
  delete bridgeEnv.ANTIGRAVITY_LS_ADDRESS;
  delete bridgeEnv.ANTIGRAVITY_CSRF_TOKEN;

  const proc = await runChildAsync(process.execPath, [HOOK_BRIDGE_PATH, 'UserPromptSubmit'], {
    input: JSON.stringify({ cwd: '/home/xiaolu/new-ws', hookEventName: 'UserPromptSubmit' }),
    env: bridgeEnv,
  });
  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '{}\n');

  let spawnedArgs = null;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(argsOut)) {
      spawnedArgs = JSON.parse(fs.readFileSync(argsOut, 'utf8'));
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(spawnedArgs, 'hook-bridge should spawn collector with arguments');
  assert.ok(spawnedArgs.includes('--refresh'));
  assert.ok(spawnedArgs.includes('--force'));
  assert.ok(spawnedArgs.includes('--pane'));
  assert.equal(spawnedArgs[spawnedArgs.indexOf('--pane') + 1], '33');
  assert.equal(spawnedArgs.includes('--conversation-id'), false, 'must NOT forward stale existingPane.conversation_id');

  const pane33 = readJsonSafe(getPanePath(statusDir, '33'));
  assert.equal(pane33.agent_state, 'working');
});

test('Linux /proc live helpers parse ancestor PID, TTY PID, LS log ports, and open FDs', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const procRoot = path.join(tmpDir, 'proc');
  const mkProc = (pid, { ppid, comm, cmdline, starttime = 100, fd0 = null, cwd = null, fds = {} }) => {
    const pDir = path.join(procRoot, String(pid));
    fs.mkdirSync(path.join(pDir, 'fd'), { recursive: true });
    // Build Linux /proc/<pid>/stat with 22 fields (rest[1]=ppid, rest[19]=starttime)
    const fieldsAfterComm = new Array(20).fill('0');
    fieldsAfterComm[0] = 'S';
    fieldsAfterComm[1] = String(ppid);
    fieldsAfterComm[19] = String(starttime);
    fs.writeFileSync(path.join(pDir, 'stat'), `${pid} (${comm}) ${fieldsAfterComm.join(' ')}\n`);
    fs.writeFileSync(path.join(pDir, 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(pDir, 'cmdline'), cmdline);
    if (fd0) fs.symlinkSync(fd0, path.join(pDir, 'fd', '0'));
    if (cwd) fs.symlinkSync(cwd, path.join(pDir, 'cwd'));
    for (const [fdNum, target] of Object.entries(fds)) {
      fs.symlinkSync(target, path.join(pDir, 'fd', fdNum));
    }
  };

  const logPath = path.join(tmpDir, 'cli-20261127_180000.log');
  fs.writeFileSync(
    logPath,
    '2026-11-27T18:00:00Z INFO starting...\n'
    + 'Language server listening on random port at 41234 for HTTP\n'
    + 'Language server listening on random port at 41235 for HTTPS\n'
  );
  assert.deepEqual(parseLsPortFromLogFile(logPath), { httpPort: 41234, httpsPort: 41235 });

  const uuidDb = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const uuidLock = '11111111-2222-3333-4444-555555555555';
  const workDir = path.join(tmpDir, 'project');
  fs.mkdirSync(workDir, { recursive: true });

  // Process tree: 10 (bash) -> 200 (agy) -> 300 (sh) -> 400 (node hook-bridge)
  mkProc(10, { ppid: 1, comm: 'bash', cmdline: '-bash\0' });
  mkProc(200, {
    ppid: 10,
    comm: 'agy',
    cmdline: '/usr/local/bin/agy\0--model\0gemini\0',
    starttime: 500,
    fd0: '/dev/pts/9',
    cwd: workDir,
    fds: {
      1: logPath,
      16: `/home/xiaolu/.gemini/antigravity-cli/conversations/${uuidDb}.db-wal`,
      17: `/home/xiaolu/.gemini/antigravity-cli/conversations/${uuidDb}.db`,
      18: `/home/xiaolu/.gemini/antigravity-cli/presence/${uuidLock}.lock`,
    },
  });
  // Newer agy process on same TTY (welcome screen only, no conversation .db or .lock)
  mkProc(250, {
    ppid: 10,
    comm: 'agy-cli',
    cmdline: 'agy-cli\0',
    starttime: 900,
    fd0: '/dev/pts/9',
    cwd: workDir,
    fds: { 1: logPath },
  });
  mkProc(300, { ppid: 200, comm: 'sh', cmdline: 'sh\0-c\0node\0' });
  mkProc(400, { ppid: 300, comm: 'node', cmdline: 'node\0hook-bridge.mjs\0' });

  assert.equal(findAncestorAgyPid(400, procRoot), 200);
  assert.equal(findAncestorAgyPid(10, procRoot), null);
  assert.equal(findAgyPidByTty('/dev/pts/9', procRoot), 250);
  assert.equal(findAgyPidByTty('/dev/pts/99', procRoot), null);

  // inspectAgyProcess on PID 200 prefers .db over .lock and ignores -wal
  const info200 = inspectAgyProcess(200, { procRoot });
  assert.equal(info200.alive, true);
  assert.equal(info200.inspected, true);
  assert.equal(info200.pid, 200);
  assert.equal(info200.conversationId, uuidDb);
  assert.equal(info200.logPath, logPath);
  assert.equal(info200.httpPort, 41234);
  assert.equal(info200.httpsPort, 41235);
  assert.equal(info200.cwd, workDir);

  // inspectAgyProcess on PID 250 (welcome screen) returns conversationId: null, inspected: true
  const info250 = inspectAgyProcess(250, { procRoot });
  assert.equal(info250.alive, true);
  assert.equal(info250.inspected, true);
  assert.equal(info250.conversationId, null);

  // inspectAgyProcess on non-agy PID or missing PID returns alive: false
  assert.deepEqual(inspectAgyProcess(300, { procRoot }), { alive: false, inspected: false });
  assert.deepEqual(inspectAgyProcess(999999, { procRoot }), { alive: false, inspected: false });
});

test('Silent statusLine feeder ingests meta.quota, effective ceiling, cache_creation_input_tokens, and stays stdout-silent', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const statusDir = path.join(tmpDir, 'status');
  const feederPath = path.join(REPO_ROOT, 'bin', 'agy-statusline-feeder.mjs');
  const fakeCollector = path.join(tmpDir, 'noop-collector.mjs');
  fs.writeFileSync(fakeCollector, 'process.exit(0);\n');

  const meta1 = {
    conversation_id: 'conv-sl-1',
    cwd: '/home/xiaolu/proj',
    model: { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
    agent_state: 'working',
    plan_tier: 'Google AI Pro',
    context_window: {
      total_input_tokens: 128000,
      total_output_tokens: 3000,
      context_window_size: 1000000,
      current_usage: {
        input_tokens: 10000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 80000,
        output_tokens: 500,
      },
    },
    quota: {
      '3p-5h': { remaining_fraction: 0.62, reset_in_seconds: 7200 },
      '3p-weekly': { remaining_fraction: 0.88, reset_in_seconds: 300000 },
      'argon-wtu': { remaining_fraction: 0.1, reset_in_seconds: 3600 },
    },
  };

  const proc1 = await runChildAsync(process.execPath, [feederPath], {
    input: '\uFEFF' + JSON.stringify(meta1),
    env: {
      ...process.env,
      WEZTERM_AGY_STATUS_DIR: statusDir,
      WEZTERM_AGY_COLLECTOR_BIN: fakeCollector,
      WEZTERM_PANE: '7',
      ANTIGRAVITY_LS_ADDRESS: 'localhost:41234',
      ANTIGRAVITY_CSRF_TOKEN: 'sl-secret-csrf',
    },
  });
  assert.equal(proc1.status, 0);
  assert.equal(proc1.stdout, '');

  const quota1 = readJsonSafe(getQuotaPath(statusDir));
  assert.equal(quota1.source, 'statusline');
  assert.equal(quota1.plan_tier, 'Google AI Pro');
  assert.equal(quota1.pools['3p'].five_hour.remaining_pct, 62);
  assert.equal(quota1.pools['3p'].weekly.remaining_pct, 88);
  assert.equal('argon' in quota1.pools, false, 'argon-wtu must be filtered out');

  const ep1 = readJsonSafe(getEndpointsPath(statusDir));
  assert.equal(ep1.endpoints['7'].ls_address, 'localhost:41234');
  assert.equal(ep1.endpoints['7'].csrf_token, 'sl-secret-csrf');
  assert.equal(fs.statSync(getEndpointsPath(statusDir)).mode & 0o777, 0o600);

  const pane7 = readJsonSafe(getPanePath(statusDir, '7'));
  assert.equal(pane7.pool, '3p');
  assert.equal(pane7.context.source, 'statusline');
  assert.equal(pane7.context.used_tokens, 128000);
  assert.equal(pane7.context.context_window_size, 1000000);
  assert.equal(pane7.context.effective_context_limit, 256000);
  assert.equal(pane7.context.effective_used_pct, 50);
  // 80000 / (10000 + 10000 + 80000) = 80%
  assert.equal(pane7.context.cached_pct, 80);

  // Streaming transient with current_usage = null preserves cached_pct = 80 instead of flickering to 0%
  const r2 = applyStatusLineMeta({
    meta: {
      ...meta1,
      agent_state: 'idle',
      context_window: {
        total_input_tokens: 130000,
        total_output_tokens: 3500,
        context_window_size: 1000000,
        current_usage: null,
      },
    },
    pane: '7',
    statusDir,
    env: {},
  });
  assert.equal(r2.pane.context.cached_pct, 80);
  assert.equal(r2.pane.agent_state, 'idle');

  // Empty conversation_id resets to clean welcome-screen zero state (no cross-session leakage)
  const rWelcome = applyStatusLineMeta({
    meta: {
      conversation_id: '',
      cwd: '/home/xiaolu',
      model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' },
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1048576 },
    },
    pane: '7',
    statusDir,
    env: {},
  });
  assert.equal(rWelcome.pane.conversation_id, null);
  assert.equal(rWelcome.pane.context.source, 'initial');
  assert.equal(rWelcome.pane.context.used_tokens, 0);
});

test('Dead endpoint eviction stops zombie port resurrection on PID change and records failed poll backoff', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const statusDir = path.join(tmpDir, 'status');
  const nowEpoch = Math.floor(Date.now() / 1000);

  // Seed yesterday's dead endpoint (PID 111) + stale quota + pane already updated to new PID 222
  fs.mkdirSync(path.join(statusDir, 'panes'), { recursive: true });
  fs.writeFileSync(
    getEndpointsPath(statusDir),
    JSON.stringify({
      endpoints: {
        '0': {
          ls_address: '127.0.0.1:1',
          csrf_token: 'dead-token',
          prefer_https: false,
          conversation_id: 'old-conv',
          pid: 111,
          updated_at: nowEpoch - 3600,
        },
      },
      latest_key: '0',
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    getPanePath(statusDir, '0'),
    JSON.stringify({
      version: 1,
      pane_id: '0',
      agy_pid: 222,
      conversation_id: 'new-conv',
      updated_at: nowEpoch,
    })
  );
  fs.writeFileSync(
    getQuotaPath(statusDir),
    JSON.stringify({
      version: 1,
      fetched_at: nowEpoch - 5000,
      source: 'ls_rpc',
      default_pool: 'gemini',
      pools: { gemini: { label: 'Gemini', five_hour: { remaining_pct: 5, reset_epoch: nowEpoch - 1000 }, weekly: { remaining_pct: 73, reset_epoch: nowEpoch + 100000 } } },
    })
  );

  // 1. Hook without ANTIGRAVITY_LS_ADDRESS when existingEp.pid (111) !== resolvedAgyPid (222) MUST evict dead endpoint!
  applyHookUpdate({
    hookEvent: 'PostToolUse',
    payload: { conversationId: 'new-conv', cwd: tmpDir },
    pane: '0',
    agyPid: 222,
    env: {},
    statusDir,
  });
  const epAfterHook = readJsonSafe(getEndpointsPath(statusDir));
  assert.equal(epAfterHook.endpoints['0'], undefined, 'dead endpoint must be evicted instead of re-stamped with PID 222');

  // 2. Re-seed a dead endpoint returning HTTP 401 and verify runRefresh prunes it and records last_poll_attempt_at
  const authFailMock = await startMockLsServer(() => ({ status: 401, body: { error: 'unauthorized' } }));
  t.after(() => authFailMock.close());
  fs.writeFileSync(
    getEndpointsPath(statusDir),
    JSON.stringify({
      endpoints: {
        '0': {
          ls_address: authFailMock.address,
          csrf_token: 'stale-csrf',
          prefer_https: false,
          pid: 222,
          updated_at: nowEpoch,
        },
      },
      latest_key: '0',
    }),
    { mode: 0o600 }
  );

  await runRefresh({
    statusDir,
    pane: '0',
    cwd: tmpDir,
    agyPid: 222,
    env: {},
    geminiBaseDir: path.join(tmpDir, 'no-gemini'),
    appDataDir: path.join(tmpDir, 'no-app'),
    nowMs: (nowEpoch + 10) * 1000,
  });
  const epAfterRefresh = readJsonSafe(getEndpointsPath(statusDir));
  assert.equal(epAfterRefresh.endpoints['0'], undefined, 'HTTP 401 endpoint must be pruned');
  const quotaAfterRefresh = readJsonSafe(getQuotaPath(statusDir));
  assert.equal(quotaAfterRefresh.last_poll_attempt_at, nowEpoch + 10, 'failed poll attempt timestamp persisted for backoff');
});

test('4-layer effective compaction ceiling, checkpointer model_limits parsing, and quota bucket merging work cleanly', () => {
  const index = buildModelIndex({
    response: {
      models: {
        'gemini-4-neon-high': {
          displayName: 'Gemini 4 Neon (High)',
          model: 'MODEL_PLACEHOLDER_M532',
          maxTokens: 1048576,
          modelExperiments: {
            experiments: {
              CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                stringValue: JSON.stringify({ enabled: true, max_token_limit: '512000' }),
              },
            },
          },
        },
        'claude-opus-5-5-high': {
          displayName: 'Claude Opus 5.5 (High)',
          model: 'MODEL_PLACEHOLDER_M402',
          maxTokens: 1000000,
          modelExperiments: {
            experiments: {
              CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                stringValue: JSON.stringify({ enabled: true, max_token_limit: '256000' }),
              },
            },
          },
        },
      },
    },
  });
  assert.equal(index.compactionByKey.gemini4neonhigh, 512000);
  assert.equal(index.compactionByKey.claudeopus55high, 256000);

  // Layer 1b env override beats catalog & runtime
  assert.equal(
    resolveEffectiveContextLimit({
      usedTokens: 100000,
      physicalWindowSize: 1048576,
      runtimeMaxContextTokens: 512000,
      catalogCompactionLimit: 256000,
      env: { AGY_TOKEN_CEILING: '300k' },
    }),
    300000
  );
  // Layer 3 catalog 256k steps up to 512k when usedTokens > 256k
  assert.equal(
    resolveEffectiveContextLimit({
      usedTokens: 300000,
      physicalWindowSize: 1000000,
      catalogCompactionLimit: 256000,
      env: {},
    }),
    512000
  );

  // Expired window yields to newer incoming window; expired incoming cannot overwrite valid future window
  const now = 2000000000;
  const yielded = mergeQuotaWindow(
    { remaining_pct: 5, reset_epoch: now - 3600 },
    { remaining_pct: 86, reset_epoch: now + 7200 },
    { isWeekly: false, nowEpoch: now, preferLowerWhenSameReset: true }
  );
  assert.equal(yielded.remaining_pct, 86);

  const protectedFuture = mergeQuotaWindow(
    { remaining_pct: 86, reset_epoch: now + 7200 },
    { remaining_pct: 5, reset_epoch: now - 3600 },
    { isWeekly: false, nowEpoch: now, preferLowerWhenSameReset: true }
  );
  assert.equal(protectedFuture.remaining_pct, 86);

  const parsedMeta = parseMetaQuotaToPools({
    'gemini-5h': { remaining_fraction: 0.85, reset_in_seconds: 5400 },
    'gemini-weekly': { remaining_fraction: 0.69, reset_in_seconds: 400000 },
  }, now);
  const merged = mergeQuotaPools({}, parsedMeta, { nowEpoch: now });
  assert.equal(merged.gemini.five_hour.remaining_pct, 85);
  assert.equal(merged.gemini.weekly.remaining_pct, 69);
});

test('setup-statusline.mjs atomically installs, backs up, and restores settings.json without touching other keys', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fakeHome = path.join(tmpDir, 'home');
  const cliDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const settingsPath = path.join(cliDir, 'settings.json');
  const statusDir = path.join(tmpDir, 'status');

  // Seed existing settings.json with UTF-8 BOM + prior custom statusLine + unrelated keys
  fs.writeFileSync(
    settingsPath,
    '\uFEFF' + JSON.stringify({
      model: 'Gemini 4 Neon (High)',
      permissions: { allow: ['command(ls)'] },
      statusLine: { enabled: true, type: 'command', command: '/old/status.sh' },
    }, null, 2)
  );

  const installRes = installStatusLineFeeder({ homeDir: fakeHome, statusDir, quiet: true });
  assert.equal(installRes.dryRun, false);
  const rawAfterInstall = fs.readFileSync(settingsPath);
  assert.equal(rawAfterInstall[0] === 0xef && rawAfterInstall[1] === 0xbb && rawAfterInstall[2] === 0xbf, false, 'BOM stripped');
  const afterInstall = JSON.parse(rawAfterInstall.toString('utf8'));
  assert.equal(afterInstall.model, 'Gemini 4 Neon (High)');
  assert.deepEqual(afterInstall.permissions, { allow: ['command(ls)'] });
  assert.equal(afterInstall.statusLine.stack_with_default, true);
  assert.ok(afterInstall.statusLine.command.includes('agy-statusline-feeder.mjs'));

  // Uninstall restores previous statusLine verbatim
  const uninstallRes = uninstallStatusLineFeeder({ homeDir: fakeHome, statusDir, quiet: true });
  assert.equal(uninstallRes.action, 'restored');
  const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(afterUninstall.statusLine, { enabled: true, type: 'command', command: '/old/status.sh' });
  assert.equal(afterUninstall.model, 'Gemini 4 Neon (High)');
});




