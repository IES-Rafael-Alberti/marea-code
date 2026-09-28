import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workspaces = [
  "apps/dashboard",
  "apps/student",
  "apps/teacher-server",
  "packages/deepagents-adapter",
  "packages/i18n",
  "packages/plugin-api",
  "packages/protocol",
  "packages/private-filesystem",
  "packages/sqlite-storage",
  "packages/student-tui",
  "packages/telemetry-pipeline",
  "packages/transport-server",
  "packages/workspace-backend",
  "plugins/inference/openrouter",
  "plugins/telemetry/langfuse",
  "plugins/telemetry/otlp",
];

function run(command, workingDirectory) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: workingDirectory,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["bun", "run", "mutation:root"], repositoryRoot);
for (const workspace of workspaces) {
  run(["bun", "run", "mutation"], resolve(repositoryRoot, workspace));
}
