/**
 * Purpose:
 * - Summarize active local Codex peer threads that recently touched the same repo.
 *
 * Owns:
 * - Reading local Codex thread state and rollout files, extracting recent code-write paths,
 *   maintaining compact per-thread coordination summaries, leasing testing ports, and
 *   rendering a concise coordination preflight for host-side code-write hints.
 *
 * Does not own:
 * - Deciding when the coordination summary should be injected, persisting session-level
 *   once-per-turn behavior, or evaluating host-specific policy rules.
 *
 * Split when:
 * - Codex state adapters, summary heuristics, or port leasing become large enough to need
 *   separate owners.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listCodexAppServerThreads,
} = require('./codex-app-thread-index.cjs');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_error) {
  DatabaseSync = null;
}

const ACTIVE_THREAD_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_THREADS = 5;
const MAX_PATHS_PER_THREAD = 4;
const MAX_SUMMARY_THREADS = 3;
const MAX_SUMMARY_BODY_CHARS = 200;
const MAX_HIGHLIGHTED_DELTA_PATHS = 1;
const MAX_SUPPLEMENTAL_PATHS = 2;
const MAX_INTENT_ITEMS = 5;
const MAX_PORT_LEASES = 10;
const TEST_PORT_START = 4601;
const TEST_PORT_END = TEST_PORT_START + MAX_PORT_LEASES - 1;
const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch']);
const CODE_OWNING_PREFIXES = ['apps/', 'scripts/', 'config/'];
const DOC_PREFIXES = ['docs/', 'wiki/'];
const SUMMARY_STATE_ROOT = ['.codex-thread-coordination'];

function buildCoordinationSummary({
  projectRoot = process.cwd(),
  currentSessionId = '',
  targetFilePaths = [],
  priorThreadReadState = {},
  codexHomeDir = process.env.CODEX_HOME_DIR || path.join(os.homedir(), '.codex'),
} = {}) {
  const threadRows = listActiveSameRepoThreads({
    projectRoot,
    currentSessionId,
    codexHomeDir,
  });
  if (threadRows.length === 0) {
    return {
      available: false,
      output: '',
      threads: [],
    };
  }

  const normalizedTargets = uniqueValues(
    (targetFilePaths || [])
      .map((value) => normalizeRepoPath(projectRoot, value))
      .filter((value) => isCodeOwningPath(value)),
  );
  const normalizedReadState = normalizeThreadReadStateMap(priorThreadReadState);
  const relevantThreads = threadRows
    .map((row) => buildThreadCoordinationRecord({
      row,
      projectRoot,
    }))
    .filter((record) => record.hasSummary)
    .filter((record) => record.summary || record.recentPaths.length > 0)
    .map((record) => ({
      ...record,
      relevanceScore: scoreThreadRelevance({
        targetFilePaths: normalizedTargets,
        record,
      }),
    }))
    .map((record) => ({
      ...record,
      relationship: classifyThreadRelationship({
        targetFilePaths: normalizedTargets,
        record,
      }),
    }))
    .filter((record) => (record.relevanceScore || 0) > 0)
    .sort(compareThreadRecords)
    .slice(0, MAX_THREADS);

  if (relevantThreads.length === 0) {
    return {
      available: false,
      hasUnreadUpdates: false,
      output: '',
      threads: [],
      relevantThreads: [],
      readStatePatch: {},
    };
  }

  const unreadThreads = relevantThreads
    .filter((record) => hasUnreadThreadUpdate({
      previousReadState: normalizedReadState[record.id],
      record,
    }))
    .map((record) => ({
      ...record,
      readDelta: buildThreadReadDelta({
        previousReadState: normalizedReadState[record.id],
        record,
        targetFilePaths: normalizedTargets,
      }),
    }));

  return {
    available: true,
    hasUnreadUpdates: unreadThreads.length > 0,
    output: unreadThreads.length > 0
      ? renderCoordinationSummary({
          threads: unreadThreads,
          targetFilePaths: normalizedTargets,
        })
      : '',
    threads: unreadThreads,
    relevantThreads,
    readStatePatch: buildThreadReadStatePatch(unreadThreads),
  };
}

function recordCodeWriteActivity({
  projectRoot = process.cwd(),
  sessionId = '',
  filePaths = [],
  prompt = '',
  toolName = '',
  toolResult = {},
  codexHomeDir = process.env.CODEX_HOME_DIR || path.join(os.homedir(), '.codex'),
} = {}) {
  if (!sessionId || !isSuccessfulToolResult(toolResult)) {
    return {
      updated: false,
      summaryPath: '',
      summary: null,
      testingPort: null,
    };
  }

  const normalizedPaths = uniqueValues(
    (filePaths || [])
      .map((value) => normalizeRepoPath(projectRoot, value))
      .filter((value) => isCodeOwningPath(value)),
  );
  if (normalizedPaths.length === 0) {
    return {
      updated: false,
      summaryPath: '',
      summary: null,
      testingPort: null,
    };
  }

  const currentThread = resolveCurrentThread({
    projectRoot,
    sessionId,
    codexHomeDir,
  });
  const existingSummary = loadThreadSummary({
    projectRoot,
    sessionId,
  });
  const focusChanged = didThreadFocusChange({
    existingSummary,
    normalizedPaths,
    prompt,
    currentThread,
  });
  const recentRolloutPaths = currentThread
    ? readRecentWritePaths({
        rolloutPath: currentThread.rolloutPath,
        projectRoot,
      }).slice(0, MAX_PATHS_PER_THREAD)
    : [];
  const mergedRecentPaths = mergeRecentPaths([
    ...normalizedPaths,
    ...recentRolloutPaths,
    ...(focusChanged ? [] : (existingSummary?.recentTouchedPaths || [])),
  ], projectRoot);
  const resolvedThreadTitle = resolvePreferredThreadTitle({
    currentThread,
    existingSummary,
    prompt,
  });
  const candidateContext = {
    sessionId,
    threadId: currentThread?.id || sessionId,
    title: resolvedThreadTitle,
    prompt,
    normalizedPaths,
    recentPaths: mergedRecentPaths,
    existingSummary,
    currentThread,
    toolName,
  };
  const summaryDraft = maybeUpdateStableThreadSummary(candidateContext);
  const testingPort = claimTestingPort({
    projectRoot,
    sessionId,
    threadId: summaryDraft.threadId,
    title: summaryDraft.title,
    stableSummary: summaryDraft.stableSummary,
    ownedModules: summaryDraft.ownedModules,
  });
  const finalSummary = {
    schemaVersion: 1,
    sessionId,
    threadId: summaryDraft.threadId,
    title: summaryDraft.title,
    stableSummary: summaryDraft.stableSummary,
    latestActivity: buildLatestActivityLine({
      latestActivity: summaryDraft.latestActivity,
      normalizedPaths,
      toolName,
    }),
    intentCard: buildIntentCard({
      title: summaryDraft.title,
      stableSummary: summaryDraft.stableSummary,
      latestActivity: summaryDraft.latestActivity,
      ownedModules: summaryDraft.ownedModules,
      promptAnchor: summaryDraft.promptAnchor,
      recentTouchedPaths: mergedRecentPaths,
    }),
    ownedModules: summaryDraft.ownedModules,
    recentTouchedPaths: mergedRecentPaths.slice(0, MAX_PATHS_PER_THREAD),
    testingPort,
    promptAnchor: summaryDraft.promptAnchor,
    firstWriteAt: existingSummary?.firstWriteAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const summaryPath = getThreadSummaryPath({
    projectRoot,
    sessionId,
  });
  writeJsonFile(summaryPath, finalSummary);
  return {
    updated: true,
    summaryPath,
    summary: finalSummary,
    testingPort,
  };
}

function maybeUpdateStableThreadSummary({
  sessionId = '',
  threadId = '',
  title = '',
  prompt = '',
  normalizedPaths = [],
  recentPaths = [],
  existingSummary = null,
  currentThread = null,
} = {}) {
  const inferredModules = inferOwnedModules(normalizedPaths.length > 0 ? normalizedPaths : recentPaths);
  const keepExistingFocus =
    normalizeText(existingSummary?.stableSummary) &&
    sameModuleOwnership(existingSummary?.ownedModules || [], inferredModules);
  const nextPromptAnchor = keepExistingFocus
    ? normalizeText(existingSummary?.promptAnchor)
    : inferPromptAnchor({
        prompt,
        title,
        currentThread,
        existingSummary,
      });
  const existingFocus = buildFocusSignature({
    modules: existingSummary?.ownedModules || [],
    promptAnchor: existingSummary?.promptAnchor || '',
  });
  const nextFocus = buildFocusSignature({
    modules: inferredModules,
    promptAnchor: nextPromptAnchor,
  });
  const shouldRewriteStableSummary =
    !normalizeText(existingSummary?.stableSummary) ||
    !existingFocus ||
    !nextFocus ||
    existingFocus !== nextFocus;

  return {
    threadId: String(threadId || currentThread?.id || sessionId || ''),
    title:
      normalizeText(title) ||
      normalizeText(existingSummary?.title) ||
      normalizeText(currentThread?.title) ||
      inferThreadTitleFromPrompt(prompt) ||
      'Untitled Codex thread',
    ownedModules: inferredModules,
    promptAnchor: nextPromptAnchor,
    stableSummary: shouldRewriteStableSummary
      ? buildStableSummaryText({
          modules: inferredModules,
          promptAnchor: nextPromptAnchor,
        })
      : String(existingSummary.stableSummary),
    latestActivity:
      normalizeText(existingSummary?.latestActivity) ||
      buildLatestActivityLine({
        normalizedPaths,
        toolName: '',
      }),
  };
}

function loadThreadSummary({
  projectRoot = process.cwd(),
  sessionId = '',
} = {}) {
  const summaryPath = getThreadSummaryPath({
    projectRoot,
    sessionId,
  });
  const summary = readJsonFile(summaryPath);
  const sanitizedSummary = sanitizeThreadSummary({
    projectRoot,
    summary,
  });
  if (!summary || !sanitizedSummary) {
    return sanitizedSummary;
  }
  if (JSON.stringify(summary) !== JSON.stringify(sanitizedSummary)) {
    writeJsonFile(summaryPath, sanitizedSummary);
  }
  return sanitizedSummary;
}

function claimTestingPort({
  projectRoot = process.cwd(),
  sessionId = '',
  threadId = '',
  title = '',
  stableSummary = '',
  ownedModules = [],
} = {}) {
  const ledgerPath = getPortLedgerPath(projectRoot);
  const ledger = readJsonFile(ledgerPath) || { schemaVersion: 1, leases: [] };
  const nowIso = new Date().toISOString();
  const leases = Array.isArray(ledger.leases) ? [...ledger.leases] : [];
  const currentKey = buildLeaseKey({ sessionId, threadId });
  const existingLease = leases.find((lease) => buildLeaseKey(lease) === currentKey);
  if (existingLease) {
    existingLease.updatedAt = nowIso;
    existingLease.title = title || existingLease.title || '';
    existingLease.stableSummary = stableSummary || existingLease.stableSummary || '';
    existingLease.ownedModules = Array.isArray(ownedModules) ? ownedModules : existingLease.ownedModules || [];
    writeJsonFile(ledgerPath, {
      schemaVersion: 1,
      leases: normalizeLeaseCapacity(leases),
    });
    return existingLease.port;
  }

  const usedPorts = new Set(leases.map((lease) => Number(lease.port)).filter(Number.isFinite));
  let assignedPort = null;
  for (let port = TEST_PORT_START; port <= TEST_PORT_END; port += 1) {
    if (!usedPorts.has(port)) {
      assignedPort = port;
      break;
    }
  }

  if (assignedPort === null) {
    leases.sort((left, right) => getLeaseTimestamp(left) - getLeaseTimestamp(right));
    const retiredLease = leases.shift();
    assignedPort = retiredLease && Number.isFinite(Number(retiredLease.port))
      ? Number(retiredLease.port)
      : TEST_PORT_START;
  }

  leases.push({
    sessionId,
    threadId,
    port: assignedPort,
    title,
    stableSummary,
    ownedModules: Array.isArray(ownedModules) ? ownedModules : [],
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  writeJsonFile(ledgerPath, {
    schemaVersion: 1,
    leases: normalizeLeaseCapacity(leases),
  });
  return assignedPort;
}

function listActiveSameRepoThreads({
  projectRoot = process.cwd(),
  currentSessionId = '',
  codexHomeDir = process.env.CODEX_HOME_DIR || path.join(os.homedir(), '.codex'),
} = {}) {
  const now = Date.now();
  const appServerResult = listCodexAppServerThreads({
    projectRoot,
    currentSessionId,
    codexHomeDir,
  });
  const appServerRows = appServerResult.available
    ? appServerResult.rows.filter((row) => isFreshThread(row, now))
    : [];
  const localRows = listActiveSameRepoThreadsFromStateDb({
    projectRoot,
    currentSessionId,
    codexHomeDir,
    now,
  });
  if (appServerRows.length > 0 || appServerResult.available) {
    return mergeThreadRows({
      primaryRows: appServerRows,
      supplementalRows: localRows,
    });
  }
  return localRows;
}

function listActiveSameRepoThreadsFromStateDb({
  projectRoot = process.cwd(),
  currentSessionId = '',
  codexHomeDir = process.env.CODEX_HOME_DIR || path.join(os.homedir(), '.codex'),
  now = Date.now(),
} = {}) {
  if (!DatabaseSync) {
    return [];
  }
  const normalizedProjectRoot = normalizeWorkspaceRoot(projectRoot);
  const databasePath = path.join(codexHomeDir, 'state_5.sqlite');
  if (!fs.existsSync(databasePath)) {
    return [];
  }

  let database;
  try {
    database = new DatabaseSync(databasePath);
    const rows = database
      .prepare(`
        SELECT
          id,
          rollout_path,
          cwd,
          title,
          preview,
          agent_nickname,
          agent_role,
          thread_source,
          archived,
          COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms
        FROM threads
        WHERE archived = 0
          AND id <> ?
        ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
        LIMIT 30
      `)
      .all(String(currentSessionId || ''));

    return rows
      .filter((row) => isSameRepoThread(row, normalizedProjectRoot))
      .filter((row) => isFreshThread(row, now));
  } catch (_error) {
    return [];
  } finally {
    if (database && typeof database.close === 'function') {
      try {
        database.close();
      } catch (_error) {
        // ignore close failures
      }
    }
  }
}

function mergeThreadRows({
  primaryRows = [],
  supplementalRows = [],
} = {}) {
  const rowsById = new Map();
  for (const row of supplementalRows || []) {
    const id = String(row?.id || '');
    if (id) {
      rowsById.set(id, row);
    }
  }
  for (const row of primaryRows || []) {
    const id = String(row?.id || '');
    if (id) {
      rowsById.set(id, mergeThreadRowFields(rowsById.get(id) || {}, row));
    }
  }
  return Array.from(rowsById.values())
    .sort((left, right) => Number(right?.updated_at_ms || 0) - Number(left?.updated_at_ms || 0))
    .slice(0, 30);
}

function mergeThreadRowFields(supplementalRow = {}, primaryRow = {}) {
  const merged = { ...supplementalRow };
  for (const [key, value] of Object.entries(primaryRow || {})) {
    if (isMeaningfulThreadRowValue(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

function isMeaningfulThreadRowValue(value) {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }
  return value !== null && typeof value !== 'undefined';
}

function resolveCurrentThread({
  projectRoot = process.cwd(),
  sessionId = '',
  codexHomeDir = process.env.CODEX_HOME_DIR || path.join(os.homedir(), '.codex'),
} = {}) {
  if (!DatabaseSync || !sessionId) {
    return null;
  }
  const normalizedProjectRoot = normalizeWorkspaceRoot(projectRoot);
  const databasePath = path.join(codexHomeDir, 'state_5.sqlite');
  if (!fs.existsSync(databasePath)) {
    return null;
  }

  let database;
  try {
    database = new DatabaseSync(databasePath);
    const row = database
      .prepare(`
        SELECT
          id,
          rollout_path,
          cwd,
          title,
          preview,
          agent_nickname,
          agent_role,
          thread_source,
          archived,
          COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms
        FROM threads
        WHERE id = ?
        LIMIT 1
      `)
      .get(String(sessionId));
    if (!row || !isSameRepoThread(row, normalizedProjectRoot)) {
      return null;
    }
    return {
      id: String(row.id || sessionId),
      rolloutPath: String(row.rollout_path || ''),
      title:
        normalizeText(row.title) ||
        normalizeText(row.preview) ||
        normalizeText(row.agent_nickname) ||
        '',
      agentNickname: normalizeText(row.agent_nickname),
      agentRole: normalizeText(row.agent_role),
      threadSource: normalizeText(row.thread_source),
    };
  } catch (_error) {
    return null;
  } finally {
    if (database && typeof database.close === 'function') {
      try {
        database.close();
      } catch (_error) {
        // ignore close failures
      }
    }
  }
}

function buildThreadCoordinationRecord({
  row,
  projectRoot,
} = {}) {
  const rolloutPath = String(row?.rollout_path || '');
  const existingSummary = loadThreadSummary({
    projectRoot,
    sessionId: String(row?.id || ''),
  });
  const rolloutRecentPaths = readRecentWritePaths({
    rolloutPath,
    projectRoot,
  });
  const recentPaths = mergeRecentPaths(
    existingSummary
      ? [
          ...(existingSummary.recentTouchedPaths || []),
          ...rolloutRecentPaths.filter((filePath) => shouldKeepRolloutPathForSummary({
            filePath,
            summary: existingSummary,
          })),
        ]
      : rolloutRecentPaths,
    projectRoot,
  ).slice(0, MAX_PATHS_PER_THREAD);
  const summary = existingSummary || synthesizeThreadSummaryFromActivity({
    projectRoot,
    sessionId: String(row?.id || ''),
    row,
    recentPaths,
  });
  if (!summary) {
    return {
      id: String(row?.id || ''),
      title:
        normalizeText(row?.title) ||
        normalizeText(row?.preview) ||
        normalizeText(row?.agent_nickname) ||
        'Untitled Codex thread',
      agentNickname: normalizeText(row?.agent_nickname),
      agentRole: normalizeText(row?.agent_role),
      threadSource: normalizeText(row?.thread_source),
      summary: null,
      stableSummary: '',
      latestActivity: '',
      intentCard: null,
      ownedModules: [],
      recentPaths: [],
      testingPort: null,
      updatedAt: '',
      hasSummary: false,
      summaryBody: '',
    };
  }

  return {
    id: String(row?.id || ''),
    title:
      normalizeText(summary?.title) ||
      normalizeText(row?.title) ||
      normalizeText(row?.preview) ||
      normalizeText(row?.agent_nickname) ||
      'Untitled Codex thread',
    agentNickname: normalizeText(row?.agent_nickname),
    agentRole: normalizeText(row?.agent_role),
    threadSource: normalizeText(row?.thread_source),
    summary: summary || null,
    stableSummary: normalizeText(summary?.stableSummary),
    latestActivity: normalizeText(summary?.latestActivity),
    intentCard: normalizeIntentCard(summary?.intentCard, {
      title: summary?.title,
      stableSummary: summary?.stableSummary,
      latestActivity: summary?.latestActivity,
      ownedModules: Array.isArray(summary?.ownedModules) ? summary.ownedModules : inferOwnedModules(recentPaths),
      recentTouchedPaths: recentPaths,
      promptAnchor: summary?.promptAnchor,
    }),
    ownedModules: Array.isArray(summary?.ownedModules) ? summary.ownedModules : inferOwnedModules(recentPaths),
    recentPaths,
    testingPort: summary?.testingPort ?? lookupTestingPort({
      projectRoot,
      sessionId: String(row?.id || ''),
      threadId: String(row?.id || ''),
    }),
    sourceUpdatedAtMs: Number(row?.updated_at_ms || 0),
    updatedAt: normalizeText(summary?.updatedAt),
    hasSummary: Boolean(summary),
    summaryBody: summary
      ? composeSummaryBody({
          stableSummary: summary.stableSummary,
          latestActivity: summary.latestActivity,
        })
      : '',
  };
}

function renderCoordinationSummary({
  threads = [],
  targetFilePaths = [],
} = {}) {
  const lines = ['[Active Thread Collaboration]'];
  lines.push('Use active peer-thread intent cards to find conflicts, handoffs, dependencies, and complementary work:');
  if (targetFilePaths.length > 0) {
    lines.push(`Current target: ${targetFilePaths.slice(0, 3).join(', ')}`);
  }
  for (const thread of threads.slice(0, MAX_SUMMARY_THREADS)) {
    const portLabel = thread.testingPort ? ` | port ${thread.testingPort}` : '';
    const modulesLabel =
      Array.isArray(thread.ownedModules) && thread.ownedModules.length > 0
        ? ` | modules ${thread.ownedModules.join(' / ')}`
        : '';
    lines.push(`- ${thread.title} (${thread.id})${modulesLabel}${portLabel}`);
    if (thread.relationship?.type) {
      lines.push(`  Relationship: ${thread.relationship.type} - ${thread.relationship.reason}`);
      if (thread.relationship.action) {
        lines.push(`  Suggested move: ${thread.relationship.action}`);
      }
    }
    if (thread.intentCard?.objective) {
      lines.push(`  Objective: ${thread.intentCard.objective}`);
    }
    lines.push(`  Summary: ${thread.stableSummary || thread.summaryBody || 'This thread wrote code; use its recent paths and intent before choosing your slice.'}`);
    if (Array.isArray(thread.intentCard?.decisions) && thread.intentCard.decisions.length > 0) {
      lines.push(`  Decisions: ${thread.intentCard.decisions.slice(0, 2).join(' | ')}`);
    }
    if (Array.isArray(thread.intentCard?.offers) && thread.intentCard.offers.length > 0) {
      lines.push(`  Offers: ${thread.intentCard.offers.slice(0, 2).join(' | ')}`);
    }
    if (Array.isArray(thread.intentCard?.needs) && thread.intentCard.needs.length > 0) {
      lines.push(`  Needs: ${thread.intentCard.needs.slice(0, 2).join(' | ')}`);
    }
    if (thread.readDelta?.detail) {
      lines.push(`  Update: ${thread.readDelta.detail}`);
    }
    if (Array.isArray(thread.readDelta?.supplementalPaths) && thread.readDelta.supplementalPaths.length > 0) {
      lines.push(`  Also check: ${thread.readDelta.supplementalPaths.join(', ')}`);
    } else if (thread.recentPaths.length > 0 && !thread.readDelta?.detail) {
      lines.push(`  Recent: ${thread.recentPaths.slice(0, MAX_SUPPLEMENTAL_PATHS).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function buildCoordinationSummarySignature({
  threads = [],
  targetFilePaths = [],
} = {}) {
  return JSON.stringify({
    targetFilePaths: uniqueValues((targetFilePaths || []).map((value) => normalizeText(value))),
    threads: (threads || []).slice(0, MAX_SUMMARY_THREADS).map((thread) => ({
      id: normalizeText(thread.id),
      title: normalizeText(thread.title),
      stableSummary: normalizeText(thread.stableSummary),
      latestActivity: normalizeText(thread.latestActivity),
      summaryBody: normalizeText(thread.summaryBody),
      recentPaths: uniqueValues(thread.recentPaths || []),
      ownedModules: uniqueValues(thread.ownedModules || []),
      relationship: thread.relationship?.type || '',
      intentObjective: normalizeText(thread.intentCard?.objective),
      testingPort: thread.testingPort ?? null,
      sourceUpdatedAtMs: Number(thread.sourceUpdatedAtMs || 0),
    })),
  });
}

function readRecentWritePaths({ rolloutPath = '', projectRoot = process.cwd() } = {}) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return [];
  }

  const paths = [];
  const lines = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_error) {
      continue;
    }

    if (parsed?.type !== 'response_item') {
      continue;
    }

    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    if (payload.type !== 'function_call' || !WRITE_TOOL_NAMES.has(String(payload.name || ''))) {
      continue;
    }

    const argumentsPayload = parseArgumentsPayload(payload.arguments);
    for (const filePath of extractWritePathsFromToolArguments(argumentsPayload, projectRoot)) {
      paths.push(filePath);
    }
  }

  return uniqueValues(paths).slice(0, MAX_PATHS_PER_THREAD);
}

function parseArgumentsPayload(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return {};
  }
}

function extractWritePathsFromToolArguments(toolInput = {}, projectRoot = process.cwd()) {
  const candidatePaths = [];
  for (const key of ['file_path', 'filePath', 'path', 'target']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) {
      candidatePaths.push(toolInput[key]);
    }
  }

  if (Array.isArray(toolInput.paths)) {
    for (const entry of toolInput.paths) {
      if (typeof entry === 'string' && entry) {
        candidatePaths.push(entry);
      }
    }
  }

  if (typeof toolInput.patch === 'string' && toolInput.patch) {
    for (const filePath of extractPatchPaths(toolInput.patch)) {
      candidatePaths.push(filePath);
    }
  }

  return uniqueValues(
    candidatePaths
      .map((filePath) => normalizeRepoPath(projectRoot, filePath))
      .filter((value) => isCodeOwningPath(value)),
  );
}

function extractPatchPaths(patchText) {
  const paths = [];
  const lines = String(patchText || '').split(/\r?\n/u);
  for (const line of lines) {
    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: ')
    ) {
      const filePath = line.replace(/^\*\*\* (?:Update|Add|Delete) File: /u, '').trim();
      if (filePath) {
        paths.push(filePath);
      }
    }
  }
  return paths;
}

function normalizeRepoPath(projectRoot, filePath) {
  const value = String(filePath || '').trim();
  if (!value) {
    return '';
  }

  const absolutePath = path.isAbsolute(value)
    ? value
    : path.resolve(projectRoot, value);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return sanitizeRepoRelativePath(relativePath.split(path.sep).join('/'));
  }

  const normalizedInput = value.replace(/\\/gu, '/');
  if (/^(?:apps|scripts|config)\//iu.test(normalizedInput)) {
    return sanitizeRepoRelativePath(normalizedInput);
  }

  return '';
}

function sanitizeRepoRelativePath(filePath) {
  const normalizedInput = stripPathLineSuffix(
    String(filePath || '').trim().replace(/\\/gu, '/'),
  );
  if (!normalizedInput) {
    return '';
  }
  const normalizedPath = path.posix
    .normalize(normalizedInput)
    .replace(/^\/+/u, '')
    .replace(/^\.\/+/u, '');
  if (
    !normalizedPath ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    return '';
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0 || hasInvalidRepoPathSegments(segments)) {
    return '';
  }
  return segments.join('/');
}

function hasInvalidRepoPathSegments(segments = []) {
  return segments.some((segment) => {
    const value = String(segment || '');
    if (!value || value === '.' || value === '..') {
      return true;
    }
    return /^\.[A-Za-z0-9_-]+$/u.test(value);
  });
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

function stripPathLineSuffix(filePath) {
  const match = String(filePath || '').match(/^(.*?\.[A-Za-z0-9_-]+):\d+(?::\d+)*$/u);
  return match ? match[1] : filePath;
}

function isSameRepoThread(row, projectRoot) {
  const threadCwd = normalizeWorkspaceRoot(String(row?.cwd || ''));
  return Boolean(threadCwd) && threadCwd === projectRoot;
}

function isFreshThread(row, now) {
  const updatedAtMs = Number(row?.updated_at_ms || 0);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return true;
  }
  return now - updatedAtMs <= ACTIVE_THREAD_WINDOW_MS;
}

function isCodeOwningPath(filePath) {
  return CODE_OWNING_PREFIXES.some((prefix) => String(filePath || '').startsWith(prefix));
}

function isSuccessfulToolResult(toolResult = {}) {
  if (!toolResult || typeof toolResult !== 'object') {
    return true;
  }
  if (toolResult.is_error === true || toolResult.isError === true) {
    return false;
  }
  const status = String(toolResult.status || '').toLowerCase();
  if (status === 'error' || status === 'failed' || status === 'cancelled') {
    return false;
  }
  return true;
}

function inferOwnedModules(paths = []) {
  const modules = [];
  for (const filePath of paths) {
    const normalized = String(filePath || '');
    if (!normalized) {
      continue;
    }
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    const lastSegment = segments[segments.length - 1] || '';
    const looksLikeFile = /\.[A-Za-z0-9_-]+$/u.test(lastSegment);
    const moduleSegments = looksLikeFile ? segments.slice(0, -1) : segments;
    if (moduleSegments.length === 0) {
      continue;
    }
    const moduleName = moduleSegments.slice(0, Math.min(moduleSegments.length, 3)).join('/');
    if (moduleName) {
      modules.push(moduleName);
    }
  }
  return uniqueValues(modules).slice(0, 2);
}

function sameModuleOwnership(leftModules = [], rightModules = []) {
  const left = uniqueValues((leftModules || []).map(normalizeText)).sort();
  const right = uniqueValues((rightModules || []).map(normalizeText)).sort();
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  return left.join('|') === right.join('|');
}

function didThreadFocusChange({
  existingSummary = null,
  normalizedPaths = [],
  prompt = '',
  currentThread = null,
} = {}) {
  if (!existingSummary) {
    return false;
  }
  const nextModules = inferOwnedModules(normalizedPaths);
  if (nextModules.length === 0) {
    return false;
  }
  const previousModules = resolveSummaryOwnedModules({
    recentTouchedPaths: existingSummary.recentTouchedPaths || [],
    ownedModules: existingSummary.ownedModules || [],
  });
  if (previousModules.length === 0 || sameModuleOwnership(previousModules, nextModules)) {
    return false;
  }
  const nextPromptAnchor = inferPromptAnchor({
    prompt,
    title: existingSummary?.title,
    currentThread,
    existingSummary,
  });
  const previousFocus = buildFocusSignature({
    modules: previousModules,
    promptAnchor: existingSummary?.promptAnchor || '',
  });
  const nextFocus = buildFocusSignature({
    modules: nextModules,
    promptAnchor: nextPromptAnchor,
  });
  return Boolean(previousFocus && nextFocus && previousFocus !== nextFocus);
}

function inferPromptAnchor({
  prompt = '',
  title = '',
  currentThread = null,
  existingSummary = null,
} = {}) {
  const candidates = [
    prompt,
    title,
    currentThread?.title,
    existingSummary?.promptAnchor,
  ].map(normalizeText).filter(Boolean);
  for (const candidate of candidates) {
    const compact = candidate.replace(/\s+/gu, ' ');
    if (compact) {
      return compact.slice(0, 80);
    }
  }
  return '';
}

function buildFocusSignature({
  modules = [],
  promptAnchor = '',
} = {}) {
  const normalizedModules = uniqueValues(modules.map(normalizeText)).sort().join('|');
  const normalizedPrompt = normalizeText(promptAnchor).slice(0, 40);
  return `${normalizedModules}::${normalizedPrompt}`;
}

function buildStableSummaryText({
  modules = [],
  promptAnchor = '',
} = {}) {
  const moduleText = modules.length > 0 ? modules.join(' / ') : 'current code module';
  const intentText = inferIntentText(promptAnchor);
  return clampText(`This thread is working on ${intentText} in ${moduleText}.`, MAX_SUMMARY_BODY_CHARS);
}

function inferIntentText(promptAnchor = '') {
  const prompt = String(promptAnchor || '');
  if (!prompt) {
    return 'feature iteration and fixes';
  }
  if (/(测|test|验证)/iu.test(prompt)) {
    return 'testing and integration';
  }
  if (/(重构|优化|refactor|optimi[sz]e)/iu.test(prompt)) {
    return 'refactoring and optimization';
  }
  if (/(修|fix|bug)/iu.test(prompt)) {
    return 'bug fixes';
  }
  if (/(新增|实现|添加|开发|build|implement|add)/iu.test(prompt)) {
    return 'feature implementation';
  }
  return 'feature iteration and fixes';
}

function buildLatestActivityLine({
  latestActivity = '',
  normalizedPaths = [],
  toolName = '',
} = {}) {
  if (normalizeText(latestActivity)) {
    return clampText(normalizeText(latestActivity), MAX_SUMMARY_BODY_CHARS);
  }
  const pathText = normalizedPaths.length > 0
    ? `Latest work touched ${normalizedPaths.slice(0, 2).join(', ')}`
    : 'Latest work touched current code changes';
  const toolText = toolName ? ` with ${toolName}` : '';
  return clampText(`${pathText}${toolText}.`, MAX_SUMMARY_BODY_CHARS);
}

function composeSummaryBody({
  stableSummary = '',
  latestActivity = '',
} = {}) {
  const stable = normalizeText(stableSummary);
  const latest = normalizeText(latestActivity);
  if (!stable && !latest) {
    return '';
  }
  if (!stable) {
    return clampText(latest, MAX_SUMMARY_BODY_CHARS);
  }
  if (!latest) {
    return clampText(stable, MAX_SUMMARY_BODY_CHARS);
  }
  return clampText(`${stable} ${latest}`, MAX_SUMMARY_BODY_CHARS);
}

function buildIntentCard({
  title = '',
  stableSummary = '',
  latestActivity = '',
  ownedModules = [],
  promptAnchor = '',
  recentTouchedPaths = [],
} = {}) {
  const normalizedModules = uniqueValues((ownedModules || []).map(normalizeOwnedModulePath).filter(Boolean));
  const normalizedPaths = uniqueValues((recentTouchedPaths || []).map(normalizeText).filter(Boolean));
  const objective =
    inferObjective({
      title,
      stableSummary,
      promptAnchor,
      ownedModules: normalizedModules,
    });
  return normalizeIntentCard({
    objective,
    plan: inferPlanItems({
      promptAnchor,
      recentTouchedPaths: normalizedPaths,
    }),
    ownedScope: normalizedModules.length > 0 ? normalizedModules : inferOwnedModules(normalizedPaths),
    decisions: inferDecisionItems({
      stableSummary,
      latestActivity,
      ownedModules: normalizedModules,
    }),
    needs: inferNeedItems({
      ownedModules: normalizedModules,
      recentTouchedPaths: normalizedPaths,
    }),
    offers: inferOfferItems({
      ownedModules: normalizedModules,
      recentTouchedPaths: normalizedPaths,
    }),
    status: 'in_progress',
  }, {
    title,
    stableSummary,
    latestActivity,
    ownedModules: normalizedModules,
    recentTouchedPaths: normalizedPaths,
    promptAnchor,
  });
}

function normalizeIntentCard(intentCard = null, fallback = {}) {
  const card = intentCard && typeof intentCard === 'object' && !Array.isArray(intentCard)
    ? intentCard
    : {};
  const ownedScope = uniqueValues([
    ...normalizeTextArray(card.ownedScope),
    ...normalizeTextArray(fallback.ownedModules),
  ])
    .map(normalizeOwnedModulePath)
    .filter(Boolean)
    .slice(0, MAX_INTENT_ITEMS);
  const recentTouchedPaths = uniqueValues(normalizeTextArray(fallback.recentTouchedPaths));
  const objective =
    normalizeText(card.objective) ||
    inferObjective({
      title: fallback.title,
      stableSummary: fallback.stableSummary,
      promptAnchor: fallback.promptAnchor,
      ownedModules: ownedScope,
    });
  return {
    objective: clampText(objective, MAX_SUMMARY_BODY_CHARS),
    plan: normalizeTextArray(card.plan).slice(0, MAX_INTENT_ITEMS),
    ownedScope,
    decisions: normalizeTextArray(card.decisions).slice(0, MAX_INTENT_ITEMS),
    needs: normalizeTextArray(card.needs).slice(0, MAX_INTENT_ITEMS),
    offers: normalizeTextArray(card.offers).slice(0, MAX_INTENT_ITEMS),
    status: normalizeIntentStatus(card.status),
    updatedAt: normalizeText(card.updatedAt || fallback.updatedAt),
    recentTouchedPaths,
  };
}

function inferObjective({
  title = '',
  stableSummary = '',
  promptAnchor = '',
  ownedModules = [],
} = {}) {
  const anchor =
    normalizeText(promptAnchor) ||
    normalizeText(stableSummary) ||
    normalizeText(title);
  if (anchor) {
    return clampText(anchor, MAX_SUMMARY_BODY_CHARS);
  }
  const moduleText = ownedModules.length > 0 ? ownedModules.join(' / ') : 'the current code area';
  return `Move ${moduleText} forward without surprising peer threads.`;
}

function inferPlanItems({
  promptAnchor = '',
  recentTouchedPaths = [],
} = {}) {
  const plan = [];
  const intent = inferIntentText(promptAnchor);
  if (intent) {
    plan.push(`Continue ${intent}`);
  }
  if (recentTouchedPaths.length > 0) {
    plan.push(`Keep recent changes coherent around ${recentTouchedPaths.slice(0, 2).join(', ')}`);
  }
  return plan;
}

function inferDecisionItems({
  stableSummary = '',
  latestActivity = '',
  ownedModules = [],
} = {}) {
  const decisions = [];
  const stable = normalizeText(stableSummary);
  if (stable) {
    decisions.push(stable);
  }
  const latest = normalizeText(latestActivity);
  if (latest && latest !== stable) {
    decisions.push(latest);
  }
  if (ownedModules.length > 0) {
    decisions.push(`Current ownership focus: ${ownedModules.join(' / ')}`);
  }
  return decisions;
}

function inferNeedItems({
  ownedModules = [],
  recentTouchedPaths = [],
} = {}) {
  const needs = [];
  if (ownedModules.length > 0) {
    needs.push(`Coordinate before reshaping shared owners in ${ownedModules.join(' / ')}`);
  }
  if (recentTouchedPaths.length > 0) {
    needs.push(`Check latest peer edits before changing ${recentTouchedPaths.slice(0, 2).join(', ')}`);
  }
  return needs;
}

function inferOfferItems({
  ownedModules = [],
  recentTouchedPaths = [],
} = {}) {
  const offers = [];
  if (ownedModules.length > 0) {
    offers.push(`Reusable context for ${ownedModules.join(' / ')}`);
  }
  if (recentTouchedPaths.length > 0) {
    offers.push(`Recent implementation clues in ${recentTouchedPaths.slice(0, 2).join(', ')}`);
  }
  return offers;
}

function normalizeIntentStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (['planned', 'in_progress', 'blocked', 'ready_for_review', 'done', 'handoff'].includes(normalized)) {
    return normalized;
  }
  return 'in_progress';
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueValues(value.map(normalizeText).filter(Boolean));
}

function buildFallbackSummary({
  title = '',
  recentPaths = [],
} = {}) {
  const pathText = recentPaths.length > 0
    ? `recently changed ${recentPaths.slice(0, 2).join(', ')}`
    : 'has already written code';
  return clampText(`${normalizeText(title) || 'Peer thread'} ${pathText}.`, MAX_SUMMARY_BODY_CHARS);
}

function synthesizeThreadSummaryFromActivity({
  projectRoot = process.cwd(),
  sessionId = '',
  row = null,
  recentPaths = [],
} = {}) {
  if (!sessionId || recentPaths.length === 0) {
    return null;
  }
  const title =
    normalizeText(row?.title) ||
    normalizeText(row?.preview) ||
    normalizeText(row?.agent_nickname) ||
    'Untitled Codex thread';
  const ownedModules = inferOwnedModules(recentPaths);
  const syntheticSummary = {
    schemaVersion: 1,
    sessionId,
    threadId: String(row?.id || sessionId),
    title,
    stableSummary: buildStableSummaryText({
      modules: ownedModules,
      promptAnchor: title,
    }),
    latestActivity: buildLatestActivityLine({
      normalizedPaths: recentPaths,
      toolName: '',
    }),
    ownedModules,
    recentTouchedPaths: recentPaths.slice(0, MAX_PATHS_PER_THREAD),
    testingPort: null,
    promptAnchor: title,
    firstWriteAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(
    getThreadSummaryPath({
      projectRoot,
      sessionId,
    }),
    syntheticSummary,
  );
  return syntheticSummary;
}

function mergeRecentPaths(paths = [], projectRoot = process.cwd()) {
  return uniqueValues(
    (paths || [])
      .map((value) => normalizeRepoPath(projectRoot, value))
      .filter((value) => isCodeOwningPath(value) && isLikelyRepoFilePath(value)),
  ).slice(0, MAX_PATHS_PER_THREAD);
}

function sanitizeThreadSummary({
  projectRoot = process.cwd(),
  summary = null,
} = {}) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }
  const recentTouchedPaths = mergeRecentPaths(summary.recentTouchedPaths || [], projectRoot);
  const ownedModules = resolveSummaryOwnedModules({
    recentTouchedPaths,
    ownedModules: summary.ownedModules,
  });
  const stableSummaryNeedsRewrite =
    !normalizeText(summary.stableSummary) ||
    (recentTouchedPaths.length > 0 && !sameModuleOwnership(summary.ownedModules || [], ownedModules));
  const latestActivityNeedsRewrite =
    !normalizeText(summary.latestActivity) ||
    !sameRecentPathList(summary.recentTouchedPaths || [], recentTouchedPaths, projectRoot);
  const promptAnchor =
    normalizeText(summary.promptAnchor) ||
    normalizeText(summary.title);

  return {
    schemaVersion: Number(summary.schemaVersion) || 1,
    sessionId: String(summary.sessionId || ''),
    threadId: String(summary.threadId || summary.sessionId || ''),
    title: normalizeText(summary.title) || 'Untitled Codex thread',
    stableSummary: stableSummaryNeedsRewrite
      ? buildStableSummaryText({
          modules: ownedModules,
          promptAnchor,
        })
      : clampText(normalizeText(summary.stableSummary), MAX_SUMMARY_BODY_CHARS),
    latestActivity: latestActivityNeedsRewrite
      ? buildLatestActivityLine({
          normalizedPaths: recentTouchedPaths,
          toolName: '',
        })
      : clampText(normalizeText(summary.latestActivity), MAX_SUMMARY_BODY_CHARS),
    intentCard: normalizeIntentCard(summary.intentCard, {
      title: summary.title,
      stableSummary: summary.stableSummary,
      latestActivity: summary.latestActivity,
      ownedModules,
      recentTouchedPaths,
      promptAnchor,
      updatedAt: summary.updatedAt,
    }),
    ownedModules,
    recentTouchedPaths,
    testingPort: normalizeTestingPort(summary.testingPort),
    promptAnchor,
    firstWriteAt: normalizeText(summary.firstWriteAt),
    updatedAt: normalizeText(summary.updatedAt),
  };
}

function resolveSummaryOwnedModules({
  recentTouchedPaths = [],
  ownedModules = [],
} = {}) {
  if (recentTouchedPaths.length > 0) {
    return inferOwnedModules(recentTouchedPaths);
  }
  return uniqueValues(
    (ownedModules || [])
      .map((value) => normalizeOwnedModulePath(value))
      .filter(Boolean),
  ).slice(0, 2);
}

function normalizeOwnedModulePath(value) {
  const normalizedPath = sanitizeRepoRelativePath(value);
  if (!normalizedPath || !isCodeOwningPath(normalizedPath)) {
    return '';
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '';
  }
  const lastSegment = segments[segments.length - 1] || '';
  const moduleSegments = /\.[A-Za-z0-9_-]+$/u.test(lastSegment)
    ? segments.slice(0, -1)
    : segments;
  if (moduleSegments.length === 0) {
    return '';
  }
  return moduleSegments.slice(0, Math.min(moduleSegments.length, 3)).join('/');
}

function sameRecentPathList(leftPaths = [], rightPaths = [], projectRoot = process.cwd()) {
  const left = mergeRecentPaths(leftPaths, projectRoot);
  const right = mergeRecentPaths(rightPaths, projectRoot);
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function normalizeTestingPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port)) {
    return null;
  }
  if (port < TEST_PORT_START || port > TEST_PORT_END) {
    return null;
  }
  return port;
}

function isLikelyRepoFilePath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || hasInvalidRepoPathSegments(segments)) {
    return false;
  }
  const lastSegment = segments[segments.length - 1] || '';
  return /^[^.][^/]*\.[A-Za-z0-9_-]+$/u.test(lastSegment);
}

function scoreThreadRelevance({
  targetFilePaths = [],
  record = {},
} = {}) {
  let score = 0;
  const targetModules = inferOwnedModules(targetFilePaths);
  const targetPrefixes = buildPathPrefixes(targetFilePaths);
  for (const recordPath of record.recentPaths || []) {
    if ((targetFilePaths || []).includes(recordPath)) {
      score += 6;
      continue;
    }
    for (const prefix of targetPrefixes) {
      if (recordPath.startsWith(prefix)) {
        score += 3;
        break;
      }
    }
  }
  for (const moduleName of record.ownedModules || []) {
    if (targetModules.includes(moduleName)) {
      score += 5;
    }
  }
  if (record.testingPort) {
    score += 1;
  }
  return score;
}

function classifyThreadRelationship({
  targetFilePaths = [],
  record = {},
} = {}) {
  const directOverlap = findDirectOverlap({
    targetFilePaths,
    recordPaths: record.recentPaths || [],
  });
  const sharedModules = findSharedModules({
    targetFilePaths,
    ownedModules: [
      ...(record.ownedModules || []),
      ...(record.intentCard?.ownedScope || []),
    ],
  });
  const status = normalizeIntentStatus(record.intentCard?.status);
  const hasNeeds = Array.isArray(record.intentCard?.needs) && record.intentCard.needs.length > 0;
  const hasOffers = Array.isArray(record.intentCard?.offers) && record.intentCard.offers.length > 0;

  if (directOverlap.length > 0) {
    return {
      type: 'conflict-risk',
      reason: `Both threads are near ${directOverlap.slice(0, 2).join(', ')}.`,
      action: 'Read the peer intent card and current file reality before editing; split ownership or hand off explicitly.',
      overlapPaths: directOverlap,
      sharedModules,
    };
  }

  if (status === 'ready_for_review') {
    return {
      type: 'review-opportunity',
      reason: 'The peer thread marked its work ready for review.',
      action: 'Use your related context to review, test, or validate the peer result before adding parallel code.',
      overlapPaths: [],
      sharedModules,
    };
  }

  if (status === 'handoff') {
    return {
      type: 'handoff-opportunity',
      reason: 'The peer thread is offering a handoff.',
      action: 'Check its decisions and recent paths, then continue the complementary slice if it matches your task.',
      overlapPaths: [],
      sharedModules,
    };
  }

  if (sharedModules.length > 0 && hasOffers) {
    return {
      type: 'complementary',
      reason: `Shared module focus: ${sharedModules.slice(0, 2).join(' / ')}.`,
      action: 'Look for reusable decisions/helpers from the peer and build the adjacent slice instead of duplicating work.',
      overlapPaths: [],
      sharedModules,
    };
  }

  if (sharedModules.length > 0 && hasNeeds) {
    return {
      type: 'dependency',
      reason: `The peer has coordination needs in ${sharedModules.slice(0, 2).join(' / ')}.`,
      action: 'Treat its needs as constraints; unblock or adapt to them before changing shared owners.',
      overlapPaths: [],
      sharedModules,
    };
  }

  if (sharedModules.length > 0) {
    return {
      type: 'same-area-awareness',
      reason: `Nearby work exists in ${sharedModules.slice(0, 2).join(' / ')}.`,
      action: 'Use the peer summary as context and keep your write slice explicit.',
      overlapPaths: [],
      sharedModules,
    };
  }

  return {
    type: 'background-context',
    reason: 'The peer thread is active but only loosely related to this target.',
    action: 'Proceed normally; borrow context only if the peer intent helps your task.',
    overlapPaths: [],
    sharedModules: [],
  };
}

function findDirectOverlap({
  targetFilePaths = [],
  recordPaths = [],
} = {}) {
  const targets = new Set(uniqueValues((targetFilePaths || []).map(normalizeText).filter(Boolean)));
  return uniqueValues((recordPaths || []).map(normalizeText).filter(Boolean))
    .filter((filePath) => targets.has(filePath));
}

function findSharedModules({
  targetFilePaths = [],
  ownedModules = [],
} = {}) {
  const targetModules = inferOwnedModules(targetFilePaths);
  const normalizedOwnedModules = uniqueValues((ownedModules || []).map(normalizeOwnedModulePath).filter(Boolean));
  return normalizedOwnedModules.filter((moduleName) => targetModules.includes(moduleName));
}

function scorePathRelevance({
  filePath = '',
  targetFilePaths = [],
  targetPrefixes = [],
  targetModules = [],
  targetWantsTestPaths = false,
} = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return 0;
  }

  let score = 0;
  if ((targetFilePaths || []).includes(normalizedPath)) {
    score += 10;
  } else {
    for (const prefix of targetPrefixes || []) {
      if (normalizedPath.startsWith(prefix)) {
        score += 6;
        break;
      }
    }
  }

  const pathModules = inferOwnedModules([normalizedPath]);
  if (pathModules.some((moduleName) => (targetModules || []).includes(moduleName))) {
    score += 3;
  }

  if (!targetWantsTestPaths && isTestLikePath(normalizedPath)) {
    score -= 1;
  }

  return score;
}

function buildPathPrefixes(paths = []) {
  const prefixes = [];
  for (const filePath of paths) {
    const parts = String(filePath || '').split('/');
    if (parts.length >= 3) {
      prefixes.push(parts.slice(0, 3).join('/'));
    } else if (parts.length >= 2) {
      prefixes.push(parts.slice(0, 2).join('/'));
    }
  }
  return uniqueValues(prefixes);
}

function selectTargetPriorityPaths({
  candidatePaths = [],
  targetFilePaths = [],
  limit = MAX_HIGHLIGHTED_DELTA_PATHS,
} = {}) {
  const normalizedCandidates = uniqueValues((candidatePaths || []).map(normalizeText).filter(Boolean));
  if (normalizedCandidates.length === 0) {
    return {
      paths: [],
      hasTargetHit: false,
    };
  }

  const targetModules = inferOwnedModules(targetFilePaths);
  const targetPrefixes = buildPathPrefixes(targetFilePaths);
  const targetWantsTestPaths = (targetFilePaths || []).some((value) => isTestLikePath(value));
  const rankedPaths = normalizedCandidates
    .map((filePath, index) => ({
      filePath,
      index,
      score: scorePathRelevance({
        filePath,
        targetFilePaths,
        targetPrefixes,
        targetModules,
        targetWantsTestPaths,
      }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });
  const hasTargetHit = rankedPaths.some((entry) => entry.score > 0);
  return {
    paths: rankedPaths.slice(0, limit).map((entry) => entry.filePath),
    hasTargetHit,
  };
}

function buildSupplementalPaths({
  candidatePaths = [],
  highlightedPaths = [],
  limit = MAX_SUPPLEMENTAL_PATHS,
} = {}) {
  const excludedPaths = new Set(uniqueValues((highlightedPaths || []).map(normalizeText).filter(Boolean)));
  return uniqueValues((candidatePaths || []).map(normalizeText).filter(Boolean))
    .filter((value) => !excludedPaths.has(value))
    .slice(0, limit);
}

function compareThreadRecords(left, right) {
  if ((right.relevanceScore || 0) !== (left.relevanceScore || 0)) {
    return (right.relevanceScore || 0) - (left.relevanceScore || 0);
  }
  const rightUpdated = parseDateValue(right.updatedAt);
  const leftUpdated = parseDateValue(left.updatedAt);
  if (rightUpdated !== leftUpdated) {
    return rightUpdated - leftUpdated;
  }
  return String(left.title || '').localeCompare(String(right.title || ''));
}

function parseDateValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getThreadSummaryPath({
  projectRoot = process.cwd(),
  sessionId = '',
} = {}) {
  return path.join(
    projectRoot,
    ...SUMMARY_STATE_ROOT,
    'summaries',
    `${sanitizeFileName(sessionId || 'default')}.json`,
  );
}

function getPortLedgerPath(projectRoot = process.cwd()) {
  return path.join(
    projectRoot,
    ...SUMMARY_STATE_ROOT,
    'ports.json',
  );
}

function sanitizeFileName(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/gu, '_');
}

function shouldKeepRolloutPathForSummary({
  filePath = '',
  summary = null,
} = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath || !summary || typeof summary !== 'object') {
    return false;
  }

  const summaryModules = resolveSummaryOwnedModules({
    recentTouchedPaths: summary.recentTouchedPaths || [],
    ownedModules: summary.ownedModules || [],
  });
  if (summaryModules.length === 0) {
    return true;
  }

  const rolloutModules = inferOwnedModules([normalizedPath]);
  if (rolloutModules.some((moduleName) => summaryModules.includes(moduleName))) {
    return true;
  }

  const summaryPrefixes = buildPathPrefixes(summary.recentTouchedPaths || []);
  return summaryPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function lookupTestingPort({
  projectRoot = process.cwd(),
  sessionId = '',
  threadId = '',
} = {}) {
  const ledger = readJsonFile(getPortLedgerPath(projectRoot));
  const leases = Array.isArray(ledger?.leases) ? ledger.leases : [];
  const currentKey = buildLeaseKey({ sessionId, threadId });
  const lease = leases.find((entry) => buildLeaseKey(entry) === currentKey);
  return lease ? Number(lease.port) : null;
}

function buildLeaseKey({
  sessionId = '',
  threadId = '',
} = {}) {
  return `${String(sessionId || '')}::${String(threadId || '')}`;
}

function normalizeLeaseCapacity(leases = []) {
  return [...leases]
    .sort((left, right) => getLeaseTimestamp(right) - getLeaseTimestamp(left))
    .slice(0, MAX_PORT_LEASES)
    .sort((left, right) => getLeaseTimestamp(left) - getLeaseTimestamp(right));
}

function getLeaseTimestamp(lease = {}) {
  const updatedAt = Date.parse(String(lease.updatedAt || ''));
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(String(lease.createdAt || ''));
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function inferThreadTitleFromPrompt(prompt = '') {
  const normalized = normalizeText(prompt);
  if (!normalized) {
    return '';
  }
  return normalized.replace(/\s+/gu, ' ').slice(0, 80);
}

function resolvePreferredThreadTitle({
  currentThread = null,
  existingSummary = null,
  prompt = '',
} = {}) {
  const candidates = [
    currentThread?.title,
    existingSummary?.title,
    prompt,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMeaningfulThreadTitle(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return 'Untitled Codex thread';
}

function normalizeMeaningfulThreadTitle(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  if (/^untitled codex thread$/iu.test(normalized)) {
    return '';
  }
  return normalized.slice(0, 120);
}

function clampText(value, maxChars) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/gu, ' ');
}

function normalizeThreadReadStateMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const entries = {};
  for (const [threadId, snapshot] of Object.entries(value)) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      continue;
    }
    entries[normalizedThreadId] = {
      sourceUpdatedAtMs: Number(snapshot.sourceUpdatedAtMs || 0),
      recentTouchedPaths: uniqueValues(snapshot.recentTouchedPaths || []),
      latestActivity: normalizeText(snapshot.latestActivity),
      lastReadAt: normalizeText(snapshot.lastReadAt),
      updatedAt: normalizeText(snapshot.updatedAt),
    };
  }
  return entries;
}

function isTestLikePath(filePath = '') {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return false;
  }
  return (
    /(^|\/)(?:__tests__|tests|e2e)\//u.test(normalizedPath) ||
    /\.(?:test|spec)\.[A-Za-z0-9_-]+$/u.test(normalizedPath)
  );
}

function hasUnreadThreadUpdate({
  previousReadState = null,
  record = {},
} = {}) {
  if (!previousReadState) {
    return true;
  }
  const currentUpdatedAtMs = Number(record.sourceUpdatedAtMs || 0);
  const previousUpdatedAtMs = Number(previousReadState.sourceUpdatedAtMs || 0);
  if (!Number.isFinite(currentUpdatedAtMs) || currentUpdatedAtMs <= 0) {
    return true;
  }
  if (!Number.isFinite(previousUpdatedAtMs) || previousUpdatedAtMs <= 0) {
    return true;
  }
  if (currentUpdatedAtMs > previousUpdatedAtMs) {
    return true;
  }

  const currentSummaryUpdatedAt = parseDateValue(record.updatedAt);
  const previousSummaryUpdatedAt = parseDateValue(previousReadState.updatedAt);
  if (
    Number.isFinite(currentSummaryUpdatedAt) &&
    currentSummaryUpdatedAt > 0 &&
    (!Number.isFinite(previousSummaryUpdatedAt) || currentSummaryUpdatedAt > previousSummaryUpdatedAt)
  ) {
    return true;
  }

  const currentPaths = uniqueValues(record.recentPaths || []);
  const previousPaths = uniqueValues(previousReadState.recentTouchedPaths || []);
  if (currentPaths.some((value) => !previousPaths.includes(value))) {
    return true;
  }

  const nextLatestActivity = normalizeText(record.latestActivity);
  const previousLatestActivity = normalizeText(previousReadState.latestActivity);
  if (nextLatestActivity && nextLatestActivity !== previousLatestActivity) {
    return true;
  }

  return false;
}

function buildThreadReadDelta({
  previousReadState = null,
  record = {},
  targetFilePaths = [],
} = {}) {
  const prioritizedRecentPaths = selectTargetPriorityPaths({
    candidatePaths: record.recentPaths || [],
    targetFilePaths,
  });
  if (!previousReadState) {
    const supplementalPaths = buildSupplementalPaths({
      candidatePaths: record.recentPaths || [],
      highlightedPaths: prioritizedRecentPaths.paths,
    });
    return {
      detail: prioritizedRecentPaths.paths.length > 0
        ? `First read; inspect first: ${prioritizedRecentPaths.paths.join(', ')}`
        : 'First read for this relevant thread.',
      highlightPaths: prioritizedRecentPaths.paths,
      supplementalPaths,
      newPaths: uniqueValues(record.recentPaths || []),
    };
  }

  const previousPaths = uniqueValues(previousReadState.recentTouchedPaths || []);
  const nextPaths = uniqueValues(record.recentPaths || []);
  const newPaths = nextPaths.filter((value) => !previousPaths.includes(value));
  if (newPaths.length > 0) {
    const prioritizedNewPaths = selectTargetPriorityPaths({
      candidatePaths: newPaths,
      targetFilePaths,
    });
    const highlightPaths = prioritizedNewPaths.paths;
    return {
      detail: highlightPaths.length > 0
        ? `${prioritizedNewPaths.hasTargetHit ? 'Most relevant new progress' : 'New since last read'}: ${highlightPaths.join(', ')}`
        : 'There are new changes since the last read.',
      highlightPaths,
      supplementalPaths: buildSupplementalPaths({
        candidatePaths: newPaths,
        highlightedPaths: highlightPaths,
      }),
      newPaths,
    };
  }

  const nextLatestActivity = normalizeText(record.latestActivity);
  const previousLatestActivity = normalizeText(previousReadState.latestActivity);
  if (nextLatestActivity && nextLatestActivity !== previousLatestActivity) {
    return {
      detail: `Latest progress since last read: ${nextLatestActivity}`,
      highlightPaths: [],
      supplementalPaths: prioritizedRecentPaths.hasTargetHit
        ? prioritizedRecentPaths.paths
        : buildSupplementalPaths({
            candidatePaths: record.recentPaths || [],
            highlightedPaths: [],
          }),
      newPaths: [],
    };
  }

  return {
    detail: prioritizedRecentPaths.paths.length > 0
      ? `${prioritizedRecentPaths.hasTargetHit ? 'Thread updated; inspect first' : 'Thread updated; check'}: ${prioritizedRecentPaths.paths.join(', ')}`
      : 'Thread updated; inspect recent relevant changes.',
    highlightPaths: prioritizedRecentPaths.paths,
    supplementalPaths: buildSupplementalPaths({
      candidatePaths: record.recentPaths || [],
      highlightedPaths: prioritizedRecentPaths.paths,
    }),
    newPaths: [],
  };
}

function buildThreadReadStatePatch(threads = []) {
  const nowIso = new Date().toISOString();
  const patch = {};
  for (const thread of threads || []) {
    const threadId = normalizeText(thread.id);
    if (!threadId) {
      continue;
    }
    patch[threadId] = {
      sourceUpdatedAtMs: Number(thread.sourceUpdatedAtMs || 0),
      recentTouchedPaths: uniqueValues(thread.recentPaths || []),
      latestActivity: normalizeText(thread.latestActivity),
      updatedAt: normalizeText(thread.updatedAt),
      lastReadAt: nowIso,
    };
  }
  return patch;
}

function uniqueValues(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

module.exports = {
  ACTIVE_THREAD_WINDOW_MS,
  MAX_PORT_LEASES,
  TEST_PORT_END,
  TEST_PORT_START,
  buildCoordinationSummary,
  buildCoordinationSummarySignature,
  buildIntentCard,
  classifyThreadRelationship,
  claimTestingPort,
  loadThreadSummary,
  maybeUpdateStableThreadSummary,
  normalizeIntentCard,
  recordCodeWriteActivity,
};
