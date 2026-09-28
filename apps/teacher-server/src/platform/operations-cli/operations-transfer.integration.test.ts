import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import {
  activatedSource,
  activeStates,
  cleanupTransferInstallations,
  continuation,
  destinationFor,
  indexState,
  interruptedApplication,
  record,
} from "./operations-transfer.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTransferInstallations);

describe("two-root installation transfer", () => {
  it("moves the database and deletion authority so that only the destination stays active", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const start = source.work("transfer.json", {
      handoffId: "handoff:one",
      destinationInstallation: destination.root,
    });
    expect(await source.run("transfer", "start", "--input", start)).toMatchObject({
      code: 0,
      open: 0,
      summary: {
        handoffId: "handoff:one",
        state: "destination-active",
        destinationState: "active",
        indexGeneration: 0,
      },
    });
    expect(indexState(source.config.indexPath)).toEqual({
      root_id: "root:operations",
      generation: 0,
      state: "retired",
    });
    expect(indexState(destination.config.indexPath)).toEqual({
      root_id: "root:destination",
      generation: 0,
      state: "active",
    });
    const runs = (path: string) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return database.prepare("SELECT id, state FROM marea_runs ORDER BY id").all();
      } finally {
        database.close();
      }
    };
    expect(runs(destination.config.databasePath)).toEqual(runs(source.config.databasePath));
    expect(runs(destination.config.databasePath).length).toBeGreaterThan(0);
    expect(record(join(destination.root, "state", "transfer-handoff.json")).handoff).toMatchObject({
      state: "destination-active",
      destinationState: "active",
    });
    expect(await source.run("transfer", "inspect")).toMatchObject({
      code: 0,
      summary: { transfer: { handoffId: "handoff:one", state: "destination-active" } },
    });
    expect(
      await source.run("recovery", "inspect", "--input", source.work("inspect.json", {})),
    ).toMatchObject({ code: 0, summary: { state: "blocked", reasonCode: "index-retired" } });
    expect(await source.run("transfer", "start", "--input", start)).toMatchObject({ code: 4 });
  });

  it("continues from every durable boundary without ever leaving two active authorities", async () => {
    for (const step of [
      "source-quiesced",
      "copied",
      "source-retired",
      "destination-active",
    ] as const) {
      const source = await activatedSource();
      const destination = destinationFor(source);
      const interrupted = interruptedApplication(source, step);
      try {
        await expect(
          interrupted.application.transferStart({
            handoffId: "handoff:crash",
            destinationInstallation: destination.root,
          }),
        ).rejects.toThrow(`interrupted after ${step}`);
      } finally {
        interrupted.close();
      }
      expect(activeStates(source, destination)).toBeLessThanOrEqual(1);
      const resumed = await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work(`continue-${step}.json`, continuation(source)),
      );
      expect(resumed, step).toMatchObject({
        code: 0,
        summary: { state: "destination-active", destinationState: "active" },
      });
      expect([
        (indexState(source.config.indexPath) as { state: string }).state,
        (indexState(destination.config.indexPath) as { state: string }).state,
      ]).toEqual(["retired", "active"]);
    }
  });

  it("aborts only before the source is retired and reactivates the source", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const early = interruptedApplication(source, "prepared");
    try {
      await expect(
        early.application.transferStart({
          handoffId: "handoff:early",
          destinationInstallation: destination.root,
        }),
      ).rejects.toThrow("interrupted after prepared");
    } finally {
      early.close();
    }
    // The source was never quiesced, so its prepared bundle may be stale: no continuation.
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("continue-early.json", continuation(source)),
      ),
    ).toMatchObject({ code: 4 });
    expect(
      await source.run(
        "transfer",
        "abort",
        "--input",
        source.work("abort-early.json", { handoffId: "handoff:early" }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "aborted", destinationState: "blocked" } });
    expect(readdirSync(destination.config.backupRoot)).toEqual([]);
    expect(existsSync(destination.config.databasePath)).toBe(false);
    expect(indexState(destination.config.indexPath)).toBeNull();

    const interrupted = interruptedApplication(source, "copied");
    try {
      await expect(
        interrupted.application.transferStart({
          handoffId: "handoff:abort",
          destinationInstallation: destination.root,
        }),
      ).rejects.toThrow("interrupted after copied");
    } finally {
      interrupted.close();
    }
    const abort = source.work("abort.json", { handoffId: "handoff:abort" });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await source.run("transfer", "abort", "--input", abort)).toMatchObject({
        code: 0,
        summary: { state: "aborted", destinationState: "blocked" },
      });
    expect((indexState(source.config.indexPath) as { state: string }).state).toBe("active");
    expect((indexState(destination.config.indexPath) as { state: string }).state).toBe("retired");
    expect(existsSync(destination.config.databasePath)).toBe(false);
    expect(readdirSync(destination.config.backupRoot)).toEqual([]);
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("continue-aborted.json", continuation(source)),
      ),
    ).toMatchObject({ code: 4 });
    expect(
      await source.run("recovery", "inspect", "--input", source.work("idle.json", {})),
    ).toMatchObject({ code: 0, summary: { state: "none", reasonCode: "idle" } });
    const fresh = destinationFor(source, { rootId: "root:second" });
    expect(
      await source.run(
        "transfer",
        "start",
        "--input",
        source.work("second.json", {
          handoffId: "handoff:second",
          destinationInstallation: fresh.root,
        }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "destination-active" } });

    const late = await activatedSource();
    const lateDestination = destinationFor(late);
    const retired = interruptedApplication(late, "source-retired");
    try {
      await expect(
        retired.application.transferStart({
          handoffId: "handoff:late",
          destinationInstallation: lateDestination.root,
        }),
      ).rejects.toThrow("interrupted after source-retired");
    } finally {
      retired.close();
    }
    expect(
      await late.run(
        "transfer",
        "abort",
        "--input",
        late.work("late.json", { handoffId: "handoff:late" }),
      ),
    ).toMatchObject({ code: 6 });
    expect(activeStates(late, lateDestination)).toBe(0);
  });

  it("refuses incompatible, occupied, nested, busy or unproven transfers", async () => {
    const source = await activatedSource();
    const start = (destinationInstallation: string, name: string) =>
      source.run(
        "transfer",
        "start",
        "--input",
        source.work(`${name}.json`, { handoffId: `handoff:${name}`, destinationInstallation }),
      );
    expect(
      await start(destinationFor(source, { authorityLineage: "lineage:other" }).root, "lineage"),
    ).toMatchObject({ code: 4 });
    expect(
      await start(destinationFor(source, { rootId: source.config.rootId }).root, "root"),
    ).toMatchObject({
      code: 4,
    });
    const occupied = destinationFor(source);
    writeFileSync(occupied.config.databasePath, "", { mode: 0o600 });
    expect(await start(occupied.root, "occupied")).toMatchObject({ code: 4 });
    expect(await start(join(source.root, "work"), "nested")).toMatchObject({ code: 2 });
    const busy = destinationFor(source);
    const held = acquireInstallation(busy.root);
    try {
      expect(await start(busy.root, "busy")).toMatchObject({ code: 3 });
    } finally {
      held.release();
    }
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("none.json", {
          handoffId: "handoff:none",
          authorityLineage: source.config.authorityLineage,
          expectedIndexGeneration: 0,
          indexDigest: `sha256:${"a".repeat(64)}`,
          sourceRoot: source.config.rootId,
          destinationRoot: "root:destination",
        }),
      ),
    ).toMatchObject({ code: 4 });
    expect((indexState(source.config.indexPath) as { state: string }).state).toBe("active");

    const tampered = destinationFor(source);
    const interrupted = interruptedApplication(source, "source-quiesced");
    try {
      await expect(
        interrupted.application.transferStart({
          handoffId: "handoff:tampered",
          destinationInstallation: tampered.root,
        }),
      ).rejects.toThrow("interrupted after source-quiesced");
    } finally {
      interrupted.close();
    }
    const input = continuation(source);
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("wrong.json", { ...input, indexDigest: `sha256:${"b".repeat(64)}` }),
      ),
    ).toMatchObject({ code: 4 });
    const path = join(source.root, "transfer-handoff.json");
    const stored = record(path);
    stored.handoff.copiedFileDigest = `sha256:${"c".repeat(64)}`;
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("tampered.json", input),
      ),
    ).toMatchObject({ code: 6 });
    expect(activeStates(source, tampered)).toBe(0);
  });
});
