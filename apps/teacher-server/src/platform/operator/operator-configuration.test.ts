import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import type {
  TeachingOperatorConfiguration,
  TeachingOperatorPolicy,
} from "../../teaching/configuration/dashboard-contracts.js";
import {
  MemoryClassDirectory,
  MemorySkillSource,
  MemoryTeachingRepository,
  policyWithoutBudget,
  readQuery,
  revisionIds,
  saveRequest,
  syntheticOperatorPolicy,
  syntheticSkill,
  teachingSettings,
  teacher,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { createTeachingConfigurationModule } from "../../teaching/configuration/dashboard-module.js";
import { createOperatorConfiguration } from "./operator-configuration-adapter.js";
import { OperatorConfigurationError } from "./operator-configuration-errors.js";
import {
  assertPostReadBounds,
  loadOperatorConfiguration,
  readBoundedBytes,
} from "./operator-filesystem-loader.js";
import { parseOperatorDocument } from "./operator-configuration-parser.js";
import type { OperatorFilesystem } from "./operator-filesystem-loader.js";

const root = mkdtempSync(join(tmpdir(), "operator-configuration-"));

function path(name: string) {
  return join(root, name);
}

function document(policy: TeachingOperatorPolicy = syntheticOperatorPolicy, classId = "class:one") {
  return { classes: [{ classId, policy }], version: 1 };
}

function writeJson(name: string, value: unknown) {
  const target = path(name);
  writeFileSync(target, JSON.stringify(value), "utf8");
  return target;
}

function configuredPolicy(configuration: TeachingOperatorConfiguration) {
  const policy = configuration.forClass("class:one");
  if (policy === null) throw new Error("Synthetic class was not configured.");
  return policy;
}

function mutablePolicy(policy: TeachingOperatorPolicy) {
  return policy as unknown as {
    route: {
      providerRoute: {
        budget: { inputTokenCeiling: number; tutoring: { maxInputTokens: number } };
      };
    };
    teacherToolPolicy: {
      restrictions: unknown;
    };
  };
}

function expectCode(
  action: () => unknown,
  code: OperatorConfigurationError["code"],
  message?: string,
) {
  try {
    action();
    expect.unreachable("Expected an operator configuration failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorConfigurationError);
    expect((error as OperatorConfigurationError).code).toBe(code);
    expect((error as OperatorConfigurationError).name).toBe("OperatorConfigurationError");
    expect((error as OperatorConfigurationError).message.length).toBeGreaterThan(0);
    if (message !== undefined) expect((error as OperatorConfigurationError).message).toBe(message);
    expect(String(error)).not.toContain(root);
  }
}

it("parses a complete document and returns cloned policies for configured classes", () => {
  const parsed = parseOperatorDocument(document());
  expect(parsed.version).toBe(1);
  expect(parsed.forClass("class:unknown")).toBeNull();
  const first = parsed.forClass("class:one");
  expect(first).toEqual(syntheticOperatorPolicy);
  const second = parsed.forClass("class:one");
  expect(second).toEqual(first);
  expect(first).not.toBe(second);
});

it("rejects duplicate classes, unsupported versions and incomplete policies", () => {
  const entry = { classId: "class:one", policy: syntheticOperatorPolicy };
  expectCode(
    () => parseOperatorDocument({ classes: [entry, entry], version: 1 }),
    "duplicate-class-id",
  );
  expectCode(() => parseOperatorDocument({ classes: [], version: 2 }), "invalid-document");
  expectCode(
    () => parseOperatorDocument({ classes: [], extra: true, version: 1 }),
    "invalid-document",
  );
  expectCode(() => parseOperatorDocument(document(policyWithoutBudget())), "invalid-document");
  const slow = structuredClone(syntheticOperatorPolicy);
  mutablePolicy(slow).route.providerRoute.budget.tutoring.maxInputTokens = 0;
  expectCode(() => parseOperatorDocument(document(slow)), "invalid-document");
  const restricted = structuredClone(syntheticOperatorPolicy);
  const restriction = (
    mutablePolicy(restricted).teacherToolPolicy.restrictions as readonly { effect: string }[]
  )[0];
  if (restriction === undefined) throw new Error("Synthetic policy has no restriction.");
  restriction.effect = "unrestricted";
  expectCode(() => parseOperatorDocument(document(restricted)), "invalid-document");
});

it("uses the shared class identity contract and strict nested policy fields", () => {
  for (const classId of ["../outside", "class name", "class\n", "", "a".repeat(129)]) {
    expectCode(
      () => parseOperatorDocument(document(syntheticOperatorPolicy, classId)),
      "invalid-document",
    );
  }
  const policy = structuredClone(syntheticOperatorPolicy);
  const configuration = parseOperatorDocument(document(policy));
  mutablePolicy(policy).route.providerRoute.budget.inputTokenCeiling = 999;
  expect(configuration.forClass("class:one")).toEqual(syntheticOperatorPolicy);
  for (const value of [
    { ...document(), classes: [{ ...document().classes[0], extra: true }] },
    document({ ...syntheticOperatorPolicy, extra: true } as TeachingOperatorPolicy),
    document({
      ...syntheticOperatorPolicy,
      route: { ...syntheticOperatorPolicy.route, extra: true },
    } as TeachingOperatorPolicy),
  ]) {
    expectCode(() => parseOperatorDocument(value), "invalid-document");
  }
});

it("isolates caller mutation before and after adapter lookups", () => {
  const parsed = parseOperatorDocument(document());
  const before = configuredPolicy(parsed);
  const mutable = mutablePolicy(before);
  mutable.route.providerRoute.budget.inputTokenCeiling = 999;
  (mutable.teacherToolPolicy.restrictions as unknown[]).push({ effect: "deny" });
  const after = configuredPolicy(parsed);
  expect(after).toEqual(syntheticOperatorPolicy);
  expect(before.route.providerRoute.budget.inputTokenCeiling).toBe(999);
  const adapter = createOperatorConfiguration(parsed);
  expect(adapter.forClass("class:two")).toBeNull();
  expect(adapter.forClass("class:one")).toEqual(syntheticOperatorPolicy);
});

it("composes the parsed adapter through the real teaching configuration module", async () => {
  const didactic = syntheticSkill("didactic", "testing");
  const evaluation = syntheticSkill("evaluation", "review");
  const repository = new MemoryTeachingRepository();
  repository.grant("t1", "class:one");
  const service = createTeachingConfigurationModule({
    clock: { now: () => "2026-09-08T08:00:00.000Z" },
    directory: new MemoryClassDirectory([{ classId: "class:one", displayName: "One" }]),
    ids: revisionIds(),
    operator: createOperatorConfiguration(parseOperatorDocument(document())),
    repository,
    skills: { forTeacherClass: () => new MemorySkillSource([didactic, evaluation]) },
  }).service;
  const settings = teachingSettings("tutoring", [didactic], [evaluation]);
  await service.save(teacher, saveRequest(settings));
  const response = await service.read(teacher, readQuery());
  expect(response.operatorReady).toBe(true);
  expect(repository.configurationFor("class:one")?.providerRoute.budget).toEqual(
    syntheticOperatorPolicy.route.providerRoute.budget,
  );
});

it("loads bounded UTF-8 JSON through the real filesystem adapter", () => {
  const target = writeJson("valid.json", document());
  const adapter = loadOperatorConfiguration(target, 65_536);
  expect(adapter.forClass("class:one")).toEqual(syntheticOperatorPolicy);
  const mutable = mutablePolicy(configuredPolicy(adapter));
  mutable.route.providerRoute.budget.inputTokenCeiling = 999;
  expect(adapter.forClass("class:one")).toEqual(syntheticOperatorPolicy);
});

it("rejects malformed documents, paths and filesystem boundaries", () => {
  const valid = writeJson("valid.json", document());
  expectCode(() => loadOperatorConfiguration(path("missing.json"), 65_536), "not-found");
  expectCode(() => loadOperatorConfiguration("valid.json", 65_536), "invalid-path");
  expectCode(() => loadOperatorConfiguration(valid, 0), "invalid-bound");
  expectCode(() => loadOperatorConfiguration(valid, 10.5), "invalid-bound");
  expectCode(() => loadOperatorConfiguration(valid, Number.MAX_SAFE_INTEGER + 1), "invalid-bound");
  expectCode(
    () => loadOperatorConfiguration(valid, 1),
    "too-large",
    "Operator configuration exceeds its byte bound.",
  );
  const minimal = path("minimal.json");
  writeFileSync(minimal, "{}", "utf8");
  expectCode(() => loadOperatorConfiguration(minimal, 2), "invalid-document");
  const link = path("valid-link.json");
  symlinkSync(valid, link);
  expectCode(() => loadOperatorConfiguration(link, 65_536), "symlink");
  expectCode(() => loadOperatorConfiguration(root, 65_536), "not-regular-file");
  const malformed = path("malformed.json");
  writeFileSync(malformed, "{", "utf8");
  expectCode(
    () => loadOperatorConfiguration(malformed, 65_536),
    "invalid-document",
    "Operator configuration is not valid JSON.",
  );
  const invalidUtf8 = path("invalid-utf8.json");
  writeFileSync(invalidUtf8, Buffer.from([0xff]), "utf8");
  expectCode(
    () => loadOperatorConfiguration(invalidUtf8, 65_536),
    "invalid-document",
    "Operator configuration is not valid UTF-8.",
  );
  const deniedParent = path("denied-parent");
  mkdirSync(deniedParent);
  const denied = join(deniedParent, "configuration.json");
  writeFileSync(denied, JSON.stringify(document()), "utf8");
  chmodSync(deniedParent, 0o000);
  expectCode(() => loadOperatorConfiguration(denied, 65_536), "access-denied");
  chmodSync(deniedParent, 0o700);
  const unreadable = path("unreadable.json");
  writeFileSync(unreadable, JSON.stringify(document()), "utf8");
  chmodSync(unreadable, 0o000);
  expectCode(() => loadOperatorConfiguration(unreadable, 65_536), "io-failure");
  chmodSync(unreadable, 0o600);
  const invalid = writeJson("invalid-document.json", { classes: [], version: 2 });
  expectCode(() => loadOperatorConfiguration(invalid, 65_536), "invalid-document");
  rmSync(valid);
  expectCode(() => loadOperatorConfiguration(valid, 65_536), "not-found");
});

it("checks post-read bounds explicitly", () => {
  const status = { size: 10 } as import("node:fs").Stats;
  expectCode(() => {
    assertPostReadBounds(status, { size: 11 } as import("node:fs").Stats, Buffer.alloc(1), 64);
  }, "changed-file");
  expectCode(() => {
    assertPostReadBounds(status, status, Buffer.alloc(65), 64);
  }, "too-large");
  expect(() => {
    assertPostReadBounds(status, status, Buffer.alloc(10), 64);
  }).not.toThrow();
});

it("rechecks the regular file and bounds after reading", () => {
  const before = {
    isSymbolicLink: () => false,
    isFile: () => true,
    size: 2,
  } as import("node:fs").Stats;
  const bytes = Buffer.from("{}", "utf8");
  function filesystem(after: import("node:fs").Stats): OperatorFilesystem {
    let readStatus = 0;
    return {
      isAbsolute: () => true,
      lstat: () => {
        const status = readStatus === 0 ? before : after;
        readStatus += 1;
        return status;
      },
      readFile: () => bytes,
    };
  }
  function failure(effect: "symlink" | "not-file" | "changed") {
    const status = {
      isSymbolicLink: () => effect === "symlink",
      isFile: () => effect !== "not-file" && effect !== "symlink",
      size: effect === "changed" ? 3 : 2,
    } as import("node:fs").Stats;
    return readBoundedBytes("/operator.json", 64, filesystem(status));
  }
  expectCode(() => {
    const status = {
      isSymbolicLink: () => false,
      isFile: () => true,
      size: 3,
    } as import("node:fs").Stats;
    readBoundedBytes("/operator.json", 2, {
      isAbsolute: () => true,
      lstat: () => status,
      readFile: () => bytes,
    });
  }, "too-large");
  expectCode(() => failure("symlink"), "symlink");
  expectCode(() => failure("not-file"), "not-regular-file");
  expectCode(() => failure("changed"), "changed-file");
  expectCode(
    () =>
      readBoundedBytes("/operator.json", 64, {
        ...filesystem({
          isSymbolicLink: () => false,
          isFile: () => true,
          size: 2,
        } as import("node:fs").Stats),
        readFile: () => Buffer.alloc(65),
      }),
    "too-large",
  );
  expect(
    readBoundedBytes(
      "/operator.json",
      64,
      filesystem({
        isSymbolicLink: () => false,
        isFile: () => true,
        size: 2,
      } as import("node:fs").Stats),
    ),
  ).toEqual(bytes);
});

afterAll(() => {
  rmSync(root, { recursive: true });
});
