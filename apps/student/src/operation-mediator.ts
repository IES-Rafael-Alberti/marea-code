import type { StudentRunSnapshot } from "@marea/protocol";
import type { ApprovalTool } from "@marea/deepagents-adapter";
import type { OperationName } from "./operation-contracts.js";

/** A capability for one exact reviewed call; it never executes an effect itself. */
export class OperationMediator implements ApprovalTool {
  readonly lifecycle = "external";
  readonly name: string;
  readonly description: string;
  private authorization: { arguments: Readonly<Record<string, string>>; result: string } | null =
    null;
  constructor(readonly operation: OperationName) {
    this.name = `marea_${operation}`;
    this.description =
      operation === "execute"
        ? "Run a shell command from the project directory after explicit student authorization. Arguments: command. Deadline 30 seconds. Output is bounded. Commands have the student's OS permissions."
        : operation === "delete"
          ? "Delete one project text file after explicit student authorization. Arguments: path. The exact contents are rechecked before deletion; directories are not accepted."
          : "Replace an exact unique text fragment in a project file after student authorization. Arguments: path, old_string, new_string. The file is rechecked before applying.";
  }
  authorize(arguments_: Readonly<Record<string, string>>, result: string): void {
    this.authorization = { arguments: arguments_, result };
  }
  clear(): void {
    this.authorization = null;
  }
  execute(arguments_: Readonly<Record<string, string>>): Promise<string> {
    const authorization = this.authorization;
    this.clear();
    if (
      authorization === null ||
      Object.keys(arguments_).length !== Object.keys(authorization.arguments).length ||
      Object.entries(arguments_).some(([key, value]) => authorization.arguments[key] !== value)
    )
      return Promise.reject(new Error("The operation does not match its authorization."));
    return Promise.resolve(authorization.result);
  }
}

export function deniesWrite(snapshot: StudentRunSnapshot): boolean {
  return (
    snapshot.teacherToolPolicy.restrictions.find((rule) => rule.tool === "write_file")?.effect ===
    "deny"
  );
}
