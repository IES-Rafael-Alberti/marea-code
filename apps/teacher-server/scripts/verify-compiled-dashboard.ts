import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const teacherServerRoot = resolve(import.meta.dir, "..");
const dashboardRoot = resolve(teacherServerRoot, "../dashboard");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "marea-dashboard-compiled-"));
const executable = resolve(temporaryDirectory, "marea-teacher-dashboard-smoke");

try {
  runCommand("bun", ["run", "build"], dashboardRoot);
  const firstBuildDigest = digestDirectory(resolve(dashboardRoot, "dist"));
  runCommand("bun", ["run", "build"], dashboardRoot);
  const secondBuildDigest = digestDirectory(resolve(dashboardRoot, "dist"));
  if (firstBuildDigest !== secondBuildDigest) {
    throw new Error("Repeated Vite builds produced different dashboard assets.");
  }

  runCommand(
    "bun",
    ["build", "./smoke/compiled-dashboard-server.ts", "--compile", "--outfile", executable],
    teacherServerRoot,
  );
  runCommand(executable, [resolve(dashboardRoot, "dist")], teacherServerRoot);
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  workingDirectory: string,
): void {
  const result = spawnSync(command, arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [`${command} ${arguments_.join(" ")} failed.`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function digestDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const filePath of collectFiles(root)) {
    hash.update(relative(root, filePath).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
