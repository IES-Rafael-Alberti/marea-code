import { spawnSync } from "node:child_process";

/**
 * Reads the project's git identity for the session banner.
 *
 * Both commands mirror the reference prompt probe (`rev-parse --abbrev-ref
 * HEAD`, `remote get-url origin`): a missing git binary, a directory that is
 * not a repository, or any failure yields no value, and the banner then omits
 * that row. Nothing here is logged or uploaded; the values only reach the
 * local banner.
 */

export type GitCommandRunner = (args: readonly string[], cwd: string) => string | null;

// The banner waits for both probes before the session starts, so a stuck Git must not stall it.
const GIT_TIMEOUT_MS = 2_000;

/** The first line of command output, without surrounding whitespace. */
export function firstOutputLine(output: string): string {
  const newline = output.indexOf("\n");
  const line = newline === -1 ? output : output.slice(0, newline);
  return line.trim();
}

export function createSystemGitRunner(): GitCommandRunner {
  return (args, cwd) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // No console window on Windows; only stdout is read.
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A spawn failure leaves status null, which is also not zero.
    if (result.status !== 0) return null;
    return firstOutputLine(result.stdout);
  };
}

export interface ProjectGitContext {
  readonly branch: string;
  readonly repositoryUrl: string;
}

export function readProjectGitContext(
  projectRoot: string,
  run: GitCommandRunner = createSystemGitRunner(),
): ProjectGitContext {
  return {
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot) ?? "",
    repositoryUrl: run(["remote", "get-url", "origin"], projectRoot) ?? "",
  };
}
