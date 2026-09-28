import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UtcTimestampSchema } from "@marea/protocol";
import { governanceServiceFixture } from "../../governance/service.fixture.js";
import { SqliteGovernanceSessionResolver } from "./sqlite-governance-session-resolver.js";

describe("trusted governance cookie metadata resolution", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  let resolver: SqliteGovernanceSessionResolver;
  beforeEach(() => {
    f = governanceServiceFixture();
    resolver = new SqliteGovernanceSessionResolver(f.database, f.repository);
    f.identities.createSession({
      userId: "user:admin",
      sessionId: "session:cookie",
      tokenHash: "private-cookie-digest",
      issuedAt: f.admin.now,
      expiresAt: f.session.expiresAt,
    });
  });
  afterEach(() => {
    f.database.close();
  });

  it("uses the actual nonrevoked SQL session and exposes no cookie/token digest", () => {
    const session = resolver.resolve("private-cookie-digest", f.admin.now);
    expect(session).toEqual({
      sessionId: "session:cookie",
      expiresAt: f.session.expiresAt,
      identity: f.session.identity,
    });
    expect(JSON.stringify(session)).not.toContain("private-cookie-digest");
    expect(Object.isFrozen(session)).toBe(true);
    expect(resolver.resolve("unknown", f.admin.now)).toBeUndefined();
    expect(
      resolver.resolve("private-cookie-digest", UtcTimestampSchema.parse(f.session.expiresAt)),
    ).toBeUndefined();
  });

  it.each([
    "UPDATE marea_auth_sessions SET revoked_at = issued_at WHERE id = 'session:cookie'",
    "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:admin'",
    "UPDATE marea_governance_accounts SET state = 'pending' WHERE user_id = 'user:admin'",
  ])("denies live credential state changes: %s", (sql) => {
    f.database.execute(sql);
    expect(resolver.resolve("private-cookie-digest", f.admin.now)).toBeUndefined();
  });
});
