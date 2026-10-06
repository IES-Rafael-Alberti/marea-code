import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { recommendationCommandFixture } from "./recommend-cli.fixture.js";
let scratch: string;
let state: ReturnType<typeof initialState>;
const tag = "v0.1.0-preview.7";
function initialState() {
  const release = { id: 1, body: "Existing notes", tag_name: tag, draft: false, prerelease: true };
  return {
    release,
    releases: [release],
    runs: [{ id: 2, head_sha: "a".repeat(40), conclusion: "success" }],
    jobs: [{ name: "publish", conclusion: "success" }],
    calls: [] as { command: string; args: string[] }[],
    rejectSignature: false,
    rejectWrite: false,
  };
}
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-recommend-cli-")));
  state = initialState();
  mkdirSync(join(scratch, "bin"));
  for (const command of ["python3", "git", "gh"]) {
    const path = join(scratch, "bin", command);
    writeFileSync(path, recommendationCommandFixture);
    chmodSync(path, 0o700);
  }
  writeFileSync(
    join(scratch, "sha256-test"),
    JSON.stringify({ supportedProtocolVersions: ["0.1"] }),
  );
  for (const component of ["student", "server"])
    for (const platform of ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"])
      writeFileSync(
        join(scratch, `${component}-${platform}.manifest.json`),
        JSON.stringify({ files: [{ path: "compatibility.json", sha256: "test" }] }),
      );
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});
function run(selected = "both") {
  const statePath = join(scratch, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const arguments_ = [
    resolve("scripts/release/recommend-preview.mjs"),
    "school/marea",
    "0.1.0-preview.7",
    scratch,
    "/independent/cosign",
    selected,
  ];
  const result = spawnSync("bun", arguments_, {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${join(scratch, "bin")}${delimiter}${String(process.env.PATH)}`,
      MAREA_RECOMMEND_TEST_STATE: statePath,
    },
  });
  state = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
  return result;
}
it("verifies before writing, preserves notes, scopes recommendations and reads them back", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(state.release.body).toBe(
    "Existing notes\n\n<!-- marea-recommended:student:0.1 -->\n\n\n<!-- marea-recommended:server:0.1 -->\n",
  );
  expect(state.calls[0]).toEqual({
    command: "python3",
    args: [
      "scripts/release/verify-published.py",
      "school/marea",
      "0.1.0-preview.7",
      scratch,
      "/independent/cosign",
    ],
  });
  state.releases = [state.release];
  state.calls = [];
  expect(run("student").status).toBe(0);
  expect(state.calls.some((call) => call.args.includes("PATCH"))).toBe(false);
});
it("refuses a failed signature, missing publication evidence, or missing metadata without writes", () => {
  state.rejectSignature = true;
  expect(run().status).not.toBe(0);
  expect(state.calls).toHaveLength(1);
  state.rejectSignature = false;
  state.jobs = [];
  expect(run().stderr).toContain("No successful native publication");
  state.jobs = [{ name: "publish", conclusion: "success" }];
  writeFileSync(join(scratch, "student-linux-x64.manifest.json"), JSON.stringify({ files: [] }));
  expect(run().stderr).toContain("predates protocol-aware");
  expect(state.calls.some((call) => call.args.includes("PATCH"))).toBe(false);
});
it("rejects undiscoverable releases, failed readback and unsupported component choices", () => {
  state.releases = [];
  expect(run().stderr).toContain("outside the discovery window");
  state.releases = [state.release];
  state.rejectWrite = true;
  expect(run().stderr).toContain("Recommendation readback failed");
  expect(run("unknown").stderr).toContain("Choose student, server or both");
});
