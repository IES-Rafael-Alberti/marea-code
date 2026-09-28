import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { withBuildWorkspace, type SourceFile } from "./workspace.boundary.js";
import { ordinaryFiles } from "./files.boundary.js";
import { component, manifestSchema, releaseVersion, sha256, target } from "./manifest.js";

/** Native-only candidate builder. Never uploads or publishes a release. */
export function buildCandidate(argv: readonly string[]): string {
  const [rawVersion, rawComponent, output] = argv;
  const version = releaseVersion.parse(rawVersion);
  const selected = component.parse(rawComponent);
  const nativeTarget = target.parse(`${process.platform}-${process.arch}`);
  if (Bun.version !== "1.4.0") throw new Error("Build requires Bun 1.4.0");
  const declared = JSON.parse(readFileSync("apps/student/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  if (declared.dependencies["@opentui/react"] !== "0.5.10")
    throw new Error("OpenTUI version changed");
  const root = resolve(output ?? "reports/candidates", `${selected}-${version}-${nativeTarget}`);
  mkdirSync(root, { recursive: false });
  const run = (
    args: [string, ...string[]],
    cwd = process.cwd(),
    environment?: NodeJS.ProcessEnv,
  ): string => {
    const result = spawnSync(args[0], args.slice(1), {
      cwd,
      encoding: "utf8",
      env: environment,
    });
    if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  const snapshot = (): SourceFile[] =>
    run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
      .sort()
      .map((path) => ({ path, sha256: existsSync(path) ? sha256(readFileSync(path)) : null }));
  const sourceFiles = snapshot();
  const sourceSnapshot = JSON.stringify(sourceFiles);
  const built = withBuildWorkspace(process.cwd(), sourceFiles, (workspace) => {
    run(
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--backend", "copyfile"],
      workspace,
    );
    const suffix = process.platform === "win32" ? ".exe" : "";
    const entries =
      selected === "student"
        ? {
            marea: "apps/student/src/marea-entry.boundary.ts",
          }
        : {
            "marea-teacher": "apps/teacher-server/teacher-host-entry.ts",
            "marea-admin": "apps/teacher-server/cli-entry.ts",
            "marea-operations": "apps/teacher-server/operations-entry.ts",
          };
    for (const [name, entry] of Object.entries(entries)) {
      run(
        ["bun", "build", entry, "--compile", "--outfile", join(root, `${name}${suffix}`)],
        workspace,
      );
    }
    run(
      [
        "bun",
        "build",
        "scripts/release/install.mjs",
        "--compile",
        "--outfile",
        join(root, `marea-install${suffix}`),
      ],
      workspace,
    );
    if (selected === "server") {
      run(["bun", "run", "build"], join(workspace, "apps/dashboard"));
      cpSync(join(workspace, "apps/dashboard/dist"), join(root, "dashboard"), { recursive: true });
    }
    // Syft scans the resolved native dependency installation, including license expressions.
    // This deliberately includes build tools: inventory scope is an explicit superset.
    run(
      [
        "syft",
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
        `cyclonedx-json=${join(root, "sbom.cdx.json")}`,
      ],
      workspace,
    );
    const sbom = z
      .object({
        bomFormat: z.literal("CycloneDX"),
        components: z.array(z.object({ name: z.string().min(1) }).loose()).min(1),
      })
      .loose()
      .parse(JSON.parse(readFileSync(join(root, "sbom.cdx.json"), "utf8")));
    for (const name of ["@opentui/core", `@opentui/core-${nativeTarget}`]) {
      if (!sbom.components.some((entry) => entry.name === name && entry.version === "0.5.10")) {
        throw new Error(`Resolved native dependency missing from SBOM: ${name}`);
      }
    }
    cpSync(join(workspace, "scripts/release/licenses"), join(root, "licenses"), {
      recursive: true,
    });
    sbom.components.push({
      type: "application",
      name: "bun",
      version: "1.4.0",
      purl: "pkg:github/oven-sh/bun@bun-v1.4.0",
      externalReferences: [
        { type: "license", url: "https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md" },
      ],
      properties: [
        { name: "marea:runtime-license-inventory", value: "licenses/bun-1.4.0-LICENSE.md" },
      ],
    });
    writeFileSync(join(root, "sbom.cdx.json"), JSON.stringify(sbom, null, 2));
    writeFileSync(
      join(root, "licenses.json"),
      JSON.stringify(
        {
          scope:
            "installed build tree including tools and nested package manifests; not a runtime dependency graph",
          components: sbom.components,
        },
        null,
        2,
      ),
    );
    if (JSON.stringify(snapshot()) !== sourceSnapshot)
      throw new Error("Source changed while building candidate");
    writeFileSync(join(root, "source-snapshot.json"), sourceSnapshot);
    const commit = run(["git", "rev-parse", "HEAD"]).trim();
    const dirty = run(["git", "status", "--porcelain"]).trim().length > 0;
    const sourceDiffSha256 = sha256(Buffer.from(run(["git", "diff", "--binary", "HEAD"])));
    writeFileSync(
      join(root, "provenance.json"),
      JSON.stringify(
        {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              buildType: "marea/native-candidate/v1",
              externalParameters: {
                version,
                selected,
                nativeTarget,
                dirty,
                sourceDiffSha256,
                sourceSnapshotSha256: sha256(Buffer.from(sourceSnapshot)),
              },
              resolvedDependencies: [
                {
                  uri: process.env.GITHUB_REPOSITORY ?? "local-review",
                  digest: { gitCommit: commit, lockfileSha256: sha256(readFileSync("bun.lock")) },
                },
              ],
            },
            runDetails: {
              builder: { id: process.env.GITHUB_WORKFLOW_REF ?? "local-unattested" },
              metadata: { invocationId: process.env.GITHUB_RUN_ID ?? "local" },
            },
          },
          subject: Object.keys(entries).map((name) => ({
            name: `${name}${suffix}`,
            digest: { sha256: sha256(readFileSync(join(root, `${name}${suffix}`))) },
          })),
        },
        null,
        2,
      ),
    );
    const files = ordinaryFiles(root).map((path) => ({
      path,
      sha256: sha256(readFileSync(join(root, path))),
      executable: !path.includes("/") && path.startsWith("marea"),
    }));
    const manifest = manifestSchema.parse({
      format: 1,
      version,
      component: selected,
      target: nativeTarget,
      bun: "1.4.0",
      opentui: "0.5.10",
      commit,
      files,
    });
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
    return root;
  });
  if (selected === "student") {
    const executable = join(root, process.platform === "win32" ? "marea.exe" : "marea");
    withBuildWorkspace(process.cwd(), [], (smokeRoot) => {
      const environment = { ...process.env, MAREA_STATE_HOME: join(smokeRoot, "state") };
      run([executable, "--lang", "en", "--help"], smokeRoot, environment);
      run([executable, "--version"], smokeRoot, environment);
    });
  }
  return built;
}
