import type { IdentityProvider } from "@marea/plugin-api";
import { ExternalAccessRequestSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { ExternalAccessService } from "./access-service.js";
import type { ExternalIdentityRepository, ExternalRuleChange } from "./contracts.js";

const label = { es: "Correo", en: "Email", eu: "Posta" };
const TEACHER: AuthenticatedIdentity = {
  classId: null,
  displayName: "Teacher",
  role: "teacher",
  userId: "user:teacher",
};

const provider: IdentityProvider = {
  authorizationUrl: () => "https://idp.test",
  complete: () => Promise.reject(new Error("unused")),
  admits: () => Promise.reject(new Error("unused")),
  normalizeRule: (kind, value) =>
    kind === "email" && value.includes("@")
      ? value.toLowerCase()
      : value === "too-long"
        ? "x".repeat(321)
        : undefined,
};

class FakeRepository implements ExternalIdentityRepository {
  stored = true;
  governed = true;
  readonly changes: ExternalRuleChange[] = [];
  readonly reads: (readonly string[])[] = [];
  available() {
    return this.stored;
  }
  classRules(): never {
    throw new Error("unused");
  }
  provision(): never {
    throw new Error("unused");
  }
  teacherClassAccess(teacherId: string, classId: string) {
    expect([teacherId, classId]).toEqual(["user:teacher", "class:a"]);
    return this.governed;
  }
  classRulesFor(classId: string, providerIds: readonly string[]) {
    this.reads.push([classId, ...providerIds]);
    return [{ providerId: "org.example.idp", kind: "email", value: "a@school.test" }];
  }
  changeRules(change: ExternalRuleChange) {
    this.changes.push(change);
  }
}

function service(repository = new FakeRepository()) {
  return {
    repository,
    access: new ExternalAccessService({
      providers: [
        {
          id: "org.example.idp",
          descriptor: {
            displayName: label,
            ruleKinds: [
              { kind: "email", label },
              { kind: "domain", label },
            ],
          },
          provider,
        },
      ],
      repository,
      clock: { now: () => "2026-10-05T10:00:00.000Z" },
    }),
  };
}

const query = ExternalAccessRequestSchema.parse({
  kind: "external-access-query",
  protocolVersion: "0.1",
  requestId: "r:query",
  classId: "class:a",
});
const change = ExternalAccessRequestSchema.parse({
  kind: "external-access-change",
  protocolVersion: "0.1",
  requestId: "r:change",
  classId: "class:a",
  operation: "add",
  providerId: "org.example.idp",
  ruleKind: "email",
  values: [" Ana@School.test ", "ana@school.test", "nope", "too-long"],
});

describe("external access service", () => {
  it("shows installed providers and the class rules to its teacher", () => {
    const test = service();
    expect(test.access.execute(TEACHER, query)).toEqual({
      kind: "external-access",
      protocolVersion: "0.1",
      requestId: "r:query",
      classId: "class:a",
      providers: [
        {
          providerId: "org.example.idp",
          displayName: label,
          ruleKinds: [
            { kind: "email", label },
            { kind: "domain", label },
          ],
        },
      ],
      rules: [{ providerId: "org.example.idp", kind: "email", value: "a@school.test" }],
      rejected: [],
    });
    expect(test.repository.reads).toEqual([["class:a", "org.example.idp"]]);
    expect(test.repository.changes).toEqual([]);
  });

  it("stores normalized distinct values and returns the rejected input", () => {
    const test = service();
    expect(test.access.execute(TEACHER, change)).toMatchObject({
      requestId: "r:change",
      rejected: ["nope", "too-long"],
    });
    expect(test.repository.changes).toEqual([
      {
        teacherId: "user:teacher",
        classId: "class:a",
        providerId: "org.example.idp",
        kind: "email",
        values: ["ana@school.test"],
        operation: "add",
        now: "2026-10-05T10:00:00.000Z",
      },
    ]);
    test.access.execute(
      TEACHER,
      ExternalAccessRequestSchema.parse({ ...change, values: ["nope"] }),
    );
    expect(test.repository.changes).toHaveLength(1);
  });

  it.each([
    ["an unknown provider", { providerId: "org.example.other" }],
    ["an undeclared rule kind", { ruleKind: "group" }],
  ] as const)("rejects %s", (_, override) => {
    const test = service();
    expect(() =>
      test.access.execute(TEACHER, ExternalAccessRequestSchema.parse({ ...change, ...override })),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it.each([
    ["storage before schema 12", "stored"],
    ["a legacy class", "governed"],
  ] as const)("hides providers and refuses changes for %s", (_, flag) => {
    const repository = new FakeRepository();
    repository[flag] = false;
    const test = service(repository);
    expect(test.access.execute(TEACHER, query)).toMatchObject({ providers: [], rules: [] });
    expect(repository.reads).toEqual([]);
    expect(() => test.access.execute(TEACHER, change)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
  });

  it("forbids students", () => {
    expect(() => service().access.execute({ ...TEACHER, role: "student" }, query)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
  });
});
