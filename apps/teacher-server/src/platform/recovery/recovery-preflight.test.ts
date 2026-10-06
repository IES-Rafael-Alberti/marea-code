import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecoveryBundle } from "./index.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";

vi.mock(
  "@marea/sqlite-storage",
  async () => (await import("./recovery-sqlite-mocks.fixture.js")).default,
);
const environment = startRecoveryTest("marea-recovery-preflight-");
const root = environment.root;
const writeState = environment.writeState;

describe("recovery preflight", () => {
  it("reserves a private staging directory before entering maintenance", () => {
    let calls = 0;
    writeState();
    createRecoveryBundle(join(root(), "staged-before-lock"), {
      ...environment.input(),
      createExclusive: (operation) => {
        const staging = readdirSync(root()).filter((name) => name.endsWith(".staging"));
        expect(staging).toHaveLength(1);
        const staged = join(root(), String(staging[0]));
        expect(statSync(staged).isDirectory()).toBe(true);
        expect(statSync(staged).mode & 0o777).toBe(0o700);
        calls += 1;
        return operation();
      },
    });
    expect(calls).toBe(1);
    expect(readdirSync(root()).filter((name) => name.endsWith(".staging"))).toEqual([]);
  });

  it("rejects an occupied destination before taking the maintenance lock or capturing data", () => {
    let calls = 0;
    writeState();
    const destination = join(root(), "already-present");
    mkdirSync(destination);
    expectRecoveryError(() => {
      createRecoveryBundle(destination, {
        ...environment.input(),
        createExclusive: (operation) => {
          calls += 1;
          return operation();
        },
      });
    }, "bundle-destination-invalid");
    expect(calls).toBe(0);
    expect(readdirSync(destination)).toEqual([]);
  });
});
