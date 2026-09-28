// Real Bun smoke for the owner-scoped authoring store. Fixture-named so it is
// excluded from coverage/mutation instrumentation like other fixtures. Run it
// directly with `bun run apps/teacher-server/src/teaching/authoring/
// authoring-roundtrip.fixture.ts`; it uses only synthetic temporary state.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Sha256Digest } from "@marea/protocol";
import { SkillAuthoringSource } from "./skill-authoring-source.boundary.js";
import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";

const execFilePromisified = promisify(execFile);
const owner = { source: "teacher", id: "owner-1" } as const;
const files = (name: string, description: string) => [
  {
    path: "SKILL.md",
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\nTeach testing.\n`,
  },
];
const request = (description: string, digest: Sha256Digest | null = null) => ({
  kind: "didactic" as const,
  slug: "sample",
  expectedDigest: digest,
  files: files("sample", description),
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return false;
  }
  return true;
}

const outcome = async function <T>(fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
    return "accepted";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code ?? (error as Error).name;
  }
};

export async function runAuthoringSmoke(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "marea-authoring-smoke-"));
  const checks: Record<string, boolean> = {};
  const store = new SkillAuthoringStore(join(root, "owner-root"), owner);
  const source = new SkillAuthoringSource(join(root, "owner-root"), owner);
  await source.initialize();

  const created = await store.create(request("Original"));
  checks.roundtrip =
    (await source.load(created.id))?.description === "Original" &&
    (await store.list("didactic")).length === 1;
  checks.validate =
    (
      await store.validate("evaluation", "practice", [
        { path: "SKILL.md", content: "---\nname: practice\ndescription: Practice\n---\n" },
      ])
    )?.id === "teacher/owner-1/practice";

  const updated = await store.replace(request("Updated", created.digest));
  checks.replace =
    updated.description === "Updated" &&
    (await outcome(() => store.replace(request("Lost", created.digest)))) ===
      "STALE_SKILL_DIGEST" &&
    (await outcome(() => store.create(request("Lost")))) === "SKILL_EXISTS" &&
    (await outcome(() => store.create(request("Lost", created.digest)))) ===
      "UNSAFE_AUTHORING_INPUT";

  const transaction = join(root, "owner-root", ".authoring-transactions", "didactic", "sample");
  await mkdir(transaction, { recursive: true });
  await rename(join(root, "owner-root", "didactic", "sample"), join(transaction, "journal"));
  checks.interruptedCreate =
    (await outcome(() => store.create(request("Replacement")))) === "SKILL_EXISTS" &&
    (await store.read("teacher/owner-1/sample"))?.description === "Updated";

  const pendingTransaction = join(
    root,
    "owner-root",
    ".authoring-transactions",
    "didactic",
    "fresh",
  );
  const pendingStage = join(pendingTransaction, "didactic", "fresh");
  await mkdir(join(pendingStage, "resources"), { recursive: true });
  await writeFile(join(pendingStage, "SKILL.md"), "---\nname: fresh\ndescription: Stale\n---\n");
  await writeFile(join(pendingStage, "resources", "stale.txt"), "stale bytes");
  const fresh = await store.create({
    kind: "didactic",
    slug: "fresh",
    expectedDigest: null,
    files: files("fresh", "Fresh"),
  } as never);
  checks.pendingStage =
    fresh.description === "Fresh" &&
    fresh.files.every((file) => file.path !== "resources/stale.txt") &&
    !(await exists(transaction));

  const outside = join(root, "outside");
  await mkdir(join(outside, "didactic", "sample", "didactic"), { recursive: true });
  const sentinel = join(outside, "didactic", "sample", "didactic", "keep.txt");
  await writeFile(sentinel, "untouched bytes");
  const linkedRoot = join(root, "linked-root");
  const linkedStore = new SkillAuthoringStore(linkedRoot, owner);
  await linkedStore.initialize();
  await rm(join(linkedRoot, ".authoring-transactions"), { force: true });
  await symlink(outside, join(linkedRoot, ".authoring-transactions"));
  checks.transactionRootLink =
    (await outcome(() => linkedStore.recover())) === "AUTHORING_RECOVERY_FAILED" &&
    (await readFile(sentinel, "utf8")) === "untouched bytes";

  const unknownRoot = join(root, "unknown-root");
  const unknownStore = new SkillAuthoringStore(unknownRoot, owner);
  await unknownStore.initialize();
  await unknownStore.create(request("Committed"));
  const unknownTransaction = join(unknownRoot, ".authoring-transactions", "didactic", "sample");
  await mkdir(join(unknownTransaction, "journal"), { recursive: true });
  await writeFile(join(unknownTransaction, "journal", "keep.txt"), "previous bytes");
  await writeFile(join(unknownTransaction, "unknown.txt"), "inspect bytes");
  checks.unknownState =
    (await outcome(() => unknownStore.recover())) === "AUTHORING_RECOVERY_FAILED" &&
    (await readFile(join(unknownTransaction, "journal", "keep.txt"), "utf8")) ===
      "previous bytes" &&
    (await readFile(join(unknownTransaction, "unknown.txt"), "utf8")) === "inspect bytes" &&
    (await readFile(join(unknownRoot, "didactic", "sample", "SKILL.md"), "utf8")).includes(
      "Committed",
    );

  checks.invalidInput =
    (await outcome(() =>
      store.create({
        kind: "didactic",
        slug: "../../sentinel",
        expectedDigest: null,
        files: files("sample", "X"),
      }),
    )) === "ZodError";

  await execFilePromisified("mkfifo", [join(root, "fifo")]);
  checks.fifoRoot =
    (await outcome(() => new SkillAuthoringStore(join(root, "fifo"), owner).initialize())) ===
    "ROOT_NOT_EXCLUSIVE";

  const ok = Object.values(checks).every((value) => value);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  return ok;
}

if (import.meta.main) {
  const ok = await runAuthoringSmoke();
  process.exit(ok ? 0 : 1);
}
