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
