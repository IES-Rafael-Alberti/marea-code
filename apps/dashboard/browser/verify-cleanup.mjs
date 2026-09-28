import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";

// Exercise the committed shell orchestration without creating files or processes.
// Only process discovery/signalling and removal are replaced; settlement and
// aggregation are the actual functions used by the launcher.
const source = readFileSync(new URL("./run-live-proof.sh", import.meta.url), "utf8");
const start = source.indexOf("owned_running() {");
const end = source.indexOf("\ntrap cleanup EXIT");
assert.ok(start >= 0 && end > start);
const functions = source.slice(start, end);

for (const [browserStatus, serverStatus, initialStatus] of [
  [2, 1, 0],
  [1, 2, 0],
  [2, 2, 0],
  [1, 1, 0],
  [2, 1, 7],
  [1, 1, 7],
]) {
  const result = spawnSync(
    "sh",
    [
      "-c",
      `${functions}
record_owned_tree() { :; }
signal_owned_processes() { printf 'SIGNAL:%s:%s\\n' "$3" "$2"; return 0; }
owned_processes_running() {
  if [ "$2" = browser ]; then return ${browserStatus}; else return ${serverStatus}; fi
}
rm() { printf 'REMOVED\\n'; }
browser_pid=browser
server_pid=server
browser_pids_file=unused
server_pids_file=unused
temp_dir=synthetic-artifacts
(exit ${initialStatus})
cleanup
`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.ifError(result.error);
  const failed = browserStatus === 2 || serverStatus === 2;
  assert.equal(result.status, initialStatus || (failed ? 1 : 0));
  assert.equal(result.stdout.includes("REMOVED"), !failed);
  assert.equal(result.stderr.includes("retaining proof artifacts"), failed);
  assert.ok(result.stdout.includes("SIGNAL:browser:TERM"));
  assert.ok(result.stdout.includes("SIGNAL:server:TERM"));
}
