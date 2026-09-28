import { dirname } from "node:path";
import { existsSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@marea/sqlite-storage", async () => {
  const fixture = await import("./recovery-smoke-mocks.fixture.js");
  return fixture.default;
});

describe("recovery bundle smoke", () => {
  it("runs the smoke flow and validates reads, writes, handles and cleanup", async () => {
    vi.resetModules();
    const fixture = await import("./recovery-smoke-mocks.fixture.js");
    fixture.resetSmokeState();
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    await import("./recovery-bundle.js");

    write.mockRestore();
    const result = JSON.parse(output.trim()) as {
      database: {
        persisted: { id: string; display_name: string };
        restored: { id: string; display_name: string };
      };
      files: readonly [string, string];
      ok: boolean;
      schemaVersion: number;
    };
    expect(result).toEqual({
      database: {
        persisted: { id: "class:restored", display_name: "Restored persistence class" },
        restored: { id: "class:smoke", display_name: "Recovery smoke class" },
      },
      files: ["Teaching configuration bytes.", "Immutable run snapshot bytes."],
      manifest: expect.anything() as unknown,
      ok: true,
      schemaVersion: 6,
    });
    const temporaryRoot = dirname(fixture.smokeState.sourceDatabasePath);
    expect(fixture.smokeState.sourceDatabasePath.endsWith("/teacher.sqlite")).toBe(true);
    expect(temporaryRoot.split("/").at(-1)?.startsWith("marea-recovery-smoke-")).toBe(true);
    expect(fixture.smokeState.executes).toEqual([
      JSON.stringify({
        sql: "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
        parameters: ["class:smoke", "smoke", "Recovery smoke class"],
      }),
      JSON.stringify({
        sql: "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?3)",
        parameters: ["class:restored", "restored", "Restored persistence class"],
      }),
    ]);
    expect(fixture.smokeState.readCalls).toBe(2);
    expect(fixture.smokeState.queries).toEqual([["class:smoke"], ["class:restored"]]);
    expect(fixture.smokeState.closeCalls).toEqual(["source", "restored", "reopened", "reopened"]);
    expect(fixture.smokeState.restoreCalls).toHaveLength(1);
    expect(fixture.smokeState.initializeCalls[0]).toBe(fixture.smokeState.sourceDatabasePath);
    expect(fixture.smokeState.initializeCalls.at(-1)).toBe(
      `${temporaryRoot}/restored/database.sqlite`,
    );
    expect(fixture.smokeState.restoreCalls[0]?.backupSchemaVersion).toBe(6);
    expect(fixture.smokeState.restoreCalls[0]?.databasePath).toContain("/.database.sqlite.");
    expect(fixture.smokeState.restoreCalls[0]?.databasePath.endsWith(".restore")).toBe(true);
    expect(existsSync(dirname(fixture.smokeState.sourceDatabasePath))).toBe(false);
  });

  it("rejects restored rows that do not match", async () => {
    for (const invalidRead of ["id", "display-name"]) {
      vi.resetModules();
      const fixture = await import("./recovery-smoke-mocks.fixture.js");
      fixture.resetSmokeState();
      fixture.smokeState.invalidRead = invalidRead;
      await expect(import("./recovery-bundle.js")).rejects.toThrow("did not match");
    }
  });
});
