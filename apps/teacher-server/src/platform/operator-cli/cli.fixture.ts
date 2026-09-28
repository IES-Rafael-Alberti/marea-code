import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { InstallationCapability } from "../../governance/authority.js";
import type { OperatorCliDependencies } from "./cli.js";
import { applicationFixture, CLI_NOW } from "./application.fixture.js";
import { PasswordInput, temporaryInstallation } from "./filesystem.fixture.js";

export function fixture() {
  const root = temporaryInstallation();
  const application = applicationFixture();
  const signals = new EventEmitter();
  const stdin = new PasswordInput();
  const events: string[] = [];
  const assertOwned = vi.fn(() => {
    events.push("assert");
    return undefined;
  });
  const capability: InstallationCapability = {
    kind: "exclusive-installation-owner",
    installationRoot: root,
    assertOwned,
  };
  const release = vi.fn(() => {
    events.push("release");
    return true;
  });
  const close = vi.fn(() => {
    events.push("close");
  });
  const composed = { application, reserved: [join(root, "locks")], close };
  const dependencies = {
    acquire: vi.fn<OperatorCliDependencies["acquire"]>(() => {
      events.push("acquire");
      return { capability, release };
    }),
    compose: vi.fn<OperatorCliDependencies["compose"]>(() => {
      events.push("compose");
      return composed;
    }),
    stdout: vi.fn<(text: string) => Promise<void>>(() => {
      events.push("stdout");
      return Promise.resolve();
    }),
    stderr: vi.fn<(text: string) => Promise<void>>(() => {
      events.push("stderr");
      return Promise.resolve();
    }),
    prompt: vi.fn(),
    stdin,
    signals,
    now: vi.fn(() => CLI_NOW),
  };
  const input = join(root, "work/request.json");
  const output = join(root, "work/output.json");
  const argv = (
    name = "center create",
    payload: unknown = { centerId: "center:test", displayName: "Center", expectedVersion: null },
    extra: string[] = [],
  ) => {
    writeFileSync(input, JSON.stringify(payload), { mode: 0o600 });
    return ["--installation", root, ...name.split(" "), "--input", input, ...extra];
  };
  return {
    root,
    input,
    output,
    application,
    signals,
    stdin,
    dependencies,
    capability,
    release,
    close,
    composed,
    events,
    argv,
  };
}

export const scope = { centerId: "center:test" };
export const target = { ...scope, classId: "class:test" };
export const account = { ...scope, userId: "user:test" };
export const expectedVersion = "revision:input";
export const owner = { source: "teacher", id: "user:test" };
