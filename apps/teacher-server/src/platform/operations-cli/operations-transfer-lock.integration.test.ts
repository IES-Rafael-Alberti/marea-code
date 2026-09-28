import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { NOW } from "../operations/retention/retention.fixture.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import { destinationInstallations } from "./operations-main.js";
import {
  activatedSource,
  cleanupTransferInstallations,
  destinationFor,
  indexState,
} from "./operations-transfer.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTransferInstallations);

describe("transfer destination left locked by an interrupted transfer", () => {
  it("names the destination before offering abandoned lock removal", async () => {
    for (const answer of ["n", "y"]) {
      const source = await activatedSource();
      const destination = destinationFor(source);
      const lock = join(destination.root, "locks", "installation.lock");
      writeFileSync(lock, '{"pid":1}', { mode: 0o600 });
      const written: string[] = [];
      const owned = acquireInstallation(source.root);
      const application = createOperationsApplication(
        owned.capability,
        readOperationsConfig(source.root),
        () => NOW,
        destinationInstallations({
          terminal: {
            interactive: true,
            write: (text) => {
              written.push(text);
            },
            readLine: () => Promise.resolve(answer),
          },
          processExists: () => false,
        }),
      );
      try {
        const start = application.transferStart({
          handoffId: `handoff:${answer}`,
          destinationInstallation: destination.root,
        });
        if (answer === "n") await expect(start).rejects.toThrow("installation-busy");
        else await expect(start).resolves.toMatchObject({ state: "destination-active" });
      } finally {
        application.close();
        owned.release();
      }
      expect(written[0]).toMatch(
        new RegExp(`^Transfer destination ${destination.root}:\\nThe installation is locked\\.\\n`),
      );
      expect(written.slice(1)).toEqual([
        answer === "n" ? "The lock was kept.\n" : "The lock was removed.\n",
      ]);
      expect(existsSync(lock)).toBe(answer === "n");
      expect((indexState(source.config.indexPath) as { state: string }).state).toBe(
        answer === "n" ? "active" : "retired",
      );
    }
  });
});
