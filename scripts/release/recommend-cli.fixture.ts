/** External-command fixture for exercising channel writes without GitHub mutations. */
export const recommendationCommandFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.MAREA_RECOMMEND_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
state.calls.push({ command, args, input });
let output = '';
let status = 0;
const fail = (code) => { status = 1; output = JSON.stringify({ status: String(code) }); };
if (command === 'python3') status = state.rejectSignature ? 1 : 0;
else if (command === 'git') output = 'a'.repeat(40);
else {
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  if (endpoint.includes('/actions/workflows/')) output = JSON.stringify({ workflow_runs: state.runs });
  else if (endpoint.includes('/jobs?')) output = JSON.stringify({ jobs: state.jobs });
  else if (endpoint.includes('/releases/tags/')) output = JSON.stringify(state.release);
  else if (endpoint.includes('/git/ref/heads/')) {
    if (state.branch) output = JSON.stringify({ object: { sha: 'head' } }); else fail(404);
  } else if (endpoint.includes('/contents/preview.json?')) {
    if (state.channel === null) fail(404);
    else output = JSON.stringify({ sha: state.blob, encoding: 'base64', content: Buffer.from(JSON.stringify(state.channel)).toString('base64') });
  } else if (endpoint.endsWith('/contents/preview.json')) {
    if (state.conflict || input.sha !== state.blob) fail(409);
    else {
      if (!state.rejectWrite) state.channel = JSON.parse(Buffer.from(input.content, 'base64').toString('utf8'));
      state.blob = 'updated';
      output = '{}';
    }
  } else if (endpoint.endsWith('/git/trees')) {
    state.pendingContent = input.tree[0].content;
    output = JSON.stringify({ sha: 'tree' });
  } else if (endpoint.endsWith('/git/commits')) output = JSON.stringify({ sha: 'commit' });
  else if (endpoint.endsWith('/git/refs')) {
    if (state.branch) fail(422);
    else {
      state.branch = true;
      state.channel = JSON.parse(state.pendingContent);
      output = '{}';
    }
  } else throw new Error('Unexpected fixture endpoint: ' + endpoint);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(output);
process.exitCode = status;
`;
