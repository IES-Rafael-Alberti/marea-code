import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";

import { createEvaluationClient } from "../../apps/dashboard/src/modules/evaluation/evaluation-client.boundary.js";
import { EvaluationController } from "../../apps/dashboard/src/modules/evaluation/evaluation-controller.js";
import {
  compileMarea,
  launchCompiledStudent,
  type PtyProcess,
} from "../../test-support/terminal/pty.js";
import {
  compileInstallationExecutables,
  freeLoopbackPort,
  PILOT_API_KEY,
  PILOT_EVALUATION,
  PILOT_REPLY_TEXT,
  PILOT_STARTUP_TEXT,
  PilotProvider,
  pilotInstallation,
  pilotStudentDriver,
  startPilotHost,
  syntheticCertificateAuthority,
  type PilotExecutables,
} from "../../test-support/platform/installation.js";

let build: string;
let binaries: PilotExecutables;
let student: string;
const cleanup: (() => Promise<void>)[] = [];
const JsonRecord = z.record(z.string(), z.json());
const Version = z.object({ version: z.string() });
const Session = z.object({ session: z.object({ token: z.string() }) });

beforeAll(async () => {
  build = await mkdtemp(join(tmpdir(), "marea-pilot-build-"));
  binaries = compileInstallationExecutables(build);
  student = join(build, "marea");
  await compileMarea(student);
}, 240_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await rm(build, { recursive: true, force: true });
});

function execute(binary: string, root: string, args: readonly string[], stdin?: string) {
  const result = spawnSync(binary, ["--installation", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return JsonRecord.parse(JSON.parse(result.stdout));
}

describe("compiled pilot", () => {
  it("serves a clean installation to real teacher, student and evaluation journeys", async () => {
    const tls = syntheticCertificateAuthority(await mkdtemp(join(tmpdir(), "marea-pilot-tls-")));
    const provider = new PilotProvider();
    const endpoint = await provider.start(tls);
    cleanup.push(() => provider.close());
    const port = await freeLoopbackPort();
    const f = pilotInstallation({ providerEndpoint: endpoint, port });
    cleanup.push(() => rm(f.root, { recursive: true, force: true }));
    const input = (name: string, payload: object) => {
      const path = f.work(`${name}.json`);
      spawnSync("sh", ["-c", `umask 077; cat > '${path}'`], { input: JSON.stringify(payload) });
      return ["--input", path];
    };

    expect(execute(binaries.operations, f.root, ["installation", "initialize"])).toEqual({
      schemaVersion: 9,
    });
    execute(binaries.admin, f.root, [
      "center",
      "create",
      ...input("center", {
        centerId: "center:a",
        displayName: "Pilot Center",
        expectedVersion: null,
      }),
    ]);
    execute(binaries.admin, f.root, [
      "class",
      "create",
      ...input("class", {
        centerId: "center:a",
        classId: "class:a",
        displayName: "Physics",
        expectedVersion: null,
      }),
    ]);
    for (const [userId, login, role, name] of [
      ["user:teacher", "teacher1", "teacher", "Tomas Teacher"],
      ["user:student", "student1", "student", "Sam Student"],
    ] as const) {
      const account = execute(binaries.admin, f.root, [
        "account",
        "create",
        ...input(`account-${login}`, {
          centerId: "center:a",
          userId,
          displayName: name,
          login,
          role,
          classId: "class:a",
          expectedVersion: null,
        }),
      ]);
      execute(
        binaries.admin,
        f.root,
        [
          "credential",
          "provision",
          "--user",
          userId,
          "--expected-version",
          z.string().parse(account.version),
          "--password-stdin",
        ],
        `${login}-synthetic-password\n`,
      );
    }

    const host = await startPilotHost(binaries.host, f.root, tls.ca);
    cleanup.push(async () => {
      await host.stop();
    });
    const post = async (path: string, body: object, headers: Record<string, string> = {}) => {
      const response = await fetch(`${f.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.origin, ...headers },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: `request:${crypto.randomUUID()}`,
          ...body,
        }),
      });
      return { status: response.status, body: JsonRecord.parse(await response.json()) };
    };
    const teacherLogin = await post("/v1/auth/login", {
      kind: "credential-login",
      credentials: { login: "teacher1", password: "teacher1-synthetic-password" },
    });
    expect(teacherLogin.status).toBe(200);
    const cookie = {
      cookie: `marea_teacher_session=${Session.parse(teacherLogin.body).session.token}`,
    };
    const catalog = await post(
      "/api/v1/dashboard/teaching/catalog",
      { kind: "teaching-catalog-query", classId: "class:a", afterSkillId: null },
      cookie,
    );
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const evaluate = z
      .array(z.object({ id: z.string(), kind: z.string(), digest: z.string() }))
      .parse(catalog.body.skills)
      .find((skill) => skill.kind === "evaluation");
    if (evaluate === undefined) throw new Error("The core evaluation skill is missing.");
    const saved = await post(
      "/api/v1/dashboard/teaching/save",
      {
        kind: "teaching-configuration-save",
        classId: "class:a",
        expectedVersion: null,
        settings: {
          agentMode: "tutoring",
          classInstructions: {
            tutoring: "PILOT-GUIDED-INSTRUCTIONS",
            free: "PILOT-FREE-INSTRUCTIONS",
          },
          selection: { didactic: [], evaluation: [{ id: evaluate.id, digest: evaluate.digest }] },
          automaticEvaluation: true,
        },
      },
      cookie,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const project = f.work("project");
    await mkdir(project, { mode: 0o700 });
    await writeFile(join(project, "exercise.txt"), "Synthetic exercise input.\n");
    const pty: PtyProcess = launchCompiledStudent(
      student,
      project,
      f.origin,
      f.work("student-state"),
    );
    cleanup.push(async () => {
      pty.kill();
      await pty.waitForExit(10_000).catch(() => undefined);
    });
    await pty.waitForText("How would you like to continue?");
    pty.write("\r");
    await pty.waitForText("Username");
    pty.write("student1\r");
    await pty.waitForText("Password");
    pty.write("student1-synthetic-password\r");
    await pty.waitForText(PILOT_STARTUP_TEXT, 60_000);
    await pty.waitForQuiet();
    const systemText = (request: (typeof provider.requests)[number]) =>
      request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content ?? "")
        .join("\n");
    const { studentState, until, turnCount, idleRun, submit, exit } = pilotStudentDriver(
      f.work("student-state"),
    );
    // Automatic evaluations of closed runs may reach the provider at any time; count turns apart.
    const tutoring = () => provider.requests.filter((request) => (request.tools ?? []).length > 0);
    const lastRequest = () => {
      const request = tutoring().at(-1);
      if (request === undefined) throw new Error("The provider received no request.");
      return request;
    };
    const waitForTutoring = async (count: number) => {
      const deadline = Date.now() + 60_000;
      while (tutoring().length < count && Date.now() < deadline)
        await new Promise((wait) => setTimeout(wait, 50));
      expect(tutoring().length).toBeGreaterThanOrEqual(count);
    };
    const waitForRequests = async (count: number) => {
      const deadline = Date.now() + 60_000;
      while (provider.requests.length < count && Date.now() < deadline)
        await new Promise((wait) => setTimeout(wait, 50));
      expect(provider.requests.length).toBeGreaterThanOrEqual(count);
    };

    // P3-01/P3-02: the guided run starts itself with read-only tools and the guided instructions.
    const startup = lastRequest();
    expect(startup.messages.some((message) => message.role === "user")).toBe(false);
    expect(systemText(startup)).toContain("PILOT-GUIDED-INSTRUCTIONS");
    expect(JSON.stringify(provider.requests)).not.toContain("PILOT-FREE-INSTRUCTIONS");
    const toolNames = (startup.tools ?? []).map((tool) => tool.function.name);
    expect(toolNames.some((name) => /write|execute/u.test(name))).toBe(false);

    await idleRun(1);
    const afterFirst = provider.requests.length + 1;
    await submit(pty, "Please help with the boundary.", async () => (await turnCount()) >= 2);
    await waitForRequests(afterFirst);
    await pty.waitForText(PILOT_REPLY_TEXT, 60_000);

    const teacherFetch = (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie.cookie);
      headers.set("origin", f.origin);
      return fetch(`${f.origin}${path}`, { ...init, headers });
    };
    const sessions = await post(
      "/api/v1/dashboard/history/sessions",
      { kind: "session-history-query", limit: 10 },
      cookie,
    );
    expect(sessions.status).toBe(200);
    const runs = z
      .array(z.object({ runId: z.string(), state: z.string() }))
      .parse(sessions.body.runs);
    expect(runs.map((run) => run.state)).toEqual(["active"]);
    const runId = runs[0]?.runId ?? "";

    // P3-05: a class edit during the run leaves its immutable snapshot in force.
    /** Saves the edited free-mode revision of the class after the given one. */
    const saveFreeRevision = (after: z.infer<typeof JsonRecord>, session: { cookie: string }) =>
      post(
        "/api/v1/dashboard/teaching/save",
        {
          kind: "teaching-configuration-save",
          classId: "class:a",
          expectedVersion: Version.parse(after.configuration).version,
          settings: {
            agentMode: "free",
            classInstructions: { tutoring: "PILOT-GUIDED-V2", free: "PILOT-FREE-V2" },
            selection: { didactic: [], evaluation: [{ id: evaluate.id, digest: evaluate.digest }] },
            automaticEvaluation: true,
          },
        },
        session,
      );
    const edited = await saveFreeRevision(saved.body, cookie);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    await idleRun(2);
    await submit(pty, "A second question.", async () => (await turnCount()) >= 3);
    await waitForRequests(afterFirst + 1);
    const second = lastRequest();
    expect(systemText(second)).toContain("PILOT-GUIDED-INSTRUCTIONS");
    expect(JSON.stringify(second)).not.toContain("V2");

    // P3-06: scoped history and an idempotent teacher notice.
    const history = await post(
      "/api/v1/dashboard/history/run",
      { kind: "run-history-query", runId, afterSequence: 0, limit: 32 },
      cookie,
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body.events)).toContain("Please help with the boundary.");
    const notice = {
      kind: "teacher-notice-publish",
      idempotencyKey: "notice:pilot",
      runId,
      text: "PilotTeacherNotice",
    };
    expect((await post("/api/v1/dashboard/notices/publish", notice, cookie)).status).toBe(200);
    expect((await post("/api/v1/dashboard/notices/publish", notice, cookie)).status).toBe(200);

    await idleRun(3);
    expect(await exit(pty)).toMatchObject({ exitCode: 0 });

    // P3-07: the closed run is evaluated asynchronously with a tool-less request, reviewed and sent.
    const client = createEvaluationClient(teacherFetch);
    const signal = new AbortController().signal;
    const deadline = Date.now() + 30_000;
    while (
      (await client.query(runId, signal)).evaluation?.state !== "draft" &&
      Date.now() < deadline
    )
      await new Promise((wait) => setTimeout(wait, 100));
    const evaluationRequest = provider.requests.find(
      (request) => (request.tools ?? []).length === 0,
    );
    expect(evaluationRequest).toBeDefined();
    let key = 0;
    const controller = new EvaluationController(
      client,
      () => undefined,
      () => `action:pilot-${String(++key)}`,
    );
    await controller.loadSessions();
    await controller.select(runId);
    expect(controller.state.draft).toEqual(PILOT_EVALUATION);
    await controller.approve();
    expect(controller.state.evaluation?.state).toBe("approved");

    const feedback = spawnSync(student, ["feedback"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: "en-US",
        MAREA_SERVER_URL: f.origin,
        MAREA_STATE_HOME: f.work("student-state"),
      },
      timeout: 30_000,
    });
    expect(feedback.status, feedback.stderr).toBe(0);
    expect(feedback.stdout).toContain(PILOT_EVALUATION.studentFeedback);
    expect(feedback.stdout).toContain("PilotTeacherNotice");
    expect(feedback.stdout.split("PilotTeacherNotice")).toHaveLength(2);
    expect(feedback.stdout).not.toContain("Private");

    // P3-08: every attempt is settled with provider usage, charged at the explicit prices.
    const database = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      const attempts = database
        .prepare(
          "SELECT purpose, state, input_tokens, output_tokens, cost_units FROM marea_usage_attempts",
        )
        .all() as {
        purpose: string;
        state: string;
        input_tokens: number;
        output_tokens: number;
        cost_units: number;
      }[];
      expect(attempts.length).toBe(provider.requests.length);
      expect(new Set(attempts.map((attempt) => attempt.purpose))).toEqual(
        new Set(["tutoring", "evaluation"]),
      );
      for (const attempt of attempts)
        expect([
          attempt.state,
          attempt.input_tokens,
          attempt.output_tokens,
          attempt.cost_units,
        ]).toEqual(["settled", 12, 6, 24]);
    } finally {
      database.close();
    }
    expect(
      provider.requests.every((request) => request.authorization === `Bearer ${PILOT_API_KEY}`),
    ).toBe(true);
    expect(host.output.stdout + host.output.stderr).not.toContain(PILOT_API_KEY);
    expect(readFileSync(f.databasePath).includes(PILOT_API_KEY)).toBe(false);

    // Restart: a new host process serves the next run in the edited free mode, without startup.
    expect(await host.stop()).toBe(0);
    const restarted = await startPilotHost(binaries.host, f.root, tls.ca);
    cleanup.push(async () => {
      await restarted.stop();
    });
    const before = provider.requests.length;
    const free = launchCompiledStudent(student, project, f.origin, f.work("student-state"));
    cleanup.push(async () => {
      free.kill();
      await free.waitForExit(10_000).catch(() => undefined);
    });
    await free.waitForText("Write to Marea", 60_000);
    await idleRun(0);
    expect(provider.requests).toHaveLength(before);
    await submit(free, "Free question.", async () => (await turnCount()) >= 1);
    await waitForRequests(before + 1);
    await free.waitForText(PILOT_REPLY_TEXT, 60_000);
    expect(systemText(lastRequest())).toContain("PILOT-FREE-V2");

    // P3-09: a provider stream lost after a prefix is shown as failed and retried explicitly.
    await idleRun(1);
    provider.partialMarker = "PilotPartialQuestion";
    const beforePartial = tutoring().length;
    await submit(free, "PilotPartialQuestion", async () => (await turnCount()) >= 2);
    await free.waitForText("Retry / continue", 120_000);
    expect(tutoring()).toHaveLength(beforePartial + 1);
    await free.waitForQuiet(500);
    expect(tutoring()).toHaveLength(beforePartial + 1);
    // A retry must continue the shown prefix; a divergent continuation is refused, not replayed.
    await submit(free, "/retry", () => tutoring().length >= beforePartial + 2);
    await free.waitForText("Retry started", 120_000);
    expect(
      lastRequest().messages.filter((message) => message.content === "PilotPartialQuestion"),
    ).toHaveLength(1);
    await submit(free, "After the interruption.", async () =>
      ((await studentState())?.run?.turns ?? []).some(
        (turn) => turn.studentText === "After the interruption.",
      ),
    );
    await until("the new message to complete", async () =>
      ((await studentState())?.run?.turns ?? []).some(
        (turn) => turn.studentText === "After the interruption." && turn.state === "completed",
      ),
    );
    expect(await exit(free)).toMatchObject({ exitCode: 0 });
    const recorded = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      const states = (
        recorded
          .prepare(
            "SELECT state FROM marea_usage_attempts WHERE purpose = 'tutoring' ORDER BY created_at, id",
          )
          .all() as { state: string }[]
      ).map((row) => row.state);
      expect(states).toHaveLength(tutoring().length);
      expect(states.filter((state) => state !== "settled")).toEqual(["unknown"]);
    } finally {
      recorded.close();
    }

    // P3-08: the operator lowers the tutoring request cap; a new run is refused before inference.
    expect(await restarted.stop()).toBe(0);
    f.writePolicy(1);
    const limited = await startPilotHost(binaries.host, f.root, tls.ca);
    cleanup.push(async () => {
      await limited.stop();
    });
    // Routes and budgets are captured by configuration revisions, so the class is saved again.
    const limitedLogin = await post("/v1/auth/login", {
      kind: "credential-login",
      credentials: { login: "teacher1", password: "teacher1-synthetic-password" },
    });
    const limitedCookie = {
      cookie: `marea_teacher_session=${Session.parse(limitedLogin.body).session.token}`,
    };
    const resaved = await saveFreeRevision(edited.body, limitedCookie);
    expect(resaved.status, JSON.stringify(resaved.body)).toBe(200);
    const capped = launchCompiledStudent(student, project, f.origin, f.work("student-state"));
    cleanup.push(async () => {
      capped.kill();
      await capped.waitForExit(10_000).catch(() => undefined);
    });
    await capped.waitForText("Write to Marea", 60_000);
    await idleRun(0);
    const beforeCap = tutoring().length;
    await submit(capped, "Within the cap.", async () => (await turnCount()) >= 1);
    await waitForTutoring(beforeCap + 1);
    await idleRun(1);
    await submit(capped, "Beyond the cap.", async () => (await turnCount()) >= 2);
    await capped.waitForText("insufficient inference budget", 120_000);
    await capped.waitForQuiet(500);
    expect(tutoring()).toHaveLength(beforeCap + 1);
    expect(await exit(capped)).toMatchObject({ exitCode: 0 });
  }, 300_000);
});
