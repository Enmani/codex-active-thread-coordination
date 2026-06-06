/**
 * Purpose:
 * - Read Codex app-server thread metadata for active-thread coordination.
 *
 * Owns:
 * - Short-lived app-server probing, protocol request/response parsing, and mapping
 *   official thread metadata into the local coordination row shape.
 *
 * Does not own:
 * - Local collision policy, rollout path scanning, sidecar summaries, port leasing,
 *   or deciding whether a coordination warning should be shown.
 *
 * Split when:
 * - The app-server protocol adapter expands beyond read-only thread listing into
 *   thread details, worktree handoff, or cross-host thread management.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_APP_SERVER_TIMEOUT_MS = 2500;
const DEFAULT_APP_SERVER_LIMIT = 30;

const PROBE_SCRIPT = `
const { spawn } = require('node:child_process');

const command = process.env.CODEX_APP_THREAD_INDEX_PROBE_COMMAND || 'codex';
let args = ['app-server', '--listen', 'stdio://'];
try {
  const parsedArgs = JSON.parse(process.env.CODEX_APP_THREAD_INDEX_PROBE_ARGS || 'null');
  if (Array.isArray(parsedArgs)) args = parsedArgs.map(String);
} catch (_error) {}

const projectRoot = process.env.CODEX_APP_THREAD_INDEX_PROJECT_ROOT || process.cwd();
const currentSessionId = process.env.CODEX_APP_THREAD_INDEX_CURRENT_SESSION_ID || '';
const timeoutMs = Math.max(250, Number(process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS || 2500));
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env,
});

let stdout = '';
let stderr = '';
let sentList = false;
let finished = false;

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\\n');
}

function readPayload(id) {
  const lines = stdout.split(/\\r?\\n/u).filter(Boolean);
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (parsed && parsed.id === id && parsed.result) return parsed.result;
  }
  return null;
}

function finish(payload) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try { child.stdin.end(); } catch (_error) {}
  try { child.kill(); } catch (_error) {}
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

child.stdout.on('data', (buffer) => {
  stdout += buffer.toString('utf8');
  if (!sentList && readPayload(1)) {
    sentList = true;
    send({
      method: 'thread/list',
      id: 2,
      params: {
        limit: 30,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: projectRoot,
        archived: false,
        useStateDbOnly: true,
      },
    });
  }
  const listPayload = readPayload(2);
  if (listPayload) {
    finish({ ok: true, result: listPayload });
  }
});

child.stderr.on('data', (buffer) => {
  stderr += buffer.toString('utf8');
});

child.on('error', (error) => {
  finish({ ok: false, error: error && error.message ? error.message : String(error), stderr });
});

child.on('exit', (code) => {
  if (!finished) {
    finish({ ok: false, error: 'app-server exited before thread/list response', code, stdout, stderr });
  }
});

const timeout = setTimeout(() => {
  finish({ ok: false, error: 'app-server thread/list timeout', stdout, stderr });
}, timeoutMs);

send({
  method: 'initialize',
  id: 1,
  params: {
    clientInfo: {
      name: 'codex-active-thread-coordination',
      title: null,
      version: '1',
    },
    capabilities: {
      experimentalApi: false,
      optOutNotificationMethods: ['remoteControl/status/changed'],
    },
  },
});
`;

function listCodexAppServerThreads({
  projectRoot = process.cwd(),
  currentSessionId = '',
  codexHomeDir = '',
  timeoutMs = Number(process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS || DEFAULT_APP_SERVER_TIMEOUT_MS),
  codexCommand = process.env.CODEX_APP_SERVER_COMMAND || 'codex',
  codexArgs = resolveCodexAppServerArgs(),
} = {}) {
  const normalizedProjectRoot = normalizeWorkspaceRoot(projectRoot);
  if (
    !normalizedProjectRoot ||
    process.env.CODEX_APP_THREAD_INDEX_DISABLED === '1' ||
    shouldSkipAppServerProbe()
  ) {
    return {
      available: false,
      rows: [],
      error: '',
    };
  }

  const result = spawnSync(process.execPath, ['-e', PROBE_SCRIPT], {
    encoding: 'utf8',
    timeout: Math.max(500, Number(timeoutMs) + 1000 || DEFAULT_APP_SERVER_TIMEOUT_MS + 1000),
    windowsHide: true,
    env: {
      ...process.env,
      ...(codexHomeDir ? { CODEX_HOME: codexHomeDir } : {}),
      CODEX_APP_THREAD_INDEX_PROBE_COMMAND: codexCommand,
      CODEX_APP_THREAD_INDEX_PROBE_ARGS: JSON.stringify(codexArgs),
      CODEX_APP_THREAD_INDEX_PROJECT_ROOT: projectRoot,
      CODEX_APP_THREAD_INDEX_CURRENT_SESSION_ID: currentSessionId,
      CODEX_APP_THREAD_INDEX_TIMEOUT_MS: String(Math.max(250, Number(timeoutMs) || DEFAULT_APP_SERVER_TIMEOUT_MS)),
    },
  });

  if (result.error || result.status !== 0) {
    return {
      available: false,
      rows: [],
      error: normalizeErrorMessage(result.error) || normalizeText(result.stderr),
    };
  }

  const payload = readLastJsonPayload(result.stdout);
  if (!payload || !payload.ok || !payload.result || !Array.isArray(payload.result.data)) {
    return {
      available: false,
      rows: [],
      error: normalizeText(payload?.error) || 'thread/list response missing data',
    };
  }

  return {
    available: true,
    rows: payload.result.data
      .slice(0, DEFAULT_APP_SERVER_LIMIT)
      .map((thread) => mapThreadToCoordinationRow(thread))
      .filter((row) => row.id && row.id !== String(currentSessionId || ''))
      .filter((row) => normalizeWorkspaceRoot(row.cwd) === normalizedProjectRoot),
    error: '',
  };
}

function shouldSkipAppServerProbe() {
  if (process.env.CODEX_APP_THREAD_INDEX_ENABLED === '1') {
    return false;
  }
  if (process.env.CODEX_APP_SERVER_COMMAND || process.env.CODEX_APP_SERVER_ARGS) {
    return false;
  }
  return /(?:^|[\\/])\.codex-test-home(?:[\\/]|$)/u.test(String(process.env.CODEX_HOME_DIR || ''));
}

function resolveCodexAppServerArgs() {
  const raw = process.env.CODEX_APP_SERVER_ARGS;
  if (!raw) {
    return ['app-server', '--listen', 'stdio://'];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch (_error) {
    // Fall through to whitespace split for simple test commands.
  }
  return raw.split(/\s+/u).map((value) => value.trim()).filter(Boolean);
}

function readLastJsonPayload(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/u).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch (_error) {
      // Keep looking; app-server may emit warnings or notifications.
    }
  }
  return null;
}

function mapThreadToCoordinationRow(thread = {}) {
  return {
    id: String(thread.id || ''),
    rollout_path: String(thread.path || ''),
    cwd: String(thread.cwd || ''),
    title: normalizeText(thread.name) || normalizeText(thread.preview),
    preview: normalizeText(thread.preview),
    agent_nickname: normalizeText(thread.agentNickname),
    agent_role: normalizeText(thread.agentRole),
    thread_source: normalizeText(thread.threadSource),
    archived: 0,
    updated_at_ms: timestampSecondsToMs(thread.updatedAt),
    source: normalizeText(thread.source),
    model_provider: normalizeText(thread.modelProvider),
    cli_version: normalizeText(thread.cliVersion),
    git_sha: normalizeText(thread.gitInfo?.sha),
    git_branch: normalizeText(thread.gitInfo?.branch),
    git_origin_url: normalizeText(thread.gitInfo?.originUrl),
  };
}

function timestampSecondsToMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric > 100000000000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function normalizeWorkspaceRoot(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    return '';
  }
  let normalized = raw.replace(/^\\\\\?\\/u, '');
  normalized = path.resolve(normalized);
  normalized = normalized.replace(/[\\/]+$/u, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function normalizeErrorMessage(error) {
  if (!error) {
    return '';
  }
  return normalizeText(error.message || String(error));
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/gu, ' ');
}

module.exports = {
  listCodexAppServerThreads,
  mapThreadToCoordinationRow,
};
