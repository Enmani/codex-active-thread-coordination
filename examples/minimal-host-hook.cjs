const {
  buildCoordinationSummary,
  recordCodeWriteActivity,
} = require('../src/active-thread-coordination.cjs');

function beforeCodeWrite({ projectRoot, sessionId, targetFilePaths }) {
  const summary = buildCoordinationSummary({
    projectRoot,
    currentSessionId: sessionId,
    targetFilePaths,
  });
  // Inject this before a write so the agent can spot conflicts, handoffs,
  // dependencies, and complementary peer work.
  return summary.output;
}

function afterSuccessfulCodeWrite({ projectRoot, sessionId, filePaths, prompt, toolName }) {
  return recordCodeWriteActivity({
    projectRoot,
    sessionId,
    filePaths,
    prompt,
    toolName,
    toolResult: { success: true },
  });
}

module.exports = {
  afterSuccessfulCodeWrite,
  beforeCodeWrite,
};
