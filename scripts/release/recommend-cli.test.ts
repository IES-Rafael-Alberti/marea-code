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
import { previewChannelSchema, type PreviewChannel } from "./preview-channel.js";
let scratch: string;
let state: ReturnType<typeof initialState>;
const version = "0.1.0-preview.7";
function initialState() {
  return {
    release: { body: "", tag_name: `v${version}`, draft: false, prerelease: true },
    runs: [{ id: 2, head_sha: "a".repeat(40), conclusion: "success" }],
    jobs: [{ name: "publish", conclusion: "success" }] as {
      name: string;
      conclusion: string;
      steps?: { name: string; conclusion: string }[];
    }[],
    calls: [] as { command: string; args: string[]; input?: Record<string, unknown> }[],
    rejectSignature: false,
    rejectWrite: false,
    conflict: false,
    branch: true,
    blob: "original",
    channel: { format: 1, available: version, recommended: {} } as PreviewChannel | null,
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
function run(selected = "both", publish = false) {
  const statePath = join(scratch, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const arguments_ = [
    resolve(
      publish
        ? "scripts/release/publish-preview-channel.mjs"
        : "scripts/release/recommend-preview.mjs",
    ),
    "school/marea",
    version,
    ...(publish ? [] : [scratch, "/independent/cosign", selected]),
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
const writes = () => state.calls.filter((call) => call.args.includes("--input"));
// These integration cases launch several real CLI processes; allow scheduling under full-suite load.
const commandTestTimeout = 30_000;
it(
  "verifies before promoting, scopes recommendations, reads back and remains idempotent",
  () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(state.channel).toEqual({
      format: 1,
      available: version,
      recommended: { "0.1": { student: version, server: version } },
    });
    expect(state.calls[0]).toEqual({
      command: "python3",
      args: [
        "scripts/release/verify-published.py",
        "school/marea",
        version,
        scratch,
        "/independent/cosign",
      ],
    });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.input).toMatchObject({ branch: "marea-preview-channel", sha: "original" });
    state.calls = [];
    expect(run("student").status).toBe(0);
    expect(writes()).toHaveLength(0);
  },
  commandTestTimeout,
);
it(
  "refuses failed signatures, missing publication evidence or metadata without writes",
  () => {
    state.rejectSignature = true;
    expect(run().status).not.toBe(0);
    expect(state.calls).toHaveLength(1);
    state.rejectSignature = false;
    state.jobs = [];
    expect(run().stderr).toContain("No successful native publication");
    state.jobs = [{ name: "publish", conclusion: "success" }];
    writeFileSync(join(scratch, "student-linux-x64.manifest.json"), JSON.stringify({ files: [] }));
    expect(run().stderr).toContain("predates protocol-aware");
    expect(writes()).toHaveLength(0);
  },
  commandTestTimeout,
);
it(
  "rejects lost updates, failed readback and invalid component choices",
  () => {
    state.conflict = true;
    expect(run().stderr).toContain("GitHub channel request failed");
    expect(state.channel?.recommended).toEqual({});
    state.conflict = false;
    state.rejectWrite = true;
    expect(run().stderr).toContain("Preview channel readback failed");
    expect(run("unknown").stderr).toContain("Choose student, server or both");
  },
  commandTestTimeout,
);
it(
  "publishes availability on a metadata-only orphan branch without recommending it",
  () => {
    state.branch = false;
    state.channel = null;
    const result = run("both", true);
    expect(result.status, result.stderr).toBe(0);
    expect(state.channel).toEqual({ format: 1, available: version, recommended: {} });
    expect(writes().map((call) => call.args.at(-3))).toEqual([
      "repos/school/marea/git/trees",
      "repos/school/marea/git/commits",
      "repos/school/marea/git/refs",
    ]);
    expect(writes()[0]?.input).toEqual({
      tree: [
        {
          path: "preview.json",
          mode: "100644",
          type: "blob",
          content: JSON.stringify(state.channel, null, 2) + "\n",
        },
      ],
    });
    expect(writes()[1]?.input).toMatchObject({ parents: [], tree: "tree" });
    expect(writes()[2]?.input).toEqual({ ref: "refs/heads/marea-preview-channel", sha: "commit" });
  },
  commandTestTimeout,
);
it(
  "preserves recommendations during publication and never adopts an unrelated branch",
  () => {
    state.channel = previewChannelSchema.parse({
      format: 1,
      available: "0.1.0-preview.6",
      recommended: { "0.1": { student: "0.1.0-preview.6" } },
    });
    expect(run("both", true).status).toBe(0);
    expect(state.channel).toEqual({
      format: 1,
      available: version,
      recommended: { "0.1": { student: "0.1.0-preview.6" } },
    });
    state.channel = null;
    state.calls = [];
    expect(run("both", true).stderr).toContain("GitHub channel request failed");
    expect(writes()).toHaveLength(0);
  },
  commandTestTimeout,
);
it(
  "refuses drafts, stable releases and a mismatched tag before publishing availability",
  () => {
    for (const release of [
      { ...state.release, draft: true },
      { ...state.release, prerelease: false },
      { ...state.release, tag_name: "v0.1.0-preview.8" },
    ]) {
      state.release = release;
      expect(run("both", true).stderr).toContain("Only a published preview");
    }
    expect(writes()).toHaveLength(0);
  },
  commandTestTimeout,
);

it(
  "handles release API responses larger than one MiB",
  () => {
    state.release.body = "published asset metadata".repeat(60_000);
    expect(run("both", true).status).toBe(0);
    expect(state.channel?.available).toBe(version);
  },
  commandTestTimeout,
);
it(
  "repairs only metadata advertisement after successful native publication and public installs",
  () => {
    state.runs = [{ id: 2, head_sha: "a".repeat(40), conclusion: "failure" }];
    state.jobs.push({
      name: "available-channel",
      conclusion: "failure",
      steps: [
        {
          name: "Verify public student and server installs, retained data and clean reinstall",
          conclusion: "success",
        },
        {
          name: "Make the tested publication available without recommending it",
          conclusion: "failure",
        },
      ],
    });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(state.channel?.recommended).toEqual({ "0.1": { student: version, server: version } });
  },
  commandTestTimeout,
);
