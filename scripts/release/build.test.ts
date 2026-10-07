import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { buildMocks, expectStudentSmoke } from "./build.fixture.js";
import { buildCandidate } from "./build.js";
import { collectDependencyNotices } from "./notices.boundary.js";
const mocks = buildMocks();
it("builds selected server programs, matching assets, real inventory command and manifest", () => {
  const result = buildCandidate(["1.2.3", "server", "/candidate"]);
  expect(result).toBe("/candidate/server-1.2.3-darwin-arm64");
  expect(mocks.cpSync).toHaveBeenCalledWith("/isolated/LICENSE", `${result}/LICENSE`);
  expect(collectDependencyNotices).toHaveBeenCalledWith(
    "/isolated",
    `${result}/licenses/dependencies`,
  );
  expect(mocks.cpSync).toHaveBeenCalledWith(
    "/isolated/apps/dashboard/dist",
    `${result}/dashboard`,
    {
      recursive: true,
    },
  );
  expect(mocks.cpSync).toHaveBeenCalledWith("/isolated/content/skills", `${result}/skills`, {
    recursive: true,
  });
  for (const name of ["marea-teacher", "marea-admin", "marea-operations", "marea-install"])
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "bun",
      expect.arrayContaining(["--compile", `${result}/${name}`]),
      expect.any(Object),
    );
  expect(mocks.spawnSync).toHaveBeenCalledWith(
    "syft",
    expect.arrayContaining([
      "dir:.",
      "--exclude",
      "./reports/**",
      "-o",
      `cyclonedx-json=${result}/sbom.cdx.json`,
    ]),
    expect.any(Object),
  );
  const manifest = mocks.writeFileSync.mock.calls.find((call) =>
    String(call[0]).endsWith("manifest.json"),
  )?.[1] as string;
  expect(JSON.parse(manifest)).toMatchObject({
    version: "1.2.3",
    component: "server",
    target: "darwin-arm64",
    bun: "1.4.2",
    opentui: "0.5.10",
  });
});
it("handles native Windows student, defaults, CI provenance and license metadata", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
  vi.stubEnv("GITHUB_WORKFLOW_REF", "workflow");
  vi.stubEnv("GITHUB_RUN_ID", "run");
  const originalRead = mocks.readFileSync.getMockImplementation() as (
    path: string,
  ) => string | Buffer;
  mocks.readFileSync.mockImplementation((path: string) =>
    path.endsWith("sbom.cdx.json")
      ? '{"bomFormat":"CycloneDX","components":[{"name":"@opentui/core","version":"0.5.10"},{"name":"@opentui/core-win32-x64","version":"0.5.10"}]}'
      : originalRead(path),
  );
  const root = buildCandidate(["1.2.3", "student"]);
  expect(root).toContain("student-1.2.3-win32-x64");
  expect(mocks.spawnSync).toHaveBeenCalledWith(
    "powershell.exe",
    expect.arrayContaining([expect.stringContaining(`${root}/marea.exe`)]),
    expect.any(Object),
  );
  expect(mocks.cpSync).toHaveBeenCalledWith(
    "/isolated/scripts/release/licenses",
    `${root}/licenses`,
    { recursive: true },
  );
  expectStudentSmoke(`${root}/marea.exe`);
  expect(mocks.writeFileSync).toHaveBeenCalledWith(
    `${root}/licenses.json`,
    expect.stringContaining("@opentui/core-win32-x64"),
  );
});
it("does not package a teacher dashboard into student distributions", () => {
  buildCandidate(["1.2.3", "student", "/candidate"]);
  expect(mocks.cpSync).not.toHaveBeenCalledWith(
    "/isolated/apps/dashboard/dist",
    expect.anything(),
    expect.anything(),
  );
});

it("rejects changed runtime, OpenTUI, invalid selection and failed native build", () => {
  vi.stubGlobal("Bun", { version: "other" });
  expect(() => buildCandidate(["1.2.3", "student"])).toThrow("Bun");
  vi.stubGlobal("Bun", { version: "1.4.2" });
  mocks.readFileSync.mockReturnValue('{"dependencies":{}}');
  expect(() => buildCandidate(["1.2.3", "student"])).toThrow("OpenTUI");
  expect(() => buildCandidate(["../bad", "student"])).toThrow();
  mocks.readFileSync.mockReturnValue('{"dependencies":{"@opentui/react":"0.5.10"}}');
  mocks.spawnSync.mockReturnValue({ status: 1, stderr: "native dependency failed" });
  expect(() => buildCandidate(["1.2.3", "student"])).toThrow(
    "git ls-files --cached --others --exclude-standard -z failed: native dependency failed",
  );
});

it("refuses malformed inventories and source changes during compilation", () => {
  const originalRead = mocks.readFileSync.getMockImplementation() as (
    path: string,
  ) => string | Buffer;
  for (const sbom of [
    {},
    { bomFormat: "other", components: [] },
    { bomFormat: "CycloneDX", components: [] },
  ]) {
    mocks.readFileSync.mockImplementation((path: string) =>
      path.endsWith("sbom.cdx.json") ? JSON.stringify(sbom) : originalRead(path),
    );
    expect(() => buildCandidate(["1.2.3", "student"])).toThrow();
  }
  mocks.readFileSync.mockImplementation(originalRead);
  let snapshots = 0;
  mocks.spawnSync.mockImplementation((_command: string, args: string[]) => ({
    status: 0,
    stdout: args[0] === "ls-files" ? `file-${String(snapshots++)}\0` : "",
    stderr: "",
  }));
  expect(() => buildCandidate(["1.2.3", "student"])).toThrow("Source changed");
});
const binaryHash = "9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd";
const sourceRecords = [
  { path: "deleted", sha256: null },
  { path: "new", sha256: binaryHash },
  { path: "tracked", sha256: binaryHash },
];
function written(path: string): string {
  const call = mocks.writeFileSync.mock.calls.find((entry) => entry[0] === path);
  assert.ok(call, `Missing artifact ${path}`);
  return call[1] as string;
}
it("binds reproducible output metadata to actual commands, source bytes and native programs", () => {
  for (const env of ["GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF", "GITHUB_RUN_ID"])
    vi.stubEnv(env, undefined);
  const root = buildCandidate(["1.2.3", "server", "/candidate"]);
  const cwd = process.cwd();
  const options = { cwd, encoding: "utf8" };
  const snapshotCommand = [
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    options,
  ];
  const buildOptions = { cwd: "/isolated", encoding: "utf8" };
  expect(mocks.withBuildWorkspace).toHaveBeenCalledWith(cwd, sourceRecords, expect.any(Function));
  expect(mocks.spawnSync.mock.calls).toEqual([
    snapshotCommand,
    [
      "bun",
      ["install", "--frozen-lockfile", "--ignore-scripts", "--backend", "copyfile"],
      buildOptions,
    ],
    [
      "bun",
      [
        "build",
        "apps/teacher-server/teacher-host-entry.ts",
        "--compile",
        "--outfile",
        `${root}/marea-teacher`,
      ],
      buildOptions,
    ],
    [
      "bun",
      [
        "build",
        "apps/teacher-server/cli-entry.ts",
        "--compile",
        "--outfile",
        `${root}/marea-admin`,
      ],
      buildOptions,
    ],
    [
      "bun",
      [
        "build",
        "apps/teacher-server/operations-entry.ts",
        "--compile",
        "--outfile",
        `${root}/marea-operations`,
      ],
      buildOptions,
    ],
    [
      "bun",
      ["build", "scripts/release/install.mjs", "--compile", "--outfile", `${root}/marea-install`],
      buildOptions,
    ],
    [
      "bun",
      ["run", "build"],
      {
        cwd: "/isolated/apps/dashboard",
        encoding: "utf8",
        env: {
          ...process.env,
          VITE_MAREA_PREVIEW_REPOSITORY: "",
          VITE_MAREA_PREVIEW_VERSION: "1.2.3",
        },
      },
    ],
    [
      "syft",
      [
        "dir:.",
        "--override-default-catalogers",
        "javascript-package-cataloger",
        "--exclude",
        "**/.old_modules-*/**",
        "--exclude",
        "./references/**",
        "--exclude",
        "./reports/**",
        "--exclude",
        "**/.stryker-tmp/**",
        "--exclude",
        "**/coverage/**",
        "--exclude",
        "./.git/**",
        "-o",
        `cyclonedx-json=${root}/sbom.cdx.json`,
      ],
      buildOptions,
    ],
    snapshotCommand,
    ["git", ["rev-parse", "HEAD"], options],
    ["git", ["status", "--porcelain"], options],
    ["git", ["diff", "--binary", "HEAD"], options],
  ]);
  expect(mocks.mkdirSync).toHaveBeenCalledExactlyOnceWith(root, { recursive: false });
  expect(written(`${root}/source-snapshot.json`)).toBe(JSON.stringify(sourceRecords));
  const runtime = {
    type: "application",
    name: "bun",
    version: "1.4.2",
    purl: "pkg:github/oven-sh/bun@bun-v1.4.2",
    externalReferences: [
      { type: "license", url: "https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md" },
    ],
    properties: [
      { name: "marea:runtime-license-inventory", value: "licenses/bun-1.4.2-LICENSE.md" },
    ],
  };
  const components = [
    { name: "@opentui/core", version: "0.5.10", licenses: [{ license: { id: "MIT" } }] },
    { name: "@opentui/core-darwin-arm64", version: "0.5.10" },
    runtime,
  ];
  expect(written(`${root}/licenses.json`)).toBe(
    JSON.stringify(
      {
        scope:
          "installed build tree including tools and nested package manifests; not a runtime dependency graph",
        components,
      },
      null,
      2,
    ),
  );
  expect(written(`${root}/sbom.cdx.json`)).toBe(
    JSON.stringify({ bomFormat: "CycloneDX", components }, null, 2),
  );
  expect(mocks.cpSync).toHaveBeenCalledWith(
    "/isolated/scripts/release/licenses",
    `${root}/licenses`,
    {
      recursive: true,
    },
  );
  expect(written(`${root}/manifest.json`)).toBe(
    JSON.stringify(
      {
        format: 1,
        version: "1.2.3",
        component: "server",
        target: "darwin-arm64",
        bun: "1.4.2",
        opentui: "0.5.10",
        commit: "a".repeat(40),
        files: [
          { path: "marea", sha256: binaryHash, executable: true },
          { path: "dashboard/index.html", sha256: binaryHash, executable: false },
        ],
      },
      null,
      2,
    ),
  );
  const provenance = JSON.parse(written(`${root}/provenance.json`)) as Record<string, unknown>;
  expect(provenance).toEqual({
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "marea/native-candidate/v1",
        externalParameters: {
          version: "1.2.3",
          selected: "server",
          nativeTarget: "darwin-arm64",
          dirty: false,
          sourceDiffSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          sourceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
        },
        resolvedDependencies: [
          {
            uri: "local-review",
            digest: { gitCommit: "a".repeat(40), lockfileSha256: binaryHash },
          },
        ],
      },
      runDetails: { builder: { id: "local-unattested" }, metadata: { invocationId: "local" } },
    },
    subject: ["marea-teacher", "marea-admin", "marea-operations"].map((name) => ({
      name,
      digest: { sha256: binaryHash },
    })),
  });
  expect(written(`${root}/provenance.json`)).toBe(JSON.stringify(provenance, null, 2));
  expect(mocks.readFileSync).toHaveBeenCalledWith("bun.lock");
  expect(mocks.writeFileSync).toHaveBeenCalledTimes(6);
  expect(mocks.writeFileSync).toHaveBeenCalledWith(
    `${root}/compatibility.json`,
    JSON.stringify({ supportedProtocolVersions: ["0.1"] }),
  );
  for (const name of ["marea-teacher", "marea-admin", "marea-operations"])
    expect(mocks.readFileSync).toHaveBeenCalledWith(`${root}/${name}`);
  expect(mocks.readFileSync).toHaveBeenCalledWith(`${root}/sbom.cdx.json`, "utf8");
});
it("records dirty and clean source distinctly, normalizes git whitespace and retains exact CI identity", () => {
  vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
  vi.stubEnv("GITHUB_WORKFLOW_REF", "workflow");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  mocks.ordinaryFiles.mockReturnValue(["marea.exe", "data.json", "marea/nested.json"]);
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  for (const [status, dirty] of [
    [" \n", false],
    [" M source\n", true],
  ] as const) {
    mocks.writeFileSync.mockClear();
    mocks.spawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "rev-parse"
          ? ` ${"a".repeat(40)}\n`
          : args[0] === "status"
            ? status
            : args[0] === "ls-files"
              ? "tracked\0deleted\0new\0"
              : "",
      stderr: "",
    }));
    const root = buildCandidate(["1.2.3", "student"]);
    expect(root).toBe(`${process.cwd()}/reports/candidates/student-1.2.3-win32-x64`);
    expect(JSON.parse(written(`${root}/provenance.json`))).toMatchObject({
      predicate: {
        buildDefinition: {
          externalParameters: { dirty },
          resolvedDependencies: [{ uri: "owner/repo" }],
        },
        runDetails: { builder: { id: "workflow" }, metadata: { invocationId: "123" } },
      },
      subject: [{ name: "marea.exe", digest: { sha256: binaryHash } }],
    });
    expect(JSON.parse(written(`${root}/manifest.json`))).toMatchObject({
      files: [
        { path: "marea.exe", executable: true },
        { path: "data.json", executable: false },
        { path: "marea/nested.json", executable: false },
      ],
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& 'bun' 'build' 'apps/student/src/marea-entry.boundary.ts' '--compile' '--outfile' '${root}/marea.exe'; exit $LASTEXITCODE`,
      ],
      { cwd: "/isolated", encoding: "utf8" },
    );
  }
});

it("rejects an SBOM that omits the actually selected OpenTUI native library or reports wrong versions", () => {
  const read = mocks.readFileSync.getMockImplementation() as (path: string) => string | Buffer;
  for (const components of [
    [{ name: "unrelated", version: "0.5.10" }],
    [{ name: "@opentui/core", version: "0.5.10" }],
    [
      { name: "@opentui/core", version: "0.5.9" },
      { name: "@opentui/core-darwin-arm64", version: "0.5.10" },
    ],
    [
      { name: "@opentui/core", version: "0.5.10" },
      { name: "@opentui/core-darwin-arm64", version: "0.5.9" },
    ],
  ]) {
    mocks.readFileSync.mockImplementation((path: string) =>
      path.endsWith("sbom.cdx.json")
        ? JSON.stringify({ bomFormat: "CycloneDX", components })
        : read(path),
    );
    expect(() => buildCandidate(["1.2.3", "student"])).toThrow(
      "Resolved native dependency missing from SBOM:",
    );
  }
});

it("rejects incomplete CycloneDX shape even when native dependencies are present", () => {
  const read = mocks.readFileSync.getMockImplementation() as (path: string) => string | Buffer;
  const valid = [
    { name: "@opentui/core", version: "0.5.10" },
    { name: "@opentui/core-darwin-arm64", version: "0.5.10" },
  ];
  for (const sbom of [
    { components: valid },
    { bomFormat: "CycloneDX", components: [...valid, {}] },
  ]) {
    mocks.readFileSync.mockImplementation((path: string) =>
      path.endsWith("sbom.cdx.json") ? JSON.stringify(sbom) : read(path),
    );
    expect(() => buildCandidate(["1.2.3", "student"])).toThrow();
  }
});

it("runs the compiled client after its build workspace has been disposed and rejects startup regressions", () => {
  let disposed = false;
  mocks.withBuildWorkspace.mockImplementation(
    (_source: string, _files: unknown, operation: (workspace: string) => string) => {
      const result = operation("/isolated");
      disposed = true;
      return result;
    },
  );
  const spawn = mocks.spawnSync.getMockImplementation() as (
    command: string,
    args: string[],
  ) => { status: number; stdout: string; stderr: string };
  mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith("/marea")) {
      expect(disposed).toBe(true);
      return { status: 1, stdout: "", stderr: "compiled initialization failed" };
    }
    return spawn(command, args);
  });
  expect(() => buildCandidate(["1.2.3", "student", "/candidate"])).toThrow(
    "compiled initialization failed",
  );
  mocks.spawnSync.mockImplementation(spawn);
  const root = buildCandidate(["1.2.3", "student", "/candidate"]);
  expectStudentSmoke(`${root}/marea`);
});
