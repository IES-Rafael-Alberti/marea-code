import * as z from "zod";
import * as git from "./git-workspace.boundary.js";
import * as storage from "./filesystem.boundary.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MessageIdSchema } from "@marea/protocol";
import { GitProjectEvidence } from "./git-evidence.boundary.js";
import { projectGit } from "./git-workspace.boundary.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marea-git-project-"));
  const directory = await mkdtemp(join(tmpdir(), "marea-git-evidence-"));
  directories.push(root, directory);
  await projectGit(root, ["init"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "code.ts"), "const value = 1;\n");
  await projectGit(root, ["add", "code.ts"]);
  const session = createFixtureController();
  await session.controller.start("Synthetic Git project");
  const options = { root, directory, localSession: session.localSession, ids: new FixtureIds() };
  const evidence = new GitProjectEvidence(options);
  const changes = async () =>
    (await session.localSession.pendingEvents(128)).filter(
      (event) => event.eventType === "project-change",
    );
  return { ...session, root, directory, options, evidence, changes };
}

it("records student and agent diffs without touching staging, ignores or HEAD", async () => {
  const f = await fixture();
  const index = await readFile(join(f.root, ".git/index"));
  const head = await readFile(join(f.root, ".git/HEAD"));
  await f.evidence.start();
  await writeFile(join(f.root, "ignored.txt"), "not evidence");
  await writeFile(join(f.root, "code.ts"), "const value = 2;\n");
  const messageId = MessageIdSchema.parse("message:git-test");
  await f.evidence.beginAgent(messageId);
  await writeFile(join(f.root, "code.ts"), "const value = 3;\n");
  await f.evidence.capture("agent", messageId);
  const events = await f.changes();
  expect(events.map((event) => event.actor)).toEqual(["student", "agent"]);
  expect(events[0]?.patch).toContain("+const value = 2;");
  expect(events[1]?.patch).toContain("-const value = 2;");
  expect(JSON.stringify(events)).not.toContain("not evidence");
  expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
  expect(await readFile(join(f.root, ".git/HEAD"))).toEqual(head);
  await f.evidence.capture("student");
  expect(await f.changes()).toHaveLength(2);
});

it("preserves repeated A-to-B edits and recovers uncertain attribution after a process interruption", async () => {
  const f = await fixture();
  await f.evidence.start();
  for (const value of [2, 1, 2]) {
    await writeFile(join(f.root, "code.ts"), `const value = ${String(value)};\n`);
    await f.evidence.capture("student");
  }
  expect((await f.changes()).map((event) => event.actor)).toEqual([
    "student",
    "student",
    "student",
  ]);
  await f.evidence.beginAgent(MessageIdSchema.parse("message:interrupted"));
  await writeFile(join(f.root, "code.ts"), "interrupted effect\n");
  await new GitProjectEvidence(f.options).start();
  expect((await f.changes()).at(-1)?.actor).toBe("unknown");
});

it("replays a prepared diff exactly once after failure to append, including later edits", async () => {
  const f = await fixture();
  await f.evidence.start();
  await writeFile(join(f.root, "code.ts"), "first edit\n");
  const append = vi
    .spyOn(f.localSession, "appendEvent")
    .mockRejectedValueOnce(new Error("synthetic interruption"));
  await expect(f.evidence.capture("student")).rejects.toThrow("synthetic interruption");
  append.mockRestore();
  await writeFile(join(f.root, "code.ts"), "second edit\n");
  await new GitProjectEvidence(f.options).capture("student");
  const changes = await f.changes();
  expect(changes).toHaveLength(2);
  expect(changes[0]?.patch).toContain("+first edit");
  expect(changes[1]?.patch).toContain("+second edit");
});

it("freezes the student's bounded diff for a message across later edits and retries", async () => {
  const f = await fixture();
  await f.evidence.start();
  const message = MessageIdSchema.parse("message:context");
  await writeFile(join(f.root, "code.ts"), "student first edit\n");
  await f.evidence.capture("student", message);
  const context = await f.evidence.context(message);
  expect(context).toContain("+student first edit");
  await writeFile(join(f.root, "code.ts"), "later edit\n");
  await f.evidence.capture("student", message);
  expect(await new GitProjectEvidence(f.options).context(message)).toBe(context);
  expect(await f.evidence.context(MessageIdSchema.parse("message:empty"))).toBe("");
});
it("handles an unborn index, includes tracked ignored files and marks oversized patches", async () => {
  const f = await fixture();
  await rm(join(f.root, ".git/index"));
  await f.evidence.start();
  await writeFile(join(f.root, "ignored.txt"), "tracked despite ignore\n");
  await projectGit(f.root, ["add", "-f", "ignored.txt"]);
  await writeFile(join(f.root, "code.ts"), "x".repeat(20000));
  await f.evidence.capture("student");
  const change = (await f.changes())[0];
  expect(change?.truncated).toBe(true);
  expect(change?.patch).toHaveLength(16384);
  await writeFile(join(f.root, "ignored.txt"), "updated tracked file\n");
  await f.evidence.capture("student");
  expect((await f.changes())[1]?.patch).toContain("+updated tracked file");
});
it("refuses capture without activation and propagates an unreadable Git index", async () => {
  const f = await fixture();
  const inactive = createFixtureController();
  await expect(
    new GitProjectEvidence({ ...f.options, localSession: inactive.localSession }).capture(
      "student",
    ),
  ).rejects.toThrow("active run");
  await rm(join(f.root, ".git/index"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(f.root, ".git/index"));
  await expect(f.evidence.capture("student")).rejects.toThrow();
});
it("detects same-size same-timestamp edits even when Git's stat cache trusts them", async () => {
  const f = await fixture();
  const { utimes } = await import("node:fs/promises");
  await projectGit(f.root, ["config", "core.trustctime", "false"]);
  await projectGit(f.root, ["config", "core.checkStat", "minimal"]);
  await utimes(join(f.root, "code.ts"), 100, 100);
  await projectGit(f.root, ["add", "code.ts"]);
  await f.evidence.start();
  await writeFile(join(f.root, "code.ts"), "const value = 9;\n");
  await utimes(join(f.root, "code.ts"), 100, 100);
  await f.evidence.capture("student");
  expect((await f.changes())[0]?.patch).toContain("+const value = 9;");
  await f.evidence.capture("student");
  expect(await f.changes()).toHaveLength(1);
});

async function journal(f: Awaited<ReturnType<typeof fixture>>) {
  const run = (await f.localSession.load()).run;
  if (run?.runId === null || run?.runId === undefined) throw new Error("Missing fixture run");
  return join(f.directory, "project-evidence", encodeURIComponent(run.runId));
}
it.each(["student", "agent", "unknown"] as const)(
  "replays a durable %s capture with its message identity and cleans temporary indexes",
  async (actor) => {
    const f = await fixture();
    await f.evidence.start();
    expect(await readdir(await journal(f))).toEqual(["state.json"]);
    await writeFile(join(f.root, "code.ts"), "changed once");
    const message = MessageIdSchema.parse("message:prepared-diff");
    vi.spyOn(f.localSession, "appendEvent").mockRejectedValueOnce(new Error("append interruption"));
    await expect(f.evidence.capture(actor, message)).rejects.toThrow("append interruption");
    await new GitProjectEvidence(f.options).capture("student");
    expect(await f.changes()).toMatchObject([{ actor, messageId: message }]);
    const context = await f.evidence.context(message);
    if (actor === "student") expect(context).toContain("+changed once");
    else expect(context).toBe("");
    expect(await f.evidence.context(message)).toBe(context);
    await writeFile(join(f.root, "code.ts"), "next student edit");
    await f.evidence.capture("student");
    expect((await f.changes())[1]?.actor).toBe("student");
    expect((await readdir(await journal(f))).some((name) => name.startsWith("index-"))).toBe(false);
  },
);
it.each([
  [16384, 2048, false],
  [16385, 10, true],
  [10, 2049, true],
] as const)(
  "bounds patches %s and summaries %s with an honest truncation flag",
  async (patchLength, summaryLength, truncated) => {
    const f = await fixture();
    await f.evidence.start();
    await writeFile(join(f.root, "code.ts"), "changed");
    const real = git.projectGit;
    vi.spyOn(git, "projectGit").mockImplementation((root, args, index) =>
      args[0] === "diff"
        ? Promise.resolve(
            args.includes("--stat") ? "s".repeat(summaryLength) : "p".repeat(patchLength),
          )
        : real(root, args, index),
    );
    const message = MessageIdSchema.parse("message:bounded");
    await f.evidence.capture("student", message);
    expect(await f.changes()).toMatchObject([
      {
        patch: "p".repeat(Math.min(16384, patchLength)),
        summary: "s".repeat(Math.min(2048, summaryLength)),
        truncated,
        messageId: message,
      },
    ]);
    expect(await f.evidence.context(message)).toBe(
      `${"s".repeat(Math.min(2048, summaryLength))}\n${"p".repeat(Math.min(16384, patchLength))}`.slice(
        0,
        4096,
      ),
    );
  },
);
it("rejects malformed tree identities before asking Git to interpret a revision", async () => {
  const f = await fixture();
  await f.evidence.start();
  const path = join(await journal(f), "state.json");
  const state = z
    .object({ tree: z.string(), agentPending: z.boolean(), generation: z.number() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  for (const tree of [`z${state.tree}`, `${state.tree}z`]) {
    await writeFile(path, JSON.stringify({ ...state, tree }));
    await expect(f.evidence.capture("student")).rejects.toBeInstanceOf(z.ZodError);
  }
});
it("records a student edit that races with creation of the initial baseline", async () => {
  const f = await fixture();
  const write = storage.writePrivateFileAtomically;
  let first = true;
  vi.spyOn(storage, "writePrivateFileAtomically").mockImplementation(async (path, contents) => {
    if (first && path.endsWith("state.json")) {
      first = false;
      await writeFile(join(f.root, "code.ts"), "student raced with baseline");
    }
    await write(path, contents);
  });
  await f.evidence.start();
  const changes = await f.changes();
  expect(changes).toMatchObject([{ actor: "student" }]);
  expect(changes[0]?.patch).toContain("+student raced with baseline");
});

it("preserves a Git failure before index creation and avoids context files for unassociated edits", async () => {
  const f = await fixture();
  const failure = new Error("Git probe failed before creating an index");
  vi.spyOn(git, "projectGit").mockRejectedValueOnce(failure);
  await expect(f.evidence.capture("student")).rejects.toBe(failure);
  await f.evidence.start();
  await writeFile(join(f.root, "code.ts"), "unassociated student edit");
  await f.evidence.capture("student");
  expect(await readdir(await journal(f))).toEqual(["state.json"]);
});
