import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import { OperatorCliError } from "../operator-cli/errors.js";
import { currentUid } from "../operator-cli/private-path.js";
import { readOperationsConfig } from "./operations-config.js";
import { cleanupOperationsInstallations, operationsInstallation } from "./operations.fixture.js";

afterEach(cleanupOperationsInstallations);

const UNAVAILABLE = new OperatorCliError("prerequisite-unavailable");

describe("private operations configuration", () => {
  it("reads the strict document with an index that is absent or a private file", () => {
    const f = operationsInstallation();
    expect(readOperationsConfig(f.root)).toEqual(f.config);
    mkdirSync(join(f.root, "state"), { mode: 0o700 });
    const nested = { ...f.config, indexPath: join(f.root, "state", "index.sqlite") };
    f.writeConfig(nested);
    expect(readOperationsConfig(f.root)).toEqual(nested);
    writeFileSync(nested.indexPath, "", { mode: 0o600 });
    expect(readOperationsConfig(f.root)).toEqual(nested);
  });

  it("refuses missing, public, foreign, overlapping or unexpected configuration", () => {
    const f = operationsInstallation();
    const refuse = (value: unknown) => {
      f.writeConfig(value);
      expect(() => readOperationsConfig(f.root)).toThrow(UNAVAILABLE);
    };
    expect(() => readOperationsConfig(f.root, currentUid() + 1)).toThrow(UNAVAILABLE);
    refuse({ ...f.config, backupRoot: f.config.databasePath });
    refuse({ ...f.config, databasePath: join(f.root, "backups") });
    refuse({ ...f.config, indexPath: join(f.root, "backups", "index.sqlite") });
    refuse({ ...f.config, backupRoot: join(f.root, "locks") });
    refuse({ ...f.config, backupRoot: join(f.root, "config") });
    mkdirSync(join(f.root, "public"), { mode: 0o755 });
    refuse({ ...f.config, indexPath: join(f.root, "public", "index.sqlite") });
    writeFileSync(join(f.root, "public-index.sqlite"), "", { mode: 0o644 });
    refuse({ ...f.config, indexPath: join(f.root, "public-index.sqlite") });
    refuse({ ...f.config, databasePath: join(f.root, "work") });
    const text = JSON.stringify({ ...f.config, stateFiles: ["state-byte"] });
    const [before, after] = text.split("byte");
    writeFileSync(
      join(f.root, "config", "operations.json"),
      Buffer.concat([Buffer.from(before ?? ""), Buffer.from([0xff]), Buffer.from(after ?? "")]),
      { mode: 0o600 },
    );
    expect(() => readOperationsConfig(f.root)).toThrow(TypeError);
    f.writeConfig({ ...f.config, unexpected: true });
    expect(() => readOperationsConfig(f.root)).toThrow();
    f.writeConfig(f.config);
    chmodSync(join(f.root, "config", "operations.json"), 0o644);
    expect(() => readOperationsConfig(f.root)).toThrow(UNAVAILABLE);
    chmodSync(join(f.root, "config", "operations.json"), 0o600);
    symlinkSync(join(f.root, "work"), join(f.root, "linked"));
    refuse({ ...f.config, backupRoot: join(f.root, "linked") });
  });
});
