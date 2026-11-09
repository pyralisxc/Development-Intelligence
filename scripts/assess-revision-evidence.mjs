#!/usr/bin/env node
import { callTool } from '../dist/src/mcp.js';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function main() {
  const project = value('--project');
  const baseRef = value('--base-ref');
  const ref = value('--ref');
  const contractText = value('--contract-json');
  if (!project || !baseRef || !ref || !contractText || contractText.length > 100000) {
    throw new Error('Require --project --base-ref --ref --contract-json (max 100000 chars)');
  }
  const keys = ['--prior-run-id', '--prior-run-sha', '--prior-outcome', '--prior-report-digest'];
  const supplied = keys.some(key => value(key) !== undefined);
  const priorTestRun = supplied ? {
    runId: value('--prior-run-id'),
    claimedSourceRevision: value('--prior-run-sha'),
    reportedOutcome: value('--prior-outcome'),
    ...(value('--prior-report-digest') === undefined ? {} : { reportDigest: value('--prior-report-digest') }),
  } : undefined;
  const args = {
    project, baseRef, ref, contract: JSON.parse(contractText),
    ...(priorTestRun ? { priorTestRun } : {}),
  };
  const result = await callTool('assess_revision_evidence', args);
  console.log(JSON.stringify(result));
}
main().catch(error => {
  console.error(JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error),
    unprovenEvidenceIsNotPromoted: true }));
  process.exitCode = 1;
});
