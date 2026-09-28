import { randomUUID } from "node:crypto";
import {
  MAX_GOVERNANCE_RESPONSE_BYTES,
  RequestIdSchema,
  UtcTimestampSchema,
} from "@marea/protocol";
import type { InstallationCapability } from "../../governance/authority.js";
import type { GovernanceOperatorApplication } from "../../governance/operator-contracts.js";
import { boundedJson, prepareArtifact, publishArtifact } from "./artifact.js";
import { COMMANDS, type CommandSpec, type Summary, type ValueFlag } from "./commands.js";
import {
  diagnosticFor,
  exitCodeFor,
  OperatorCliError,
  OperatorCliInterrupted,
  type ExitCode,
} from "./errors.js";
import { readJsonObject, readPassword, type PasswordStream } from "./input.js";
import type { OwnedInstallation } from "./installation-lock.js";

export interface ComposedInstallation<A = GovernanceOperatorApplication> {
  readonly application: A;
  /** Installation paths an artifact destination may not enter. */
  readonly reserved: readonly string[];
  readonly close: () => void;
}
interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface OperatorCliDependencies<A = GovernanceOperatorApplication> {
  readonly acquire: (root: string) => OwnedInstallation | Promise<OwnedInstallation>;
  readonly compose: (capability: InstallationCapability) => ComposedInstallation<A>;
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void | Promise<void>;
  readonly prompt: (text: string) => void;
  readonly stdin: PasswordStream;
  readonly signals: SignalSource;
  readonly now: () => string;
}
interface ParsedCommand<A> {
  readonly root: string;
  readonly spec: CommandSpec<A>;
  readonly flags: Readonly<Partial<Record<ValueFlag, string>>>;
  readonly passwordStdin: boolean;
}

/** `--installation <root> <group> <action>` followed only by that command's flags, once each. */
export function parseArguments<A = GovernanceOperatorApplication>(
  argv: readonly string[],
  commands: Readonly<Record<string, CommandSpec<A>>> = COMMANDS as Readonly<
    Record<string, CommandSpec<A>>
  >,
): ParsedCommand<A> {
  const [option, root, group, action, ...rest] = argv;
  const name = `${String(group)} ${String(action)}`;
  const spec = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (option !== "--installation" || !root || spec === undefined)
    throw new OperatorCliError("invalid-input");
  const flags: Partial<Record<ValueFlag, string>> = {};
  let passwordStdin = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    const flag = token.slice(2) as ValueFlag;
    const value = rest[index + 1];
    if (spec.passwordStdin && token === "--password-stdin" && !passwordStdin) {
      passwordStdin = true;
    } else if (
      token.startsWith("--") &&
      spec.flags.includes(flag) &&
      !Object.hasOwn(flags, flag) &&
      value !== undefined &&
      value.length > 0 &&
      !value.startsWith("--")
    ) {
      flags[flag] = value;
      index += 1;
    } else throw new OperatorCliError("invalid-input");
  }
  if (spec.flags.some((flag) => !Object.hasOwn(flags, flag)))
    throw new OperatorCliError("invalid-input");
  return { root, spec, flags, passwordStdin };
}

async function execute<A>(
  command: ParsedCommand<A>,
  capability: InstallationCapability,
  composed: ComposedInstallation<A>,
  dependencies: OperatorCliDependencies<A>,
  signal: AbortSignal,
): Promise<Summary> {
  signal.throwIfAborted();
  const { spec, flags } = command;
  const payload = flags.input === undefined ? {} : readJsonObject(flags.input, spec.inputBytes);
  if (Object.keys(payload).some((key) => !spec.keys.includes(key)))
    throw new OperatorCliError("invalid-input");
  const output =
    flags.output === undefined
      ? undefined
      : prepareArtifact(capability.installationRoot, composed.reserved, flags.output);
  const outcome = await spec.run(composed.application, {
    context: {
      authority: {
        ...capability,
        assertOwned: () => {
          capability.assertOwned();
          output?.assertParent();
        },
      },
      now: UtcTimestampSchema.parse(dependencies.now()),
      requestId: RequestIdSchema.parse(`request:cli-${randomUUID()}`),
    },
    payload,
    flags,
    password: () =>
      readPassword(dependencies.stdin, command.passwordStdin, dependencies.prompt, signal),
  });
  capability.assertOwned();
  if (outcome.artifact !== undefined) {
    publishArtifact(output, boundedJson(outcome.artifact.value, outcome.artifact.maxBytes));
  }
  return outcome.summary;
}

async function diagnose<A>(
  dependencies: OperatorCliDependencies<A>,
  code: Exclude<ExitCode, 0>,
): Promise<ExitCode> {
  try {
    await dependencies.stderr(diagnosticFor(code));
    return code;
  } catch {
    return 6;
  }
}

/**
 * Parse before side effects, then hold the exclusive installation through composition, the
 * bounded operation, resource close and ownership verification before reporting output. Signals cancel pending
 * prompts; an operation already started is awaited before cleanup reports 130/143.
 */
export async function runOperatorCli<A = GovernanceOperatorApplication>(
  argv: readonly string[],
  dependencies: OperatorCliDependencies<A>,
  commands?: Readonly<Record<string, CommandSpec<A>>>,
): Promise<ExitCode> {
  let command: ParsedCommand<A>;
  try {
    command = parseArguments(argv, commands);
  } catch {
    return diagnose(dependencies, 2);
  }
  const controller = new AbortController();
  const onInterrupt = () => {
    controller.abort(new OperatorCliInterrupted(130));
  };
  const onTerminate = () => {
    controller.abort(new OperatorCliInterrupted(143));
  };
  dependencies.signals.on("SIGINT", onInterrupt);
  dependencies.signals.on("SIGTERM", onTerminate);
  try {
    // A synchronous owner starts work in this turn; only lock recovery waits for an answer.
    const acquired = dependencies.acquire(command.root);
    const owned = acquired instanceof Promise ? await acquired : acquired;
    return await runOwned(command, owned, dependencies, controller.signal);
  } catch (error) {
    return await diagnose(dependencies, exitCodeFor(error));
  } finally {
    dependencies.signals.removeListener("SIGINT", onInterrupt);
    dependencies.signals.removeListener("SIGTERM", onTerminate);
  }
}

/** An acquired installation is mandatory throughout work, cleanup and final output. */
async function runOwned<A>(
  command: ParsedCommand<A>,
  owned: OwnedInstallation,
  dependencies: OperatorCliDependencies<A>,
  signal: AbortSignal,
): Promise<ExitCode> {
  let code: ExitCode = 0;
  let composed: ComposedInstallation<A> | undefined;
  let result: Summary = {};
  try {
    const installation = owned.capability;
    const capability: InstallationCapability = {
      ...installation,
      assertOwned: () => {
        signal.throwIfAborted();
        installation.assertOwned();
      },
    };
    capability.assertOwned();
    composed = dependencies.compose(capability);
    result = await execute(command, capability, composed, dependencies, signal);
  } catch (error) {
    code = exitCodeFor(error);
  }
  let closed = false;
  let outcome:
    { readonly code: 0; readonly output: string } | { readonly code: Exclude<ExitCode, 0> };
  try {
    composed?.close();
    closed = true;
    if (code === 0) {
      signal.throwIfAborted();
      owned.capability.assertOwned();
      const line = boundedJson(result, MAX_GOVERNANCE_RESPONSE_BYTES - 1);
      outcome = { code: 0, output: `${line.toString("utf8")}\n` };
    } else outcome = { code };
  } catch (error) {
    outcome = { code: closed ? exitCodeFor(error) : 6 };
  }
  try {
    // An uncertain resource close must retain exclusion, never authorize another owner.
    if (closed && !owned.release()) return await diagnose(dependencies, 6);
    if (outcome.code === 0) {
      await dependencies.stdout(outcome.output);
      return 0;
    }
  } catch {
    return diagnose(dependencies, 6);
  }
  return diagnose(dependencies, outcome.code);
}
