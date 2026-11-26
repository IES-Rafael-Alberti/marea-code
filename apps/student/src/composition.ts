import { loadRequiredSkills } from "./required-skill-context.js";
import { describeProject } from "./project-description.boundary.js";
import { diagnosticGateway } from "./diagnostic-gateway.js";
import { clientIdentity } from "./turn-diagnostic-report.js";
import { meterUsage } from "./session-usage.js";
import { FileOperationExecutor } from "./operation-executor.boundary.js";
import { GitProjectEvidence } from "./git-evidence.boundary.js";
import { ResilientProjectEvidence } from "./resilient-evidence.boundary.js";
import { join, resolve } from "node:path";

import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
  type AgentCheckpoint,
  type LocalCheckpointOptions,
} from "@marea/deepagents-adapter";
import type { Translator } from "@marea/i18n";
import { SoftwareVersionSchema, type RunToken } from "@marea/protocol";
import { openGuardedWorkspace } from "@marea/workspace-backend";

import type {
  AgentRuntime,
  ExternalAuthorization,
  GuardedWorkspaceWriter,
  StudentInterface,
  StudentServer,
} from "./contracts.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { auditStudentStatePermissions } from "./student-state-permissions.boundary.js";
import { createFileClassPreferenceStore } from "./class-preference.boundary.js";
import { createFileEffectLedger } from "./effect-ledger.boundary.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { createHttpModelGateway, createHttpStudentServer } from "./http-client.boundary.js";
import { LocalSession } from "./local-session.js";
import {
  createLocalStateRecovery,
  isDamagedCheckpointState,
  type LocalStateRecovery,
  type LocalStateRecoveryReport,
} from "./local-state-recovery.boundary.js";
import { createSystemClock, createSystemIdSource } from "./platform.boundary.js";
import { StudentSessionController, type StudentStartupStage } from "./session-controller.js";
import { createCrashSafeWorkspaceWriter } from "./workspace-writer.js";
import { RunSkillReader } from "./run-skill-reader.js";
import { createRuntimeReadTools } from "./runtime-read-tools.js";

export interface StudentCompositionOptions {
  readonly agent: AgentRuntime;
  readonly clientVersion: string;
  readonly projectRoot: string;
  readonly server: StudentServer;
  readonly stateDirectory: string;
  readonly studentInterface: StudentInterface;
  readonly workspace: GuardedWorkspaceWriter;
}

export interface ProductionStudentCompositionOptions {
  readonly clientVersion: string;
  readonly externalAuthorization?: ExternalAuthorization;
  /** Start-output sink for the one-time local-state recovery notice. */
  readonly notice?: (text: string) => void;
  readonly onStartupStage?: (stage: StudentStartupStage) => void;
  readonly projectRoot: string;
  readonly serverUrl: string;
  readonly stateDirectory: string;
  readonly studentInterface: StudentInterface;
  /** Interface language for the recovery notice; resolved from the environment when absent. */
  readonly translator?: Translator;
}

export interface ProductionStudentApplication {
  readonly controller: StudentSessionController;
  /** Damaged local state that startup set aside instead of failing. */
  readonly localStateRecovery: LocalStateRecoveryReport;
  dispose(): void;
}

export type AgentCheckpointCloser = (checkpoint: AgentCheckpoint) => void;

export class StudentRunTokenBinding {
  #controller: StudentSessionController | null = null;

  readonly read = (): Promise<RunToken> => {
    if (this.#controller === null) {
      throw new Error("The student session controller is not ready.");
    }
    return activeRunToken(this.#controller);
  };

  bind(controller: StudentSessionController): StudentSessionController {
    this.#controller = controller;
    return controller;
  }
}

export async function createStudentApplication(
  options: StudentCompositionOptions,
): Promise<StudentSessionController> {
  const clientVersion = SoftwareVersionSchema.parse(options.clientVersion);
  const stores = await createFileStudentStores(options);
  const clock = createSystemClock();
  const ids = createSystemIdSource();
  return new StudentSessionController({
    agent: options.agent,
    classPreference: createFileClassPreferenceStore(options.stateDirectory),
    clientVersion,
    clock,
    credentials: stores.credentials,
    ids,
    localSession: new LocalSession(stores.state, ids, clock),
    server: options.server,
    studentInterface: options.studentInterface,
    workspace: options.workspace,
  });
}

export async function createProductionStudentApplication(
  options: ProductionStudentCompositionOptions,
  closeCheckpoint: AgentCheckpointCloser = closeAgentCheckpoint,
): Promise<ProductionStudentApplication> {
  const clientVersion = SoftwareVersionSchema.parse(options.clientVersion);
  const projectRoot = resolve(options.projectRoot);
  const stateDirectory = resolve(options.stateDirectory);
  const stores = await createFileStudentStores({ projectRoot, stateDirectory });
  // Not awaited: a slow or failing permission check never delays or blocks the student.
  void auditStudentStatePermissions(stateDirectory, stores.failures);
  const localState = createLocalStateRecovery({
    notice: options.notice,
    probes: [
      { file: "session.json", load: () => stores.state.load(), reason: "session" },
      { file: "credential.json", load: () => stores.credentials.load(), reason: "credential" },
    ],
    stateDirectory,
    translator: options.translator,
  });
  await localState.prepare();
  const workspace = await openGuardedWorkspace({ rootPath: projectRoot });
  const clock = createSystemClock();
  const ids = createSystemIdSource();
  const httpOptions = { baseUrl: options.serverUrl };
  const server = createHttpStudentServer(httpOptions);
  const tokenBinding = new StudentRunTokenBinding();
  const localSession = new LocalSession(stores.state, ids, clock);
  const usage = meterUsage(
    createHttpModelGateway({ ...httpOptions, runToken: tokenBinding.read }),
    localSession.recordUsage.bind(localSession),
    options.studentInterface.showUsage?.bind(options.studentInterface),
  );
  const gateway = diagnosticGateway(usage.gateway, localSession, ids);
  const projectContext = await describeProject(projectRoot);
  const checkpoint = await openRecoverableCheckpoint(localState, {
    projectDirectory: projectRoot,
    storageDirectory: join(stateDirectory, "agent"),
  });
  // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
  const agent = createDeepAgentsStudentRuntime({
    loadSkills: (runId, snapshot, signal) =>
      loadRequiredSkills(
        snapshot,
        new RunSkillReader({
          runId,
          snapshot,
          server,
          nextRequestId: ids.request,
          runToken: tokenBinding.read,
        }),
        signal,
      ),
    operations: true,
    projectContext: (snapshot) =>
      snapshot.teacherToolPolicy.restrictions.some((rule) => rule.tool === "list_directory")
        ? ""
        : projectContext,
    checkpoint,
    // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
    model: createMareaGatewayModel({ gateway, nextRequestId: ids.request }),
    readOnlyTools: (runId, snapshot) =>
      createRuntimeReadTools({
        snapshot,
        workspace,
        skills: new RunSkillReader({
          runId,
          snapshot,
          server,
          nextRequestId: ids.request,
          runToken: tokenBinding.read,
        }),
      }),
  });
  // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
  const writer = createCrashSafeWorkspaceWriter({
    ledger: createFileEffectLedger(stateDirectory),
    workspace,
  });
  const controller = new StudentSessionController({
    liveProgress: true,
    // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
    diagnostics: {
      client: clientIdentity(clientVersion),
      log: stores.failures,
      lastModelResponse: gateway.lastResponse,
      onServerSupport: gateway.reportRepairs,
    },
    onStartupStage: options.onStartupStage,
    onServerCapabilities: usage.onServerCapabilities,
    agent,
    classPreference: createFileClassPreferenceStore(stateDirectory),
    clientVersion,
    externalAuthorization: options.externalAuthorization,
    clock,
    credentials: stores.credentials,
    ids,
    localSession,
    evidence: new ResilientProjectEvidence(
      new GitProjectEvidence({ root: projectRoot, directory: stateDirectory, localSession, ids }),
      localSession,
      ids,
    ),
    operations: new FileOperationExecutor({
      root: projectRoot,
      directory: stateDirectory,
      workspace,
      writer,
    }),
    server,
    studentInterface: options.studentInterface,
    // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
    workspace: writer,
  });
  let open = true;
  await localState.announce();
  return Object.freeze({
    controller: tokenBinding.bind(controller),
    localStateRecovery: localState.report(),
    dispose(): void {
      if (!open) return;
      open = false;
      closeCheckpoint(checkpoint);
    },
  });
}

/**
 * A damaged durable checkpoint must not block the student: the adapter's state
 * is set aside and a fresh checkpoint store is opened. Unreadable state stays an
 * error, because losing access is not the same as losing content.
 */
async function openRecoverableCheckpoint(
  localState: LocalStateRecovery,
  options: LocalCheckpointOptions,
): Promise<AgentCheckpoint> {
  try {
    return createLocalCheckpoint(options);
  } catch (error) {
    if (!isDamagedCheckpointState(error)) throw error;
    await localState.quarantineCheckpointState();
    return createLocalCheckpoint(options);
  }
}

export function activeRunToken(controller: StudentSessionController) {
  return controller.modelRunToken();
}
