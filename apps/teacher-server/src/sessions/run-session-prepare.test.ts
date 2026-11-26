import { OpenRunRequestSchema } from "@marea/protocol";
import { expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { RunSessionService, type RunSessionServiceDependencies } from "./run-session-service.js";

const STUDENT: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};
const OPEN = OpenRunRequestSchema.parse({
  clientSessionId: "client:alice",
  clientVersion: "0.1.0",
  idempotencyKey: "open:alice",
  intent: { kind: "new" },
  project: { displayName: "Wave lab" },
  protocolVersion: "0.1",
  requestId: "request:open",
});

function service(prepare?: (identity: AuthenticatedIdentity) => Promise<void>) {
  const unused = () => {
    throw new Error("not used");
  };
  const dependencies: RunSessionServiceDependencies = {
    clock: { now: unused },
    digest: { digest: unused },
    ids: { createId: unused },
    secrets: { issue: unused },
    repository: {
      appendEvents: unused,
      authorizeLease: unused,
      closeRunAuthenticated: unused,
      closeRun: unused,
      openRun: unused,
      renewLease: unused,
    },
    snapshots: { capture: unused, ...(prepare === undefined ? {} : { prepare }) },
  };
  return new RunSessionService(dependencies);
}

it("prepares only a student's new run and never fails because of it", async () => {
  const prepare = vi.fn(() => Promise.resolve());
  await service(prepare).prepare(STUDENT, OPEN);
  expect(prepare.mock.calls).toEqual([[STUDENT]]);
  await service(prepare).prepare({ ...STUDENT, role: "teacher" }, OPEN);
  await service(prepare).prepare(STUDENT, { ...OPEN, intent: { kind: "resume" } });
  expect(prepare).toHaveBeenCalledOnce();
  await expect(
    service(() => Promise.reject(new Error("model down"))).prepare(STUDENT, OPEN),
  ).resolves.toBeUndefined();
  await expect(service().prepare(STUDENT, OPEN)).resolves.toBeUndefined();
});
