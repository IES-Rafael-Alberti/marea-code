import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillIdSchema } from "@marea/protocol";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernanceOperatorResources } from "./governance-operator-resources.boundary.js";
import { loadOperatorConfiguration } from "./operator-filesystem-loader.js";
import { governanceServiceFixture } from "../../governance/service.fixture.js";
import type { OperatorContext } from "../../governance/authority.js";
import { syntheticOperatorPolicy } from "../../teaching/configuration/dashboard-module.fixture.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { skill, saveRequest } from "../../teaching/authoring/authoring-test-support.fixture.js";
import { policyBytes } from "./governance-policy-publication.boundary.js";

describe("private operator resources use canonical existing policy and owner stores", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  let root: string;
  let context: OperatorContext;
  let resources: ReturnType<typeof createGovernanceOperatorResources>;
  const owner = { source: "teacher", id: "teacher-one" } as const;
  beforeEach(async () => {
    f = governanceServiceFixture();
    const owned = f.operatorContext();
    context = { authority: owned.authority, requestId: owned.requestId, now: owned.now };
    root = realpathSync(mkdtempSync(join(tmpdir(), "marea-operator-resources-")));
    const teacher = new SkillAuthoringStore(join(root, "teacher"), owner);
    const center = new SkillAuthoringStore(join(root, "center"), {
      source: "center",
      id: "center-one",
    });
    await teacher.initialize();
    await center.initialize();
    resources = createGovernanceOperatorResources({
      core: f.source,
      teachers: new Map([[owner.id, teacher]]),
      centers: new Map([["center-one", center]]),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const document = {
    version: 1 as const,
    classes: [{ classId: "class:a", policy: syntheticOperatorPolicy }],
  };

  it("validates without publication and publishes only a new private policy file", async () => {
    expect(await resources.validatePolicy({ ...context, document })).toEqual({ classes: 1 });
    const outputPath = join(root, "policy.json");
    expect(await resources.publishPolicy({ ...context, document, outputPath })).toEqual({
      classes: 1,
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(loadOperatorConfiguration(outputPath, 4_194_304).forClass("class:a")).toEqual(
      syntheticOperatorPolicy,
    );
    const bytes = readFileSync(outputPath);
    await expect(
      resources.publishPolicy({ ...context, document, outputPath }),
    ).rejects.toMatchObject({ code: "io-failure" });
    expect(readFileSync(outputPath)).toEqual(bytes);
    expect(readdirSync(root).sort()).toEqual(["center", "policy.json", "teacher"]);
  });

  it.each(["list", "read"] as const)(
    "rechecks ownership before a queued %s touches source content",
    async (operation) => {
      const release = Promise.withResolvers<undefined>();
      const source = {
        list: vi.fn(() => Promise.resolve([])),
        load: vi.fn(() => Promise.resolve(null)),
      };
      vi.spyOn(SkillAuthoringStore.prototype, "withReadSource").mockImplementation(async (work) => {
        await release.promise;
        return work(source);
      });
      const result =
        operation === "list"
          ? resources.listSkills({ ...context, owner, kind: "didactic" })
          : resources.readSkill({
              ...context,
              owner,
              skillId: SkillIdSchema.parse("teacher/teacher-one/practice"),
            });
      const rejection = expect(result).rejects.toThrow("Installation is not owned.");
      f.release();
      release.resolve(undefined);
      await rejection;
      expect(source.list).not.toHaveBeenCalled();
      expect(source.load).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown fields, incomplete budgets, duplicate classes and oversized policy", async () => {
    await expect(
      resources.validatePolicy({
        ...context,
        document: { ...document, secret: "hidden" },
      } as never),
    ).rejects.toThrow();
    const incomplete = structuredClone(document);
    for (const entry of incomplete.classes)
      Reflect.deleteProperty(entry.policy.route.providerRoute, "budget");
    await expect(
      resources.validatePolicy({ ...context, document: incomplete }),
    ).rejects.toMatchObject({ code: "invalid-document" });
    await expect(
      resources.validatePolicy({
        ...context,
        document: { ...document, classes: [...document.classes, ...document.classes] },
      }),
    ).rejects.toMatchObject({ code: "duplicate-class-id" });
    const oversized = {
      version: 1 as const,
      classes: Array.from({ length: 10000 }, (_, index) => ({
        classId: `class:${String(index)}`,
        policy: syntheticOperatorPolicy,
      })),
    };
    await expect(
      resources.validatePolicy({ ...context, document: oversized }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("accepts a complete policy at exactly four MiB and refuses one more byte", () => {
    const entrySize =
      Buffer.byteLength(JSON.stringify({ classId: "c00000", policy: syntheticOperatorPolicy })) + 1;
    const classes = Array.from({ length: Math.floor((4194304 - 30) / entrySize) }, (_, index) => ({
      classId: `c${String(index).padStart(5, "0")}`,
      policy: syntheticOperatorPolicy,
    }));
    const exact = { version: 1, classes };
    let remaining = 4194304 - Buffer.byteLength(JSON.stringify(exact));
    for (const entry of classes) {
      const padding = Math.min(121, remaining);
      entry.classId += "x".repeat(padding);
      remaining -= padding;
    }
    expect(remaining).toBe(0);
    expect(policyBytes(exact)).toHaveLength(4194304);
    const first = classes[0];
    if (first === undefined) throw new Error("Missing policy fixture");
    first.classId += "x";
    expect(() => policyBytes(exact)).toThrow("Operator configuration exceeds its byte bound.");
  });

  it("rejects relative paths, public parents, symlink parents and dangling destinations", async () => {
    for (const outputPath of ["policy.json", join(root, "bad\0file")])
      await expect(
        resources.publishPolicy({ ...context, document, outputPath }),
      ).rejects.toMatchObject({
        code: "invalid-path",
        message: "Choose a new absolute private output path.",
      });
    chmodSync(root, 0o755);
    await expect(
      resources.publishPolicy({ ...context, document, outputPath: join(root, "policy.json") }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    chmodSync(root, 0o700);
    symlinkSync(join(root, "absent"), join(root, "dangling"));
    await expect(
      resources.publishPolicy({ ...context, document, outputPath: join(root, "dangling") }),
    ).rejects.toMatchObject({ code: "io-failure" });
    symlinkSync(root, join(root, "alias"));
    await expect(
      resources.publishPolicy({
        ...context,
        document,
        outputPath: join(root, "alias", "policy.json"),
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    expect(readdirSync(root).some((name) => name.startsWith(".marea-policy-"))).toBe(false);
  });

  it("validates, creates, lists, reads and replaces through the configured owner store", async () => {
    const request = saveRequest("didactic", "practice", skill("practice"));
    const { expectedDigest: _expected, ...validation } = request;
    expect(_expected).toBeNull();
    expect(await resources.validateSkill({ ...context, owner, request: validation })).toMatchObject(
      { id: "teacher/teacher-one/practice" },
    );
    expect(await resources.listSkills({ ...context, owner, kind: "didactic" })).toEqual([]);
    const created = await resources.saveSkill({ ...context, owner, request });
    expect(created).not.toHaveProperty("files");
    expect(await resources.listSkills({ ...context, owner, kind: "didactic" })).toEqual([created]);
    expect(await resources.readSkill({ ...context, owner, skillId: created.id })).toMatchObject({
      digest: created.digest,
    });
    expect(
      (await resources.readSkill({ ...context, owner, skillId: created.id }))?.files,
    ).toHaveLength(1);
    await expect(resources.saveSkill({ ...context, owner, request })).rejects.toMatchObject({
      code: "SKILL_EXISTS",
    });
    const changed = await resources.saveSkill({
      ...context,
      owner,
      request: saveRequest("didactic", "practice", skill("practice", "Changed"), created.digest),
    });
    expect(changed.digest).not.toBe(created.digest);
    await expect(
      resources.saveSkill({
        ...context,
        owner,
        request: { ...request, expectedDigest: created.digest },
      }),
    ).rejects.toMatchObject({ code: "STALE_SKILL_DIGEST" });
    expect(
      await resources.listSkills({
        ...context,
        owner: { source: "center", id: "center-one" },
        kind: "didactic",
      }),
    ).toEqual([]);
    expect(
      await resources.listSkills({ ...context, owner: { source: "marea" }, kind: "evaluation" }),
    ).toHaveLength(1);
    expect(
      await resources.readSkill({
        ...context,
        owner: { source: "marea" },
        skillId: f.evaluator.id,
      }),
    ).toEqual(f.evaluator);
  });

  it("never accepts free-form roots, foreign skill IDs, unknown owners or core writes", async () => {
    const request = saveRequest("didactic", "practice", skill("practice"));
    await expect(
      resources.saveSkill({ ...context, owner: { source: "marea" }, request } as never),
    ).rejects.toThrow();
    await expect(
      resources.saveSkill({ ...context, owner: { ...owner, root }, request } as never),
    ).rejects.toThrow();
    await expect(
      resources.saveSkill({ ...context, owner, request: { ...request, extra: true } } as never),
    ).rejects.toThrow();
    await expect(
      resources.listSkills({ ...context, owner: { ...owner, id: "unknown" }, kind: "didactic" }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    await expect(
      resources.readSkill({
        ...context,
        owner,
        skillId: SkillIdSchema.parse("teacher/foreign/practice"),
      }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    await expect(
      resources.readSkill({
        ...context,
        owner: { source: "marea" },
        skillId: SkillIdSchema.parse("teacher/teacher-one/practice"),
      }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  });

  it("fails closed if the owner validator cannot materialize a bundle", async () => {
    vi.spyOn(SkillAuthoringStore.prototype, "validate").mockResolvedValueOnce(null);
    await expect(
      resources.validateSkill({
        ...context,
        owner,
        request: { kind: "didactic", slug: "practice", files: skill("practice") },
      }),
    ).rejects.toMatchObject({ code: "request.conflict" });
  });

  it("rechecks installation ownership before skill publication and after async reads", async () => {
    let checks = 0;
    const authority = {
      ...context.authority,
      assertOwned: () => {
        if (++checks === 2) throw new Error("Lost lock");
        return undefined;
      },
    };
    await expect(
      resources.saveSkill({
        ...context,
        authority,
        owner,
        request: saveRequest("didactic", "practice", skill("practice")),
      }),
    ).rejects.toThrow("Lost lock");
    expect(await resources.listSkills({ ...context, owner, kind: "didactic" })).toEqual([]);
    f.beforeLoad(() => {
      f.release();
      return Promise.resolve();
    });
    await expect(
      resources.readSkill({ ...context, owner: { source: "marea" }, skillId: f.evaluator.id }),
    ).rejects.toThrow("Installation is not owned.");
  });
});
