import * as privacy from "@marea/private-filesystem";
import { expect, it, vi } from "vitest";
import type { FailureLog } from "./failure-log.boundary.js";
import {
  auditStudentStatePermissions,
  securePrivateDirectory,
  securePrivateFileParent,
} from "./student-state-permissions.boundary.js";

import { useWindowsPlatformSandbox } from "./windows-platform.fixture.js";

useWindowsPlatformSandbox("marea-student-permissions-");

function recordingLog() {
  const records: Parameters<FailureLog["append"]>[0][] = [];
  return {
    records,
    log: {
      path: "synthetic.jsonl",
      append: vi.fn<FailureLog["append"]>((record) => {
        records.push(record);
        return Promise.resolve();
      }),
    },
  };
}

function onWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32" });
}

it("keeps strict POSIX modes for the student's folders and files", () => {
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  securePrivateDirectory("/tmp/state");
  securePrivateFileParent("/tmp/state/credential.json");
  expect(secure.mock.calls).toEqual([
    ["/tmp/state", 0o700],
    ["/tmp/state/credential.json", 0o600],
  ]);
});

it("never writes an ACL for the student's state on Windows", () => {
  onWindows();
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  securePrivateDirectory("C:\\state");
  securePrivateFileParent("C:\\state\\credential.json");
  expect(secure).not.toHaveBeenCalled();
});

it("does not check permissions outside Windows", async () => {
  const { log } = recordingLog();
  const audit = vi.fn();
  await auditStudentStatePermissions("/tmp/state", log, audit);
  expect(audit).not.toHaveBeenCalled();
  expect(log.append).not.toHaveBeenCalled();
});

it("records nothing when the Windows state folder is private", async () => {
  onWindows();
  const { log } = recordingLog();
  const audit = vi.fn().mockResolvedValue({ status: "private" });
  await auditStudentStatePermissions("C:\\state", log, audit);
  expect(audit).toHaveBeenCalledWith("C:\\state");
  expect(log.append).not.toHaveBeenCalled();
});

it("records broad readers by category, without paths, and continues", async () => {
  onWindows();
  vi.useFakeTimers({ now: new Date("2026-11-26T08:00:00.000Z"), toFake: ["Date"] });
  const { log, records } = recordingLog();
  const audit = vi.fn().mockResolvedValue({ status: "exposed", principals: ["everyone", "users"] });
  await expect(auditStudentStatePermissions("C:\\state", log, audit)).resolves.toBeUndefined();
  vi.useRealTimers();
  expect(records).toEqual([
    {
      occurredAt: "2026-11-26T08:00:00.000Z",
      kind: "state-permissions",
      result: "broad-access",
      principals: ["everyone", "users"],
    },
  ]);
  expect(JSON.stringify(records)).not.toContain("state\\");
});

it("records the numeric code when the check itself fails, and continues", async () => {
  onWindows();
  const { log, records } = recordingLog();
  const audit = vi.fn().mockResolvedValue({ status: "failed", code: "0x80070005" });
  await expect(auditStudentStatePermissions("C:\\state", log, audit)).resolves.toBeUndefined();
  expect(records).toHaveLength(1);
  const { occurredAt, ...record } = records[0] ?? {};
  expect(Number.isNaN(Date.parse(String(occurredAt)))).toBe(false);
  expect(record).toEqual({ kind: "state-permissions", result: "check-failed", code: "0x80070005" });
});

it("never throws when the check or the diagnostic write fails", async () => {
  onWindows();
  const { log } = recordingLog();
  await expect(
    auditStudentStatePermissions("C:\\state", log, () => Promise.reject(new Error("broken"))),
  ).resolves.toBeUndefined();
  log.append.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    auditStudentStatePermissions("C:\\state", log, () =>
      Promise.resolve({ status: "failed", code: "timeout" }),
    ),
  ).resolves.toBeUndefined();
  expect(log.append).toHaveBeenCalledTimes(1);
});

it("uses the read-only Windows audit by default", async () => {
  onWindows();
  const audit = vi
    .spyOn(privacy, "auditWindowsPrivateAccess")
    .mockResolvedValue({ status: "failed", code: "0x80070005" });
  const secure = vi.spyOn(privacy, "securePrivatePath");
  const { log, records } = recordingLog();
  await auditStudentStatePermissions("C:\\state", log);
  expect(audit).toHaveBeenCalledWith("C:\\state");
  expect(secure).not.toHaveBeenCalled();
  expect(records).toHaveLength(1);
});
