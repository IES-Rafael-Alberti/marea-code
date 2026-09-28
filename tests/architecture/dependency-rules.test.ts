import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/architecture");
const dependencyCruiser = resolve(
  repositoryRoot,
  "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
);
const configuration = resolve(repositoryRoot, ".dependency-cruiser.mjs");

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function isolatedFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-architecture-"));
  temporaryRoots.push(root);
  await cp(fixtureRoot, root, { recursive: true });
  const packages = [
    ["@langchain/core", "./language_models/base"],
    ["@langchain/langgraph-checkpoint", "."],
    ["@opentui/core", "."],
  ] as const;
  for (const [name, entry] of packages) {
    const directory = join(root, "node_modules", name);
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        exports: { [entry]: "./dist/index.js" },
      }),
    );
    await writeFile(join(directory, "dist/index.js"), "export {};\n");
  }
  for (const [path, source] of [
    [
      "packages/deepagents-adapter/src/allowed.js",
      'import "@langchain/core/language_models/base";\n',
    ],
    ["packages/student-tui/src/allowed.js", 'import "@opentui/core";\n'],
    ["packages/sqlite-storage/src/allowed.js", 'import "bun:sqlite";\n'],
    ["apps/student/dist/generated.js", 'import "../../teacher-server/index.js";\n'],
    [
      "apps/student/forbidden-isolated.js",
      'import "../../packages/deepagents-adapter/node_modules/.bun/fixture/node_modules/@langchain/core/dist/index.js";\n',
    ],
    [
      "packages/deepagents-adapter/node_modules/.bun/fixture/node_modules/@langchain/core/dist/index.js",
      "export {};\n",
    ],
  ] as const) {
    const destination = join(root, path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, source);
  }
  return root;
}

describe("architecture dependency rules", () => {
  it("rejects intentional application and upstream boundary violations", async () => {
    const root = await isolatedFixture();
    const child = spawn(
      process.execPath,
      [
        dependencyCruiser,
        "--config",
        configuration,
        "--include-only",
        "^(apps|packages|plugins|scripts|node_modules|bun:|@langchain/|@opentui/|deepagents(?:/|$)|langchain(?:/|$))",
        ".",
      ],
      { cwd: root },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    const report = `${stdout}\n${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(report).toContain("server-does-not-import-dashboard-browser");
    expect(report).toContain("pure-plugin-api-stays-pure");
    expect(report).toContain("student-does-not-import-other-apps");
    expect(report).toContain("apps/student/index.js");
    expect(report).toContain("apps/teacher-server/index.js");
    expect(report).toContain("agent-upstream-is-owned-by-its-adapter");
    expect(report).toContain("scripts/forbidden-deepagents.js");
    expect(report).toContain("@langchain/langgraph-checkpoint");
    expect(report).toContain("node_modules/@langchain/core/dist/index.js");
    expect(report).toContain("bun-sqlite-is-owned-by-storage-adapter");
    expect(report).toContain("opentui-is-owned-by-student-interface");
    expect(report).toContain("scripts/forbidden-native-boundaries.js");
    expect(report).toContain("bun:sqlite");
    expect(report).toContain("@opentui/core");
    expect(report).toContain("plugin-inference-alpha-is-isolated");
    expect(report).toContain("plugins/inference/alpha/index.js");
    expect(report).toContain("plugins/inference/beta/index.js");
    expect(report).toContain("apps/student/forbidden-isolated.js");
    expect(report).toContain(
      "packages/deepagents-adapter/node_modules/.bun/fixture/node_modules/@langchain/core/dist/index.js",
    );
    expect(report).not.toContain("allowed.js");
    expect(report).not.toContain("apps/student/dist/generated.js");
  });
});
