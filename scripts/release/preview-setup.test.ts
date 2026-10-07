import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installExampleSkill } from "./preview-skills.boundary.js";
vi.mock("./preview-skills.boundary.js", () => ({ installExampleSkill: vi.fn() }));

import { provisionServer, scaffoldServer, setupAnswers } from "./preview-setup.boundary.js";
let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-preview-setup-test-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});
const answers = {
  center: "School",
  classroom: "Class",
  teacher: "Teacher",
  login: "teacher",
  origin: "https://school.test",
  port: 18787,
};

it.each([false, true])("creates private configuration with optional Google: %s", (google) => {
  const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
  const directories = vi.spyOn(filesystem, "mkdirSync").mockClear();
  const root = join(scratch, "installation");
  const input = {
    ...answers,
    ...(google
      ? { google: { clientId: "id", clientSecret: "secret", domain: "school.test" } }
      : {}),
  };
  expect(() => {
    scaffoldServer(root, "/programs/server", "invalid", input);
  }).toThrow();
  scaffoldServer(root, "/programs/server", "0.1.0-preview.1", input);
  expect(installExampleSkill).toHaveBeenCalledWith(root, "/programs/server");
  const read = (file: string) =>
    JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
  for (const file of [
    "policy.json",
    "config/teacher-host.json",
    "config/operator-cli.json",
    "config/operations.json",
  ]) {
    const config = read(file);
    if (file.endsWith("operations.json")) {
      expect(config.authorityLineage).toMatch(/^lineage:[0-9a-f-]{36}$/u);
      expect(config.rootId).toMatch(/^root:[0-9a-f-]{36}$/u);
      expect(config.databaseLineage).toMatch(/^sha256:[0-9a-f]{64}$/u);
      delete config.authorityLineage;
      delete config.rootId;
      delete config.databaseLineage;
    }
    expect(JSON.stringify(config).replaceAll(root, "<installation>")).toMatchSnapshot(file);
  }
  expect(read("config/teacher-host.json")).toMatchObject({
    serverVersion: "0.1.0-preview.1",
    dashboardDistPath: "/programs/server/dashboard",
    allowedHosts: ["school.test"],
    allowedOrigins: ["https://school.test"],
    secureDashboardCookie: true,
    listen: { hostname: "127.0.0.1", port: 18787 },
    identityProviders: google
      ? [
          {
            pluginId: "org.marea.google-workspace",
            settingsPath: join(root, "state/google-workspace.json"),
          },
        ]
      : [],
  });
  expect(read("config/operator-cli.json")).toMatchObject({
    databasePath: join(root, "marea.sqlite"),
    personalOwners: [{ classId: "class:main", teacherId: "user:teacher" }],
  });
  expect(read("config/operations.json")).toMatchObject({
    releaseId: "release:preview",
    stateFiles: [],
  });
  for (const call of writes.mock.calls) {
    expect(call[2]).toEqual(
      call[0] === join(root, "core/evaluation/evaluate/SKILL.md")
        ? { mode: 0o600 }
        : { flag: "wx", mode: 0o600 },
    );
  }
  for (const call of directories.mock.calls.filter((call) => call[0] !== root))
    expect(call[1]).toEqual({ mode: 0o700 });
  expect(readFileSync(join(root, "state/digest.key")).length).toBe(32);
  expect(readFileSync(join(root, "core/evaluation/evaluate/SKILL.md"), "utf8")).toContain(
    "name: evaluate",
  );
  expect(existsSync(join(root, "state/google-workspace.json"))).toBe(google);
  if (google) expect(read("state/google-workspace.json")).toEqual(input.google);
  expect(statSync(join(root, "config/teacher-host.json")).mode & 0o077).toBe(0);
  expect(() => {
    scaffoldServer(root, "new", "0.1.0-preview.2", input);
  }).toThrow("empty");
  expect(setupAnswers.parse({ ...answers, origin: "http://school.test" }).origin).toBe(
    "http://school.test",
  );
});

it.each(["darwin", "win32"])(
  "provisions through offline CLIs without putting a password into arguments or files: %s",
  (platform) => {
    const root = join(scratch, "installation");
    mkdirSync(root);
    mkdirSync(join(root, "work"));
    const saved = Object.getOwnPropertyDescriptor(process, "platform");
    const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
    const payloads: object[] = [];
    const commands: unknown[] = [];
    const run = vi.fn((_binary: string, args: readonly string[]) => {
      if (args.includes("--input"))
        payloads.push(JSON.parse(readFileSync(String(args.at(-1)), "utf8")) as object);
      commands.push({
        binary: _binary,
        args: args.map((a) =>
          a.startsWith(root + "/work/") ? "<input>" : a === root ? "<installation>" : a,
        ),
        payload: args.includes("--input") ? payloads.at(-1) : undefined,
      });
      return JSON.stringify({ version: "revision:created" });
    });
    try {
      Object.defineProperty(process, "platform", { value: platform });
      provisionServer(root, "/release", answers, "private-password", run);
    } finally {
      if (saved) Object.defineProperty(process, "platform", saved);
    }
    expect(commands).toMatchSnapshot("offline provisioning protocol");
    expect(run).toHaveBeenCalledWith(
      `/release/marea-admin${platform === "win32" ? ".exe" : ""}`,
      [
        "--installation",
        root,
        "credential",
        "provision",
        "--user",
        "user:teacher",
        "--expected-version",
        "revision:created",
        "--password-stdin",
      ],
      "private-password\n",
    );
    for (const call of writes.mock.calls) expect(call[2]).toEqual({ mode: 0o600 });
    expect(JSON.stringify(payloads)).not.toContain("private-password");
    expect(payloads).toContainEqual({
      centerId: "center:main",
      userId: "user:teacher",
      expectedVersion: "revision:created",
    });
    expect(payloads).toContainEqual({ userId: "user:teacher", name: "before-server-settings" });
    expect(readdirSync(join(root, "work"))).toEqual([]);
    expect(() => {
      provisionServer(root, "/release", answers, "private-password", () => {
        throw new Error("failed");
      });
    }).toThrow("failed");
    expect(readdirSync(join(root, "work"))).toEqual([]);
  },
);

it("validates setup before writing any private state", () => {
  for (const port of [1024, 65535])
    expect(setupAnswers.parse({ ...answers, port }).port).toBe(port);
  for (const port of [1023, 65536, 1.5])
    expect(() => setupAnswers.parse({ ...answers, port })).toThrow();
  for (const domain of ["a.b", "school.example.test", "school-name.test"]) {
    expect(
      setupAnswers.parse({ ...answers, google: { domain, clientId: "id", clientSecret: "secret" } })
        .google?.domain,
    ).toBe(domain);
  }
  for (const domain of [
    "!school.test",
    "school.test!",
    "school..test",
    "SCHOOL.test",
    "school.TEST",
  ]) {
    expect(() =>
      setupAnswers.parse({
        ...answers,
        google: { domain, clientId: "id", clientSecret: "secret" },
      }),
    ).toThrow();
  }
  for (const field of ["clientId", "clientSecret"])
    expect(() =>
      setupAnswers.parse({
        ...answers,
        google: { domain: "school.test", clientId: "id", clientSecret: "secret", [field]: "" },
      }),
    ).toThrow();
  const root = join(scratch, "http");
  scaffoldServer(root, "/release", "1.0.0-preview.1", {
    ...answers,
    origin: "http://localhost:18787",
  });
  expect(
    (
      JSON.parse(readFileSync(join(root, "config/teacher-host.json"), "utf8")) as {
        secureDashboardCookie: boolean;
      }
    ).secureDashboardCookie,
  ).toBe(false);
});
