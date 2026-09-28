import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIdSchema } from "@marea/protocol";
import { governanceServiceFixture } from "../../governance/service.fixture.js";
import {
  GovernanceSourceCoordinator,
  type GovernanceSourceOptions,
} from "./governance-source-coordinator.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { skill, saveRequest } from "../../teaching/authoring/authoring-test-support.fixture.js";
import type { GovernanceClassScope } from "../../governance/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { SkillSource } from "../../teaching/skills/skill-source.js";

describe("governance exchange source ownership and real writer gates", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  let root: string;
  let center: SkillAuthoringStore;
  let teacher: SkillAuthoringStore;
  let options: GovernanceSourceOptions;
  beforeEach(async () => {
    f = governanceServiceFixture();
    root = realpathSync(mkdtempSync(join(tmpdir(), "marea-governance-source-")));
    center = new SkillAuthoringStore(join(root, "center"), { source: "center", id: "center:a" });
    teacher = new SkillAuthoringStore(join(root, "teacher"), {
      source: "teacher",
      id: "user:admin",
    });
    await center.initialize();
    await teacher.initialize();
    await center.create(saveRequest("didactic", "center-skill", skill("center-skill")));
    await teacher.create(saveRequest("didactic", "teacher-skill", skill("teacher-skill")));
    options = {
      core: f.source,
      repository: f.repository,
      clock: f.clock,
      centers: new Map([["center:a", center]]),
      teachers: new Map([["user:admin", teacher]]),
      operatorPersonalOwnerForClass: new Map(),
      membership: new SqliteTeachingConfigurationRepository(f.database),
    };
  });
  afterEach(() => {
    f.database.close();
    rmSync(root, { recursive: true, force: true });
  });
  function scope(operator = false): GovernanceClassScope {
    return { context: operator ? f.context() : f.admin, centerId: "center:a", classId: "class:a" };
  }
  function assign() {
    f.repository.commitChangeMembership({
      context: f.context(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:admin",
      state: "active",
      expectedVersion: null,
    });
  }

  it("uses core and center sources without turning administration into personal-source permission", async () => {
    const coordinator = new GovernanceSourceCoordinator(options);
    await coordinator.withSource(scope(), async (source, assertCurrent) => {
      expect((await source.list("didactic")).map((entry) => entry.id)).toEqual([
        "center/center:a/center-skill",
      ]);
      expect(await source.load(SkillIdSchema.parse("teacher/user:admin/teacher-skill"))).toBeNull();
      expect(await source.load(f.evaluator.id)).toEqual(f.evaluator);
      assertCurrent();
    });
    assign();
    await coordinator.withSource(scope(), async (source) => {
      expect((await source.list("didactic")).map((entry) => entry.id)).toEqual([
        "center/center:a/center-skill",
        "teacher/user:admin/teacher-skill",
      ]);
    });
  });

  it("keeps both owner gates through publication and releases them on failure", async () => {
    assign();
    const coordinator = new GovernanceSourceCoordinator(options);
    const started = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const order: string[] = [];
    const held = coordinator.withSource(scope(), async (source, assertCurrent) => {
      await source.list("didactic");
      started.resolve(undefined);
      await finish.promise;
      assertCurrent();
      order.push("publication");
      throw new Error("Synthetic publication failed");
    });
    const rejection = expect(held).rejects.toThrow("Synthetic publication failed");
    await started.promise;
    const centerWrite = center
      .create(saveRequest("didactic", "later-center", skill("later-center")))
      .then(() => {
        order.push("center-write");
      });
    const teacherWrite = teacher
      .create(saveRequest("didactic", "later-teacher", skill("later-teacher")))
      .then(() => {
        order.push("teacher-write");
      });
    await Promise.resolve();
    expect(order).toEqual([]);
    finish.resolve(undefined);
    await rejection;
    await Promise.all([centerWrite, teacherWrite]);
    expect(order[0]).toBe("publication");
    expect(order.slice(1).sort()).toEqual(["center-write", "teacher-write"]);
  });

  it("invalidates escaped publication guards and rechecks personal membership while held", async () => {
    assign();
    const coordinator = new GovernanceSourceCoordinator(options);
    const escaped = await coordinator.withSource(scope(), async (source, guard) => {
      await source.list("didactic");
      f.database.execute(
        "UPDATE marea_governance_memberships SET state = 'revoked' WHERE user_id = 'user:admin'",
      );
      expect(guard).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
      return guard;
    });
    expect(escaped).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("uses only the explicitly configured personal operator owner and snapshots the maps", async () => {
    const owners = new Map([["class:a", "user:admin"]]);
    const coordinator = new GovernanceSourceCoordinator({
      ...options,
      operatorPersonalOwnerForClass: owners,
    });
    owners.clear();
    await coordinator.withSource(scope(true), async (source) => {
      expect(
        await source.load(SkillIdSchema.parse("teacher/user:admin/teacher-skill")),
      ).not.toBeNull();
    });
    await new GovernanceSourceCoordinator(options).withSource(scope(true), async (source) => {
      expect(await source.load(SkillIdSchema.parse("teacher/user:admin/teacher-skill"))).toBeNull();
    });
  });

  it("denies revoked scope before acquiring any owner and again after waiting for an owner", async () => {
    const coordinator = new GovernanceSourceCoordinator(options);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const held = center.withReadSource(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const operation = vi.fn(() => Promise.resolve());
    const queued = coordinator.withSource(scope(), operation);
    const rejection = expect(queued).rejects.toMatchObject({ code: "dashboard.forbidden" });
    f.database.execute(
      "UPDATE marea_center_memberships SET capability = 'member' WHERE user_id = 'user:admin'",
    );
    release.resolve(undefined);
    await held;
    await rejection;
    expect(operation).not.toHaveBeenCalled();
    const acquire = vi.spyOn(center, "withReadSource");
    expect(() => coordinator.withSource(scope(), operation)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it("uses a deterministic reverse-owner order and rejects ambiguous shared roots", async () => {
    assign();
    const acquired: string[] = [];
    for (const store of [center, teacher]) {
      const original = store.withReadSource.bind(store);
      vi.spyOn(store, "withReadSource").mockImplementation(function <T>(
        operation: (source: SkillSource) => Promise<T>,
      ) {
        acquired.push(store.coordinationKey);
        return original(operation);
      });
    }
    await new GovernanceSourceCoordinator(options).withSource(scope(), async (source) => {
      expect(await source.list("didactic")).toHaveLength(2);
    });
    expect(acquired).toEqual([center.coordinationKey, teacher.coordinationKey]);
    acquired.length = 0;
    const reversed = new GovernanceSourceCoordinator({
      ...options,
      centers: new Map([["center:a", teacher]]),
      teachers: new Map([["user:admin", center]]),
    });
    await reversed.withSource(scope(), async (source) => {
      expect(await source.list("didactic")).toHaveLength(2);
    });
    expect(acquired).toEqual([center.coordinationKey, teacher.coordinationKey]);
    const ambiguous = new GovernanceSourceCoordinator({
      ...options,
      teachers: new Map([["user:admin", center]]),
    });
    expect(() => ambiguous.withSource(scope(), () => Promise.resolve())).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
  });

  it.each([new Error("Membership storage failed"), new TeacherDomainError("request.conflict")])(
    "does not swallow unexpected membership failures",
    (error) => {
      const coordinator = new GovernanceSourceCoordinator({
        ...options,
        membership: {
          requireTeacherClass: () => {
            throw error;
          },
        },
      });
      expect(() => coordinator.withSource(scope(), () => Promise.resolve())).toThrow(error);
    },
  );
});
