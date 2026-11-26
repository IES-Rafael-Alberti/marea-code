import type { StudentRunSnapshot } from "@marea/protocol";
import type { ApprovalTool, AgentRuntimeOptions } from "@marea/deepagents-adapter";
import { operationArgumentsProblem } from "./operation-arguments.js";
import type { OperationName } from "./operation-contracts.js";
import {
  COMMAND_DEADLINE_MS,
  COMMAND_OUTPUT_HEAD_CHARACTERS,
  COMMAND_OUTPUT_TAIL_CHARACTERS,
} from "./command-limits.js";

/** A capability for one exact reviewed call; it never executes an effect itself. */
/** The interpreter this machine actually uses, so the model writes commands it can run. */
function shellNote(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? 'Shell: this computer runs Windows, so commands run in cmd.exe, not PowerShell or bash. Use cmd syntax (dir, type, cd /d, del, &&); quote paths with spaces in double quotes ("my file.txt"), never single quotes; one command per call is clearest.'
    : "Shell: this computer runs commands with /bin/sh. Quote paths with spaces.";
}

export class OperationMediator implements ApprovalTool {
  readonly lifecycle = "external";
  readonly name: string;
  readonly description: string;
  /** Every approved action of one turn; a batch may approve several of this operation. */
  private authorizations: { arguments: Readonly<Record<string, string>>; result: string }[] = [];
  constructor(
    readonly operation: OperationName,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.name = `marea_${operation}`;
    this.description =
      operation === "execute"
        ? `Run a shell command from the project directory after explicit student authorization. Arguments: command. Deadline ${String(COMMAND_DEADLINE_MS / 60_000)} minutes; the student can cancel earlier and the command is then stopped. Output is bounded: only the first ${String(COMMAND_OUTPUT_HEAD_CHARACTERS)} and the last ${String(COMMAND_OUTPUT_TAIL_CHARACTERS)} characters are kept, with the middle reported as omitted. Commands have the student's OS permissions. ${shellNote(platform)}`
        : operation === "delete"
          ? "Delete one project text file after explicit student authorization. Arguments: file_path. The exact contents are rechecked before deletion; directories are not accepted."
          : "Replace an exact unique text fragment in a project file after student authorization. Arguments: file_path, old_string, new_string. The file is rechecked before applying.";
  }
  validate(arguments_: Readonly<Record<string, string>>): string | null {
    return operationArgumentsProblem(this.operation, arguments_);
  }
  authorize(arguments_: Readonly<Record<string, string>>, result: string): void {
    this.authorizations.push({ arguments: arguments_, result });
  }
  clear(): void {
    this.authorizations = [];
  }
  /** Consumes the authorization with exactly these arguments; any other call clears them all. */
  execute(arguments_: Readonly<Record<string, string>>): Promise<string> {
    const index = this.authorizations.findIndex(
      (authorization) =>
        Object.keys(arguments_).length === Object.keys(authorization.arguments).length &&
        Object.entries(arguments_).every(([key, value]) => authorization.arguments[key] === value),
    );
    const authorization = this.authorizations[index];
    if (authorization === undefined) {
      this.clear();
      return Promise.reject(new Error("The operation does not match its authorization."));
    }
    this.authorizations.splice(index, 1);
    return Promise.resolve(authorization.result);
  }
}

export function deniesWrite(snapshot: StudentRunSnapshot): boolean {
  return (
    snapshot.teacherToolPolicy.restrictions.find((rule) => rule.tool === "write_file")?.effect ===
    "deny"
  );
}

/** A teaching aid for exercise writes, independent from OS effects and student authorization. */
export function socraticOptions(
  snapshot: StudentRunSnapshot,
  startup: boolean,
  primary: ApprovalTool,
  operations: readonly OperationMediator[],
): Pick<AgentRuntimeOptions, "socratic"> {
  if (startup || snapshot.agentMode !== "tutoring" || snapshot.socraticMode === undefined)
    return {};
  return {
    socratic: {
      mode: snapshot.socraticMode,
      tools: [
        primary.name,
        ...operations
          .filter((operation) => operation.operation === "edit_file")
          .map((operation) => operation.name),
      ],
    },
  };
}
