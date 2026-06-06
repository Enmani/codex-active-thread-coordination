#!/usr/bin/env node
const path = require('node:path');
const {
  buildCoordinationSummary,
  recordCodeWriteActivity,
} = require('../src/active-thread-coordination.cjs');

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || 'summary';

  if (args.help || args.h || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === 'summary') {
    const result = buildCoordinationSummary({
      projectRoot: args.projectRoot || process.cwd(),
      currentSessionId: args.sessionId || '',
      targetFilePaths: collectValues(args.target),
      codexHomeDir: args.codexHome || process.env.CODEX_HOME || undefined,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (result.output) {
      process.stdout.write(`${result.output}\n`);
    }
    return 0;
  }

  if (command === 'record') {
    const result = recordCodeWriteActivity({
      projectRoot: args.projectRoot || process.cwd(),
      sessionId: args.sessionId || '',
      filePaths: collectValues(args.file),
      prompt: args.prompt || '',
      toolName: args.toolName || 'manual',
      toolResult: { success: true },
      codexHomeDir: args.codexHome || process.env.CODEX_HOME || undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.updated ? 0 : 2;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  return 1;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/u, 2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = typeof inlineValue === 'string' ? inlineValue : argv[index + 1];
    if (typeof inlineValue !== 'string' && value && !String(value).startsWith('--')) {
      index += 1;
    }
    const finalValue = typeof value === 'undefined' || String(value).startsWith('--') ? true : value;
    if (Object.hasOwn(parsed, key)) {
      parsed[key] = [...collectValues(parsed[key]), finalValue];
    } else {
      parsed[key] = finalValue;
    }
  }
  return parsed;
}

function collectValues(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === 'undefined' || value === false || value === true) {
    return [];
  }
  return [String(value)].filter(Boolean).map((item) => path.normalize(item));
}

function printHelp() {
  process.stdout.write(`codex-active-thread-coordination

Usage:
  codex-active-thread-coordination summary --target <path> [--session-id <id>] [--json]
  codex-active-thread-coordination record --session-id <id> --file <path> [--prompt <text>]

Commands:
  summary   Render active peer-thread coordination hints for target paths.
  record    Record a successful code write into the local sidecar summary.

Options:
  --project-root <path>  Repository root. Defaults to cwd.
  --codex-home <path>    Codex home. Defaults to CODEX_HOME or ~/.codex.
  --session-id <id>      Current Codex session/thread id.
  --target <path>        Target path for summary relevance. Repeatable.
  --file <path>          Written file path for record. Repeatable.
  --json                 Print raw JSON for summary.
`);
}

process.exitCode = main(process.argv.slice(2));
