import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sha256DigestSchema, SkillIdSchema } from "@marea/protocol";
import { BundledSkillSource } from "../skills/bundled-skill-source.boundary.js";
import type { SkillBundle, SkillSource } from "../skills/skill-source.js";
import { TeacherDomainError } from "../../identity/errors.js";
import {
  createProductSkillAuthoringService,
  type ProductSkillAuthoringWriter,
} from "./skill-authoring-service.js";
import {
  draft,
  membership,
  personalId,
  realWriter,
  request,
  serviceOptions,
  sourceFrom,
  teacher,
  temporaryRootRegistry,
  writeCoreSkill,
} from "./skill-authoring-service.fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ProductSkillAuthoringService copy", () => {
  const temporaryRoots = temporaryRootRegistry();

  afterEach(() => temporaryRoots.cleanup());

  it("copies an authorized core bundle completely and changes only frontmatter name", async () => {
    const real = await realWriter();
    temporaryRoots.add(real.root);
    const coreRoot = await mkdtemp(join(tmpdir(), "marea-teaching-core-"));
    temporaryRoots.add(coreRoot);
    await writeCoreSkill(coreRoot);
    const core = await new BundledSkillSource(coreRoot).load(
      "marea/core-practice" as import("@marea/protocol").SkillId,
    );
    if (core === null) throw new Error("The synthetic core skill was not created.");
    const auth = membership();
    const service = createProductSkillAuthoringService(
      serviceOptions(auth, real.store, sourceFrom([core])),
    );
    const copied = await service.copy(
      teacher,
      request("class:physics", "skill-authoring-copy", {
        slug: "personal-practice",
        sourceDigest: core.digest,
        sourceSkillId: core.id,
      }),
    );
    const skillFile = copied.skill.files.find(({ path }) => path === "SKILL.md");
    const resource = copied.skill.files.find(({ path }) => path === "resources/old-name.txt");
    expect(copied.skill.id).toBe(personalId("personal-practice"));
    expect(copied.skill.description).toBe("Core practice");
    expect(copied.skill.license).toBe("MIT");
    expect(skillFile?.content).toContain("name: personal-practice");
    expect(resource?.content).toBe("Keep the old slug in this resource: core-practice.");
    expect(skillFile?.content).toContain("old slug is only in this prose");
    expect(skillFile?.content).toBe(
      "---\nname: personal-practice\ndescription: Core practice\nlicense: MIT\n---\n\nThe old slug is only in this prose.\n",
    );

    const foreignTeacherBundle = {
      ...core,
      id: SkillIdSchema.parse("teacher/teacher:other/core-practice"),
      source: "teacher",
    } as SkillBundle;
    const catalogService = createProductSkillAuthoringService(
      serviceOptions(auth, real.store, sourceFrom([core, foreignTeacherBundle])),
    );
    expect(
      (
        await catalogService.read(
          teacher,
          request("class:physics", "skill-authoring-read", {
            target: { scope: "catalog", skillId: core.id },
          }),
        )
      ).editable,
    ).toBe(false);
    expect(
      (
        await catalogService.read(
          teacher,
          request("class:physics", "skill-authoring-read", {
            target: { scope: "catalog", skillId: foreignTeacherBundle.id },
          }),
        )
      ).editable,
    ).toBe(false);

    const recheckAuth = membership();
    const seeded = await real.store.create({
      expectedDigest: null,
      files: draft("didactic", "recheck-copy").files,
      kind: "didactic",
      slug: "recheck-copy",
    });
    let releaseSource!: (value: SkillBundle | null) => void;
    const coreSource = sourceFrom([core]);
    const waitingSource: SkillSource = {
      list: (kind) => coreSource.list(kind),
      load: () =>
        new Promise<SkillBundle | null>((resolve) => {
          releaseSource = resolve;
        }),
    };
    const noGuardCreate = vi.fn(() => Promise.resolve(seeded));
    const noGuardWriter: ProductSkillAuthoringWriter = {
      create: noGuardCreate,
      read: real.store.read.bind(real.store),
      replace: real.store.replace.bind(real.store),
      validate: real.store.validate.bind(real.store),
    };
    const recheckService = createProductSkillAuthoringService(
      serviceOptions(recheckAuth, noGuardWriter, waitingSource),
    );
    const pendingCopy = recheckService.copy(
      teacher,
      request("class:physics", "skill-authoring-copy", {
        slug: "recheck-copy",
        sourceDigest: core.digest,
        sourceSkillId: core.id,
      }),
    );
    expect(recheckAuth.calls).toHaveLength(1);
    recheckAuth.revoke();
    releaseSource(core);
    await expect(pendingCopy).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(noGuardCreate).not.toHaveBeenCalled();

    const guarded = await realWriter();
    temporaryRoots.add(guarded.root);
    const guardedAuth = membership();
    const guardedWriter: ProductSkillAuthoringWriter = {
      create: (save, guard) =>
        guarded.store.create(save, async () => {
          guardedAuth.revoke();
          await guard?.();
        }),
      read: guarded.store.read.bind(guarded.store),
      replace: guarded.store.replace.bind(guarded.store),
      validate: guarded.store.validate.bind(guarded.store),
    };
    const guardedService = createProductSkillAuthoringService(
      serviceOptions(guardedAuth, guardedWriter, sourceFrom([core])),
    );
    await expect(
      guardedService.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "guarded-copy",
          sourceDigest: core.digest,
          sourceSkillId: core.id,
        }),
      ),
    ).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(await guarded.store.read(personalId("guarded-copy"))).toBeNull();

    await expect(
      service.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "missing-copy",
          sourceDigest: core.digest,
          sourceSkillId: SkillIdSchema.parse("marea/missing"),
        }),
      ),
    ).rejects.toMatchObject({
      code: "SKILL_MISSING",
      message: "The authorized source skill is unavailable.",
    });
    await expect(
      service.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "stale-copy",
          sourceDigest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
          sourceSkillId: core.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "STALE_SKILL_DIGEST",
      message: "The source skill has changed; read it again before copying.",
    });
    await expect(
      service.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "personal-practice",
          sourceDigest: core.digest,
          sourceSkillId: core.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "SKILL_EXISTS" });
  });
});
