import { CredentialLoginRequestSchema, EnrollStudentRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";
import { IdentityService } from "./identity-service.js";
import { PasswordAdmission } from "./password-admission.js";
import type { AuthenticatedIdentity, IdentityRepository } from "./contracts.js";

const identity: AuthenticatedIdentity = {
  classId: "class:one",
  displayName: "Synthetic student",
  role: "student",
  userId: "user:one",
};
const login = CredentialLoginRequestSchema.parse({
  kind: "credential-login",
  protocolVersion: "0.1",
  requestId: "request:login",
  credentials: { login: "synthetic", password: "synthetic-password" },
});
const enroll = EnrollStudentRequestSchema.parse({
  ...login,
  kind: "student-invitation-enrollment",
  displayName: "Synthetic student",
  invitationCode: "synthetic-invitation",
});

describe("password admission security boundary", () => {
  it("shares two slots across login and enrollment, rejects without queuing or identity lookup, then recovers", async () => {
    const pending = Promise.withResolvers<undefined>();
    const verify = vi.fn(async () => {
      await pending.promise;
      return true;
    });
    const hash = vi.fn(async () => {
      await pending.promise;
      return "synthetic-hash";
    });
    const findCredential = vi.fn(() => ({ ...identity, passwordHash: "synthetic-hash" }));
    const createSession = vi.fn();
    const repository: IdentityRepository = {
      applyBootstrap: () => true,
      consumeInvitation: () => ({ enrolled: true, identity }),
      createSession,
      findCredential,
      resolveSession: () => identity,
      revokeSession: () => true,
    };
    const service = new IdentityService({
      clock: { now: () => "2026-09-27T10:00:00.000Z" },
      ids: { createId: (kind) => `${kind}:synthetic` },
      secrets: { issue: () => "s".repeat(40) },
      digest: { digest: () => "synthetic-digest" },
      dummyPasswordHash: "synthetic-dummy",
      passwords: { hash, verify },
      repository,
    });
    const first = service.login(login);
    const second = service.enroll(enroll);
    for (const request of [
      login,
      { ...login, credentials: { ...login.credentials, login: "absent" } },
    ]) {
      await expect(service.login(request)).rejects.toMatchObject({ code: "auth.busy" });
    }
    await expect(service.enroll(enroll)).rejects.toMatchObject({ code: "auth.busy" });
    expect(findCredential).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    // Existing sessions and logout do not consume a password slot.
    expect(service.authenticate("synthetic-token").identity).toEqual(identity);
    expect(service.logout("synthetic-token", "request:logout").alreadyLoggedOut).toBe(false);
    pending.resolve(undefined);
    await Promise.all([first, second]);
    await expect(service.login(login)).resolves.toMatchObject({ principal: { role: "student" } });
    expect(createSession).toHaveBeenCalledTimes(3);
  });

  it("releases admission after synchronous throws and asynchronous rejection", async () => {
    const admission = new PasswordAdmission();
    const pending = Promise.withResolvers<undefined>();
    const held = admission.run(() => pending.promise);
    await expect(
      admission.run(() => {
        throw new Error("synthetic-failure");
      }),
    ).rejects.toThrow("synthetic-failure");
    await expect(
      admission.run(() => Promise.reject(new Error("synthetic-rejection"))),
    ).rejects.toThrow("synthetic-rejection");
    await expect(admission.run(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
    pending.resolve(undefined);
    await held;
  });
});
