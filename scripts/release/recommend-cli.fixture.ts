/** External-command fixture for exercising the maintainer CLI without GitHub writes. */
export const recommendationCommandFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.MAREA_RECOMMEND_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
state.calls.push({ command, args });
let output = '';
let status = 0;
if (command === 'python3') status = state.rejectSignature ? 1 : 0;
else if (command === 'git') output = 'a'.repeat(40);
else if (args.includes('PATCH')) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!state.rejectWrite) state.release.body = input.body;
} else {
  const endpoint = args[1];
  if (endpoint.includes('/actions/workflows/')) output = JSON.stringify({ workflow_runs: state.runs });
  else if (endpoint.includes('/jobs?')) output = JSON.stringify({ jobs: state.jobs });
  else if (endpoint.endsWith('?per_page=100')) output = JSON.stringify(state.releases);
  else output = JSON.stringify(state.release);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(output);
process.exitCode = status;
`;
