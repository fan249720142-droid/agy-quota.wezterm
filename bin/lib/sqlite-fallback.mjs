import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sqlitePromise = null;

/**
 * Load Node 24 built-in `node:sqlite` while suppressing ExperimentalWarning.
 */
export async function loadSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      const origEmitWarning = process.emitWarning;
      process.emitWarning = function filteredEmitWarning(warning, ...args) {
        const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
        const type = typeof args[0] === 'string' ? args[0] : String(warning?.name || '');
        if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) {
          return;
        }
        return origEmitWarning.call(this, warning, ...args);
      };
      try {
        return await import('node:sqlite');
      } finally {
        process.emitWarning = origEmitWarning;
      }
    })();
  }
  return sqlitePromise;
}

function openReadOnlyDb(DatabaseSync, dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    // Fallback for read-only directories where WAL/SHM cannot be created.
    const msg = String(err?.message || '');
    if (/readonly|unable to open|SHM|WAL/i.test(msg)) {
      return new DatabaseSync(`file:${encodeURI(dbPath)}?immutable=1`, { readOnly: true });
    }
    throw err;
  }
}

/**
 * Decode a raw protobuf wire buffer into [{ fn, wt, val }] records.
 */
export function decodeProtoFields(buf) {
  const view = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const fields = [];
  let pos = 0;

  const readVarint = () => {
    let val = 0n;
    let shift = 0n;
    while (pos < view.length) {
      const b = view[pos++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return val;
      shift += 7n;
      if (shift > 70n) throw new Error('Malformed varint');
    }
    throw new Error('Truncated varint');
  };

  while (pos < view.length) {
    const tag = readVarint();
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fn <= 0) throw new Error('Invalid field number');

    if (wt === 0) {
      const v = readVarint();
      fields.push({ fn, wt, val: v });
    } else if (wt === 1) {
      if (pos + 8 > view.length) throw new Error('Truncated fixed64');
      fields.push({ fn, wt, val: view.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wt === 2) {
      const lenBig = readVarint();
      const len = Number(lenBig);
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > view.length) {
        throw new Error('Truncated length-delimited field');
      }
      fields.push({ fn, wt, val: view.subarray(pos, pos + len) });
      pos += len;
    } else if (wt === 5) {
      if (pos + 4 > view.length) throw new Error('Truncated fixed32');
      fields.push({ fn, wt, val: view.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`Unsupported wire type ${wt}`);
    }
  }

  return fields;
}

function safeBigIntToNumber(v) {
  if (typeof v !== 'bigint') return Number(v) || 0;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (v < 0n) return 0;
  return Number(v);
}

function decodeUtf8(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

function decodeUsageSubmessage(buf) {
  const fields = decodeProtoFields(buf);
  let modelEnumInt = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (const f of fields) {
    if (f.wt !== 0) continue;
    const n = safeBigIntToNumber(f.val);
    if (f.fn === 1) modelEnumInt = n;
    else if (f.fn === 2) inputTokens = n;
    else if (f.fn === 3) outputTokens = n;
    else if (f.fn === 5) cacheReadTokens = n;
  }

  if (inputTokens + outputTokens + cacheReadTokens <= 0) {
    return null;
  }
  return { modelEnumInt, inputTokens, outputTokens, cacheReadTokens };
}

/**
 * Decode a `gen_metadata.data` GeneratorMetadata protobuf blob.
 */
export function decodeGeneratorMetadataProto(buf) {
  if (!buf || buf.length === 0) return null;
  let topFields;
  try {
    topFields = decodeProtoFields(buf);
  } catch {
    return null;
  }

  const chatModelField = topFields.find((f) => f.fn === 1 && f.wt === 2);
  if (!chatModelField) return null;

  let cmFields;
  try {
    cmFields = decodeProtoFields(chatModelField.val);
  } catch {
    return null;
  }

  let modelEnumInt = null;
  let responseModel = null;
  let modelDisplayName = null;
  let maxContextTokens = null;
  let primaryUsage = null;
  const retryUsages = [];

  for (const f of cmFields) {
    if (f.fn === 3 && f.wt === 0) {
      modelEnumInt = safeBigIntToNumber(f.val);
    } else if (f.fn === 4 && f.wt === 2) {
      try {
        primaryUsage = decodeUsageSubmessage(f.val);
      } catch {
        // Ignore malformed usage submessage.
      }
    } else if (f.fn === 9 && f.wt === 2) {
      try {
        const startFields = decodeProtoFields(f.val);
        const cwField = startFields.find((sf) => sf.fn === 10 && sf.wt === 2);
        if (cwField) {
          const cwFields = decodeProtoFields(cwField.val);
          const maxField = cwFields.find((cf) => cf.fn === 4 && cf.wt === 0);
          if (maxField) {
            maxContextTokens = safeBigIntToNumber(maxField.val);
          }
        }
      } catch {
        // Ignore malformed chatStartMetadata.
      }
    } else if (f.fn === 17 && f.wt === 2) {
      try {
        const retryFields = decodeProtoFields(f.val);
        const ruField = retryFields.find((rf) => rf.fn === 2 && rf.wt === 2);
        if (ruField) {
          const u = decodeUsageSubmessage(ruField.val);
          if (u) retryUsages.push(u);
        }
      } catch {
        // Ignore malformed retryInfo.
      }
    } else if (f.fn === 19 && f.wt === 2) {
      responseModel = decodeUtf8(f.val) || null;
    } else if (f.fn === 21 && f.wt === 2) {
      modelDisplayName = decodeUtf8(f.val) || null;
    }
  }

  const usage = primaryUsage || (retryUsages.length > 0 ? retryUsages[retryUsages.length - 1] : null);
  if (!modelEnumInt && usage?.modelEnumInt) {
    modelEnumInt = usage.modelEnumInt;
  }

  return {
    modelEnumInt,
    responseModel,
    modelDisplayName,
    maxContextTokens,
    usage,
  };
}

/**
 * Decode a `steps.metadata` protobuf blob as a secondary fallback.
 */
export function decodeStepMetadataProto(buf) {
  if (!buf || buf.length === 0) return null;
  let fields;
  try {
    fields = decodeProtoFields(buf);
  } catch {
    return null;
  }
  let modelEnumInt = null;
  let usage = null;
  for (const f of fields) {
    if (f.fn === 11 && f.wt === 0) {
      modelEnumInt = safeBigIntToNumber(f.val);
    } else if (f.fn === 9 && f.wt === 2) {
      try {
        usage = decodeUsageSubmessage(f.val);
      } catch {
        // Ignore malformed usage submessage.
      }
    }
  }
  if (!usage) return null;
  return {
    modelEnumInt: modelEnumInt || usage.modelEnumInt || null,
    responseModel: null,
    modelDisplayName: null,
    maxContextTokens: null,
    usage,
  };
}

export function getCandidateAppDataDirs(explicitDir = null) {
  if (explicitDir && typeof explicitDir === 'string') {
    return [path.resolve(explicitDir)];
  }
  const dirs = [];
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    const resolved = path.resolve(p);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  add(process.env.WEZTERM_AGY_APP_DATA_DIR);
  add(process.env.ANTIGRAVITY_APP_DATA_DIR);
  add(path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  add(path.join(os.homedir(), '.gemini', 'antigravity'));
  return dirs;
}

function normalizeFsPath(p) {
  if (!p) return '';
  const resolved = path.resolve(String(p));
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

function parseWorkspaceUris(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let items = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    items = raw.split(',');
  }
  const paths = [];
  for (const item of items) {
    const s = String(item || '').trim();
    if (!s) continue;
    if (s.startsWith('file://')) {
      try {
        paths.push(normalizeFsPath(decodeURIComponent(new URL(s).pathname)));
        continue;
      } catch {
        // Fall through.
      }
    }
    paths.push(normalizeFsPath(s));
  }
  return paths.filter(Boolean);
}

function parseSqliteTimeMs(ts) {
  if (!ts || typeof ts !== 'string' || ts.startsWith('0001-01-01')) return 0;
  // Normalize Go/SQLite "2026-11-27 08:37:36.669634603+00:00" to ISO-ish ms precision.
  const normalized = ts.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function getFileMtimeMs(filePath) {
  let maxMs = 0;
  for (const suffix of ['', '-wal']) {
    try {
      const st = fs.statSync(filePath + suffix);
      if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
    } catch {
      // Ignore missing files.
    }
  }
  return maxMs;
}

function scoreWorkspaceMatch(workspacePaths, targetCwd) {
  const normCwd = normalizeFsPath(targetCwd);
  if (!normCwd) return 0;
  let best = 0;
  for (const ws of workspacePaths) {
    if (ws === normCwd) {
      best = Math.max(best, 10_000 + ws.length);
    } else if (ws === '/' || normCwd.startsWith(`${ws}/`)) {
      best = Math.max(best, 5_000 + ws.length);
    } else if (ws.startsWith(`${normCwd}/`)) {
      best = Math.max(best, 1_000 + normCwd.length);
    }
  }
  return best;
}

function mapSummaryToAgentState(row) {
  if (!row) return null;
  if (row.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(row.not_fully_idle) === 1) {
    return 'working';
  }
  if (row.status === 'CASCADE_RUN_STATUS_IDLE') {
    return 'idle';
  }
  return null;
}

async function querySummaryRow(DatabaseSync, appDataDir, conversationId, targetCwd) {
  const sumPath = path.join(appDataDir, 'conversation_summaries.db');
  if (!fs.existsSync(sumPath)) return null;

  let db;
  try {
    db = openReadOnlyDb(DatabaseSync, sumPath);
    const hasTable = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='conversation_summaries'"
    ).get();

    if (hasTable) {
      if (conversationId) {
        return db.prepare(
          'SELECT conversation_id, workspace_uris, status, not_fully_idle, last_modified_time, last_user_input_time FROM conversation_summaries WHERE conversation_id = ?'
        ).get(conversationId) || null;
      }

      const rows = db.prepare(
        'SELECT conversation_id, workspace_uris, status, not_fully_idle, last_modified_time, last_user_input_time FROM conversation_summaries'
      ).all();

      const scored = [];
      for (const r of rows) {
        const convPath = path.join(appDataDir, 'conversations', `${r.conversation_id}.db`);
        if (!fs.existsSync(convPath)) continue;
        const wsPaths = parseWorkspaceUris(r.workspace_uris);
        const wsScore = scoreWorkspaceMatch(wsPaths, targetCwd);
        const effectiveMs = Math.max(
          parseSqliteTimeMs(r.last_modified_time),
          parseSqliteTimeMs(r.last_user_input_time),
          getFileMtimeMs(convPath)
        );
        scored.push({ row: r, wsScore, wsPaths, effectiveMs });
      }

      if (scored.length > 0) {
        scored.sort((a, b) => {
          const aMatch = a.wsScore > 0 ? 1 : 0;
          const bMatch = b.wsScore > 0 ? 1 : 0;
          if (aMatch !== bMatch) return bMatch - aMatch;
          if (a.wsScore !== b.wsScore) return b.wsScore - a.wsScore;
          return b.effectiveMs - a.effectiveMs;
        });
        return scored[0].row;
      }
    }

    // FTS fallback if only conversations_fts exists.
    const hasFts = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE name='conversations_fts'"
    ).get();
    if (hasFts && targetCwd) {
      const rows = db.prepare(
        'SELECT DISTINCT conversation_id, workspace, last_modified_time FROM conversations_fts ORDER BY last_modified_time DESC LIMIT 50'
      ).all();
      for (const r of rows) {
        const convPath = path.join(appDataDir, 'conversations', `${r.conversation_id}.db`);
        if (!fs.existsSync(convPath)) continue;
        const wsPaths = parseWorkspaceUris(r.workspace);
        if (scoreWorkspaceMatch(wsPaths, targetCwd) > 0) {
          return {
            conversation_id: r.conversation_id,
            workspace_uris: JSON.stringify(wsPaths),
            status: null,
            not_fully_idle: 0,
          };
        }
      }
    }
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
  return null;
}

function findNewestConvDbFile(appDataDir) {
  const convDir = path.join(appDataDir, 'conversations');
  let files;
  try {
    files = fs.readdirSync(convDir).filter((f) => f.endsWith('.db'));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    const full = path.join(convDir, f);
    const mtimeMs = getFileMtimeMs(full);
    if (!best || mtimeMs > best.mtimeMs) {
      best = { conversationId: f.slice(0, -3), dbPath: full, mtimeMs };
    }
  }
  return best;
}

/**
 * Read conversation model & latest token usage from local Antigravity SQLite DBs (read-only).
 */
export async function readConversationFromSqlite({
  conversationId = null,
  cwd = null,
  appDataDir = null,
} = {}) {
  const { DatabaseSync } = await loadSqlite();
  const dirs = getCandidateAppDataDirs(appDataDir);

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let cid = conversationId;
    let summaryRow = await querySummaryRow(DatabaseSync, dir, cid, cwd);
    if (!cid && summaryRow?.conversation_id) {
      cid = summaryRow.conversation_id;
    }

    if (!cid) {
      const newest = findNewestConvDbFile(dir);
      if (newest) {
        cid = newest.conversationId;
        summaryRow = await querySummaryRow(DatabaseSync, dir, cid, cwd);
      }
    }

    if (!cid) continue;
    const convDbPath = path.join(dir, 'conversations', `${cid}.db`);
    if (!fs.existsSync(convDbPath)) continue;

    let db;
    try {
      db = openReadOnlyDb(DatabaseSync, convDbPath);

      let latestMeta = null;
      let latestUsageMeta = null;
      let stepCount = 0;

      const hasGen = db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='gen_metadata'"
      ).get();

      if (hasGen) {
        const cntRow = db.prepare('SELECT COUNT(*) AS cnt FROM gen_metadata').get();
        if (Number(cntRow?.cnt) > 0) {
          stepCount = Number(cntRow.cnt);
        }
        const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 32').all();
        for (const r of rows) {
          if (!r?.data) continue;
          const decoded = decodeGeneratorMetadataProto(r.data);
          if (!decoded) continue;
          if (!latestMeta && (decoded.modelEnumInt || decoded.modelDisplayName || decoded.responseModel)) {
            latestMeta = decoded;
          }
          if (decoded.usage) {
            latestUsageMeta = decoded;
            break;
          }
        }
      }

      if (!latestUsageMeta) {
        const hasSteps = db.prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='steps'"
        ).get();
        if (hasSteps) {
          if (stepCount === 0) {
            const cntRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE metadata IS NOT NULL').get();
            stepCount = Number(cntRow?.cnt) || 0;
          }
          const rows = db.prepare(
            'SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx DESC LIMIT 32'
          ).all();
          for (const r of rows) {
            if (!r?.metadata) continue;
            const decoded = decodeStepMetadataProto(r.metadata);
            if (!decoded) continue;
            if (!latestMeta && decoded.modelEnumInt) latestMeta = decoded;
            if (decoded.usage) {
              latestUsageMeta = decoded;
              break;
            }
          }
        }
      }

      const combinedMeta = latestUsageMeta || latestMeta;
      const wsPaths = parseWorkspaceUris(summaryRow?.workspace_uris);

      return {
        conversation_id: cid,
        cwd: wsPaths[0] || cwd || null,
        stepCount,
        modelEnumInt: combinedMeta?.modelEnumInt || latestMeta?.modelEnumInt || null,
        modelDisplayName: latestMeta?.modelDisplayName || combinedMeta?.modelDisplayName || null,
        responseModel: latestMeta?.responseModel || combinedMeta?.responseModel || null,
        maxContextTokens: latestMeta?.maxContextTokens || combinedMeta?.maxContextTokens || null,
        usage: latestUsageMeta?.usage || null,
        agentState: mapSummaryToAgentState(summaryRow),
      };
    } catch {
      continue;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close failures.
      }
    }
  }

  return null;
}
