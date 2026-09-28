import { CredentialLoginSchema, SafeDisplayNameSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  governanceFixture,
  governanceId as id,
  seedGovernancePilot,
} from "./governance-repository.fixture.js";
import { withoutDeletionAuthority } from "./identity-creation-guard.js";

describe("retired governance identities", () => {
  it("refuses to recreate an account whose identity permanent deletion retired", () => {
    const checked: string[] = [];
    const f = governanceFixture({
      accountCreatable: (userId) => {
        checked.push(userId);
        return userId !== "user:retired";
      },
    });
    const admin = seedGovernancePilot(f);
    checked.length = 0;
    const create = (userId: string, login: string) =>
      f.accounts.commitCreateAccount({
        context: admin,
        centerId: id("center:a"),
        userId: id(userId),
        login: CredentialLoginSchema.parse(login),
        displayName: SafeDisplayNameSchema.parse("Returning"),
        role: "student",
        classId: id("class:a"),
        passwordHash: "private",
      });
    expect(() => create("user:retired", "retired-login")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    expect(
      f.database.readOne("SELECT id FROM marea_users WHERE id = 'user:retired'"),
    ).toBeUndefined();
    expect(
      f.database.readOne(
        "SELECT user_id FROM marea_governance_accounts WHERE user_id = 'user:retired'",
      ),
    ).toBeUndefined();
    expect(create("user:fresh", "fresh-login")).toMatchObject({ userId: "user:fresh" });
    expect(checked).toEqual(["user:retired", "user:fresh"]);
    f.database.close();
  });

  it("keeps compositions without a deletion index explicit", () => {
    expect(withoutDeletionAuthority().accountCreatable("user:any")).toBe(true);
  });
});
