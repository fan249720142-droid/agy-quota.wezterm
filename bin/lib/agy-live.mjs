import fs from 'node:fs';
import path from 'node:path';

const AGY_BIN_RE = /^(agy|agy-cli|antigravity)(?:\.exe)?$/i;
const AGY_NODE_SCRIPT_RE = /^(agy|agy-cli|antigravity)(?:\.(?:js|mjs|cjs))?$/i;
const NODE_BIN_RE = /^node(?:js)?(?:\.exe)?$/i;
const CONV_DB_RE = /[/\\]conversations[/\\]([0-9a-f-]{36})\.db$/i;
const PRESENCE_LOCK_RE = /[/\\]presence[/\\]([0-9a-f-]{36})\.lock$/i;
const CLI_LOG_RE = /(cli-[^/\\]+\.log)$/i;
const HTTP_PORT_RE = /Language server listening on random port at (\d+) for HTTP\b/i;
const HTTPS_PORT_RE = /Language server listening on random port at (\d+) for HTTPS\b/i;
const LOG_READ_BYTES = 8192;

function isProcAvailable(procRoot) {
  return process.platform === 'linux' || procRoot !== '/proc';
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readStatInfo(pidDir) {
  const raw = readTextSafe(path.join(pidDir, 'stat'));
  if (!raw) return null;
  const lparen = raw.indexOf('(');
  const rparen = raw.lastIndexOf(')');
  if (lparen < 0 || rparen <= lparen) return null;

  const comm = raw.slice(lparen + 1, rparen);
  const rest = raw.slice(rparen + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const starttime = rest.length > 19 ? Number(rest[19]) : 0;

  return {
    comm,
    ppid: Number.isInteger(ppid) ? ppid : null,
    starttime: Number.isFinite(starttime) ? starttime : 0,
  };
}

function isAgyProcess(pidDir, { allowMissingIdentity = false } = {}) {
  let sawIdentity = false;

  const commRaw = readTextSafe(path.join(pidDir, 'comm'));
  if (commRaw !== null) {
    sawIdentity = true;
    if (AGY_BIN_RE.test(commRaw.trim())) return true;
  }

  const cmdlineRaw = readTextSafe(path.join(pidDir, 'cmdline'));
  if (cmdlineRaw !== null && cmdlineRaw.length > 0) {
    sawIdentity = true;
    const args = cmdlineRaw.split('\0').filter(Boolean);
    if (args.length > 0) {
      const binName = path.basename(args[0]);
      if (AGY_BIN_RE.test(binName)) return true;
      if (NODE_BIN_RE.test(binName) && args[1] && AGY_NODE_SCRIPT_RE.test(path.basename(args[1]))) {
        return true;
      }
    }
  }

  const statInfo = readStatInfo(pidDir);
  if (statInfo?.comm) {
    sawIdentity = true;
    if (AGY_BIN_RE.test(statInfo.comm.trim())) return true;
  }

  return allowMissingIdentity && !sawIdentity;
}

/**
 * Walk `/proc/<pid>/stat` (plus `comm` and `cmdline`) up the parent chain to find
 * the nearest ancestor whose executable/basename is `agy`, `agy-cli`, or `antigravity`.
 */
export function findAncestorAgyPid(startPid = process.ppid, procRoot = '/proc') {
  if (!isProcAvailable(procRoot)) return null;
  let pid = Number(startPid);
  const visited = new Set();

  for (let depth = 0; depth < 64 && Number.isInteger(pid) && pid > 1 && !visited.has(pid); depth++) {
    visited.add(pid);
    const pidDir = path.join(procRoot, String(pid));
    if (!fs.existsSync(pidDir)) break;
    if (isAgyProcess(pidDir)) return pid;
    const stat = readStatInfo(pidDir);
    if (!stat || !stat.ppid || stat.ppid <= 1) break;
    pid = stat.ppid;
  }

  return null;
}

/**
 * Scan numeric PID directories in `procRoot` for an `agy` process whose `fd/0`
 * readlink matches `ttyPath`, picking the newest matching PID.
 */
export function findAgyPidByTty(ttyPath, procRoot = '/proc') {
  if (!ttyPath || !isProcAvailable(procRoot)) return null;
  const targetTty = String(ttyPath).trim();
  if (!targetTty) return null;

  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    const pidDir = path.join(procRoot, entry);
    if (!isAgyProcess(pidDir)) continue;

    let fd0;
    try {
      fd0 = fs.readlinkSync(path.join(pidDir, 'fd', '0'));
    } catch {
      continue;
    }
    if (fd0 !== targetTty) continue;

    const starttime = readStatInfo(pidDir)?.starttime || 0;
    if (!best) {
      best = { pid, starttime };
      continue;
    }
    if (starttime > 0 && best.starttime > 0 && starttime !== best.starttime) {
      if (starttime > best.starttime) best = { pid, starttime };
    } else if (pid > best.pid) {
      best = { pid, starttime };
    }
  }

  return best ? best.pid : null;
}

/**
 * Read the first ~8KB of an Antigravity CLI log file to extract HTTP/HTTPS LS ports.
 */
export function parseLsPortFromLogFile(logPath) {
  if (!logPath) return { httpPort: null, httpsPort: null };
  let fd;
  let text = '';
  try {
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.allocUnsafe(LOG_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, LOG_READ_BYTES, 0);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return { httpPort: null, httpsPort: null };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }

  const httpMatch = HTTP_PORT_RE.exec(text);
  const httpsMatch = HTTPS_PORT_RE.exec(text);
  const httpPort = httpMatch ? Number(httpMatch[1]) : null;
  const httpsPort = httpsMatch ? Number(httpsMatch[1]) : null;

  return {
    httpPort: Number.isInteger(httpPort) && httpPort > 0 ? httpPort : null,
    httpsPort: Number.isInteger(httpsPort) && httpsPort > 0 ? httpsPort : null,
  };
}

/**
 * Inspect an active Antigravity CLI process via `/proc/<pid>/fd/*` and `/proc/<pid>/cwd`
 * to detect `/resume` conversation changes and welcome-screen state in real time.
 */
export function inspectAgyProcess(agyPid, { procRoot = '/proc' } = {}) {
  const pid = Number(agyPid);
  if (!isProcAvailable(procRoot) || !Number.isInteger(pid) || pid <= 0) {
    return { alive: false, inspected: false };
  }

  const pidDir = path.join(procRoot, String(pid));
  if (!fs.existsSync(pidDir)) {
    return { alive: false, inspected: false };
  }
  if (!isAgyProcess(pidDir, { allowMissingIdentity: true })) {
    return { alive: false, inspected: false };
  }

  const fdDir = path.join(pidDir, 'fd');
  let fdEntries;
  try {
    fdEntries = fs.readdirSync(fdDir);
  } catch {
    return { alive: true, inspected: false, pid };
  }

  const dbIds = [];
  const lockIds = [];
  let logPath = null;

  for (const entry of fdEntries) {
    let target;
    try {
      target = fs.readlinkSync(path.join(fdDir, entry));
    } catch {
      continue;
    }

    const dbMatch = CONV_DB_RE.exec(target);
    if (dbMatch && !dbIds.includes(dbMatch[1])) {
      dbIds.push(dbMatch[1]);
      continue;
    }

    const lockMatch = PRESENCE_LOCK_RE.exec(target);
    if (lockMatch && !lockIds.includes(lockMatch[1])) {
      lockIds.push(lockMatch[1]);
      continue;
    }

    if (!logPath && CLI_LOG_RE.test(target)) {
      logPath = target;
    }
  }

  let conversationId = null;
  if (dbIds.length > 0) {
    const matchedLock = dbIds.find((id) => lockIds.includes(id));
    conversationId = matchedLock || dbIds[dbIds.length - 1];
  } else if (lockIds.length > 0) {
    conversationId = lockIds[0];
  }

  const { httpPort, httpsPort } = logPath
    ? parseLsPortFromLogFile(logPath)
    : { httpPort: null, httpsPort: null };

  let cwd = null;
  try {
    cwd = fs.readlinkSync(path.join(pidDir, 'cwd')) || null;
  } catch {
    cwd = null;
  }

  return {
    alive: true,
    inspected: true,
    pid,
    conversationId,
    logPath,
    httpPort,
    httpsPort,
    cwd,
  };
}
