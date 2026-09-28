import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { SkillIdSchema } from "@marea/protocol";

import {
  BASE,
  buildComposition,
  COOKIE,
  ORIGIN,
  routeRequest,
} from "./product-http-composition.fixture.js";
import {
  draft,
  request as authoringRequest,
} from "../teaching/authoring-runtime/skill-authoring-service.fixture.js";
import {
  newRun,
  student as teachingStudent,
} from "../../test-support/teaching-integration.fixture.js";
import type { NodeSqliteTestDatabase } from "../../test-support/node-sqlite-database.boundary.js";

describe("composed product skill-authoring HTTP", () => {
  it("round-trips through the product factory and preserves resource bytes", async () => {
    const harness = await buildComposition();
    try {
      const configurationBefore = harness.database.readOne(
        "SELECT revision_id FROM marea_current_class_teaching WHERE class_id = 'class:one'",
      );
      const snapshotBefore = harness.database.readOne(
        "SELECT public_snapshot_json, teaching_json FROM marea_run_snapshots JOIN marea_run_teaching_snapshots ON marea_run_teaching_snapshots.snapshot_id = marea_run_snapshots.id WHERE marea_run_snapshots.id = 'snapshot:composition'",
      );
      const save = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "composed"),
            expectedDigest: null,
          }),
        ),
      );
      expect(save.status).toBe(200);
      const saved = (await save.json()) as {
        skill: { digest: string; id: string; files: { path: string; content: string }[] };
      };
      expect(saved.skill.id).toBe("teacher/t1/composed");
      expect(saved.skill.files.find((file) => file.path === "resources/notes.txt")?.content).toBe(
        "The practice resource.",
      );

      const read = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/read",
          authoringRequest("class:one", "skill-authoring-read", {
            target: { scope: "personal", slug: "composed" },
          }),
        ),
      );
      expect(read.status).toBe(200);
      const readBody = (await read.json()) as { skill: { id: string } };
      expect(readBody.skill.id).toBe("teacher/t1/composed");

      const beforeValidate = await harness.catalog.load(SkillIdSchema.parse("teacher/t1/composed"));
      const validate = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/validate",
          authoringRequest("class:one", "skill-authoring-validate", {
            draft: draft("didactic", "composed", "Changed description"),
          }),
        ),
      );
      expect(validate.status).toBe(200);
      const validateBody = (await validate.json()) as { skill: { digest: string } };
      expect(validateBody.skill.digest).not.toBe(saved.skill.digest);
      expect((await harness.store.read("teacher/t1/composed"))?.digest).toBe(
        beforeValidate?.digest,
      );

      const replace = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "composed", "Changed description"),
            expectedDigest: saved.skill.digest,
          }),
        ),
      );
      expect(replace.status).toBe(200);
      const replaced = (await replace.json()) as {
        skill: { digest: string; files: { path: string; content: string }[] };
      };
      expect(replaced.skill.digest).toBe(validateBody.skill.digest);
      expect(
        replaced.skill.files.find((file) => file.path === "resources/notes.txt")?.content,
      ).toBe("The practice resource.");
      const stale = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "composed", "stale"),
            expectedDigest: saved.skill.digest,
          }),
        ),
      );
      expect(stale.status).toBe(409);
      const readback = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/read",
          authoringRequest("class:one", "skill-authoring-read", {
            target: { scope: "personal", slug: "composed" },
          }),
        ),
      );
      expect(((await readback.json()) as { skill: { digest: string } }).skill.digest).toBe(
        replaced.skill.digest,
      );

      const catalogSkill = await harness.catalog.load(SkillIdSchema.parse("marea/core-practice"));
      expect(catalogSkill).not.toBeNull();
      const copy = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/copy",
          authoringRequest("class:one", "skill-authoring-copy", {
            slug: "copied-core",
            sourceDigest: catalogSkill?.digest,
            sourceSkillId: "marea/core-practice",
          }),
        ),
      );
      expect(copy.status).toBe(200);
      const copyBody = (await copy.json()) as { skill: { id: string } };
      expect(copyBody.skill.id).toBe("teacher/t1/copied-core");

      const center = await harness.catalog.load(
        SkillIdSchema.parse("center/center:one/core-practice"),
      );
      expect(center).not.toBeNull();
      const centerCopy = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/copy",
          authoringRequest("class:one", "skill-authoring-copy", {
            slug: "copied-center",
            sourceDigest: center?.digest,
            sourceSkillId: "center/center:one/core-practice",
          }),
        ),
      );
      expect(centerCopy.status).toBe(200);
      expect(((await centerCopy.json()) as { skill: { id: string } }).skill.id).toBe(
        "teacher/t1/copied-center",
      );
      const centerRead = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/read",
          authoringRequest("class:one", "skill-authoring-read", {
            target: { scope: "catalog", skillId: "center/center:one/core-practice" },
          }),
        ),
      );
      expect(centerRead.status).toBe(200);
      expect(((await centerRead.json()) as { editable: boolean }).editable).toBe(false);

      const coreRead = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/read",
          authoringRequest("class:one", "skill-authoring-read", {
            target: { scope: "catalog", skillId: "marea/core-practice" },
          }),
        ),
      );
      expect(coreRead.status).toBe(200);
      expect(((await coreRead.json()) as { editable: boolean }).editable).toBe(false);

      expect(configurationBefore).toEqual({ revision_id: "revision:1" });
      const after = harness.database.readOne(
        "SELECT revision_id FROM marea_current_class_teaching WHERE class_id = 'class:one'",
      );
      expect(after).toEqual(configurationBefore);
      const snapshotAfter = harness.database.readOne(
        "SELECT public_snapshot_json, teaching_json FROM marea_run_snapshots JOIN marea_run_teaching_snapshots ON marea_run_teaching_snapshots.snapshot_id = marea_run_snapshots.id WHERE marea_run_snapshots.id = 'snapshot:composition'",
      );
      expect(snapshotAfter).toEqual(snapshotBefore);
    } finally {
      harness.database.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("rechecks SQLite membership at the real W03 publication guard and preserves disk/catalog state", async () => {
    const harness = await buildComposition({ revokeDuringPublication: true });
    try {
      const before = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "revoked-publication"),
            expectedDigest: null,
          }),
        ),
      );
      expect(before.status).toBe(403);
      expect(await harness.store.read("teacher/t1/revoked-publication")).toBeNull();
      await expect(
        readFile(join(harness.teacherRoot, "didactic", "revoked-publication", "SKILL.md")),
      ).rejects.toThrow();
      expect(
        await harness.catalog.load(SkillIdSchema.parse("teacher/t1/revoked-publication")),
      ).toBeNull();
      expect(
        harness.database.readOne(
          "SELECT COUNT(*) AS count FROM marea_teacher_classes WHERE teacher_id = 't1' AND class_id = 'class:one'",
        ),
      ).toEqual({ count: 0n });
    } finally {
      harness.database.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("keeps an actually selected and captured personal revision immutable when replacing that same skill", async () => {
    const harness = await buildComposition();
    try {
      const create = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "testing", "Original selected revision"),
            expectedDigest: null,
          }),
        ),
      );
      expect(create.status).toBe(200);
      const original = (await create.json()) as {
        skill: {
          digest: string;
          files: { path: string; content: string; sizeBytes: number }[];
          id: string;
        };
      };
      expect(original.skill.id).toBe("teacher/t1/testing");

      const select = await harness.app.fetch(
        routeRequest("/api/v1/dashboard/teaching/save", {
          classId: "class:one",
          expectedVersion: "revision:1",
          kind: "teaching-configuration-save",
          protocolVersion: "0.1",
          requestId: "request:select-testing",
          settings: {
            agentMode: "tutoring",
            automaticEvaluation: false,
            classInstructions: {
              free: "Free instructions.",
              tutoring: "Tutoring instructions.",
            },
            selection: {
              didactic: [{ id: original.skill.id, digest: original.skill.digest }],
              evaluation: [],
            },
          },
        }),
      );
      expect(select.status).toBe(200);
      const opened = harness.teachingServices.runs.open(
        teachingStudent,
        newRun("selected-testing"),
      );
      const captured = harness.runSkills.loadRunTeaching(opened.lease.runId, opened.snapshot.id);
      const capturedSkill = captured?.teaching.didacticSkills.find(
        ({ id }) => id === original.skill.id,
      );
      expect(capturedSkill).toEqual(original.skill);

      const persistedBefore = harness.database.readOne(
        "SELECT current.revision_id, revisions.configuration_json FROM marea_current_class_teaching current JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id WHERE current.class_id = 'class:one'",
      );
      const persistedConfiguration = JSON.parse(String(persistedBefore?.configuration_json)) as {
        selection: { didactic: { id: string; digest: string }[] };
      };
      expect(persistedConfiguration.selection.didactic).toEqual([
        { id: original.skill.id, digest: original.skill.digest },
      ]);

      const replace = await harness.app.fetch(
        routeRequest(
          "/api/v1/dashboard/skill-authoring/save",
          authoringRequest("class:one", "skill-authoring-save", {
            draft: draft("didactic", "testing", "Replacement selected revision"),
            expectedDigest: original.skill.digest,
          }),
        ),
      );
      expect(replace.status).toBe(200);
      const replacement = (await replace.json()) as {
        skill: {
          digest: string;
          id: string;
          files: { path: string; content: string; sizeBytes: number }[];
        };
      };
      expect(replacement.skill.id).toBe(original.skill.id);
      expect(replacement.skill.digest).not.toBe(original.skill.digest);
      expect(await harness.catalog.load(SkillIdSchema.parse(original.skill.id))).toEqual(
        replacement.skill,
      );

      const persistedAfter = harness.database.readOne(
        "SELECT current.revision_id, revisions.configuration_json FROM marea_current_class_teaching current JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id WHERE current.class_id = 'class:one'",
      );
      expect(persistedAfter).toEqual(persistedBefore);
      expect(
        harness.runSkills.loadRunTeaching(opened.lease.runId, opened.snapshot.id)?.teaching
          .didacticSkills,
      ).toContainEqual(original.skill);
      expect(
        harness.runSkills.loadRunTeaching(opened.lease.runId, opened.snapshot.id)?.teaching
          .didacticSkills,
      ).not.toContainEqual(replacement.skill);
    } finally {
      harness.database.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  it("enforces teacher cookie, membership, host and origin at the composed root", async () => {
    const harness = await buildComposition();
    try {
      const body = authoringRequest("class:one", "skill-authoring-read", {
        target: { scope: "catalog", skillId: "marea/core-practice" },
      });
      expect(
        (await harness.app.fetch(routeRequest("/api/v1/dashboard/skill-authoring/read", body, "")))
          .status,
      ).toBe(401);
      expect(
        (
          await harness.app.fetch(
            routeRequest(
              "/api/v1/dashboard/skill-authoring/read",
              body,
              "marea_teacher_session=student-composition-token",
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await harness.app.fetch(
            routeRequest(
              "/api/v1/dashboard/skill-authoring/read",
              body,
              COOKIE,
              "https://attacker.test",
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await harness.app.fetch(
            new Request(`${BASE}/api/v1/dashboard/skill-authoring/read`, {
              body: JSON.stringify(body),
              headers: {
                cookie: COOKIE,
                host: "attacker.test",
                origin: ORIGIN,
                "content-type": "application/json",
              },
              method: "POST",
            }),
          )
        ).status,
      ).toBe(403);
      const saveBody = authoringRequest("class:one", "skill-authoring-save", {
        draft: draft("didactic", "policy-check"),
        expectedDigest: null,
      });
      const noOrigin = routeRequest("/api/v1/dashboard/skill-authoring/save", saveBody, COOKIE, "");
      noOrigin.headers.delete("origin");
      expect((await harness.app.fetch(noOrigin)).status).toBe(403);
      expect(
        (
          await harness.app.fetch(
            routeRequest("/api/v1/dashboard/skill-authoring/save?search=true", saveBody),
          )
        ).status,
      ).toBe(403);
      databaseRevoke(harness.database);
      expect(
        (await harness.app.fetch(routeRequest("/api/v1/dashboard/skill-authoring/read", body)))
          .status,
      ).toBe(403);
      for (const [cookie, classId] of [
        [COOKIE, "class:two"],
        ["marea_teacher_session=student-composition-token", "class:one"],
        ["marea_teacher_session=other-teacher-composition-token", "class:two"],
      ] as const) {
        expect(
          (
            await harness.app.fetch(
              routeRequest(
                "/api/v1/dashboard/skill-authoring/read",
                authoringRequest(classId, "skill-authoring-read", {
                  target: { scope: "catalog", skillId: "marea/core-practice" },
                }),
                cookie,
              ),
            )
          ).status,
        ).toBe(403);
      }
    } finally {
      harness.database.close();
      await rm(harness.root, { force: true, recursive: true });
    }
  });
});

function databaseRevoke(database: NodeSqliteTestDatabase): void {
  database.execute(
    "DELETE FROM marea_teacher_classes WHERE teacher_id = 't1' AND class_id = 'class:one'",
  );
}
