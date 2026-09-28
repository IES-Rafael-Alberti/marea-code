import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, it, describe } from "vitest";
import { SkillIdSchema } from "@marea/protocol";
import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import { newRoot, owner, roots, saveRequest, skill } from "./authoring-test-support.fixture.js";
import type { SkillBundle, SkillSource, SkillSummary } from "../skills/skill-source.js";
import type { SkillAuthoringFile, SkillSaveRequest } from "./skill-authoring-store.boundary.js";
import { runAuthoringSmoke } from "./authoring-roundtrip.fixture.js";
import { SkillAuthoringSource } from "./skill-authoring-source.boundary.js";
import { requireSkillBundle } from "./skill-authoring-helpers.boundary.js";

describe("SkillAuthoringStore", () => {
  it("rejects the destructive review regression before any filesystem operation", async () => {
    const synthetic = await mkdtemp(join(tmpdir(), "marea-review-regression-"));
    roots.push(synthetic);
    const ownerRoot = join(synthetic, "owner-root");
    await mkdir(join(ownerRoot, "sentinel"), { recursive: true });
    await writeFile(join(ownerRoot, "sentinel", "keep.txt"), "unrelated bytes");
    await writeFile(join(synthetic, "outside-sentinel"), "outside bytes");
    const store = new SkillAuthoringStore(ownerRoot, owner);
    await expect(
      store.create(saveRequest("didactic", "../../sentinel", skill("sentinel"))),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(readFile(join(ownerRoot, "sentinel", "keep.txt"), "utf8")).resolves.toBe(
      "unrelated bytes",
    );
    await expect(readFile(join(synthetic, "outside-sentinel"), "utf8")).resolves.toBe(
      "outside bytes",
    );
    await expect(
      store.create(saveRequest("didactic", "../outside-sentinel", skill("x"))),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(readFile(join(synthetic, "outside-sentinel"), "utf8")).resolves.toBe(
      "outside bytes",
    );
  });

  it("captures the whole save request at runtime before filesystem work and never no-ops a create", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing"), 42 as never)),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing"), "not-a-digest" as never)),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(store.create(undefined as never)).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-request",
      message: "Provide a skill save request object.",
    });
    await expect(store.create(null as never)).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-request",
      message: "Provide a skill save request object.",
    });
    await expect(
      store.create(saveRequest("didactic", "\ud800slug", skill("testing"))),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-request",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing"), "\ud800digest" as never)),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-request",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    await expect(
      store.create({ kind: "didactic", slug: "testing", files: skill("testing") } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.create(saveRequest(7 as never, "testing", skill("testing"))),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.create(saveRequest("didactic", 7 as never, skill("testing"))),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-request",
      message: "Provide a string skill slug.",
    });
    await expect(
      store.create(saveRequest("didactic", "testing", [{ path: "SKILL.md", content: "\ud800" }])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/testing",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    await expect(
      store.create(saveRequest("didactic", "testing", [{ path: "\ud800.txt", content: "text" }])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/testing",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    await expect(
      store.create(saveRequest("didactic", "shape", ["text" as never])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/shape",
      message: "Provide path and text content for every skill file.",
    });
    await expect(store.list("operations" as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(store.read("teacher/owner-1/..%2Fescape")).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(store.read("teacher/owner-1/\ud800x")).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "skill-id",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    expect((await store.list("didactic")).length).toBe(0);
  });

  it("rejects unsupported runtime value shapes and immutable-file mutations after capture", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const files = [...skill("testing", "Original")];
    const request = {
      kind: "didactic" as const,
      slug: "testing",
      files: [...files] as SkillSaveRequest["files"],
      expectedDigest: null,
    };
    const created = await store.create(request);
    (request.files as SkillAuthoringFile[])[0] = {
      path: "SKILL.md",
      content: "---\nname: testing\ndescription: Mutated\n---\n",
    };
    expect(created.description).toBe("Original");
    expect((await store.read("teacher/owner-1/testing"))?.description).toBe("Original");
    const mutated = [...files];
    mutated[0] = { path: "SKILL.md", content: "---\nname: testing\ndescription: After\n---\n" };
    const promise = store.replace({
      kind: "didactic",
      slug: "testing",
      files: mutated,
      expectedDigest: created.digest,
    });
    mutated[0] = { path: "SKILL.md", content: "---\nname: testing\ndescription: Raced\n---\n" };
    expect((await promise).description).toBe("After");
    expect((await store.read("teacher/owner-1/testing"))?.description).toBe("After");
  });

  it("rejects committed non-directory state and unsafe transaction content without deleting it", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await writeFile(join(root, "didactic", "testing"), "not-a-directory");
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing"))),
    ).rejects.toMatchObject({
      code: "AUTHORING_WRITE_FAILED",
      location: join(realpathSync(root), "didactic", "testing"),
      message: "Use a real skill directory for each committed skill.",
    });
    await expect(readFile(join(root, "didactic", "testing"), "utf8")).resolves.toBe(
      "not-a-directory",
    );
    const transaction = join(root, ".authoring-transactions", "didactic", "mystery");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "unknown.txt"), "unknown transaction state");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/mystery/unknown.txt",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "unknown.txt"), "utf8")).resolves.toBe(
      "unknown transaction state",
    );
  });

  it("fails closed for transaction entries that only fake a kind name", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "fake-kind");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "didactic"), "not a directory");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/fake-kind/didactic",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "didactic"), "utf8")).resolves.toBe("not a directory");
  });

  it("leaves invalid transaction slug directories untouched", async () => {
    const root = await newRoot();
    const transaction = join(root, ".authoring-transactions", "evaluation", "Bad_Slug");
    await mkdir(transaction, { recursive: true });
    const store = new SkillAuthoringStore(root, owner);
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "Bad_Slug",
      message: "Inspect the invalid transaction name before any cleanup.",
    });
    await expect(exists(transaction)).resolves.toBe(true);
  });

  it("distinguishes inspection errors from missing state and rejects unsafe recovery entries", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transactions = join(root, ".authoring-transactions");
    await mkdir(transactions, { recursive: true });
    try {
      await chmod(transactions, 0o000);
      await expect(store.recover()).rejects.toMatchObject({
        code: "AUTHORING_RECOVERY_FAILED",
        message: "The exclusive filesystem could not inspect the skill state.",
      });
    } finally {
      await chmod(transactions, 0o700);
    }
    try {
      await chmod(transactions, 0o111);
      await expect(store.recover()).rejects.toMatchObject({
        code: "AUTHORING_RECOVERY_FAILED",
        message: "The exclusive filesystem could not inspect the skill state.",
      });
    } finally {
      await chmod(transactions, 0o700);
    }
    const committedLink = join(root, "didactic", "linked");
    await symlink(join(root, "evaluation"), committedLink);
    const transaction = join(root, ".authoring-transactions", "didactic", "linked");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await expect(store.recover()).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "didactic/linked",
      message: "Replace the committed skill link with a real directory.",
    });
    await expect(exists(transaction)).resolves.toBe(true);
  });

  it("recovers a corrupt journal file fail-closed", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "testing");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "journal"), "corrupt journal");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      message: "Inspect the transaction journal; it must be a real directory.",
    });
    await expect(readFile(join(transaction, "journal"), "utf8")).resolves.toBe("corrupt journal");
  });

  it("fails closed when a committed transaction target is not a directory", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "testing");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(root, "didactic", "testing"), "not-a-directory");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      message: "Inspect the committed skill path; it must be a real directory.",
    });
    await expect(readFile(join(root, "didactic", "testing"), "utf8")).resolves.toBe(
      "not-a-directory",
    );
  });

  it("fails closed on symbolic links inside pending stage state without deleting it", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "partial");
    await mkdir(join(transaction, "didactic"), { recursive: true });
    await symlink(join(root, "evaluation"), join(transaction, "didactic", "evaluation"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/partial/didactic/evaluation",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
    await expect(exists(join(root, "evaluation"))).resolves.toBe(true);
    await expect(exists(transaction)).resolves.toBe(true);
  });

  it("rejects a committed symbolic link before staging and covers null/shape file entries", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await symlink(join(root, "evaluation"), join(root, "didactic", "testing"));
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing"))),
    ).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "didactic/testing",
      message: "Replace the committed skill link with a real directory.",
    });
    const transactions = join(root, ".authoring-transactions");
    await mkdir(transactions, { recursive: true });
    await symlink(join(root, "evaluation"), join(transactions, "eval-link"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "eval-link",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
    await expect(
      store.create(saveRequest("didactic", "shape", [null as never])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/shape",
      message: "Provide path and text content for every skill file.",
    });
  });

  it("rejects unknown transaction kind directories and slug links without deleting them", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transactions = join(root, ".authoring-transactions");
    await mkdir(join(transactions, "unknown-kind"), { recursive: true });
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "unknown-kind",
      message: "Inspect the unknown transaction directory before any cleanup.",
    });
    await expect(exists(join(transactions, "unknown-kind"))).resolves.toBe(true);
  });

  it("rejects symbolic transaction slugs without deleting them", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transactions = join(root, ".authoring-transactions");
    const slugLink = join(transactions, "didactic", "linked-slug");
    await mkdir(join(transactions, "didactic"), { recursive: true });
    await symlink(join(root, "evaluation"), slugLink);
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/linked-slug",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
    await expect(exists(slugLink)).resolves.toBe(true);
  });

  it("maps committed inspection failures without losing the previous bundle", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(saveRequest("didactic", "testing", skill("testing")));
    try {
      await chmod(join(root, "didactic"), 0o000);
      await expect(
        store.create(saveRequest("didactic", "testing", skill("testing", "New"))),
      ).rejects.toMatchObject({
        code: "AUTHORING_WRITE_FAILED",
        message: "The exclusive filesystem could not inspect the skill state.",
      });
    } finally {
      await chmod(join(root, "didactic"), 0o700);
    }
    expect((await store.read("teacher/owner-1/testing"))?.digest).toBe(original.digest);
  });

  it("preserves the original failure when the transaction directory cannot be created", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transactions = join(root, ".authoring-transactions");
    await mkdir(transactions, { recursive: true });
    try {
      await chmod(transactions, 0o555);
      await expect(
        store.create(saveRequest("didactic", "blocked", skill("blocked"))),
      ).rejects.toMatchObject({
        code: "AUTHORING_WRITE_FAILED",
        location: join(realpathSync(transactions), "didactic", "blocked", "didactic"),
        message: "The exclusive filesystem did not accept the bounded write operation.",
      });
    } finally {
      await chmod(transactions, 0o700);
    }
    await expect(exists(join(transactions, "didactic", "blocked"))).resolves.toBe(false);
  });

  it("fails validation cleanup closed when the transaction slot holds unknown state", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "testing");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "x.txt"), "unknown");
    await expect(store.validate("didactic", "testing", skill("testing"))).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/testing/x.txt",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "x.txt"), "utf8")).resolves.toBe("unknown");
  });

  it("exposes the SkillSource facade through the shared owner gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-facade-"));
    roots.push(root);
    const store = new SkillAuthoringStore(root, owner);
    const authoringSource = new SkillAuthoringSource(root, owner);
    await authoringSource.initialize();
    const source: SkillSource = authoringSource;
    const created = await store.create(saveRequest("didactic", "testing", skill("testing")));
    const loaded = await source.load(
      (await import("@marea/protocol")).SkillIdSchema.parse("teacher/owner-1/testing"),
    );
    expect(loaded).toEqual(created);
    expect((await source.list("didactic")).map((summary) => summary.id)).toEqual([
      "teacher/owner-1/testing",
    ]);
    expect(
      await source.load((await import("@marea/protocol")).SkillIdSchema.parse("marea/testing")),
    ).toBeNull();
  });

  it("serializes separate store instances that alias the same root", async () => {
    const root = await newRoot();
    const first = new SkillAuthoringStore(root, owner);
    const aliased = new SkillAuthoringStore(`${root}${sep}`, owner);
    await expect(
      Promise.allSettled([
        first.create(saveRequest("didactic", "testing", skill("testing", "First"))),
        aliased.create(saveRequest("didactic", "testing", skill("testing", "Second"))),
      ]),
    ).resolves.toMatchObject([
      { status: "fulfilled" },
      { status: "rejected", reason: { code: "SKILL_EXISTS" } },
    ]);
  });

  it("runs the real authoring roundtrip smoke end to end", async () => {
    expect(await runAuthoringSmoke()).toBe(true);
  });

  it("fails requireSkillBundle when the catalog lacks the requested skill", async () => {
    const missing = {
      list: (): Promise<readonly SkillSummary[]> => Promise.resolve([]),
      load: (): Promise<SkillBundle | null> => Promise.resolve(null),
    } as SkillSource;
    await expect(
      requireSkillBundle(missing, SkillIdSchema.parse("marea/missing")),
    ).rejects.toMatchObject({
      name: "SkillAuthoringError",
      code: "SKILL_MISSING",
      message: "The expected committed skill bundle is missing from its owner catalog.",
    });
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return false;
  }
  return true;
}
