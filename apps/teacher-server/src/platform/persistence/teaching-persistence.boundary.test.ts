import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OpenRunRequestSchema,
  RunSkillRequestSchema,
  RunSkillResponseSchema,
  Sha256DigestSchema,
} from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import {
  clock,
  newRun,
  seedTeachingDatabase,
  servicesFor,
  student,
  teacher,
  writeCatalog,
} from "../../../test-support/teaching-integration.fixture.js";
import {
  teachingConfiguration,
  teachingInput,
  teachingSkill,
} from "../../../test-support/teaching-fixture.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { SqliteRunSkillRepository } from "./sqlite-run-skill-repository.js";
import {
  createApplication,
  createServices,
  RecordingProvider,
  request as httpRequest,
} from "../../product-http/product-http.fixture.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
  type SkillSource,
} from "../../teaching/skills/index.js";
const otherTeacher: AuthenticatedIdentity = { ...teacher, userId: "t2" };

describe("durable teaching revisions and scoped skill delivery", () => {
  let root: string;
  let database: NodeSqliteTestDatabase;
  let source: SkillSource;
  let services: ReturnType<typeof servicesFor>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "marea-teaching-persistence-"));
    database = new NodeSqliteTestDatabase(join(root, "teacher.sqlite"));
    seedTeachingDatabase(database);
    await writeCatalog(join(root, "teacher-skills"), teachingSkill("didactic"));
    await writeCatalog(join(root, "core-skills"), teachingSkill("evaluation"));
    source = new CompositeSkillSource([
      new DirectorySkillSource(join(root, "teacher-skills"), { source: "teacher", id: "t1" }),
      new BundledSkillSource(join(root, "core-skills")),
    ]);
    services = servicesFor(database, source);
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("preserves exact active content through source deletion, a class edit and database reopen", async () => {
    const first = await services.teaching.save(teacher, teachingInput());
    const opened = services.runs.open(student, newRun("first"));
    const request = RunSkillRequestSchema.parse({
      protocolVersion: "0.1",
      requestId: "request:skill",
      runId: opened.lease.runId,
      snapshotId: opened.snapshot.id,
      skillId: "teacher/t1/testing",
    });
    expect(services.skills.read(opened.lease.token, request).skill).toEqual(
      teachingSkill("didactic"),
    );
    expect(first.content.automaticEvaluation).toBe(false);
    const frozen = JSON.stringify(opened.snapshot);
    for (const directory of ["teacher-skills", "core-skills"])
      await rm(join(root, directory), { recursive: true });
    const edited = await services.teaching.save(teacher, {
      ...teachingInput("free"),
      expectedVersion: first.content.configurationVersion,
      selection: { didactic: [], evaluation: [] },
    });
    expect(edited.content.configurationVersion).not.toBe(first.content.configurationVersion);
    const second = services.runs.open(student, newRun("second"));
    expect(second.snapshot.agentMode).toBe("free");
    expect(second.snapshot.didacticSkills).toEqual([]);
    expect(services.skills.read(opened.lease.token, request).skill).toEqual(
      teachingSkill("didactic"),
    );
    expect(() =>
      services.skills.read(
        second.lease.token,
        RunSkillRequestSchema.parse({
          ...request,
          runId: second.lease.runId,
          snapshotId: second.snapshot.id,
        }),
      ),
    ).toThrow("run.unavailable");
    database.close();
    database = new NodeSqliteTestDatabase(join(root, "teacher.sqlite"));
    services = servicesFor(database, source);
    const resumed = services.runs.open(
      student,
      OpenRunRequestSchema.parse({
        ...newRun("resume"),
        intent: { kind: "resume" },
        runId: opened.lease.runId,
      }),
    );
    expect(JSON.stringify(resumed.snapshot)).toBe(frozen);
    expect(services.skills.read(resumed.lease.token, request).skill).toEqual(
      teachingSkill("didactic"),
    );
    expect(services.teaching.load(teacher, "class:one")).toEqual(edited);
    for (const table of [
      "marea_runs",
      "marea_run_teaching_snapshots",
      "marea_class_teaching_revisions",
    ])
      expect(database.readOne(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 2n });
    expect(JSON.stringify(resumed.snapshot)).not.toContain("Synthetic evaluation");
    expect(
      new SqliteRunSkillRepository(database).loadRunTeaching(opened.lease.runId, opened.snapshot.id)
        ?.teaching.evaluationSkills,
    ).toEqual([teachingSkill("evaluation")]);
  });

  it("enforces teacher membership, student membership and optimistic concurrent edits", async () => {
    expect(services.teaching.load(teacher, "class:one")).toBeNull();
    expect(services.configurations.loadForStudent(student)).toBeNull();
    expect(() => services.teaching.load(otherTeacher, "class:one")).toThrow("dashboard.forbidden");
    for (const identity of [
      teacher,
      { ...teacher, classId: student.classId },
      { ...student, classId: null },
    ])
      expect(() => services.configurations.loadForStudent(identity)).toThrow("run.unavailable");
    const first = await services.teaching.save(teacher, teachingInput());
    expect(services.configurations.loadForStudent({ ...student, classId: "class:two" })).toBeNull();
    expect(
      services.configurations.loadForStudent({ ...student, userId: "s2", classId: "class:two" }),
    ).toBeNull();
    const input = { ...teachingInput(), expectedVersion: first.content.configurationVersion };
    const results = await Promise.allSettled([
      services.teaching.save(teacher, input),
      services.teaching.save(teacher, input),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(({ status }) => status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected).toHaveProperty("0.reason.code", "request.conflict");
    expect(
      database.readOne("SELECT COUNT(*) AS count FROM marea_class_teaching_revisions"),
    ).toEqual({ count: 2n });
    services.configurations.saveRevision({
      classId: "class:two",
      teacherId: "t2",
      createdAt: clock.now(),
      expectedVersion: null,
      configuration: teachingConfiguration("free", "revision:other"),
    });
    expect(() => {
      database.execute(
        "UPDATE marea_current_class_teaching SET revision_id = 'revision:other' WHERE class_id = 'class:one'",
      );
    }).toThrow();
  });

  it("rechecks authorization after async reads before making a revision current", async () => {
    let revoked = false;
    const original = source;
    const revoking: SkillSource = {
      list: (kind) => original.list(kind),
      load: async (id) => {
        const bundle = await original.load(id);
        if (!revoked) {
          database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
          revoked = true;
        }
        return bundle;
      },
    };
    services = servicesFor(database, revoking);
    await expect(services.teaching.save(teacher, teachingInput())).rejects.toThrow(
      "dashboard.forbidden",
    );
    expect(
      database.readOne("SELECT COUNT(*) AS count FROM marea_class_teaching_revisions"),
    ).toEqual({ count: 0n });
  });

  it("rejects evaluation, wrong scopes, missing references and corrupted reference digests", async () => {
    await services.teaching.save(teacher, teachingInput());
    const opened = services.runs.open(student, newRun("scope"));
    const request = RunSkillRequestSchema.parse({
      protocolVersion: "0.1",
      requestId: "request:scope",
      runId: opened.lease.runId,
      snapshotId: opened.snapshot.id,
      skillId: "teacher/t1/testing",
    });
    for (const change of [
      { runId: "run:foreign" },
      { snapshotId: "snapshot:foreign" },
      { skillId: "marea/review" },
      { skillId: "teacher/t2/testing" },
    ])
      expect(() =>
        services.skills.read(
          opened.lease.token,
          RunSkillRequestSchema.parse({ ...request, ...change }),
        ),
      ).toThrow("run.unavailable");
    expect(() => services.skills.read("unknown-token", request)).toThrow("run.unavailable");
    const second = services.runs.open(student, newRun("other-scope"));
    expect(() =>
      services.skills.read(
        opened.lease.token,
        RunSkillRequestSchema.parse({
          ...request,
          runId: second.lease.runId,
          snapshotId: second.snapshot.id,
        }),
      ),
    ).toThrow("run.unavailable");
    const invalidReference = {
      ...opened.snapshot,
      didacticSkills: [
        {
          id: teachingSkill("didactic").id,
          digest: Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`),
        },
      ],
    };
    database.execute("UPDATE marea_run_snapshots SET public_snapshot_json = ?2 WHERE id = ?1", [
      opened.snapshot.id,
      JSON.stringify(invalidReference),
    ]);
    expect(() => services.skills.read(opened.lease.token, request)).toThrow("run.unavailable");
    database.execute("UPDATE marea_run_snapshots SET public_snapshot_json = ?2 WHERE id = ?1", [
      opened.snapshot.id,
      JSON.stringify({ ...opened.snapshot, agentMode: "free" }),
    ]);
    expect(() => services.skills.read(opened.lease.token, request)).toThrow("run.unavailable");
    database.execute("UPDATE marea_run_snapshots SET public_snapshot_json = ?2 WHERE id = ?1", [
      opened.snapshot.id,
      JSON.stringify({ ...opened.snapshot, id: "snapshot:corrupt" }),
    ]);
    expect(() => services.skills.read(opened.lease.token, request)).toThrow("run.unavailable");
  });

  it("serves frozen skills over authenticated HTTP without caching or private content", async () => {
    await services.teaching.save(teacher, teachingInput());
    const opened = services.runs.open(student, newRun("http"));
    const body = RunSkillRequestSchema.parse({
      protocolVersion: "0.1",
      requestId: "request:http-skill",
      runId: opened.lease.runId,
      snapshotId: opened.snapshot.id,
      skillId: "teacher/t1/testing",
    });
    const application = createApplication({
      ...createServices(new RecordingProvider()),
      runs: services.runs,
      skills: services.skills,
    });
    const response = await application.fetch(
      httpRequest("/v1/runs/skills/read", body, opened.lease.token),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const content = RunSkillResponseSchema.parse(await response.json());
    expect(content).toEqual({ ...body, skillId: undefined, skill: teachingSkill("didactic") });
    expect(JSON.stringify(content)).not.toContain("Synthetic evaluation");
    expect(JSON.stringify(content)).not.toContain("synthetic-model");
    for (const [credential, status] of [
      [undefined, 401],
      ["not-a-run-lease", 409],
    ] as const)
      expect(
        (await application.fetch(httpRequest("/v1/runs/skills/read", body, credential))).status,
      ).toBe(status);
    const invalid = await application.fetch(
      httpRequest("/v1/runs/skills/read", { ...body, path: "/private" }, opened.lease.token),
    );
    expect(invalid.status).toBe(400);
    const evaluation = await application.fetch(
      httpRequest("/v1/runs/skills/read", { ...body, skillId: "marea/review" }, opened.lease.token),
    );
    expect(evaluation.status).toBe(409);
    expect(await evaluation.text()).not.toContain("evaluation");
  });
});
