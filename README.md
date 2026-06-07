# Codex Active Thread Coordination

Local collaboration and orchestration helpers for parallel OpenAI Codex threads.

This project extracts a small, repo-local collaboration layer from a heavily customized Codex setup. It helps multiple local Codex threads understand one another's intent, scope, recent decisions, and complementary work opportunities before writing code.

It is not an official OpenAI project.

## What It Does

- Reads active Codex threads from `~/.codex/state_5.sqlite` when available.
- Optionally probes `codex app-server --listen stdio://` and merges `thread/list` metadata.
- Records compact per-thread code-write summaries and intent cards under `.codex-thread-coordination/`.
- Classifies nearby peers as `conflict-risk`, `complementary`, `dependency`, `handoff-opportunity`, `review-opportunity`, or `same-area-awareness`.
- Renders a short `[Active Thread Collaboration]` preflight before code writes.
- Avoids reading full peer transcripts by default.

## Why This Exists

Running several local Codex threads against one repo is powerful. The first problem is collision avoidance: two threads should not blindly edit the same owner file or claim the same dev port.

The more interesting problem is collaboration. A peer thread might be building a substrate you can reuse, holding a decision you should respect, offering a handoff, or asking for review. This tool keeps that signal small enough to inject before code writes without turning Codex into a chatty multi-agent platform.

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

Render a collaboration preflight for the files you are about to edit:

```sh
node bin/codex-active-thread-coordination.cjs summary \
  --project-root /path/to/repo \
  --session-id current-thread-id \
  --target apps/web/src/App.tsx
```

Record a successful write and publish/update the current thread's intent card:

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

`buildCoordinationSummary(...)` returns `{ available, output, threads, relevantThreads, readStatePatch }`. Each rendered thread includes a `relationship` and an `intentCard` when available.

`recordCodeWriteActivity(...)` updates `.codex-thread-coordination/summaries/<session>.json` and returns the written summary plus an optional testing port.

Intent cards look like this:

```json
{
  "objective": "Create reusable route substrate helpers.",
  "plan": ["Extract helper", "Wire sidebar later"],
  "ownedScope": ["apps/web/src"],
  "decisions": ["Route ownership stays in the app shell."],
  "needs": ["Do not duplicate route state helpers."],
  "offers": ["Reusable route helper for sidebar flow."],
  "status": "in_progress"
}
```

## Hook Integration Shape

This repo intentionally does not ship a universal Codex hook installer. Different users wire Codex through shell wrappers, desktop app hooks, editor extensions, or custom policy engines.

The expected host behavior is:

1. Before the first real code-writing tool call in a prompt turn, call `summary`.
2. Inject `output` only when it is non-empty so the agent can decide whether the peer is a conflict, dependency, handoff, review target, or complementary collaborator.
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
