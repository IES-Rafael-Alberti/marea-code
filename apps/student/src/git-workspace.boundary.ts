import { appendGitConfigParameters } from "./git-config-parameters.js";
import { StudentWorkspaceError } from "./startup-failure.boundary.js";
import * as z from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import select from "@inquirer/select";
import { createTranslator, type Translator } from "@marea/i18n";

const execute = promisify(execFile);
const AUTOMATIC_CONTENT_COMMANDS = new Set<string | undefined>([
  "status",
  "add",
  "read-tree",
  "write-tree",
  "diff",
]);
const SAFE_GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const ExitSchema = z.object({ code: z.number() });

/** Read names only: config enumeration does not run configured filter commands. */
async function filterOverrides(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  let names: string;
  try {
    const result = await execute(
      "git",
      [
        ...SAFE_GIT_OPTIONS,
        "config",
        "--includes",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      { cwd: root, env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    names = result.stdout;
  } catch (error) {
    // Git's no-match status; every other error fails closed.
    if (ExitSchema.safeParse(error).data?.code === 1) return "";
    throw error;
  }
  const filters = new Set<string>();
  for (const name of names.split("\0")) {
    const match = /^filter\.(.*)\.(?:clean|smudge|process|required)$/su.exec(name);
    if (name === "") continue;
    if (match?.[1] === undefined) throw new Error("Invalid Git filter configuration.");
    filters.add(match[1]);
  }
  // Git's command-scope format quotes key and value separately. Unlike -c
  // key=value, this preserves '=' inside a valid filter subsection name.
  return appendGitConfigParameters(
    env.GIT_CONFIG_PARAMETERS,
    [...filters].flatMap((name) =>
      (["clean", "smudge", "process", "required"] as const).map(
        (kind) => [`filter.${name}.${kind}`, kind === "required" ? "false" : ""] as const,
      ),
    ),
  );
}

/** Automatic operations suppress external helpers and prohibit object downloads. */
export async function projectGit(
  root: string,
  args: readonly string[],
  index?: string,
): Promise<string> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
  };
  const overrides = AUTOMATIC_CONTENT_COMMANDS.has(args[0]) ? await filterOverrides(root, env) : "";
  const commandEnv =
    overrides === ""
      ? env
      : {
          ...env,
          GIT_CONFIG_PARAMETERS: overrides,
        };
  // Nested repositories have their own filter configuration. Keep gitlink changes,
  // but do not inspect their working trees or render recursive submodule diffs.
  const command = args[0];
  const safeArgs =
    command === "status" || command === "diff"
      ? [
          command,
          "--ignore-submodules=dirty",
          ...(command === "diff" ? ["--submodule=short"] : []),
          ...args.slice(1),
        ]
      : args;
  const { stdout } = await execute("git", [...SAFE_GIT_OPTIONS, ...safeArgs], {
    cwd: root,
    // Auxiliary Git processes must not attach a window while the TUI shuts down.
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: commandEnv,
  });
  return stdout;
}

export async function ensureGitWorkspace(
  root: string,
  translator: Translator = createTranslator("es"),
): Promise<void> {
  try {
    await projectGit(root, ["--version"]);
  } catch {
    throw new StudentWorkspaceError("student.git.missing", translator);
  }
  let repository: string | null = null;
  try {
    repository = (await projectGit(root, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    /* Offer initialization below. */
  }
  if (repository !== null) {
    if ((await realpath(repository)) !== (await realpath(root)))
      throw new StudentWorkspaceError("student.git.not-root", translator);
    return;
  }
  const accepted = await select({
    message: translator.t("student.git.confirm"),
    choices: [
      { name: translator.t("student.git.create"), value: true },
      { name: translator.t("student.git.cancel"), value: false },
    ],
  });
  if (!accepted) throw new StudentWorkspaceError("student.git.cancelled", translator);
  await projectGit(root, ["init"]);
  try {
    await writeFile(join(root, ".gitignore"), "node_modules/\n.venv/\n.env\n.env.*\n.DS_Store\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
}

const ErrnoSchema = z.object({ code: z.string() });
export function hasErrorCode(error: unknown, code: string): boolean {
  const parsed = ErrnoSchema.safeParse(error);
  return parsed.success && parsed.data.code === code;
}
