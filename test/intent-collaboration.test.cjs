const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCoordinationSummary,
  classifyThreadRelationship,
  recordCodeWriteActivity,
} = require('../src/active-thread-coordination.cjs');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-collab-'));
}

test('recordCodeWriteActivity writes an intent card for collaboration', () => {
  const workspace = makeWorkspace();
  const result = recordCodeWriteActivity({
    projectRoot: workspace,
    sessionId: 'writer-thread',
    filePaths: [path.join(workspace, 'apps', 'web', 'src', 'router.ts')],
    prompt: 'implement route handoff support',
    toolName: 'Edit',
    toolResult: { success: true },
    codexHomeDir: path.join(workspace, '.codex-test-home'),
  });

  assert.equal(result.updated, true);
  assert.equal(result.summary.intentCard.status, 'in_progress');
  assert.match(result.summary.intentCard.objective, /route handoff support|feature implementation/i);
  assert.deepEqual(result.summary.intentCard.ownedScope, ['apps/web/src']);
  assert.ok(result.summary.intentCard.offers.some((item) => item.includes('apps/web/src')));
});

test('classifyThreadRelationship separates conflicts from complementary work', () => {
  const conflict = classifyThreadRelationship({
    targetFilePaths: ['apps/web/src/router.ts'],
    record: {
      recentPaths: ['apps/web/src/router.ts'],
      ownedModules: ['apps/web/src'],
      intentCard: { status: 'in_progress', offers: ['router context'] },
    },
  });
  assert.equal(conflict.type, 'conflict-risk');

  const complementary = classifyThreadRelationship({
    targetFilePaths: ['apps/web/src/sidebar.ts'],
    record: {
      recentPaths: ['apps/web/src/router.ts'],
      ownedModules: ['apps/web/src'],
      intentCard: {
        status: 'in_progress',
        offers: ['Reusable route helper'],
        needs: [],
      },
    },
  });
  assert.equal(complementary.type, 'complementary');
});

test('buildCoordinationSummary renders active thread collaboration language', () => {
  const workspace = makeWorkspace();
  writeJson(
    path.join(workspace, '.codex-thread-coordination', 'summaries', 'peer-thread.json'),
    {
      schemaVersion: 1,
      sessionId: 'peer-thread',
      threadId: 'peer-thread',
      title: 'Route substrate peer',
      stableSummary: 'This thread is working on route substrate changes in apps/web/src.',
      latestActivity: 'Latest work touched apps/web/src/router.ts.',
      intentCard: {
        objective: 'Create reusable route substrate helpers.',
        plan: ['Extract helper', 'Wire sidebar later'],
        ownedScope: ['apps/web/src'],
        decisions: ['Route ownership stays in the app shell.'],
        needs: ['Do not duplicate route state helpers.'],
        offers: ['Reusable route helper for sidebar flow.'],
        status: 'in_progress',
      },
      ownedModules: ['apps/web/src'],
      recentTouchedPaths: ['apps/web/src/router.ts'],
      testingPort: 4601,
      promptAnchor: 'route substrate',
      firstWriteAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  );
  const codexHomeDir = path.join(workspace, '.codex-test-home');
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const stateDbPath = path.join(codexHomeDir, 'state_5.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(stateDbPath);
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
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, cwd, title, preview, agent_nickname, agent_role,
      thread_source, archived, updated_at, updated_at_ms
    ) VALUES (
      'peer-thread', '', @cwd, 'Route substrate peer', '', '', '', 'local', 0, @updatedAt, @updatedAtMs
    )
  `).run({
    cwd: workspace,
    updatedAt: Math.floor(Date.now() / 1000),
    updatedAtMs: Date.now(),
  });
  database.close();

  const summary = buildCoordinationSummary({
    projectRoot: workspace,
    currentSessionId: 'current-thread',
    targetFilePaths: [path.join(workspace, 'apps', 'web', 'src', 'sidebar.ts')],
    codexHomeDir,
  });

  assert.equal(summary.available, true);
  assert.match(summary.output, /\[Active Thread Collaboration\]/);
  assert.match(summary.output, /Relationship: complementary/);
  assert.match(summary.output, /Reusable route helper/);
});
