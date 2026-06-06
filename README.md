# Codex Active Thread Coordination

Local active-thread coordination helpers for OpenAI Codex power users.

This project extracts a small, repo-local coordination layer from a heavily customized Codex setup. It helps multiple local Codex threads avoid stepping on the same files by sharing compact sidecar summaries, recent touched paths, and optional testing-port leases.

It is not an official OpenAI project.

## What It Does

- Reads active Codex threads from `~/.codex/state_5.sqlite` when available.
- Optionally probes `codex app-server --listen stdio://` and merges `thread/list` metadata.
- Records compact per-thread code-write summaries under `.codex-thread-coordination/`.
- Renders a short `[Active Thread Coordination]` preflight for nearby peer threads that touched related paths.
- Avoids reading full peer transcripts by default.

## Why This Exists

Running several local Codex threads against one repo is powerful, but it is easy for two threads to edit the same owner file, claim the same dev port, or duplicate a half-finished implementation. This tool keeps the coordination signal small enough to inject before code writes without turning Codex into a multi-agent platform.

## Install

```sh
git clone https://github.com/Enmani/codex-active-thread-coordination.git
cd codex-active-thread-coordination
npm test
```

Use directly from the checkout:

```sh
node bin/codex-active-thread-coordination.cjs summary --target apps/web/src/App.tsx
```

## CLI

Render a preflight summary for the files you are about to edit:

```sh
node bin/codex-active-thread-coordination.cjs summary \
  --project-root /path/to/repo \
  --session-id current-thread-id \
  --target apps/web/src/App.tsx
```

Record a successful write after your hook observes an edit:

```sh
node bin/codex-active-thread-coordination.cjs record \
  --project-root /path/to/repo \
  --session-id current-thread-id \
  --file apps/web/src/App.tsx \
  --prompt "fix the app shell route"
```

## Public API

```js
const {
  buildCoordinationSummary,
  recordCodeWriteActivity,
} = require('./src/active-thread-coordination.cjs');
```

`buildCoordinationSummary(...)` returns `{ available, output, threads, relevantThreads, readStatePatch }`.

`recordCodeWriteActivity(...)` updates `.codex-thread-coordination/summaries/<session>.json` and returns the written summary plus an optional testing port.

## Hook Integration Shape

This repo intentionally does not ship a universal Codex hook installer. Different users wire Codex through shell wrappers, desktop app hooks, editor extensions, or custom policy engines.

The expected host behavior is:

1. Before the first real code-writing tool call in a prompt turn, call `summary`.
2. Inject `output` only when it is non-empty.
3. After a successful `Edit`, `Write`, `MultiEdit`, or `apply_patch`, call `record`.
4. Keep the current thread id and `readStatePatch` in your host/session state if you want unread-only behavior.

See `examples/minimal-host-hook.cjs` for a tiny wiring sketch.

## State Files

The tool writes only inside the target repository:

```text
.codex-thread-coordination/
  summaries/
    <session-id>.json
  ports.json
```

These files are local coordination state. Add `.codex-thread-coordination/` to `.gitignore` in repos where you use the tool.

## Requirements

- Node.js with `node:sqlite` support for reading `state_5.sqlite`.
- OpenAI Codex installed locally if you want app-server probing.

If `node:sqlite` or app-server probing is unavailable, the tool degrades to the sidecar information it can read.

## License

MIT
