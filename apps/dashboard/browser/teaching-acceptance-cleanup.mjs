/* global process, console */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runner = "apps/dashboard/browser/run-teaching-browser-acceptance.sh";
const source = await readFile(runner, "utf8");
const functions = source.slice(
  source.indexOf("owned_running() {"),
  source.indexOf("\ntrap cleanup EXIT"),
);
assert.equal(functions.startsWith("owned_running() {"), true);

const changedRoot = spawnSync(
  "sh",
  ["-c", `${functions}\nps() { echo 999999; }\nis_owned_root 42 42 1\n`],
  { encoding: "utf8", timeout: 5_000 },
);
assert.ifError(changedRoot.error);
assert.equal(changedRoot.status, 1, "an unwaited root PID with a foreign parent is not owned");

// The actual cleanup aggregation must retain both an original failure code and
// diagnostics whenever a process identity cannot be established.
for (const [initial, browser, server, build] of [
  [0, 1, 1, 1],
  [0, 2, 1, 1],
  [0, 1, 2, 1],
  [0, 1, 1, 2],
  [7, 2, 2, 2],
  [7, 1, 1, 1],
]) {
  const result = spawnSync(
    "sh",
    [
      "-c",
      `${functions}
record_owned_tree() { :; }
signal_owned_processes() { return 0; }
owned_processes_running() {
  case "$2" in browser) return ${browser};; server) return ${server};; build) return ${build};; esac
}
rm() { echo REMOVED; }
browser_pid=browser
server_pid=server
build_pid=build
browser_pids_file=unused
server_pids_file=unused
build_pids_file=unused
temp_dir=synthetic-diagnostics
(exit ${initial})
cleanup
`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.ifError(result.error);
  const uncertain = [browser, server, build].includes(2);
  const expected = initial || (uncertain ? 1 : 0);
  assert.equal(result.status, expected);
  assert.equal(result.stdout.includes("REMOVED"), expected === 0);
  assert.equal(result.stderr.includes("retaining failed proof diagnostics"), expected !== 0);
}

async function verifyStopped(directory) {
  let inspected = 0;
  for (const file of ["build.pids", "server.pids", "browser.pids"]) {
    const records = (await readFile(join(directory, file), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(records.length > 0, true, `No ${file} ownership evidence`);
    for (const record of records) {
      const [pid, started] = record.split("\t");
      assert.match(pid, /^\d+$/);
      const current = spawnSync("ps", ["-p", pid, "-o", "lstart=,state="], { encoding: "utf8" });
      assert.ifError(current.error);
      const value = current.stdout.trim();
      const sameIdentity = value.startsWith(started);
      assert.equal(
        sameIdentity && !/\sZ\S*$/.test(value),
        false,
        `Owned process ${pid} remains live`,
      );
      inspected += 1;
    }
  }
  return inspected;
}

async function rehearsal(signal) {
  const child = spawn("sh", [runner], {
    env: {
      ...process.env,
      TEACHING_ACCEPTANCE_FAIL: signal === null ? "1" : "0",
      TEACHING_ACCEPTANCE_HOLD_MS: signal === null ? "0" : "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let sent = false;
  const timer = globalThis.setTimeout(() => child.kill("SIGTERM"), 60_000);
  child.stdout.on("data", (bytes) => {
    output += bytes.toString();
    if (signal !== null && !sent && output.includes("TEACHING_BROWSER_READY_FOR_SIGNAL")) {
      sent = true;
      assert.equal(child.kill(signal), true);
    }
  });
  child.stderr.on("data", (bytes) => {
    output += bytes.toString();
  });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, exitSignal) => resolve({ code, exitSignal }));
  }).finally(() => globalThis.clearTimeout(timer));
  assert.equal(result.exitSignal, null, output);
  assert.equal(result.code, signal === null ? 1 : signal === "SIGINT" ? 130 : 143, output);
  if (signal !== null) assert.equal(sent, true, output);
  else assert.equal(output.includes("Intentional acceptance failure"), true, output);
  const retained = /retaining failed proof diagnostics: (.+)/.exec(output)?.[1];
  assert.notEqual(retained, undefined, output);
  const count = await verifyStopped(retained);
  console.log(
    `TEACHING cleanup ${signal ?? "assertion failure"}: exit ${String(result.code)}, ${String(count)} recorded processes stopped; diagnostics ${retained}`,
  );
}

await rehearsal(null);
await rehearsal("SIGTERM");
await rehearsal("SIGINT");
