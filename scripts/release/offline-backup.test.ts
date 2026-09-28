import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  acquireInstallation: vi.fn(),
  createOperationsApplication: vi.fn(),
  readOperationsConfig: vi.fn(),
}));
vi.mock("../../apps/teacher-server/src/platform/operator-cli/installation-lock.js", () => mocks);
vi.mock(
  "../../apps/teacher-server/src/platform/operations-cli/operations-application.js",
  () => mocks,
);
vi.mock("../../apps/teacher-server/src/platform/operations-cli/operations-config.js", () => mocks);
import { withOfflineBackup } from "./offline-backup.boundary.js";
beforeEach(() => vi.resetAllMocks());
it("holds ownership through deletion-aware backup and activation and closes resources", async () => {
  const assertOwned = vi.fn();
  const release = vi.fn();
  const close = vi.fn();
  const backup = vi.fn().mockResolvedValue({ path: "backup" });
  const owner = { capability: { assertOwned }, release };
  mocks.acquireInstallation.mockReturnValue(owner);
  mocks.readOperationsConfig.mockReturnValue({ releaseId: "old" });
  mocks.createOperationsApplication.mockReturnValue({ createBackup: backup, close });
  const activate = vi.fn().mockResolvedValue("done");
  expect(await withOfflineBackup("/state", activate)).toBe("done");
  expect(backup).toHaveBeenCalledWith(expect.stringMatching(/^release-\d+$/u));
  expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(
    activate.mock.invocationCallOrder[0] ?? 0,
  );
  expect(release).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  const clock = mocks.createOperationsApplication.mock.lastCall?.[2] as () => string;
  expect(Number.isNaN(Date.parse(clock()))).toBe(false);
  backup.mockRejectedValue(new Error("backup failed"));
  await expect(withOfflineBackup("/state", activate)).rejects.toThrow("backup failed");
  expect(activate).toHaveBeenCalledTimes(1);
  mocks.readOperationsConfig.mockImplementation(() => {
    throw new Error("config failed");
  });
  await expect(withOfflineBackup("/state", activate)).rejects.toThrow("config failed");
  expect(release).toHaveBeenCalledTimes(3);
});
