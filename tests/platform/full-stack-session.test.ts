import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createStudentApplication } from "../../apps/student/src/composition.js";
import { TurnAttemptFailed } from "../../apps/student/src/contracts.js";
import type {
  AgentApprovalTurn,
  AgentEvent,
  AgentRuntime,
  ApprovalDecision,
  ApprovalPrompt,
  AuthenticationReason,
  StudentInterface,
  StudentViewEvent,
} from "../../apps/student/src/contracts.js";
import { createFileEffectLedger } from "../../apps/student/src/effect-ledger.boundary.js";
import { createHttpStudentServer } from "../../apps/student/src/http-client.boundary.js";
import { createCrashSafeWorkspaceWriter } from "../../apps/student/src/workspace-writer.js";
import {
  ActiveRunDashboardResponseSchema,
  ApprovalIdSchema,
  InvitationCodeSchema,
  StudentRunSnapshotSchema,
} from "../../packages/protocol/src/index.js";
import {
  openGuardedWorkspace,
  WorkspaceError,
} from "../../packages/workspace-backend/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { ClassBootstrapService } from "../../apps/teacher-server/src/classes/index.js";
import { ActiveRunsService } from "../../apps/teacher-server/src/dashboard-api/index.js";
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
import { createTeacherProductHttp } from "../../apps/teacher-server/src/product-http/index.js";
import {
  unavailableSkillAuthoring,
  unavailableTeachingConfiguration,
} from "../../apps/teacher-server/src/product-http/product-http.fixture.js";
import { RunInferenceService } from "../../apps/teacher-server/src/model-gateway/run-inference-service.js";
import { SqliteUsageLedger } from "../../apps/teacher-server/src/platform/persistence/sqlite-usage-ledger.js";
import type { RunSnapshotSource } from "../../apps/teacher-server/src/sessions/index.js";
import { RunSessionService } from "../../apps/teacher-server/src/sessions/index.js";
import { RunSkillService } from "../../apps/teacher-server/src/teaching/skills/index.js";
import { NodeSqliteTestDatabase } from "../../apps/teacher-server/test-support/node-sqlite-database.boundary.js";
import { createMigrationCatalog } from "../../packages/sqlite-storage/src/migration-catalog.js";

const NOW = "2026-09-04T10:00:00.000Z";
const TEACHER_ORIGIN = "https://teacher.test";
const INVITATION = InvitationCodeSchema.parse("physics_invite_2026");
const APPROVAL_ID = ApprovalIdSchema.parse("approval:session");

class StableValues implements Clock, IdGenerator, SecretIssuer {
  #next = 0;

  createId(namespace: Parameters<IdGenerator["createId"]>[0]): string {
    this.#next += 1;
    return `${namespace}:${String(this.#next)}`;
  }

  issue(): string {
    this.#next += 1;
    return `secret_${String(this.#next).padStart(48, "0")}`;
  }

  now(): string {
    return NOW;
  }
}

const passwords: PasswordHasher = Object.freeze({
  hash: (password: string) => Promise.resolve(`argon2id:${password}`),
  verify: (password: string, hash: string) => Promise.resolve(hash === `argon2id:${password}`),
});

const digest: SecretDigest = Object.freeze({
  digest: (secret: string) => createHash("sha256").update(secret).digest("hex"),
});

class ApprovingStudentInterface implements StudentInterface {
  readonly authenticationReasons: AuthenticationReason[] = [];
  readonly presented: StudentViewEvent[] = [];
  readonly prompts: ApprovalPrompt[] = [];

  authenticate(reason: AuthenticationReason) {
    this.authenticationReasons.push(reason);
    return Promise.resolve({
      displayName: "Student Ada",
      invitationCode: INVITATION,
      kind: "enroll" as const,
      login: "ada.student",
      password: "student-password",
    });
  }

  confirmWrite(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    this.prompts.push(prompt);
    return Promise.resolve("approved");
  }

  present(event: StudentViewEvent): void {
    this.presented.push(event);
  }
}

class SyntheticAgent implements AgentRuntime {
  readonly approvals: AgentApprovalTurn[] = [];
  messages = 0;

  async *streamMessage(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.messages += 1;
    yield { text: "I will prepare the notes. ", type: "assistant-text-delta" };
    yield {
      approvalId: APPROVAL_ID,
      content: "The tide is rising.\n",
      path: "notes/tide.txt",
      summary: "Create the tide notes",
      type: "write-approval-required",
    };
  }

  async *resumeApproval(turn: AgentApprovalTurn): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.approvals.push(turn);
    yield { text: "Done.", type: "assistant-text-delta" };
    yield { type: "turn-completed" };
  }
}

interface ConnectionBridge {
  readonly fetch: (request: Request) => Promise<Response>;
  loseNextEvents(): void;
  loseNextOpen(): void;
  readonly traffic: readonly string[];
}

function connectionBridge(application: {
  fetch(request: Request): Response | Promise<Response>;
}): ConnectionBridge {
  let dropEvents = false;
  let dropOpen = false;
  const traffic: string[] = [];
  return {
    async fetch(request: Request): Promise<Response> {
      traffic.push(await request.clone().text());
      const headers = new Headers(request.headers);
      headers.set("host", "teacher.test");
      const response = await application.fetch(new Request(request, { headers }));
      traffic.push(await response.clone().text());
      if (dropOpen && new URL(request.url).pathname === "/v1/runs/open") {
        dropOpen = false;
        throw new Error("Simulated disconnect after opening the run.");
      }
      if (dropEvents && new URL(request.url).pathname === "/v1/runs/events") {
        dropEvents = false;
        throw new Error("Simulated disconnect after storing events.");
      }
      return response;
    },
    loseNextEvents(): void {
      dropEvents = true;
    },
    loseNextOpen(): void {
      dropOpen = true;
    },
    traffic,
  };
}

function installSchema(database: NodeSqliteTestDatabase): void {
  database.execute("PRAGMA foreign_keys = ON");
  for (const migration of createMigrationCatalog()) {
    for (const statement of migration.statements) database.execute(statement);
  }
}

describe("safe vertical slice", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("runs, reconnects, edits once, appears in the dashboard, and closes safely", async () => {
    const database = new NodeSqliteTestDatabase();
    installSchema(database);
    const values = new StableValues();
    const identities = new IdentityService({
      clock: values,
      digest,
      dummyPasswordHash: "argon2id:dummy-password",
      ids: values,
      passwords,
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
      invitations: [{ classKey: "physics", code: INVITATION }],
      seedId: "full-stack-session",
    });
    const snapshots: RunSnapshotSource = {
      capture(snapshotId) {
        return {
          providerRoute: {
            model: "private-upstream-model",
            providerId: "org.marea.openrouter",
          },
          snapshot: StudentRunSnapshotSchema.parse({
            agentMode: "tutoring",
            didacticSkills: [],
            id: snapshotId,
            modelAlias: "marea",
            prompt: {
              content: "Help the student reason before changing a file.",
              digest: `sha256:${"a".repeat(64)}`,
              version: "prompt:session",
            },
            teacherToolPolicy: {
              restrictions: [{ effect: "require-approval", tool: "write_file" }],
              version: "policy:session",
            },
          }),
        };
      },
    };
    const runs = new RunSessionService({
      clock: values,
      digest,
      ids: values,
      repository: new SqliteRunSessionRepository(database),
      secrets: values,
      snapshots,
    });
    const application = createTeacherProductHttp({
      allowedHosts: ["teacher.test"],
      allowedOrigins: [TEACHER_ORIGIN],
      serverVersion: "0.2.0",
      services: {
        teachingConfiguration: unavailableTeachingConfiguration,
        skillAuthoring: unavailableSkillAuthoring,
        classroom: new ClassBootstrapService(new SqliteClassroomRepository(database)),
        dashboard: new ActiveRunsService(new SqliteDashboardRepository(database), values),
        history: new HistoryService(new SqliteHistoryRepository(database)),
        evaluations: new EvaluationService({
          repository: new SqliteEvaluationRepository(database),
          clock: values,
          ids: values,
        }),
        notices: new NoticeService({
          repository: new SqliteNoticeRepository(database),
          clock: values,
          ids: values,
          digest,
        }),
        identity: identities,
        modelClock: values,
        modelUsage: new RunInferenceService({
          ledger: new SqliteUsageLedger(database),
          clock: values,
          createReservationId: () => values.createId("event"),
        }),
        providers: { resolve: () => undefined },
        retry: { wait: () => Promise.resolve() },
        runs,
        skills: new RunSkillService(new SqliteRunSkillRepository(database), runs),
      },
    });
    const bridge = connectionBridge(application);
    const server = createHttpStudentServer({ baseUrl: TEACHER_ORIGIN, fetch: bridge.fetch });
    const root = await mkdtemp(join(tmpdir(), "marea-session-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "wave-lab");
    const stateDirectory = join(root, "student-state");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, ".keep"), "", "utf8");
    const workspace = await openGuardedWorkspace({ rootPath: projectRoot });
    const writer = createCrashSafeWorkspaceWriter({
      ledger: createFileEffectLedger(stateDirectory),
      workspace,
    });
    const agent = new SyntheticAgent();
    const studentInterface = new ApprovingStudentInterface();

    bridge.loseNextOpen();
    const interrupted = await createStudentApplication({
      agent,
      clientVersion: "0.2.0",
      projectRoot,
      server,
      stateDirectory,
      studentInterface,
      workspace: writer,
    });
    await expect(interrupted.start(basename(projectRoot))).rejects.toMatchObject({
      code: "transport.unavailable",
      retryable: true,
    });

    const resumed = await createStudentApplication({
      agent,
      clientVersion: "0.2.0",
      projectRoot,
      server,
      stateDirectory,
      studentInterface,
      workspace: writer,
    });
    const opened = await resumed.start(basename(projectRoot));
    bridge.loseNextEvents();
    let disconnectRejection: TurnAttemptFailed | null = null;
    try {
      await resumed.sendMessage(
        "message:session",
        "Please prepare the tide notes.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) disconnectRejection = error;
    }
    expect(disconnectRejection?.cause).toMatchObject({
      code: "transport.unavailable",
      retryable: true,
    });
    await resumed.sendMessage(
      "message:session",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );
    await resumed.sendMessage(
      "message:session",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );

    expect(await readFile(join(projectRoot, "notes/tide.txt"), "utf8")).toBe(
      "The tide is rising.\n",
    );
    expect(agent.messages).toBe(1);
    expect(agent.approvals).toHaveLength(1);
    expect(studentInterface.prompts).toHaveLength(1);
    expect(studentInterface.authenticationReasons).toEqual(["missing"]);

    await expect(
      writer.writeApproved("effect:escape", "../escape.txt", "blocked"),
    ).rejects.toMatchObject({
      code: "invalid-path",
      name: WorkspaceError.name,
    });

    const restarted = await createStudentApplication({
      agent,
      clientVersion: "0.2.0",
      projectRoot,
      server,
      stateDirectory,
      studentInterface,
      workspace: writer,
    });
    const reopened = await restarted.start(basename(projectRoot));
    expect(reopened.runId).toBe(opened.runId);
    expect(studentInterface.authenticationReasons).toEqual(["missing"]);

    const teacherLogin = await application.fetch(
      new Request(`${TEACHER_ORIGIN}/v1/auth/login`, {
        body: JSON.stringify({
          credentials: { login: "grace.teacher", password: "teacher-password" },
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:teacher-login",
        }),
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
      }),
    );
    const cookie = teacherLogin.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTypeOf("string");
    const dashboard = await application.fetch(
      new Request(
        `${TEACHER_ORIGIN}/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50`,
        { headers: { cookie: cookie ?? "", host: "teacher.test" } },
      ),
    );
    expect(ActiveRunDashboardResponseSchema.parse(await dashboard.json()).runs).toMatchObject([
      {
        highestDurableSequence: 8,
        pendingApproval: false,
        projectDisplayName: "wave-lab",
        runId: opened.runId,
        studentDisplayName: "Student Ada",
      },
    ]);

    const storedEvents = database.readAll(
      "SELECT sequence, payload_json FROM marea_run_events ORDER BY sequence",
    );
    expect(storedEvents).toHaveLength(8);
    expect(new Set(storedEvents.map((event) => event.sequence)).size).toBe(8);
    const localState = await readFile(join(stateDirectory, "session.json"), "utf8");
    const publicMaterial = `${bridge.traffic.join("\n")}\n${localState}`;
    expect(publicMaterial).not.toContain("private-upstream-model");
    expect(publicMaterial).not.toContain("org.marea.openrouter");

    await restarted.close();
    const emptyDashboard = await application.fetch(
      new Request(
        `${TEACHER_ORIGIN}/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Aclosed-dashboard&limit=50`,
        { headers: { cookie: cookie ?? "", host: "teacher.test" } },
      ),
    );
    expect(ActiveRunDashboardResponseSchema.parse(await emptyDashboard.json()).runs).toEqual([]);
    database.close();
  });
});
import { HistoryService } from "../../apps/teacher-server/src/sessions/history-service.js";
import { NoticeService } from "../../apps/teacher-server/src/sessions/notice-service.js";
import { EvaluationService } from "../../apps/teacher-server/src/evaluation/evaluation-service.js";
import { SqliteEvaluationRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-evaluation-repository.js";
import { SqliteNoticeRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-notice-repository.js";
import { SqliteHistoryRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-history-repository.js";
