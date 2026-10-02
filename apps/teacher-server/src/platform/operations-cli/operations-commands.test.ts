import { describe, expect, it, vi } from "vitest";

import type { CommandRequest } from "../operator-cli/commands.js";
import type { OperationsApplication } from "./operations-application.js";
import { operationsCommands } from "./operations-commands.js";

function request(payload: Record<string, unknown>): CommandRequest {
  return {
    context: {} as CommandRequest["context"],
    payload,
    flags: {},
    password: () => Promise.resolve(""),
  };
}

const CHECKPOINT = { state: "uncertain" };

describe("operations command table", () => {
  it("declares each command's closed keys, flags and bounds", () => {
    const commands = operationsCommands();
    expect(Object.isFrozen(commands)).toBe(true);
    expect(
      Object.fromEntries(
        Object.entries(commands).map(([name, spec]) => [
          name,
          [spec.keys, spec.flags, spec.inputBytes, spec.passwordStdin],
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "backup create": [
          [
            "name",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "backup reconcile": [
          [
            "bundlePath",
            "restoredDatabasePath",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "backup restore": [
          [
            "bundlePath",
            "destinationRoot",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "deletion activate": [
          [],
          [],
          65536,
          false,
        ],
        "deletion confirm": [
          [
            "format",
            "previewId",
            "requestId",
            "authorityLineage",
            "installationId",
            "sourceDatabaseLineage",
            "actorBinding",
            "policyRevision",
            "expectedIndexGeneration",
            "targets",
            "graphDigest",
            "counts",
            "bytes",
            "blockers",
            "createdAt",
            "expiresAt",
            "artifactDigest",
          ],
          [
            "input",
          ],
          262144,
          false,
        ],
        "deletion preview": [
          [
            "requestId",
            "previewId",
            "policyRevision",
            "targets",
          ],
          [
            "input",
            "output",
          ],
          65536,
          false,
        ],
        "installation initialize": [
          [],
          [],
          65536,
          false,
        ],
        "installation upgrade-profiles": [
          [
            "name",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "recovery continue": [
          [
            "operationId",
            "expectedIndexGeneration",
            "artifactDigest",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "recovery inspect": [
          [
            "operationId",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "recovery mark-failed": [
          [
            "operationId",
            "expectedIndexGeneration",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "recovery transfer-continue": [
          [
            "handoffId",
            "authorityLineage",
            "expectedIndexGeneration",
            "indexDigest",
            "sourceRoot",
            "destinationRoot",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "server-settings initialize": [
          [
            "userId",
            "name",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "transfer abort": [
          [
            "handoffId",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
        "transfer inspect": [
          [],
          [],
          65536,
          false,
        ],
        "transfer start": [
          [
            "handoffId",
            "destinationInstallation",
          ],
          [
            "input",
          ],
          65536,
          false,
        ],
      }
    `);
  });

  it("summarizes recovery inspections including their checkpoint state", async () => {
    const inspection = {
      state: "uncertain",
      operationId: "preview:one",
      checkpoint: CHECKPOINT,
      reasonCode: "pending-checkpoint",
    };
    const inspect = vi.fn().mockResolvedValue(inspection);
    const app = { inspect } as unknown as OperationsApplication;
    const spec = operationsCommands()["recovery inspect"];
    expect(await spec?.run(app, request({ operationId: "preview:one" }))).toEqual({
      summary: {
        state: "uncertain",
        operationId: "preview:one",
        checkpointState: "uncertain",
        reasonCode: "pending-checkpoint",
      },
    });
    expect(inspect).toHaveBeenCalledWith("preview:one");
  });

  it("summarizes initialization and isolated restores", async () => {
    const restored = {
      state: "restored",
      reasonCode: "none",
      schemaVersion: 9,
      checked: 2,
      tombstoned: 0,
      path: "/private/restored",
    };
    const restore = vi.fn().mockResolvedValue(restored);
    const app = {
      initialize: vi.fn(() => ({ schemaVersion: 9 })),
      restore,
    } as unknown as OperationsApplication;
    const commands = operationsCommands();
    expect(await commands["installation initialize"]?.run(app, request({}))).toEqual({
      summary: { schemaVersion: 9 },
    });
    const input = { bundlePath: "/private/bundle", destinationRoot: "/private/restored" };
    expect(await commands["backup restore"]?.run(app, request(input))).toEqual({
      summary: restored,
    });
    expect(restore).toHaveBeenCalledWith(input);
    await expect(
      commands["backup restore"]?.run(app, request({ ...input, extra: true })),
    ).rejects.toThrow();
  });
});

it("parses a closed new-backup name for explicit profile upgrade", async () => {
  const upgradeProfiles = vi
    .fn()
    .mockResolvedValue({ schemaVersion: 10, backupPath: "/private/before" });
  const app = { upgradeProfiles } as unknown as OperationsApplication;
  const spec = operationsCommands()["installation upgrade-profiles"];
  expect(await spec?.run(app, request({ name: "before" }))).toEqual({
    summary: { schemaVersion: 10, backupPath: "/private/before" },
  });
  expect(upgradeProfiles).toHaveBeenCalledWith("before");
  for (const payload of [{ name: "../escape" }, { name: "before", extra: true }, {}])
    await expect(spec?.run(app, request(payload))).rejects.toThrow();
  expect(upgradeProfiles).toHaveBeenCalledTimes(1);
});

it("grants server settings to an explicit teacher after a named safety backup", async () => {
  const initializeServerSettings = vi
    .fn()
    .mockResolvedValue({ administrator: "user:teacher", revision: 0 });
  const app = { initializeServerSettings } as unknown as OperationsApplication;
  const spec = operationsCommands()["server-settings initialize"];
  expect(await spec?.run(app, request({ userId: "user:teacher", name: "before" }))).toEqual({
    summary: { administrator: "user:teacher", revision: 0 },
  });
  expect(initializeServerSettings).toHaveBeenCalledWith("user:teacher", "before");
  for (const payload of [{ userId: "user:teacher", name: "../escape" }, { name: "before" }])
    await expect(spec?.run(app, request(payload))).rejects.toThrow();
  expect(initializeServerSettings).toHaveBeenCalledOnce();
});
