/**
 * Purpose:
 * - Verify active-thread coordination can use Codex app-server thread metadata.
 *
 * Owns:
 * - Focused regression coverage for the official thread metadata adapter and its
 *   integration with local sidecar summaries.
 *
 * Does not own:
 * - Host-specific hook dispatch or repository policy behavior.
 *
 * Split when:
 * - The Codex app-server adapter grows support for thread reads, worktrees, or handoff flows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  buildCoordinationSummary,
} = require('../src/active-thread-coordination.cjs');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
}

function writeStateDb(codexHomeDir, rows) {
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const database = new DatabaseSync(path.join(codexHomeDir, 'state_5.sqlite'));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      cwd TEXT,
      title TEXT,
      preview TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      thread_source TEXT,
      archived INTEGER DEFAULT 0,
      updated_at INTEGER,
      updated_at_ms INTEGER
    );
  `);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, rollout_path, cwd, title, preview, agent_nickname, agent_role,
      thread_source, archived, updated_at, updated_at_ms
    ) VALUES (
      @id, @rollout_path, @cwd, @title, @preview, @agent_nickname, @agent_role,
      @thread_source, 0, @updated_at, @updated_at_ms
    )
  `);
  for (const row of rows) {
    insert.run(row);
  }
  database.close();
}

function writeFakeAppServer(workspace) {
  const scriptPath = path.join(workspace, 'fake-codex-app-server.cjs');
  fs.writeFileSync(
    scriptPath,
    `
process.stdin.setEncoding('utf8');
let buffer = '';
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function handle(message) {
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex-app-server',
        codexHome: process.env.CODEX_HOME || '',
        platformFamily: 'test',
        platformOs: 'test',
      },
    });
    return;
  }
  if (message.method === 'thread/list') {
    const now = Math.floor(Date.now() / 1000);
    send({
      id: message.id,
      result: {
        data: [
          {
            id: 'official-peer-thread',
            sessionId: 'official-peer-thread',
            forkedFromId: null,
            preview: 'Official app-server peer thread',
            ephemeral: false,
            modelProvider: 'codex',
            createdAt: now - 60,
            updatedAt: now,
            status: { type: 'notLoaded' },
            path: process.env.OFFICIAL_THREAD_ROLLOUT,
            cwd: process.env.CODEX_APP_THREAD_INDEX_PROJECT_ROOT,
            cliVersion: '0.135.0-alpha.1',
            source: 'vscode',
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: { sha: 'abc123', branch: 'official-thread-test', originUrl: null },
            name: 'Official app-server peer',
            turns: [],
          },
          {
            id: process.env.CODEX_APP_THREAD_INDEX_CURRENT_SESSION_ID,
            sessionId: process.env.CODEX_APP_THREAD_INDEX_CURRENT_SESSION_ID,
            preview: 'Current thread should be filtered',
            ephemeral: false,
            modelProvider: 'codex',
            createdAt: now,
            updatedAt: now,
            status: { type: 'notLoaded' },
            path: '',
            cwd: process.env.CODEX_APP_THREAD_INDEX_PROJECT_ROOT,
            cliVersion: '0.135.0-alpha.1',
            source: 'vscode',
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: 'Current thread should be filtered',
            turns: [],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/u);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`,
    'utf8',
  );
  return scriptPath;
}

test('active-thread coordination prefers Codex app-server thread metadata when available', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'active-thread-app-server-'));
  const rolloutPath = path.join(
    workspace,
    '.codex-test-home',
    'sessions',
    '2026',
    '06',
    '01',
    'rollout-official-peer.jsonl',
  );
  writeJsonLines(rolloutPath, [
    {
      timestamp: '2026-06-01T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: path.join(workspace, 'apps', 'web', 'src', 'official-peer.ts'),
        }),
      },
    },
  ]);
  writeJson(
    path.join(
      workspace,
      '.codex-thread-coordination',
      'summaries',
      'official-peer-thread.json',
    ),
    {
      schemaVersion: 1,
      sessionId: 'official-peer-thread',
      threadId: 'official-peer-thread',
      title: 'Official app-server peer',
      stableSummary: 'This thread is working on Codex app-server metadata integration in apps/web/src.',
      latestActivity: 'Latest work touched apps/web/src/official-peer.ts.',
      ownedModules: ['apps/web/src'],
      recentTouchedPaths: ['apps/web/src/official-peer.ts'],
      testingPort: 4602,
      promptAnchor: 'official peer',
      firstWriteAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:01:00.000Z',
    },
  );

  const fakeServerPath = writeFakeAppServer(workspace);
  const previousEnv = {
    command: process.env.CODEX_APP_SERVER_COMMAND,
    args: process.env.CODEX_APP_SERVER_ARGS,
    enabled: process.env.CODEX_APP_THREAD_INDEX_ENABLED,
    rollout: process.env.OFFICIAL_THREAD_ROLLOUT,
    timeout: process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS,
  };
  process.env.CODEX_APP_SERVER_COMMAND = process.execPath;
  process.env.CODEX_APP_SERVER_ARGS = JSON.stringify([fakeServerPath]);
  process.env.CODEX_APP_THREAD_INDEX_ENABLED = '1';
  process.env.OFFICIAL_THREAD_ROLLOUT = rolloutPath;
  process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS = '8000';

  try {
    const summary = buildCoordinationSummary({
      projectRoot: workspace,
      currentSessionId: 'current-thread-id',
      targetFilePaths: [path.join(workspace, 'apps', 'web', 'src', 'current.ts')],
      codexHomeDir: path.join(workspace, '.codex-test-home'),
    });

    assert.equal(summary.available, true);
    assert.equal(summary.threads.length, 1);
    assert.equal(summary.threads[0].id, 'official-peer-thread');
    assert.match(summary.output, /\[Active Thread Collaboration\]/);
    assert.match(summary.output, /Official app-server peer/);
    assert.match(summary.output, /apps\/web\/src\/official-peer\.ts/);
    assert.doesNotMatch(summary.output, /Current thread should be filtered/);
  } finally {
    restoreOptionalEnv('CODEX_APP_SERVER_COMMAND', previousEnv.command);
    restoreOptionalEnv('CODEX_APP_SERVER_ARGS', previousEnv.args);
    restoreOptionalEnv('CODEX_APP_THREAD_INDEX_ENABLED', previousEnv.enabled);
    restoreOptionalEnv('OFFICIAL_THREAD_ROLLOUT', previousEnv.rollout);
    restoreOptionalEnv('CODEX_APP_THREAD_INDEX_TIMEOUT_MS', previousEnv.timeout);
  }
});

test('active-thread coordination preserves local rollout evidence when official metadata omits it', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'active-thread-app-server-merge-'));
  const codexHomeDir = path.join(workspace, '.codex-test-home');
  const rolloutPath = path.join(
    codexHomeDir,
    'sessions',
    '2026',
    '06',
    '01',
    'rollout-local-peer.jsonl',
  );
  writeJsonLines(rolloutPath, [
    {
      timestamp: '2026-06-01T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: path.join(workspace, 'apps', 'web', 'src', 'local-fallback.ts'),
        }),
      },
    },
  ]);
  const nowMs = Date.now();
  writeStateDb(codexHomeDir, [
    {
      id: 'official-peer-thread',
      rollout_path: rolloutPath,
      cwd: workspace,
      title: 'Local fallback peer',
      preview: 'Local fallback preview',
      agent_nickname: null,
      agent_role: null,
      thread_source: 'local',
      updated_at: Math.floor(nowMs / 1000),
      updated_at_ms: nowMs,
    },
  ]);

  const fakeServerPath = writeFakeAppServer(workspace);
  const previousEnv = {
    command: process.env.CODEX_APP_SERVER_COMMAND,
    args: process.env.CODEX_APP_SERVER_ARGS,
    enabled: process.env.CODEX_APP_THREAD_INDEX_ENABLED,
    rollout: process.env.OFFICIAL_THREAD_ROLLOUT,
    timeout: process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS,
  };
  process.env.CODEX_APP_SERVER_COMMAND = process.execPath;
  process.env.CODEX_APP_SERVER_ARGS = JSON.stringify([fakeServerPath]);
  process.env.CODEX_APP_THREAD_INDEX_ENABLED = '1';
  process.env.OFFICIAL_THREAD_ROLLOUT = '';
  process.env.CODEX_APP_THREAD_INDEX_TIMEOUT_MS = '8000';

  try {
    const summary = buildCoordinationSummary({
      projectRoot: workspace,
      currentSessionId: 'current-thread-id',
      targetFilePaths: [path.join(workspace, 'apps', 'web', 'src', 'current.ts')],
      codexHomeDir,
    });

    assert.equal(summary.available, true);
    assert.equal(summary.threads.length, 1);
    assert.equal(summary.threads[0].id, 'official-peer-thread');
    assert.match(summary.output, /Official app-server peer/);
    assert.match(summary.output, /apps\/web\/src\/local-fallback\.ts/);
  } finally {
    restoreOptionalEnv('CODEX_APP_SERVER_COMMAND', previousEnv.command);
    restoreOptionalEnv('CODEX_APP_SERVER_ARGS', previousEnv.args);
    restoreOptionalEnv('CODEX_APP_THREAD_INDEX_ENABLED', previousEnv.enabled);
    restoreOptionalEnv('OFFICIAL_THREAD_ROLLOUT', previousEnv.rollout);
    restoreOptionalEnv('CODEX_APP_THREAD_INDEX_TIMEOUT_MS', previousEnv.timeout);
  }
});

function restoreOptionalEnv(name, value) {
  if (typeof value === 'undefined') {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
