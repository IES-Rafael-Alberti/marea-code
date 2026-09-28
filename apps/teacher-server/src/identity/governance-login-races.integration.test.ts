import { beforeEach, afterEach, expect, it } from "vitest";
import { CredentialLoginRequestSchema } from "@marea/protocol";
import { governanceServiceFixture } from "../governance/service.fixture.js";
import { IdentityService } from "./identity-service.js";

let f: ReturnType<typeof governanceServiceFixture>;
beforeEach(() => {
  f = governanceServiceFixture();
  f.createAccount("center:a", "user:target", "student", "class:a");
  f.activate("center:a", "user:target");
});
afterEach(() => {
  f.database.close();
});

it.each(["credential", "disabled", "pending"])(
  "rejects %s changes during password verification before issuing a session",
  async (change) => {
    const before = f.database.readAll("SELECT * FROM marea_auth_sessions");
    const service = new IdentityService({
      repository: f.identities,
      clock: f.clock,
      ids: { createId: (namespace) => `${namespace}:denied-login` },
      secrets: { issue: () => "s".repeat(40) },
      digest: { digest: (secret) => `digest:${secret}` },
      dummyPasswordHash: "dummy-hash",
      passwords: {
        hash: (password) => Promise.resolve(`hash:${password}`),
        verify: async () => {
          await Promise.resolve();
          if (change === "credential")
            f.database.execute(
              "UPDATE marea_users SET password_hash = 'rotated' WHERE id = 'user:target'",
            );
          else
            f.database.execute(
              "UPDATE marea_governance_accounts SET state = ?1 WHERE user_id = 'user:target'",
              [change],
            );
          return true;
        },
      },
    });
    await expect(
      service.login(
        CredentialLoginRequestSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:login-race",
          kind: "credential-login",
          credentials: { login: "user-target", password: "private-password" },
        }),
      ),
    ).rejects.toMatchObject({ code: "auth.invalid" });
    expect(f.database.readAll("SELECT * FROM marea_auth_sessions")).toEqual(before);
  },
);
