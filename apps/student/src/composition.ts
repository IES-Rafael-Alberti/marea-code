import { describeProject } from "./project-description.boundary.js";
import { diagnosticGateway } from "./diagnostic-gateway.js";
import { FileOperationExecutor } from "./operation-executor.boundary.js";
import { GitProjectEvidence } from "./git-evidence.boundary.js";
import { join, resolve } from "node:path";

import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
  type AgentCheckpoint,
} from "@marea/deepagents-adapter";
import { SoftwareVersionSchema, type RunToken } from "@marea/protocol";
import { openGuardedWorkspace } from "@marea/workspace-backend";

import type {
  AgentRuntime,
  GuardedWorkspaceWriter,
  StudentInterface,
  StudentServer,
} from "./contracts.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { createFileEffectLedger } from "./effect-ledger.boundary.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { createHttpModelGateway, createHttpStudentServer } from "./http-client.boundary.js";
import { LocalSession } from "./local-session.js";
import { createSystemClock, createSystemIdSource } from "./platform.boundary.js";
import { StudentSessionController } from "./session-controller.js";
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
  readonly projectRoot: string;
  readonly serverUrl: string;
  readonly stateDirectory: string;
  readonly studentInterface: StudentInterface;
}

export interface ProductionStudentApplication {
  readonly controller: StudentSessionController;
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
  const workspace = await openGuardedWorkspace({ rootPath: projectRoot });
  const clock = createSystemClock();
  const ids = createSystemIdSource();
  const httpOptions = { baseUrl: options.serverUrl };
  const server = createHttpStudentServer(httpOptions);
  const tokenBinding = new StudentRunTokenBinding();
  const localSession = new LocalSession(stores.state, ids, clock);
  const gateway = diagnosticGateway(
    createHttpModelGateway({
      ...httpOptions,
      runToken: tokenBinding.read,
    }),
    localSession,
    ids,
  );
  const projectContext = await describeProject(projectRoot);
  const checkpoint = createLocalCheckpoint({
    projectDirectory: projectRoot,
    storageDirectory: join(stateDirectory, "agent"),
  });
  // Stryker disable next-line ObjectLiteral: deleting required constructor fields is a type error.
  const agent = createDeepAgentsStudentRuntime({
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
    agent,
    clientVersion,
    clock,
    credentials: stores.credentials,
    ids,
    localSession,
    evidence: new GitProjectEvidence({
      root: projectRoot,
      directory: stateDirectory,
      localSession,
      ids,
    }),
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
  return Object.freeze({
    controller: tokenBinding.bind(controller),
    dispose(): void {
      if (!open) return;
      open = false;
      closeCheckpoint(checkpoint);
    },
  });
}

export function activeRunToken(controller: StudentSessionController) {
  return controller.modelRunToken();
}
