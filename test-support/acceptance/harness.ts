import { createHash } from "node:crypto";
import { createLoopbackHttpServer, type LoopbackHttpServer } from "../http.js";

import {
  InvitationCodeSchema,
  EnrollStudentRequestSchema,
  RequestIdSchema,
  Sha256DigestSchema,
  StudentRunSnapshotSchema,
  type StudentRunSnapshot,
} from "../../packages/protocol/src/index.js";
import { openGuardedWorkspace } from "../../packages/workspace-backend/src/index.js";
import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
} from "../../packages/deepagents-adapter/src/index.js";

import { activeRunToken, createStudentApplication } from "../../apps/student/src/composition.js";
import { createDeepAgentsStudentRuntime } from "../../apps/student/src/deepagents-runtime.boundary.js";
import { createFileEffectLedger } from "../../apps/student/src/effect-ledger.boundary.js";
import {
  createHttpModelGateway,
  createHttpStudentServer,
} from "../../apps/student/src/http-client.boundary.js";
import type {
  AgentRuntime,
  Clock as StudentClock,
  StudentInterface,
  StudentServer,
} from "../../apps/student/src/contracts.js";
import { createCrashSafeWorkspaceWriter } from "../../apps/student/src/workspace-writer.js";
import { ClassBootstrapService } from "../../apps/teacher-server/src/classes/index.js";
import { ActiveRunsService } from "../../apps/teacher-server/src/dashboard-api/index.js";
import { HistoryService } from "../../apps/teacher-server/src/sessions/history-service.js";
import { NoticeService } from "../../apps/teacher-server/src/sessions/notice-service.js";
import { createEvaluationModule } from "../../apps/teacher-server/src/evaluation/evaluation-module.js";
import { SqliteEvaluationRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-evaluation-repository.js";
import { SqliteNoticeRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-notice-repository.js";
import { SqliteHistoryRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-history-repository.js";
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  SecretDigest,
  SecretIssuer,
} from "../../apps/teacher-server/src/identity/index.js";
import { IdentityService } from "../../apps/teacher-server/src/identity/index.js";
import {
  SqliteClassroomRepository,
  SqliteDashboardRepository,
  SqliteIdentityRepository,
  SqliteRunSessionRepository,
  SqliteRunSkillRepository,
} from "../../apps/teacher-server/src/platform/persistence/index.js";
import {
  createTeacherProductHttp,
  type TeacherProductHttpOptions,
} from "../../apps/teacher-server/src/product-http/index.js";
import {
  unavailableSkillAuthoring,
  unavailableTeachingConfiguration,
} from "../../apps/teacher-server/src/product-http/product-http.fixture.js";
import { RunInferenceService } from "../../apps/teacher-server/src/model-gateway/run-inference-service.js";
import { SqliteUsageLedger } from "../../apps/teacher-server/src/platform/persistence/sqlite-usage-ledger.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../apps/teacher-server/test-support/usage-fixture.js";
import type { RunSnapshotSource } from "../../apps/teacher-server/src/sessions/index.js";
import { RunSessionService } from "../../apps/teacher-server/src/sessions/index.js";
import { RunSkillService } from "../../apps/teacher-server/src/teaching/skills/index.js";
import { NodeSqliteTestDatabase } from "../../apps/teacher-server/test-support/node-sqlite-database.boundary.js";
import { createMigrationCatalog } from "../../packages/sqlite-storage/src/migration-catalog.js";

import { DeterministicInferenceProvider } from "./inference.js";

const START_TIME = "2026-09-07T10:00:00.000Z";
const TEST_INVITATION_ADA = InvitationCodeSchema.parse("physics_invite_ada_2026");
const TEST_INVITATION_BOB = InvitationCodeSchema.parse("physics_invite_bob_2026");
const TEST_PROMPT_DIGEST = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);

export const ACCEPTANCE_CLIENT_VERSION = "0.2.0";
export const ACCEPTANCE_PROJECT = "wave-lab";
export const ACCEPTANCE_SESSION = Object.freeze({
  ada: Object.freeze({
    displayName: "Student Ada",
    invitationCode: TEST_INVITATION_ADA,
    login: "ada.student",
    password: "student-password",
  }),
  bob: Object.freeze({
    displayName: "Student Bob",
    invitationCode: TEST_INVITATION_BOB,
    login: "bob.student",
    password: "student-password",
  }),
});

export class MutableTestClock implements Clock, StudentClock {
  #milliseconds: number;

  public constructor(initial = START_TIME) {
    this.#milliseconds = Date.parse(initial);
  }

  public now(): string {
    return new Date(this.#milliseconds).toISOString();
  }

  public advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("The test clock advance must be a non-negative safe integer.");
    }
    this.#milliseconds += milliseconds;
  }
}

export class AcceptanceValues implements IdGenerator, SecretIssuer {
  #counter = 0;

  public createId(namespace: Parameters<IdGenerator["createId"]>[0] | "request"): string {
    this.#counter += 1;
    return `${namespace}:test:${String(this.#counter)}`;
  }

  public issue(): string {
    this.#counter += 1;
    return `secret_${String(this.#counter).padStart(48, "0")}`;
  }
}

export const acceptancePasswords: PasswordHasher = Object.freeze({
  hash: (password: string) => Promise.resolve(`argon2id:${password}`),
  verify: (password: string, hash: string) => Promise.resolve(hash === `argon2id:${password}`),
});

export const acceptanceDigest: SecretDigest = Object.freeze({
  digest: (secret: string) => createHash("sha256").update(secret).digest("hex"),
});

export function acceptanceSnapshot(snapshotId: string): StudentRunSnapshot {
  return StudentRunSnapshotSchema.parse({
    agentMode: "tutoring",
    didacticSkills: [],
    id: snapshotId,
    modelAlias: "marea",
    prompt: {
      content: "Help the student reason before changing a file.",
      digest: TEST_PROMPT_DIGEST,
      version: "prompt:acceptance",
    },
    teacherToolPolicy: {
      restrictions: [{ effect: "require-approval", tool: "write_file" }],
      version: "policy:acceptance",
    },
  });
}

function installSchema(database: NodeSqliteTestDatabase): void {
  database.execute("PRAGMA foreign_keys = ON");
  for (const migration of createMigrationCatalog()) {
    for (const statement of migration.statements) database.execute(statement);
  }
}

export {
  createLoopbackHttpServer,
  type LoopbackHttpServer,
  type HeldHttpResponse,
  type ResponseLossRule,
} from "../http.js";

export interface AcceptanceHarness {
  readonly application: ReturnType<typeof createTeacherProductHttp>;
  readonly clock: MutableTestClock;
  readonly database: NodeSqliteTestDatabase;
  readonly http: LoopbackHttpServer;
  readonly provider: DeterministicInferenceProvider;
  readonly studentServer: StudentServer;
  readonly nextModelRequestId: () => ReturnType<typeof RequestIdSchema.parse>;
  readonly evaluationErrors: readonly string[];
  readonly close: () => Promise<void>;
}

export function enrollAcceptanceStudent(harness: AcceptanceHarness, name: "ada" | "bob") {
  const credentials = ACCEPTANCE_SESSION[name];
  return harness.studentServer.enroll(
    EnrollStudentRequestSchema.parse({
      kind: "student-invitation-enrollment",
      protocolVersion: "0.1",
      requestId: `request:enroll:${name}`,
      invitationCode: credentials.invitationCode,
      displayName: credentials.displayName,
      credentials: { login: credentials.login, password: credentials.password },
    }),
  );
}

export async function createAcceptanceHarness(
  options: {
    readonly snapshotSource?: (database: NodeSqliteTestDatabase) => RunSnapshotSource;
    readonly provider?: DeterministicInferenceProvider;
    readonly evaluationIntervalMs?: number;
    readonly dashboardAssets?: (request: Request) => Response;
    readonly observeHttpResponse?: (path: string, status: number) => void;
  } = {},
): Promise<AcceptanceHarness> {
  const database = new NodeSqliteTestDatabase();
  installSchema(database);
  const clock = new MutableTestClock();
  const values = new AcceptanceValues();
  const identities = new IdentityService({
    clock,
    digest: acceptanceDigest,
    dummyPasswordHash: "argon2id:dummy-password",
    ids: values,
    passwords: acceptancePasswords,
    repository: new SqliteIdentityRepository(database),
    secrets: values,
  });
  await identities.bootstrap({
    accounts: [
      {
        classKey: "physics",
        displayName: "Teacher Grace",
        login: "grace.teacher",
        password: "teacher-password",
        role: "teacher",
      },
    ],
    classes: [{ displayName: "Physics", key: "physics" }],
    invitations: [
      { classKey: "physics", code: TEST_INVITATION_ADA },
      { classKey: "physics", code: TEST_INVITATION_BOB },
    ],
    seedId: "acceptance",
  });
  const snapshots: RunSnapshotSource = options.snapshotSource?.(database) ?? {
    capture: (snapshotId) => ({
      providerRoute: {
        model: "deterministic-upstream",
        providerId: "test.deterministic",
        budget: SYNTHETIC_ROUTE_BUDGET,
      },
      snapshot: acceptanceSnapshot(snapshotId),
    }),
  };
  const runs = new RunSessionService({
    clock,
    digest: acceptanceDigest,
    ids: values,
    repository: new SqliteRunSessionRepository(database),
    secrets: values,
    snapshots,
  });
  const provider = options.provider ?? new DeterministicInferenceProvider();
  const providers = {
    resolve: (providerId: string) => (providerId === "test.deterministic" ? provider : undefined),
  };
  const evaluationErrors: string[] = [];
  const evaluations = createEvaluationModule({
    repository: new SqliteEvaluationRepository(database),
    ledger: new SqliteUsageLedger(database),
    clock,
    ids: values,
    providers,
    createReservationId: () => values.createId("event"),
    intervalMs: options.evaluationIntervalMs ?? 250,
    onError: () => {
      evaluationErrors.push("evaluation-tick-failed");
    },
  });
  evaluations.recoverAfterExclusiveStartup();
  const productOptions: TeacherProductHttpOptions = {
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["http://127.0.0.1"],
    serverVersion: ACCEPTANCE_CLIENT_VERSION,
    services: {
      teachingConfiguration: unavailableTeachingConfiguration,
      skillAuthoring: unavailableSkillAuthoring,
      classroom: new ClassBootstrapService(new SqliteClassroomRepository(database)),
      dashboard: new ActiveRunsService(new SqliteDashboardRepository(database), clock),
      history: new HistoryService(new SqliteHistoryRepository(database)),
      evaluations: evaluations.service,
      notices: new NoticeService({
        repository: new SqliteNoticeRepository(database),
        clock,
        ids: values,
        digest: acceptanceDigest,
      }),
      identity: identities,
      modelClock: clock,
      modelUsage: new RunInferenceService({
        ledger: new SqliteUsageLedger(database),
        clock,
        createReservationId: () => values.createId("event"),
      }),
      providers,
      retry: { wait: () => Promise.resolve() },
      runs,
      skills: new RunSkillService(new SqliteRunSkillRepository(database), runs),
    },
  };
  let application = createTeacherProductHttp(productOptions);
  const http = await createLoopbackHttpServer({
    async fetch(request) {
      if (
        options.dashboardAssets !== undefined &&
        new URL(request.url).pathname.startsWith("/dashboard")
      )
        return options.dashboardAssets(request);
      const response = await application.fetch(request);
      options.observeHttpResponse?.(new URL(request.url).pathname, response.status);
      return response;
    },
  });
  application = createTeacherProductHttp({
    ...productOptions,
    allowedOrigins: ["http://127.0.0.1", http.baseUrl],
    secureDashboardCookie: false,
  });
  evaluations.start();
  const studentServer = createHttpStudentServer({ baseUrl: http.baseUrl });
  return {
    application,
    clock,
    database,
    http,
    provider,
    evaluationErrors,
    studentServer,
    nextModelRequestId: () => RequestIdSchema.parse(values.createId("request")),
    async close(): Promise<void> {
      await http.close();
      await evaluations.stop();
      database.close();
    },
  };
}

export interface RealStudentApplication {
  readonly agent: AgentRuntime;
  readonly controller: Awaited<ReturnType<typeof createStudentApplication>>;
  dispose(): void;
}

export async function createRealStudentApplication(options: {
  readonly harness: AcceptanceHarness;
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly studentInterface: StudentInterface;
}): Promise<RealStudentApplication> {
  const checkpoint = createLocalCheckpoint({
    projectDirectory: options.projectRoot,
    storageDirectory: `${options.stateDirectory}/agent`,
  });
  let controller: Awaited<ReturnType<typeof createStudentApplication>> | null = null;
  const model = createMareaGatewayModel({
    gateway: createHttpModelGateway({
      baseUrl: options.harness.http.baseUrl,
      runToken: () => {
        if (controller === null) throw new Error("The acceptance controller is not ready.");
        return activeRunToken(controller);
      },
    }),
    nextRequestId: options.harness.nextModelRequestId,
  });
  const agent = createDeepAgentsStudentRuntime({ checkpoint, model });
  const workspace = await openGuardedWorkspace({ rootPath: options.projectRoot });
  controller = await createStudentApplication({
    agent,
    clientVersion: ACCEPTANCE_CLIENT_VERSION,
    projectRoot: options.projectRoot,
    server: options.harness.studentServer,
    stateDirectory: options.stateDirectory,
    studentInterface: options.studentInterface,
    workspace: createCrashSafeWorkspaceWriter({
      ledger: createFileEffectLedger(options.stateDirectory),
      workspace,
    }),
  });
  const readyController = controller;
  let open = true;
  return {
    agent,
    controller: readyController,
    dispose(): void {
      if (!open) return;
      open = false;
      closeAgentCheckpoint(checkpoint);
    },
  };
}
