import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalIdSchema,
  OpenRunRequestSchema,
  RequestIdSchema,
  type SessionToken,
} from "../../packages/protocol/src/index.js";

import {
  ACCEPTANCE_CLIENT_VERSION,
  ACCEPTANCE_SESSION,
  createAcceptanceHarness,
  type AcceptanceHarness,
  type RealStudentApplication,
} from "./harness.js";
import { createFileEffectLedger } from "../../apps/student/src/effect-ledger.boundary.js";
import { createFileStudentStores } from "../../apps/student/src/filesystem.boundary.js";
import type {
  AgentApprovalTurn,
  AgentEvent,
  AgentMessageTurn,
  AgentRuntime,
  ApprovalDecision,
  ApprovalPrompt,
  AuthenticationReason,
  StudentInterface,
  StudentState,
  StudentStateStore,
  StudentViewEvent,
} from "../../apps/student/src/contracts.js";
import { LocalSession } from "../../apps/student/src/local-session.js";
import { createSystemIdSource } from "../../apps/student/src/platform.boundary.js";
import { StudentSessionController } from "../../apps/student/src/session-controller.js";
import { openGuardedWorkspace } from "../../packages/workspace-backend/src/index.js";
import { createCrashSafeWorkspaceWriter } from "../../apps/student/src/workspace-writer.js";

export class AcceptanceInterface implements StudentInterface {
  public readonly authenticationReasons: AuthenticationReason[] = [];
  public readonly prompts: ApprovalPrompt[] = [];
  public readonly presented: StudentViewEvent[] = [];

  public constructor(
    private readonly account: keyof typeof ACCEPTANCE_SESSION = "ada",
    private readonly decision: ApprovalDecision = "approved",
  ) {}

  public authenticate(reason: AuthenticationReason) {
    this.authenticationReasons.push(reason);
    const credentials = ACCEPTANCE_SESSION[this.account];
    return Promise.resolve({
      displayName: credentials.displayName,
      invitationCode: credentials.invitationCode,
      kind: "enroll" as const,
      login: credentials.login,
      password: credentials.password,
    });
  }

  public confirmWrite(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    this.prompts.push(prompt);
    return Promise.resolve(this.decision);
  }

  public present(event: StudentViewEvent): void {
    this.presented.push(event);
  }

  public assistantText(): string {
    return this.presented
      .filter((event) => event.type === "assistant-text")
      .map((event) => event.text)
      .join("");
  }
}

export class BarrierAcceptanceInterface extends AcceptanceInterface {
  readonly #assistantText = Promise.withResolvers<string>();
  public readonly assistantTextPresented = this.#assistantText.promise;

  public override present(event: StudentViewEvent): void {
    super.present(event);
    if (event.type === "assistant-text") this.#assistantText.resolve(event.text);
  }
}

export class AcceptanceAgent implements AgentRuntime {
  public readonly messageTurns: AgentMessageTurn[] = [];
  public readonly approvalTurns: AgentApprovalTurn[] = [];
  public messageCalls = 0;
  public writeMessages = true;
  public failNext = false;

  public async *streamMessage(
    turn: AgentMessageTurn,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    await Promise.resolve(signal.aborted);
    this.messageCalls += 1;
    this.messageTurns.push(turn);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("synthetic recoverable error");
    }
    yield { text: "I will help. ", type: "assistant-text-delta" };
    if (this.writeMessages && /write|prepare|notes|tide/iu.test(turn.text)) {
      yield {
        approvalId: ApprovalIdSchema.parse("approval:acceptance"),
        content: "The tide is rising.\n",
        path: "notes/tide.txt",
        summary: "Create the tide notes",
        type: "write-approval-required",
      };
      return;
    }
    yield { type: "turn-completed" };
  }

  public async *resumeApproval(
    turn: AgentApprovalTurn,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    await Promise.resolve(signal.aborted);
    this.approvalTurns.push(turn);
    yield { text: "Done.", type: "assistant-text-delta" };
    yield { type: "turn-completed" };
  }
}

export class StreamingCancellationAgent extends AcceptanceAgent {
  public readonly textYielded = Promise.withResolvers<boolean>();

  public override async *streamMessage(
    turn: AgentMessageTurn,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.messageCalls += 1;
    this.messageTurns.push(turn);
    this.textYielded.resolve(true);
    if (!this.writeMessages) {
      yield { type: "turn-completed" };
      return;
    }
    yield { text: "Partial answer", type: "assistant-text-delta" };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      }
    });
    yield { type: "turn-cancelled" };
  }
}

export class BlockingApprovalInterface extends AcceptanceInterface {
  public readonly prompted = Promise.withResolvers<boolean>();

  public override confirmWrite(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    this.prompts.push(prompt);
    this.prompted.resolve(true);
    return Promise.withResolvers<ApprovalDecision>().promise;
  }
}

export interface TestProject {
  readonly projectRoot: string;
  readonly root: string;
  readonly stateDirectory: string;
}

export class AcceptanceResources {
  readonly #closers: (() => void)[] = [];
  readonly #harnesses: AcceptanceHarness[] = [];
  readonly #projects: string[] = [];

  public async close(): Promise<void> {
    for (const close of this.#closers.splice(0).reverse()) close();
    await Promise.all(
      this.#harnesses
        .splice(0)
        .reverse()
        .map((harness) => harness.close()),
    );
    await Promise.all(
      this.#projects
        .splice(0)
        .reverse()
        .map((path) => rm(path, { force: true, recursive: true })),
    );
  }

  public async harness(): Promise<AcceptanceHarness> {
    const value = await createAcceptanceHarness();
    this.#harnesses.push(value);
    return value;
  }

  public async project(prefix: string): Promise<TestProject> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    this.#projects.push(root);
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "student-state");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, ".keep"), "", "utf8");
    return { projectRoot, root, stateDirectory };
  }

  public registerReal(application: RealStudentApplication): RealStudentApplication {
    this.#closers.push(() => {
      application.dispose();
    });
    return application;
  }
}

export async function syntheticStudent(
  value: AcceptanceHarness,
  location: TestProject,
  agent: AgentRuntime,
  studentInterface: StudentInterface = new AcceptanceInterface(),
  stateStore?: StudentStateStore,
): Promise<StudentSessionController> {
  const workspace = await openGuardedWorkspace({ rootPath: location.projectRoot });
  const stores = await createFileStudentStores(location);
  return new StudentSessionController({
    agent,
    clientVersion: ACCEPTANCE_CLIENT_VERSION,
    clock: value.clock,
    credentials: stores.credentials,
    ids: createSystemIdSource(),
    localSession: new LocalSession(stateStore ?? stores.state, createSystemIdSource(), value.clock),
    server: value.studentServer,
    studentInterface,
    workspace: createCrashSafeWorkspaceWriter({
      ledger: createFileEffectLedger(location.stateDirectory),
      workspace,
    }),
  });
}

export async function enroll(value: AcceptanceHarness, account: keyof typeof ACCEPTANCE_SESSION) {
  const credentials = ACCEPTANCE_SESSION[account];
  return value.studentServer.enroll({
    credentials: { login: credentials.login, password: credentials.password },
    displayName: credentials.displayName,
    invitationCode: credentials.invitationCode,
    kind: "student-invitation-enrollment",
    protocolVersion: "0.1",
    requestId: RequestIdSchema.parse(`request:enroll:${account}`),
  });
}

export async function openRun(value: AcceptanceHarness, token: SessionToken, suffix: string) {
  return value.studentServer.openRun(
    token,
    OpenRunRequestSchema.parse({
      clientSessionId: `client:${suffix}`,
      clientVersion: ACCEPTANCE_CLIENT_VERSION,
      idempotencyKey: `open:${suffix}`,
      intent: { kind: "new" },
      project: { displayName: `project-${suffix}` },
      protocolVersion: "0.1",
      requestId: `request:open:${suffix}`,
    }),
  );
}

export type { StudentState, StudentStateStore };
