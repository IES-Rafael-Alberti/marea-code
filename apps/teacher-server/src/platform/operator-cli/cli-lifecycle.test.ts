import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./commands.js";
import { OperatorCliError } from "./errors.js";
import { cleanupInstallations } from "./filesystem.fixture.js";
import { renameSync, mkdirSync, existsSync } from "node:fs";
import { MAX_GOVERNANCE_RESPONSE_BYTES } from "@marea/protocol";
import { TeacherDomainError } from "../../identity/errors.js";
import { runOperatorCli } from "./cli.js";
import { fixture, target, expectedVersion } from "./cli.fixture.js";
import { centerResult, exchangeResult } from "./application.fixture.js";

const exportArtifact = (f: ReturnType<typeof fixture>) =>
  runOperatorCli(
    f.argv("class export", { ...target, expectedTeachingVersion: null }, ["--output", f.output]),
    f.dependencies,
  );

afterEach(() => {
  cleanupInstallations();
  vi.restoreAllMocks();
});

describe("owned lifecycle and truthful completion", () => {
  it("does no work without ownership or configuration and sanitizes failures", async () => {
    const f = fixture();
    f.dependencies.acquire.mockImplementationOnce(() => {
      throw new OperatorCliError("installation-busy");
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(3);
    expect(f.dependencies.compose).not.toHaveBeenCalled();
    f.dependencies.compose.mockImplementationOnce(() => {
      throw new OperatorCliError("prerequisite-unavailable");
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(5);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.application.createCenter.mockRejectedValueOnce(new TeacherDomainError("request.conflict"));
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(4);
    f.application.createCenter.mockRejectedValueOnce(new Error("secret /private/path"));
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(6);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
    expect(f.dependencies.stderr.mock.calls.flat().join("")).not.toContain("secret");
  });
  it("waits for an asynchronous owner such as abandoned lock recovery before any work", async () => {
    const f = fixture();
    const owner = f.dependencies.acquire(f.root);
    if (owner instanceof Promise) throw new Error("synchronous fixture owner expected");
    f.dependencies.acquire.mockImplementationOnce(() => Promise.resolve(owner));
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(0);
    expect(f.dependencies.compose).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    f.dependencies.acquire.mockImplementationOnce(() =>
      Promise.reject(new OperatorCliError("installation-busy")),
    );
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(3);
    expect(f.dependencies.compose).toHaveBeenCalledTimes(1);
  });
  it("waits for work before cleanup, gates late commits on cancellation and keeps unrelated listeners", async () => {
    for (const [signal, exit] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const f = fixture();
      let finish!: () => void;
      let committed = false;
      const other = vi.fn();
      f.signals.on(signal, other);
      f.application.createCenter.mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        input.authority.assertOwned();
        committed = true;
        return centerResult;
      });
      const running = runOperatorCli(f.argv(), f.dependencies);
      f.signals.emit(signal);
      f.signals.emit(signal);
      expect(f.close).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      finish();
      expect(await running).toBe(exit);
      expect(committed).toBe(false);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.dependencies.stdout).not.toHaveBeenCalled();
      expect(f.signals.listeners(signal)).toEqual([other]);
      expect(other).toHaveBeenCalledTimes(2);
    }
  });
  it("cancels already-aborted composition and reports interrupted work even if the port resolves", async () => {
    const f = fixture();
    f.dependencies.compose.mockImplementationOnce(() => {
      f.signals.emit("SIGINT");
      return f.composed;
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(130);
    expect(f.application.createCenter).not.toHaveBeenCalled();
    f.application.createCenter.mockImplementationOnce(() => {
      f.signals.emit("SIGTERM");
      return Promise.resolve(centerResult);
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(143);
    f.dependencies.acquire.mockImplementationOnce(() => {
      f.signals.emit("SIGINT");
      return { capability: f.capability, release: f.release };
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(130);
  });
  it("cancels a pending password without provisioning or leaking the secret", async () => {
    const f = fixture();
    const running = runOperatorCli(
      [
        "--installation",
        f.root,
        "credential",
        "provision",
        "--user",
        "user:test",
        "--expected-version",
        expectedVersion,
        "--password-stdin",
      ],
      f.dependencies,
    );
    f.stdin.send("part-of-private-password");
    f.signals.emit("SIGINT");
    expect(await running).toBe(130);
    expect(f.application.provisionCredential).not.toHaveBeenCalled();
    expect(f.stdin.eventNames()).toEqual([]);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
  });
  it("retains exclusion on uncertain resource close and never prints success on failed release", async () => {
    const f = fixture();
    f.close.mockImplementationOnce(() => {
      throw new Error("private");
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(6);
    expect(f.release).not.toHaveBeenCalled();
    f.release.mockReturnValueOnce(false);
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(6);
    f.release.mockImplementationOnce(() => {
      throw new Error("private");
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(6);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
    expect(f.signals.eventNames()).toEqual([]);
  });
  it("checks ownership after asynchronous work and handles failures during final verification/output", async () => {
    const f = fixture();
    f.application.createCenter.mockImplementationOnce(() => {
      vi.mocked(f.capability.assertOwned).mockImplementation(() => {
        throw new OperatorCliError("installation-lost");
      });
      return Promise.resolve(centerResult);
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(3);
    const g = fixture();
    g.close.mockImplementationOnce(() => {
      g.signals.emit("SIGTERM");
    });
    expect(await runOperatorCli(g.argv(), g.dependencies)).toBe(143);
    const h = fixture();
    h.close.mockImplementationOnce(() => {
      vi.mocked(h.capability.assertOwned).mockImplementation(() => {
        throw new OperatorCliError("installation-lost");
      });
    });
    expect(await runOperatorCli(h.argv(), h.dependencies)).toBe(3);
    const i = fixture();
    i.dependencies.stdout.mockRejectedValueOnce(new Error("EPIPE private"));
    expect(await runOperatorCli(i.argv(), i.dependencies)).toBe(6);
    expect(i.release).toHaveBeenCalledTimes(1);
    i.dependencies.stderr.mockRejectedValue(new Error("closed"));
    expect(await runOperatorCli([], i.dependencies)).toBe(6);
  });
  it("rejects invalid clock, oversized summaries and private destinations before reporting success", async () => {
    const f = fixture();
    f.dependencies.now.mockReturnValueOnce("not-a-date");
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(2);
    expect(f.application.createCenter).not.toHaveBeenCalled();
    f.application.createCenter.mockResolvedValueOnce({
      ...centerResult,
      displayName: "é".repeat(MAX_GOVERNANCE_RESPONSE_BYTES),
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(6);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
    expect(
      await runOperatorCli(
        f.argv("class export", { ...target, expectedTeachingVersion: null }, [
          "--output",
          join(f.root, "locks/out"),
        ]),
        f.dependencies,
      ),
    ).toBe(2);
    expect(f.application.exportClass).not.toHaveBeenCalled();
  });
  it("binds private artifact destinations across asynchronous ports", async () => {
    const f = fixture();
    f.application.exportClass.mockImplementationOnce(() => {
      renameSync(join(f.root, "work"), join(f.root, "moved"));
      mkdirSync(join(f.root, "work"), { mode: 0o700 });
      return Promise.resolve(exchangeResult);
    });
    expect(await exportArtifact(f)).toBe(6);
    expect(existsSync(f.output)).toBe(false);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
  });
  it("refuses a lost initial capability before composition and an unexpected artifact without a destination", async () => {
    const f = fixture();
    vi.mocked(f.capability.assertOwned).mockImplementation(() => {
      throw new OperatorCliError("installation-lost");
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(3);
    expect(f.dependencies.compose).not.toHaveBeenCalled();
    expect(f.application.createCenter).not.toHaveBeenCalled();
    const g = fixture();
    const spec = COMMANDS["center create"];
    if (spec === undefined) throw new Error("missing command");
    vi.spyOn(spec, "run").mockResolvedValue({
      summary: {},
      artifact: { value: {}, maxBytes: 100 },
    });
    expect(await runOperatorCli(g.argv(), g.dependencies)).toBe(6);
    expect(g.dependencies.stdout).not.toHaveBeenCalled();
  });
  it("rechecks cancellation and ownership before artifact publication and never commits after authority loss", async () => {
    for (const change of ["cancel", "lost"] as const) {
      const f = fixture();
      f.application.exportClass.mockImplementationOnce(() => {
        if (change === "cancel") f.signals.emit("SIGTERM");
        else
          vi.mocked(f.capability.assertOwned).mockImplementation(() => {
            throw new OperatorCliError("installation-lost");
          });
        return Promise.resolve(exchangeResult);
      });
      expect(await exportArtifact(f)).toBe(change === "cancel" ? 143 : 3);
      expect(existsSync(f.output)).toBe(false);
    }
    const f = fixture();
    let committed = false;
    f.application.createCenter.mockImplementationOnce((input) => {
      vi.mocked(f.capability.assertOwned).mockImplementation(() => {
        throw new OperatorCliError("installation-lost");
      });
      input.authority.assertOwned();
      committed = true;
      return Promise.resolve(centerResult);
    });
    expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(3);
    expect(committed).toBe(false);
  });
  it("bounds the complete stdout line including its one trailing newline", async () => {
    const size = Buffer.byteLength(JSON.stringify({ ...centerResult, displayName: "" }));
    for (const bytes of [MAX_GOVERNANCE_RESPONSE_BYTES - 1, MAX_GOVERNANCE_RESPONSE_BYTES]) {
      const f = fixture();
      f.application.createCenter.mockResolvedValue({
        ...centerResult,
        displayName: "x".repeat(bytes - size),
      });
      expect(await runOperatorCli(f.argv(), f.dependencies)).toBe(
        bytes < MAX_GOVERNANCE_RESPONSE_BYTES ? 0 : 6,
      );
      if (bytes < MAX_GOVERNANCE_RESPONSE_BYTES)
        expect(Buffer.byteLength(f.dependencies.stdout.mock.calls[0]?.[0] ?? "")).toBe(
          MAX_GOVERNANCE_RESPONSE_BYTES,
        );
      else expect(f.dependencies.stdout).not.toHaveBeenCalled();
    }
  });
});
