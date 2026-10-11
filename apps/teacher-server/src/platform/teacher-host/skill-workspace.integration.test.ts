import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { SkillAuthoringSaveResponseSchema, SkillWorkspaceResponseSchema } from "@marea/protocol";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "./teacher-host.fixture.js";
import { syntheticProfileHostServices } from "./profile-host-options.fixture.js";
import { startTeacherHost } from "./teacher-host.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { replaceTeachingSkills } from "../../teaching/configuration/replace-skills.js";

afterEach(cleanupTeacherHostInstallations);
it("creates, assigns and revises a personal skill through the production HTTP host and persists it across restart", async () => {
  const f = teacherHostInstallation();
  const store = initializeSqliteStorage({
    databasePath: f.databasePath,
    schema: "skill-assignments",
  });
  store.database.execute("INSERT INTO marea_classes VALUES ('class:ready','ready','Ready')");
  store.database.execute("INSERT INTO marea_teacher_classes VALUES ('user:teacher','class:ready')");
  store.database.execute(
    "INSERT INTO marea_users VALUES ('student:ana','ana','hash:password','student','Ana','class:ready')",
  );
  new SqliteTeachingConfigurationRepository(store.database).saveRevision({
    classId: "class:ready",
    teacherId: "user:teacher",
    expectedVersion: null,
    createdAt: "now",
    configuration: replaceTeachingSkills(teachingConfiguration(), [], [], "revision:start"),
  });
  store.close();
  let sequence = 0;
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    ...syntheticProfileHostServices(() => `revision:${String(++sequence)}`),
  });
  if (host.state !== "ready" || !f.served.fetch) throw new Error("host");
  const fetch = f.served.fetch;
  const post = (path: string, body: object, cookie = "") =>
    fetch(
      new Request(`http://teacher.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "teacher.test",
          origin: "https://dashboard.test",
          cookie,
        },
        body: JSON.stringify(body),
      }),
    );
  const login = await post("/v1/auth/login", {
    protocolVersion: "0.1",
    requestId: "request:login",
    kind: "credential-login",
    credentials: { login: "teacher", password: "teacher-password" },
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("login");
  const envelope = { protocolVersion: "0.1", requestId: "request:skills", classId: "class:ready" };
  const workspace = async (operation: object) => {
    const response = await post(
      "/api/v1/dashboard/skill-workspace",
      { ...envelope, ...operation },
      cookie,
    );
    expect(response.status).toBe(200);
    return SkillWorkspaceResponseSchema.parse(await response.json());
  };
  const save = async (instructions: string, digest: string | null) => {
    const response = await post(
      "/api/v1/dashboard/skill-authoring/save",
      {
        ...envelope,
        kind: "skill-authoring-save",
        expectedDigest: digest,
        draft: {
          slug: "testing",
          kind: "didactic",
          files: [
            {
              path: "SKILL.md",
              content: `---\nname: testing\ndescription: Practice testing\nmetadata:\n  title: Unit testing\n---\n${instructions}`,
            },
          ],
        },
      },
      cookie,
    );
    expect(response.status).toBe(200);
    return SkillAuthoringSaveResponseSchema.parse(await response.json()).skill;
  };
  try {
    const original = await save("Ask for one test.", null);
    const library = await workspace({ kind: "library", after: null });
    if (library.kind !== "library") throw new Error("library");
    expect(library.skills.some((skill) => skill.title === "Unit testing")).toBe(true);
    await workspace({
      kind: "assign",
      expectedClassVersion: "revision:start",
      students: [{ studentId: "student:ana", expectedVersion: null }],
      selection: [{ id: original.id, digest: original.digest }],
    });
    const usage = await workspace({ kind: "usage", skillId: original.id });
    if (usage.kind !== "usage") throw new Error("usage");
    expect(usage.uses).toEqual([
      { classId: "class:ready", displayName: "Ready", classroom: false, students: 1 },
    ]);
    const updated = await save("Ask for a boundary case.", original.digest);
    await workspace({
      kind: "apply",
      skillId: updated.id,
      digest: updated.digest,
      expectedUsage: usage.version,
    });
    expect(await workspace({ kind: "students", after: null })).toMatchObject({
      students: [
        { studentId: "student:ana", selection: [{ id: updated.id, digest: updated.digest }] },
      ],
    });
    const forbidden = await post("/api/v1/dashboard/skill-workspace", {
      ...envelope,
      kind: "students",
      after: null,
    });
    expect(forbidden.status).toBe(401);
  } finally {
    await host.stop();
  }
  const reopened = initializeSqliteStorage({
    databasePath: f.databasePath,
    schema: "skill-assignments",
  });
  try {
    const repository = new SqliteTeachingConfigurationRepository(reopened.database);
    const student = repository.loadForStudent({
      userId: "student:ana",
      classId: "class:ready",
      role: "student",
      displayName: "Ana",
    });
    expect(student?.content.didacticSkills[0]?.files[0]?.content).toContain(
      "Ask for a boundary case.",
    );
    expect(
      repository.loadForTeacher("user:teacher", "class:ready")?.content.didacticSkills,
    ).toEqual([]);
    expect(student?.content.evaluationSkills).toEqual([]);
  } finally {
    reopened.close();
  }
});
