import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import { initializeSqliteStorage, createDashboardProfileStore } from "@marea/sqlite-storage";
import {
  activatedSource,
  destinationFor,
  cleanupTransferInstallations,
} from "./operations-transfer.fixture.js";
afterEach(cleanupTransferInstallations);
it.each(["dashboard-profiles", "educational-insights"] as const)(
  "transfers %s with profile reset revisions and installation authority",
  async (schema) => {
    const source = await activatedSource();
    const storage = initializeSqliteStorage({
      databasePath: source.config.databasePath,
      schema,
    });
    const user = storage.database.readOne("SELECT id FROM marea_users LIMIT 1");
    if (typeof user?.id !== "string") throw new Error("Missing synthetic user");
    const value = {
      schemaVersion: 1,
      revision: "transferred-reset",
      updatedAt: "2026-09-22T12:00:00Z",
      serializedValue: null,
    };
    createDashboardProfileStore(storage.database).write(user.id, null, value);
    storage.close();
    const destination = await transfer(source);
    const restored = initializeSqliteStorage({
      databasePath: destination.config.databasePath,
      schema,
    });
    expect(createDashboardProfileStore(restored.database).read(user.id, null)).toEqual(value);
    restored.close();
  },
);

it("preserves schema 9 when transferring an installation without profiles", async () => {
  const source = await activatedSource();
  const destination = await transfer(source);
  const restored = initializeSqliteStorage({
    databasePath: destination.config.databasePath,
    schema: "retention-audit",
  });
  expect(restored.schema.version).toBe(9);
  restored.close();
});

async function transfer(source: Awaited<ReturnType<typeof activatedSource>>) {
  const destination = destinationFor(source);
  const input = source.work("profile-transfer.json", {
    handoffId: "handoff:profiles",
    destinationInstallation: destination.root,
  });
  expect(await source.run("transfer", "start", "--input", input)).toMatchObject({
    code: 0,
    summary: { state: "destination-active" },
  });
  return destination;
}
