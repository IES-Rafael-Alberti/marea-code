import { Sha256DigestSchema, SkillIdSchema } from "@marea/protocol";
import type { SkillBundle } from "../skills/skill-source.js";
import { TeacherDomainError } from "../../identity/errors.js";
import {
  createProductSkillAuthoringService,
  createSkillAuthoringModule,
  SkillAuthoringServiceError,
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
  student,
  temporaryRootRegistry,
} from "./skill-authoring-service.fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

async function expectInvalidCanonical(operation: () => Promise<object>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SkillAuthoringServiceError);
    if (error instanceof SkillAuthoringServiceError) {
      expect(error.code).toBe("invalid-canonical");
      expect(error.message).toBe("Skill authoring operation failed: invalid-canonical.");
    }
    return;
  }
  throw new Error("Expected an invalid-canonical failure.");
}

describe("ProductSkillAuthoringService", () => {
  const temporaryRoots = temporaryRootRegistry();

  afterEach(() => temporaryRoots.cleanup());

  it("keeps service failure identity and safe messages stable", () => {
    const error = new SkillAuthoringServiceError("invalid-canonical");
    expect(error.name).toBe("SkillAuthoringServiceError");
    expect(error.message).toBe("Skill authoring operation failed: invalid-canonical.");
    expect(error.code).toBe("invalid-canonical");
  });

  it("validates without publishing, creates, reads, replaces, and preserves old results", async () => {
    const real = await realWriter();
    temporaryRoots.add(real.root);
    const auth = membership();
    const service = createProductSkillAuthoringService(
      serviceOptions(auth, real.store, sourceFrom([])),
    );
    expect(
      createSkillAuthoringModule(serviceOptions(auth, real.store, sourceFrom([]))).service,
    ).toBeDefined();

    const missing = await service.read(
      teacher,
      request("class:physics", "skill-authoring-read", {
        target: { scope: "personal", slug: "practice" },
      }),
    );
    expect(missing.skill).toBeNull();
    expect(missing.editable).toBe(false);

    const validated = await service.validate(
      teacher,
      request("class:physics", "skill-authoring-validate", { draft: draft() }),
    );
    expect(validated.skill.source).toBe("teacher");
    expect(validated.skill.id).toBe(personalId("practice"));
    expect(await real.store.read(personalId("practice"))).toBeNull();

    const saved = await service.save(
      teacher,
      request("class:physics", "skill-authoring-save", {
        draft: draft(),
        expectedDigest: null,
      }),
    );
    expect(saved.skill.description).toBe("Practice testing");

    const readback = await service.read(
      teacher,
      request("class:physics", "skill-authoring-read", {
        target: { scope: "personal", slug: "practice" },
      }),
    );
    expect(readback.editable).toBe(true);
    expect(readback.skill?.digest).toBe(saved.skill.digest);

    const replaced = await service.save(
      teacher,
      request("class:physics", "skill-authoring-save", {
        draft: draft("didactic", "practice", "Updated practice"),
        expectedDigest: saved.skill.digest,
      }),
    );
    expect(replaced.skill.description).toBe("Updated practice");
    expect(saved.skill.description).toBe("Practice testing");
    await expect(
      service.save(
        teacher,
        request("class:physics", "skill-authoring-save", {
          draft: draft("didactic", "practice", "Stale"),
          expectedDigest: saved.skill.digest,
        }),
      ),
    ).rejects.toMatchObject({ code: "STALE_SKILL_DIGEST" });
    await expect(
      service.save(
        teacher,
        request("class:physics", "skill-authoring-save", {
          draft: draft("didactic", "practice", "Duplicate"),
          expectedDigest: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "SKILL_EXISTS" });

    const evaluation = await service.validate(
      teacher,
      request("class:physics", "skill-authoring-validate", {
        draft: draft("evaluation", "rubric", "Private evaluation"),
      }),
    );
    expect(evaluation.skill.kind).toBe("evaluation");
  });

  it("requires teacher membership before private writer or source access", async () => {
    const auth = membership();
    const writer = vi.fn<(teacherId: string) => ProductSkillAuthoringWriter>();
    const source = vi.fn<(teacherId: string, classId: string) => never>();
    const service = createProductSkillAuthoringService({
      membership: auth.repository,
      sourceForTeacherClass: source,
      writerForTeacher: writer,
    });

    await expect(
      service.read(
        student,
        request("class:physics", "skill-authoring-read", {
          target: { scope: "personal", slug: "practice" },
        }),
      ),
    ).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(writer).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(auth.calls).toHaveLength(0);

    auth.revoke();
    await expect(
      service.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "copy",
          sourceDigest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
          sourceSkillId: SkillIdSchema.parse("marea/source"),
        }),
      ),
    ).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(source).not.toHaveBeenCalled();
  });

  it("does not resolve a private writer after initial membership is revoked", async () => {
    const auth = membership();
    auth.revoke();
    const writer = vi.fn<(teacherId: string) => ProductSkillAuthoringWriter>();
    const service = createProductSkillAuthoringService({
      membership: auth.repository,
      sourceForTeacherClass: () => {
        throw new Error("source must not be resolved");
      },
      writerForTeacher: writer,
    });

    await expect(
      service.save(
        teacher,
        request("class:physics", "skill-authoring-save", {
          draft: draft(),
          expectedDigest: null,
        }),
      ),
    ).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(writer).not.toHaveBeenCalled();
  });

  it("rechecks membership after awaited validation and catalog reads", async () => {
    const real = await realWriter();
    temporaryRoots.add(real.root);
    const auth = membership();
    let releaseValidation!: () => void;
    const validationReady = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const writer: ProductSkillAuthoringWriter = {
      create: real.store.create.bind(real.store),
      read: real.store.read.bind(real.store),
      replace: real.store.replace.bind(real.store),
      validate: async (kind, slug, files) => {
        await validationReady;
        return real.store.validate(kind, slug, files);
      },
    };
    const sourceReady = new Promise<SkillBundle | null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 0);
    });
    const source = {
      list: () => Promise.resolve([]),
      load: () => sourceReady,
    } as never;
    const service = createProductSkillAuthoringService(serviceOptions(auth, writer, source));
    const validation = service.validate(
      teacher,
      request("class:physics", "skill-authoring-validate", { draft: draft() }),
    );
    expect(auth.calls).toHaveLength(1);
    auth.revoke();
    releaseValidation();
    await expect(validation).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));

    const catalogAuth = membership();
    let releaseSource!: (value: null) => void;
    const waitingSource = {
      list: () => Promise.resolve([]),
      load: () =>
        new Promise<null>((resolve) => {
          releaseSource = resolve;
        }),
    };
    const catalogService = createProductSkillAuthoringService(
      serviceOptions(catalogAuth, real.store, waitingSource),
    );
    const read = catalogService.read(
      teacher,
      request("class:physics", "skill-authoring-read", {
        target: { scope: "catalog", skillId: SkillIdSchema.parse("marea/source") },
      }),
    );
    expect(catalogAuth.calls).toHaveLength(1);
    catalogAuth.revoke();
    releaseSource(null);
    await expect(read).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
  });

  it("checks the trusted guard immediately before real publication", async () => {
    const real = await realWriter();
    temporaryRoots.add(real.root);
    const auth = membership();
    const writer: ProductSkillAuthoringWriter = {
      create: (save, guard) =>
        real.store.create(save, async () => {
          auth.revoke();
          await guard?.();
        }),
      read: real.store.read.bind(real.store),
      replace: real.store.replace.bind(real.store),
      validate: real.store.validate.bind(real.store),
    };
    const service = createProductSkillAuthoringService(
      serviceOptions(auth, writer, sourceFrom([])),
    );
    await expect(
      service.save(
        teacher,
        request("class:physics", "skill-authoring-save", {
          draft: draft(),
          expectedDigest: null,
        }),
      ),
    ).rejects.toEqual(new TeacherDomainError("dashboard.forbidden"));
    expect(await real.store.read(personalId("practice"))).toBeNull();
  });

  it("fails closed for malformed canonical results and foreign personal results", async () => {
    const real = await realWriter();
    temporaryRoots.add(real.root);
    const auth = membership();
    const foreign: ProductSkillAuthoringWriter = {
      create: vi.fn<ProductSkillAuthoringWriter["create"]>(),
      read: () =>
        Promise.resolve({
          id: "teacher:other/practice",
          name: "practice",
          source: "teacher",
        } as never),
      replace: vi.fn<ProductSkillAuthoringWriter["replace"]>(),
      validate: () => Promise.resolve(null),
    };
    const service = createProductSkillAuthoringService(
      serviceOptions(auth, foreign, sourceFrom([])),
    );
    await expectInvalidCanonical(() =>
      service.read(
        teacher,
        request("class:physics", "skill-authoring-read", {
          target: { scope: "personal", slug: "practice" },
        }),
      ),
    );
    await expectInvalidCanonical(() =>
      service.validate(
        teacher,
        request("class:physics", "skill-authoring-validate", { draft: draft() }),
      ),
    );

    const wrongProvenanceService = createProductSkillAuthoringService(
      serviceOptions(
        auth,
        {
          ...foreign,
          read: () =>
            Promise.resolve({
              id: personalId("practice"),
              name: "practice",
              source: "marea",
            }),
        } as never,
        sourceFrom([]),
      ),
    );
    await expectInvalidCanonical(() =>
      wrongProvenanceService.read(
        teacher,
        request("class:physics", "skill-authoring-read", {
          target: { scope: "personal", slug: "practice" },
        }),
      ),
    );

    const mismatch = await realWriter();
    temporaryRoots.add(mismatch.root);
    const mismatchService = createProductSkillAuthoringService(
      serviceOptions(
        auth,
        {
          create: mismatch.store.create.bind(mismatch.store),
          read: mismatch.store.read.bind(mismatch.store),
          replace: mismatch.store.replace.bind(mismatch.store),
          validate: () =>
            mismatch.store.validate("didactic", "other", draft("didactic", "other").files),
        },
        sourceFrom([]),
      ),
    );
    await expectInvalidCanonical(() =>
      mismatchService.validate(
        teacher,
        request("class:physics", "skill-authoring-validate", { draft: draft() }),
      ),
    );

    const malformed = {
      criteria: [],
      description: "Bad source",
      digest: Sha256DigestSchema.parse(`sha256:${"c".repeat(64)}`),
      files: [{ content: "not frontmatter", path: "SKILL.md", sizeBytes: 14 }],
      id: SkillIdSchema.parse("marea/bad-source"),
      kind: "didactic",
      license: null,
      name: "bad-source",
      source: "marea",
      compatibility: null,
    } as SkillBundle;
    const malformedService = createProductSkillAuthoringService(
      serviceOptions(auth, foreign, sourceFrom([malformed])),
    );
    await expectInvalidCanonical(() =>
      malformedService.copy(
        teacher,
        request("class:physics", "skill-authoring-copy", {
          slug: "bad-copy",
          sourceDigest: malformed.digest,
          sourceSkillId: malformed.id,
        }),
      ),
    );

    const missingName = {
      ...malformed,
      digest: Sha256DigestSchema.parse(`sha256:${"e".repeat(64)}`),
      files: [
        { content: "---\ndescription: Missing name\n---\n", path: "SKILL.md", sizeBytes: 35 },
      ],
      id: SkillIdSchema.parse("marea/missing-name"),
      name: "missing-name",
    } as SkillBundle;
    const malformedYaml = {
      ...malformed,
      digest: Sha256DigestSchema.parse(`sha256:${"f".repeat(64)}`),
      files: [{ content: "---\nname: [\n---\n", path: "SKILL.md", sizeBytes: 17 }],
      id: SkillIdSchema.parse("marea/malformed-yaml"),
      name: "malformed-yaml",
    } as SkillBundle;
    const malformedWithName = {
      ...malformed,
      digest: Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`),
      files: [
        {
          content: "---\nname: malformed-with-error\ndescription: Test\nbad: [\n---\n",
          path: "SKILL.md",
          sizeBytes: 64,
        },
      ],
      id: SkillIdSchema.parse("marea/malformed-with-error"),
      name: "malformed-with-error",
    } as SkillBundle;
    const prefixedFrontmatter = {
      ...malformed,
      digest: Sha256DigestSchema.parse(`sha256:${"2".repeat(64)}`),
      files: [
        {
          content: "x\n\n\n---\nname: prefixed\ndescription: Prefixed\n---\n",
          path: "SKILL.md",
          sizeBytes: 53,
        },
      ],
      id: SkillIdSchema.parse("marea/prefixed"),
      name: "prefixed",
    } as SkillBundle;
    const noSkillFile = {
      ...malformed,
      digest: Sha256DigestSchema.parse(`sha256:${"1".repeat(64)}`),
      files: [{ content: "resource", path: "resources/a.txt", sizeBytes: 8 }],
      id: SkillIdSchema.parse("marea/no-skill-file"),
      name: "no-skill-file",
    } as SkillBundle;
    const invalidSources = createProductSkillAuthoringService(
      serviceOptions(
        auth,
        foreign,
        sourceFrom([
          malformed,
          missingName,
          malformedYaml,
          malformedWithName,
          noSkillFile,
          prefixedFrontmatter,
        ]),
      ),
    );
    for (const invalid of [
      malformed,
      missingName,
      malformedYaml,
      malformedWithName,
      noSkillFile,
      prefixedFrontmatter,
    ]) {
      await expectInvalidCanonical(() =>
        invalidSources.copy(
          teacher,
          request("class:physics", "skill-authoring-copy", {
            slug: `copy-${invalid.name}`,
            sourceDigest: invalid.digest,
            sourceSkillId: invalid.id,
          }),
        ),
      );
    }
  });
});
