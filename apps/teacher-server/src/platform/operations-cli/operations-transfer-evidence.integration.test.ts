import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { OperationsBoundaryError } from "../operations/canonical-encoder.js";
import { NOW } from "../operations/retention/retention.fixture.js";
import type { TransferStep } from "./installation-transfer.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import {
  activatedSource,
  activeStates,
  cleanupTransferInstallations,
  continuation,
  destinationFor,
  indexState,
  interruptedApplication,
  record,
  setIndexState,
  type Source,
} from "./operations-transfer.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTransferInstallations);

type Destination = ReturnType<typeof destinationFor>;

async function interrupt(source: Source, destination: Destination, step: TransferStep) {
  const interrupted = interruptedApplication(source, step);
  try {
    await expect(
      interrupted.application.transferStart({
        handoffId: "handoff:evidence",
        destinationInstallation: destination.root,
      }),
    ).rejects.toThrow(`interrupted after ${step}`);
  } finally {
    interrupted.close();
  }
}

/** Runs one application operation on the source with an observer of durable steps. */
async function withApplication<T>(
  source: Source,
  operation: (application: ReturnType<typeof createOperationsApplication>) => Promise<T>,
  acquire: (root: string) => ReturnType<typeof acquireInstallation> = acquireInstallation,
) {
  const steps: TransferStep[] = [];
  const owned = acquireInstallation(source.root);
  const application = createOperationsApplication(
    owned.capability,
    readOperationsConfig(source.root),
    () => NOW,
    { acquire, read: readOperationsConfig, durable: (step) => steps.push(step) },
  );
  try {
    return { steps, result: await operation(application).catch((error: unknown) => error) };
  } finally {
    application.close();
    owned.release();
  }
}

const resume = (source: Source, input: Record<string, unknown>, name = "resume.json") =>
  source.run("recovery", "transfer-continue", "--input", source.work(name, input));

describe("two-root installation transfer evidence", () => {
  it("records each durable step, a private handoff, a named bundle and no staging leftovers", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const { steps, result } = await withApplication(source, (application) =>
      application.transferStart({
        handoffId: "handoff:steps",
        destinationInstallation: destination.root,
      }),
    );
    expect(result).toMatchObject({ state: "destination-active" });
    expect(steps).toEqual([
      "prepared",
      "source-quiesced",
      "destination-adopted",
      "copied",
      "source-retirement-committed",
      "source-retired",
      "destination-activation-committed",
      "destination-active",
    ]);
    const bundle = `transfer-${createHash("sha256").update("root:operations").digest("hex").slice(0, 16)}`;
    expect(readdirSync(destination.config.backupRoot)).toEqual([bundle]);
    expect(readdirSync(destination.root).filter((name) => name.startsWith(".transfer-"))).toEqual(
      [],
    );
    const records = [
      join(source.root, "transfer-handoff.json"),
      join(destination.root, "state", "transfer-handoff.json"),
    ];
    for (const path of records) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(record(records[1] ?? "").handoff).toMatchObject({
      destinationCheckpoint: { rootId: "root:destination" },
    });

    const aborting = await activatedSource();
    const abortDestination = destinationFor(aborting);
    await interrupt(aborting, abortDestination, "copied");
    const aborted = await withApplication(aborting, (application) =>
      application.transferAbort({ handoffId: "handoff:evidence" }),
    );
    expect(aborted.steps).toEqual([
      "abort-destination-retired",
      "abort-source-reactivated",
      "aborted",
    ]);
  });

  it("continues only the exact recorded handoff and never an aborted one", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    await interrupt(source, destination, "source-quiesced");
    const exact = continuation(source);
    for (const [field, value] of [
      ["handoffId", "handoff:other"],
      ["authorityLineage", "lineage:other"],
      ["expectedIndexGeneration", 1],
      ["sourceRoot", "root:other"],
      ["destinationRoot", "root:other"],
    ] as const)
      expect(
        await resume(source, { ...exact, [field]: value }, `${field}.json`),
        field,
      ).toMatchObject({ code: 4 });
    expect((indexState(source.config.indexPath) as { state: string }).state).toBe(
      "transfer-prepared",
    );
    expect(
      await source.run(
        "transfer",
        "abort",
        "--input",
        source.work("abort.json", { handoffId: "handoff:evidence" }),
      ),
    ).toMatchObject({ code: 0 });
    expect(await resume(source, exact, "aborted.json")).toMatchObject({ code: 4 });
    expect(activeStates(source, destination)).toBe(1);
  });

  it("refuses a second transfer, a foreign database lineage and a destination with a handoff", async () => {
    const source = await activatedSource();
    const start = (destination: Destination, name: string) =>
      source.run(
        "transfer",
        "start",
        "--input",
        source.work(`${name}.json`, {
          handoffId: `handoff:${name}`,
          destinationInstallation: destination.root,
        }),
      );
    expect(
      await start(
        destinationFor(source, { databaseLineage: `sha256:${"e".repeat(64)}` }),
        "lineage",
      ),
    ).toMatchObject({ code: 4 });
    // An unrecorded bundle left by an interrupted start is replaced.
    const orphaned = destinationFor(source);
    const bundle = `transfer-${createHash("sha256").update("root:operations").digest("hex").slice(0, 16)}`;
    mkdirSync(join(orphaned.config.backupRoot, bundle, "partial"), {
      recursive: true,
      mode: 0o700,
    });
    await interrupt(source, orphaned, "prepared");
    expect(existsSync(join(orphaned.config.backupRoot, bundle, "partial"))).toBe(false);
    expect(await start(destinationFor(source), "second")).toMatchObject({ code: 4 });
    expect((indexState(source.config.indexPath) as { state: string }).state).toBe("active");
    expect(
      await source.run(
        "transfer",
        "abort",
        "--input",
        source.work("abort-prepared.json", { handoffId: "handoff:evidence" }),
      ),
    ).toMatchObject({ code: 0 });
    // A destination that already holds a handoff record is never used again.
    const other = await activatedSource();
    const recorded = destinationFor(other);
    writeFileSync(
      join(recorded.root, "state", "transfer-handoff.json"),
      JSON.stringify(record(join(source.root, "transfer-handoff.json"))),
      { mode: 0o600 },
    );
    expect(
      await other.run(
        "transfer",
        "start",
        "--input",
        other.work("recorded.json", {
          handoffId: "handoff:recorded",
          destinationInstallation: recorded.root,
        }),
      ),
    ).toMatchObject({ code: 4 });

    // A repeated abort after an interruption finds the bundle already gone.
    const again = await activatedSource();
    const againDestination = destinationFor(again);
    await interrupt(again, againDestination, "source-quiesced");
    rmSync(againDestination.config.backupRoot, { recursive: true });
    mkdirSync(againDestination.config.backupRoot, { mode: 0o700 });
    expect(
      await again.run(
        "transfer",
        "abort",
        "--input",
        again.work("abort-again.json", { handoffId: "handoff:evidence" }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "aborted" } });
  });

  it("replaces every sidecar of a partial copy and moves absent state files", async () => {
    const source = await activatedSource();
    writeFileSync(join(source.root, "marker.json"), "{}", { mode: 0o600 });
    source.writeConfig({ ...source.config, stateFiles: ["marker.json"] });
    const destination = destinationFor(source, { stateFiles: ["marker.json"] });
    await interrupt(source, destination, "source-quiesced");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      writeFileSync(`${destination.config.databasePath}${suffix}`, "partial", { mode: 0o600 });
    expect(await resume(source, continuation(source))).toMatchObject({
      code: 0,
      summary: { state: "destination-active" },
    });
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(`${destination.config.databasePath}${suffix}`), suffix).toBe(false);
    expect(existsSync(join(destination.root, "marker.json"))).toBe(true);
  });

  it("reports uncertain evidence and lost destination ownership as such", async () => {
    const uncertain = new OperationsBoundaryError(
      "uncertain",
      "The transfer evidence is not valid.",
    );
    const source = await activatedSource();
    const destination = destinationFor(source);
    await interrupt(source, destination, "copied");
    rmSync(destination.config.indexPath);
    const missing = await withApplication(source, (application) =>
      application.transferContinue(continuation(source) as never),
    );
    expect(missing.result).toEqual(uncertain);

    const late = await activatedSource();
    await interrupt(late, destinationFor(late), "source-retired");
    const refused = await withApplication(late, (application) =>
      application.transferAbort({ handoffId: "handoff:evidence" }),
    );
    expect(refused.result).toEqual(uncertain);

    const lost = await activatedSource();
    const lostDestination = destinationFor(lost);
    const released = vi.fn(() => true);
    const outcome = await withApplication(
      lost,
      (application) =>
        application.transferStart({
          handoffId: "handoff:lost",
          destinationInstallation: lostDestination.root,
        }),
      (root) => {
        const owned = acquireInstallation(root);
        return {
          capability: {
            ...owned.capability,
            assertOwned: () => {
              throw new OperatorCliError("installation-lost");
            },
          },
          release: () => released() && owned.release(),
        };
      },
    );
    expect(outcome.result).toEqual(new OperatorCliError("installation-lost"));
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("refuses a handoff record that lost its source checkpoint", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    await interrupt(source, destination, "source-quiesced");
    const path = join(source.root, "transfer-handoff.json");
    const stored = record(path);
    delete stored.handoff.authorityCheckpoint;
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    expect(await source.run("transfer", "inspect")).toMatchObject({ code: 2 });
  });

  it("starts only from an active source authority", async () => {
    for (const state of ["transfer-prepared", "retired"]) {
      const source = await activatedSource();
      const destination = destinationFor(source);
      setIndexState(source.config.indexPath, state);
      expect(
        await source.run(
          "transfer",
          "start",
          "--input",
          source.work("inactive.json", {
            handoffId: "handoff:inactive",
            destinationInstallation: destination.root,
          }),
        ),
        state,
      ).toMatchObject({ code: 4 });
      expect(existsSync(join(source.root, "transfer-handoff.json"))).toBe(false);
      expect(readdirSync(destination.config.backupRoot)).toEqual([]);
    }
  });
});
