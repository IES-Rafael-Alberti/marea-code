import { afterEach, describe, expect, it, vi } from "vitest";

import type { OperatorCliDependencies } from "../operator-cli/cli.js";
import type { InstallationCapability } from "../../governance/authority.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import type { OperationsApplication } from "./operations-application.js";
import { composeOperations, runOperationsMain } from "./operations-main.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue(4),
  acquire: vi.fn(),
  ports: {
    stdout: vi.fn(),
    stderr: vi.fn(),
    prompt: vi.fn(),
    stdin: { name: "stdin" },
    signals: { name: "signals" },
    now: vi.fn(() => "2026-09-14T01:02:03.004Z"),
  },
  read: vi.fn(),
  create: vi.fn(),
  commands: { "deletion activate": {} },
  status: vi.fn().mockResolvedValue(0),
}));
vi.mock("./installation-status.js", () => ({ runInstallationStatus: mocks.status }));
// Lock recovery wraps the real acquisition; the wrapper records what it was composed from.
vi.mock("../installation/lock-recovery-terminal.boundary.js", () => ({
  processLockRecovery: () => "process lock recovery",
}));
vi.mock("../installation/abandoned-lock-recovery.js", () => ({
  acquireWithLockRecovery: (acquire: unknown, recovery: unknown) => ({ acquire, recovery }),
}));
vi.mock("../operator-cli/cli.js", () => ({ runOperatorCli: mocks.run }));
vi.mock("../operator-cli/installation-lock.js", () => ({ acquireInstallation: mocks.acquire }));
vi.mock("../operator-cli/main.js", () => ({ processPorts: () => mocks.ports }));
vi.mock("./operations-config.js", () => ({ readOperationsConfig: mocks.read }));
vi.mock("./operations-application.js", () => ({ createOperationsApplication: mocks.create }));
vi.mock("./operations-commands.js", () => ({ operationsCommands: () => mocks.commands }));

afterEach(() => {
  vi.clearAllMocks();
});

const capability: InstallationCapability = {
  kind: "exclusive-installation-owner",
  installationRoot: "/private/installation",
  assertOwned: () => undefined,
};

describe("private operations executable wiring", () => {
  it("composes the configured application with reserved installation paths", () => {
    const close = vi.fn();
    const application = { close } as unknown as OperationsApplication;
    mocks.read.mockReturnValue({
      databasePath: "/private/installation/marea.sqlite",
      indexPath: "/private/installation/index.sqlite",
      backupRoot: "/private/installation/backups",
    });
    mocks.create.mockReturnValue(application);
    const now = () => "2026-09-14T10:00:00.000Z";
    const installations = { acquire: vi.fn(), read: vi.fn() };
    const composed = composeOperations(capability, now, installations);
    expect(mocks.read).toHaveBeenCalledWith("/private/installation");
    expect(mocks.create).toHaveBeenCalledWith(
      capability,
      mocks.read.mock.results[0]?.value,
      now,
      installations,
    );
    expect(composed.application).toBe(application);
    expect(composed.reserved).toEqual([
      "/private/installation/locks",
      "/private/installation/config",
      "/private/installation/marea.sqlite",
      "/private/installation/marea.sqlite-wal",
      "/private/installation/marea.sqlite-shm",
      "/private/installation/marea.sqlite-journal",
      "/private/installation/index.sqlite",
      "/private/installation/index.sqlite-wal",
      "/private/installation/index.sqlite-shm",
      "/private/installation/index.sqlite-journal",
      "/private/installation/backups",
    ]);
    composed.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps closed CLI errors and hides every other composition failure", () => {
    const busy = new OperatorCliError("installation-lost");
    mocks.read.mockImplementationOnce(() => {
      throw busy;
    });
    expect(() => composeOperations(capability, () => "now")).toThrow(busy);
    mocks.read.mockImplementationOnce(() => {
      throw new Error("private path detail");
    });
    expect(() => composeOperations(capability, () => "now")).toThrow(
      new OperatorCliError("prerequisite-unavailable"),
    );
  });

  it("wires argv, ports, descriptors, clock and the operations command table", async () => {
    const argv = ["--installation", "/private/installation", "deletion", "activate"];
    expect(await runOperationsMain(argv)).toBe(4);
    const [received, deps, commands] = mocks.run.mock.calls[0] as [
      string[],
      OperatorCliDependencies<OperationsApplication>,
      unknown,
    ];
    expect(received).toBe(argv);
    expect(commands).toBe(mocks.commands);
    expect(deps).toMatchObject(mocks.ports);
    expect(deps.acquire).toEqual({ acquire: mocks.acquire, recovery: "process lock recovery" });
    mocks.read.mockReturnValue({ databasePath: "/d", indexPath: "/i", backupRoot: "/b" });
    mocks.create.mockReturnValue({ close: vi.fn() });
    deps.compose(capability);
    expect(mocks.create.mock.calls[0]?.[2]).toBe(mocks.ports.now);
    const installations = mocks.create.mock.calls[0]?.[3] as { acquire: unknown; read: unknown };
    expect(typeof installations.acquire).toBe("function");
    expect(installations.read).toBe(mocks.read);
    const old = process.argv;
    process.argv = ["runtime", "executable", ...argv];
    try {
      expect(await runOperationsMain()).toBe(4);
      expect(mocks.run.mock.calls[1]?.[0]).toEqual(argv);
    } finally {
      process.argv = old;
    }
  });

  it("routes only the exact lock-free status command away from the locked runner", async () => {
    expect(
      await runOperationsMain(["--installation", "/private/root", "installation", "status"]),
    ).toBe(0);
    expect(mocks.status).toHaveBeenCalledWith("/private/root", mocks.ports);
    expect(mocks.run).not.toHaveBeenCalled();
    for (const argv of [
      ["--installation", "/private/root", "installation", "status", "--input", "x"],
      ["--installation", "/private/root", "installation", "initialize"],
      ["--installation", "/private/root", "recovery", "status"],
      ["--root", "/private/root", "installation", "status"],
      ["--installation"],
    ])
      expect(await runOperationsMain(argv)).toBe(4);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(5);
  });

  it("the root entry awaits operations main and assigns its exit code", async () => {
    const old = process.exitCode;
    try {
      mocks.run.mockResolvedValueOnce(6);
      await import("../../../operations-entry.js");
      expect(process.exitCode).toBe(6);
    } finally {
      process.exitCode = old;
    }
  });
});
