import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TransferStep } from "./installation-transfer.js";
import {
  activatedSource,
  cleanupTransferInstallations,
  continuation,
  destinationFor,
  indexState,
  interruptedApplication,
  type Source,
} from "./operations-transfer.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTransferInstallations);

type Destination = ReturnType<typeof destinationFor>;

/** Both authorities and the copied database, as an operator would find them after a crash. */
function snapshot(source: Source, destination: Destination) {
  const state = (path: string) => (indexState(path) as { state: string } | null)?.state ?? null;
  return {
    source: state(source.config.indexPath),
    destination: state(destination.config.indexPath),
    destinationDatabase: existsSync(destination.config.databasePath),
  };
}

/** Kills a transfer operation right after `step`, leaving exactly what had been committed. */
async function crash(
  source: Source,
  step: TransferStep,
  operation: (application: ReturnType<typeof interruptedApplication>["application"]) => unknown,
) {
  const interrupted = interruptedApplication(source, step);
  try {
    await expect(Promise.resolve().then(() => operation(interrupted.application))).rejects.toThrow(
      `interrupted after ${step}`,
    );
  } finally {
    interrupted.close();
  }
}

const HANDOFF = "handoff:crash";

async function crashedStart(step: TransferStep) {
  const source = await activatedSource();
  const destination = destinationFor(source);
  await crash(source, step, (application) =>
    application.transferStart({ handoffId: HANDOFF, destinationInstallation: destination.root }),
  );
  const crashed = snapshot(source, destination);
  expect(
    [crashed.source, crashed.destination].filter((state) => state === "active").length,
    step,
  ).toBeLessThanOrEqual(1);
  return { source, destination, crashed };
}

const resume = (source: Source) =>
  source.run(
    "recovery",
    "transfer-continue",
    "--input",
    source.work(`continue-${String(Date.now())}.json`, continuation(source)),
  );
const abort = (source: Source) =>
  source.run(
    "transfer",
    "abort",
    "--input",
    source.work(`abort-${String(Date.now())}.json`, { handoffId: HANDOFF }),
  );

const MOVED = { source: "retired", destination: "active", destinationDatabase: true };
const KEPT = { source: "active", destinationDatabase: false };

describe("transfer recovery after a crash between an index commit and its record", () => {
  // Every durable point of a start: whether abort may still undo it, and whether continue may
  // finish it. A refused abort must leave everything exactly as the crash left it.
  const points: readonly [TransferStep, "abortable" | "retired", "continues" | "restart"][] = [
    ["prepared", "abortable", "restart"],
    ["source-quiesced", "abortable", "continues"],
    ["destination-adopted", "abortable", "continues"],
    ["copied", "abortable", "continues"],
    ["source-retirement-committed", "retired", "continues"],
    ["source-retired", "retired", "continues"],
    ["destination-activation-committed", "retired", "continues"],
    ["destination-active", "retired", "continues"],
  ];

  it.each(points)("after %s abort is %s and continue %s", async (step, undo, finish) => {
    const aborting = await crashedStart(step);
    const aborted = await abort(aborting.source);
    if (undo === "abortable") {
      expect(aborted, step).toMatchObject({ code: 0, summary: { state: "aborted" } });
      expect(snapshot(aborting.source, aborting.destination), step).toMatchObject(KEPT);
      expect(snapshot(aborting.source, aborting.destination).destination).not.toBe("active");
    } else {
      expect(aborted, step).toMatchObject({ code: 6 });
      expect(snapshot(aborting.source, aborting.destination), step).toEqual(aborting.crashed);
      // Refusing the abort keeps the move recoverable.
      expect(await resume(aborting.source), step).toMatchObject({ code: 0 });
      expect(snapshot(aborting.source, aborting.destination), step).toEqual(MOVED);
    }

    const continuing = await crashedStart(step);
    const continued = await resume(continuing.source);
    if (finish === "continues") {
      expect(continued, step).toMatchObject({
        code: 0,
        summary: { state: "destination-active", destinationState: "active" },
      });
      expect(snapshot(continuing.source, continuing.destination), step).toEqual(MOVED);
    } else {
      expect(continued, step).toMatchObject({ code: 4 });
      expect(snapshot(continuing.source, continuing.destination), step).toEqual(continuing.crashed);
    }
  });

  // An interrupted abort is repeated, never continued: a retired copy refuses to continue (6), and
  // a reactivated source refuses a continuation whose bundle may be stale (4).
  it.each([
    ["copied", "abort-destination-retired", 6, "retired"],
    ["copied", "abort-source-reactivated", 6, "retired"],
    ["source-quiesced", "abort-source-reactivated", 4, null],
  ] as const)(
    "repeats an abort of a %s transfer interrupted after %s",
    async (start, step, continueCode, destinationState) => {
      const { source, destination } = await crashedStart(start);
      await crash(source, step, (application) => application.transferAbort({ handoffId: HANDOFF }));
      const crashed = snapshot(source, destination);
      expect(crashed.destination, step).toBe(destinationState);
      expect(await resume(source), step).toMatchObject({ code: continueCode });
      expect(snapshot(source, destination), step).toEqual(crashed);
      expect(await abort(source), step).toMatchObject({ code: 0, summary: { state: "aborted" } });
      expect(snapshot(source, destination), step).toEqual({
        source: "active",
        destination: destinationState,
        destinationDatabase: false,
      });
    },
  );
});
