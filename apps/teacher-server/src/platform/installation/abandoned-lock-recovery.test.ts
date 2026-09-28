import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorCliError } from "../operator-cli/errors.js";
import type { OwnedInstallation } from "../operator-cli/installation-lock.js";
import { currentUid } from "../operator-cli/private-path.js";
import {
  acquireWithLockRecovery,
  offerAbandonedLockRemoval,
  type LockRecoveryDependencies,
} from "./abandoned-lock-recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    if (existsSync(join(root, "locks"))) chmodSync(join(root, "locks"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

const QUESTION =
  "The installation is locked.\n" +
  "This usually means Marea did not shut down correctly (power loss, abrupt restart or forced stop).\n" +
  'If another Marea program is running on this installation right now, answer "no": removing the lock could damage data.\n';
const ASK = "Remove the lock and continue anyway? [y/N] ";

function installation(locks: { host?: string; operator?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-lock-recovery-")));
  roots.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "locks"), { mode: 0o700 });
  const host = join(root, ".marea-installation.lock");
  const operator = join(root, "locks", "installation.lock");
  if (locks.host !== undefined) writeFileSync(host, locks.host, { mode: 0o600 });
  if (locks.operator !== undefined) writeFileSync(operator, locks.operator, { mode: 0o600 });
  return { root, host, operator };
}

function terminal(answer: string | undefined, interactive = true, onAsk = () => undefined) {
  const written: string[] = [];
  const dependencies: LockRecoveryDependencies = {
    terminal: {
      interactive,
      write: (text) => {
        written.push(text);
      },
      readLine: () => {
        onAsk();
        return Promise.resolve(answer);
      },
    },
    processExists: vi.fn(() => false),
    uid: currentUid(),
  };
  return { written, dependencies };
}

describe("abandoned installation lock recovery", () => {
  it("removes both locks after an explicit yes and warns when the recorded owner exists", async () => {
    for (const answer of ["y", " YES \r"]) {
      const f = installation({ host: '{"pid":4242,"token":"t"}', operator: '{"pid":4242}' });
      const t = terminal(answer);
      vi.mocked(t.dependencies.processExists).mockReturnValue(true);
      expect(await offerAbandonedLockRemoval(f.root, t.dependencies)).toBe(true);
      expect(t.dependencies.processExists).toHaveBeenCalledTimes(1);
      expect(t.dependencies.processExists).toHaveBeenCalledWith(4242);
      expect(t.written).toEqual([
        QUESTION +
          "Warning: Marea appears to be running (process 4242). Removing the lock is not recommended.\n" +
          ASK,
        "The lock was removed.\n",
      ]);
      expect([existsSync(f.host), existsSync(f.operator)]).toEqual([false, false]);
    }
    const one = installation({ operator: '{"pid":7}', host: '{"pid":8}' });
    const both = terminal("y");
    vi.mocked(both.dependencies.processExists).mockReturnValue(true);
    expect(await offerAbandonedLockRemoval(one.root, both.dependencies)).toBe(true);
    expect(both.written[0]).toContain("(process 8, 7)");
    const operatorOnly = installation({ operator: "" });
    const defaultUid = terminal("yes");
    expect(
      await offerAbandonedLockRemoval(operatorOnly.root, {
        terminal: defaultUid.dependencies.terminal,
        processExists: defaultUid.dependencies.processExists,
      }),
    ).toBe(true);
    expect(defaultUid.written[0]).toBe(QUESTION + ASK);
    expect(existsSync(operatorOnly.operator)).toBe(false);
  });

  it("keeps the locks without a yes, without a terminal or when nothing is recognisably locked", async () => {
    for (const answer of [undefined, "", "n", "no", "yes please"]) {
      const f = installation({ host: '{"pid":"text"}', operator: "not json" });
      const t = terminal(answer);
      expect(await offerAbandonedLockRemoval(f.root, t.dependencies)).toBe(false);
      expect(t.dependencies.processExists).not.toHaveBeenCalled();
      expect(t.written).toEqual([QUESTION + ASK, "The lock was kept.\n"]);
      expect([existsSync(f.host), existsSync(f.operator)]).toEqual([true, true]);
    }
    const f = installation({ host: "{}" });
    const silent = terminal("y", false);
    expect(await offerAbandonedLockRemoval(f.root, silent.dependencies)).toBe(false);
    expect(silent.written).toEqual([
      "The installation is locked. If Marea did not shut down correctly, run this command in a terminal to review and remove the lock.\n",
    ]);
    expect(existsSync(f.host)).toBe(true);

    const unlocked = installation();
    const none = terminal("y");
    expect(await offerAbandonedLockRemoval(unlocked.root, none.dependencies)).toBe(false);
    expect(await offerAbandonedLockRemoval(join(unlocked.root, "missing"), none.dependencies)).toBe(
      false,
    );
    const foreign = installation({ host: "{}" });
    expect(
      await offerAbandonedLockRemoval(foreign.root, {
        ...none.dependencies,
        uid: currentUid() + 1,
      }),
    ).toBe(false);
    chmodSync(foreign.host, 0o644);
    expect(await offerAbandonedLockRemoval(foreign.root, none.dependencies)).toBe(false);
    chmodSync(foreign.host, 0o600);
    chmodSync(foreign.root, 0o755);
    expect(await offerAbandonedLockRemoval(foreign.root, none.dependencies)).toBe(false);
    expect(none.written).toEqual([]);
    expect(existsSync(foreign.host)).toBe(true);
  });

  it("removes nothing when the locks change while waiting or cannot be removed", async () => {
    const replaced = installation({ host: "{}", operator: "{}" });
    const changed = terminal("y", true, () => {
      rmSync(replaced.operator);
      writeFileSync(replaced.operator, "{}", { mode: 0o600 });
    });
    expect(await offerAbandonedLockRemoval(replaced.root, changed.dependencies)).toBe(false);
    expect(changed.written.at(-1)).toBe("The lock changed while waiting; nothing was removed.\n");
    expect(existsSync(replaced.host)).toBe(true);

    const vanished = installation({ host: "{}", operator: "{}" });
    const gone = terminal("y", true, () => {
      rmSync(vanished.operator);
    });
    expect(await offerAbandonedLockRemoval(vanished.root, gone.dependencies)).toBe(false);
    expect(gone.written.at(-1)).toBe("The lock changed while waiting; nothing was removed.\n");
    expect(existsSync(vanished.host)).toBe(true);

    const exposed = installation({ host: "{}" });
    const unusable = terminal("y", true, () => {
      chmodSync(exposed.root, 0o755);
    });
    expect(await offerAbandonedLockRemoval(exposed.root, unusable.dependencies)).toBe(false);
    expect(unusable.written.at(-1)).toBe("The lock changed while waiting; nothing was removed.\n");
    expect(existsSync(exposed.host)).toBe(true);

    const unwritable = installation({ host: "{}", operator: "{}" });
    const blocked = terminal("y", true, () => {
      chmodSync(join(unwritable.root, "locks"), 0o500);
    });
    expect(await offerAbandonedLockRemoval(unwritable.root, blocked.dependencies)).toBe(false);
    expect(blocked.written.at(-1)).toBe("The lock could not be removed.\n");
    expect(existsSync(unwritable.operator)).toBe(true);
  });

  it("acquires again only after a busy installation had its abandoned lock removed", async () => {
    const owned = { release: () => true } as unknown as OwnedInstallation;
    const f = installation({ operator: "{}" });
    const busy = new OperatorCliError("installation-busy");
    const acquire = vi.fn<(root: string) => OwnedInstallation>(() => owned);
    const t = terminal("y");
    expect(await acquireWithLockRecovery(acquire, t.dependencies)(f.root)).toBe(owned);
    expect(t.written).toEqual([]);

    acquire.mockImplementationOnce(() => {
      throw busy;
    });
    expect(await acquireWithLockRecovery(acquire, t.dependencies)(f.root)).toBe(owned);
    expect(acquire).toHaveBeenLastCalledWith(f.root);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(existsSync(f.operator)).toBe(false);

    acquire.mockImplementation(() => {
      throw busy;
    });
    await expect(acquireWithLockRecovery(acquire, t.dependencies)(f.root)).rejects.toBe(busy);
    expect(acquire).toHaveBeenCalledTimes(4);
    const unavailable = new OperatorCliError("installation-unavailable");
    const other = installation({ operator: "{}" });
    acquire.mockImplementation(() => {
      throw unavailable;
    });
    const quiet = terminal("y");
    await expect(acquireWithLockRecovery(acquire, quiet.dependencies)(other.root)).rejects.toBe(
      unavailable,
    );
    const plain = new Error("installation-busy");
    acquire.mockImplementation(() => {
      throw plain;
    });
    await expect(acquireWithLockRecovery(acquire, quiet.dependencies)(other.root)).rejects.toBe(
      plain,
    );
    expect(quiet.written).toEqual([]);
    expect(existsSync(other.operator)).toBe(true);
  });
});
