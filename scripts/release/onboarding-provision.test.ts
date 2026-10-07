import { afterEach, beforeEach, expect, it, vi } from "vitest";
const p = vi.hoisted(() => ({
  scaffoldServer: vi.fn(),
  provisionServer: vi.fn(),
  acquireInstallation: vi.fn(),
  release: vi.fn(),
  initializeSqliteStorage: vi.fn(),
  close: vi.fn(),
  serverSettingsStore: vi.fn(),
  write: vi.fn(),
  serverSettingsOperator: vi.fn(),
  forClass: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  repository: vi.fn(),
  service: vi.fn(),
  skills: vi.fn(),
  readOperatorCliConfig: vi.fn(),
  readOperationsConfig: vi.fn(),
  readTeacherHostConfig: vi.fn(),
  writeFileSync: vi.fn(),
  configureIdentityProviders: vi.fn(),
}));
vi.mock("node:fs", () => ({ writeFileSync: p.writeFileSync }));
vi.mock("@marea/sqlite-storage", () => ({ initializeSqliteStorage: p.initializeSqliteStorage }));
vi.mock("./preview-setup.boundary.js", () => p);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/installation-lock.js", () => p);
vi.mock("../../apps/teacher-server/src/platform/operator-cli/composition.js", () => p);
vi.mock("../../apps/teacher-server/src/platform/operations-cli/operations-config.js", () => p);
vi.mock("../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js", () => p);
vi.mock(
  "../../apps/teacher-server/src/platform/teacher-host/identity-provider-composition.js",
  () => ({ ...p, readIdentityProviderSettings: vi.fn(), systemIdentityRuntime: {} }),
);
vi.mock(
  "../../apps/teacher-server/src/platform/teacher-host/server-settings-store.boundary.js",
  () => p,
);
vi.mock("../../apps/teacher-server/src/server-settings/operator.js", () => p);
vi.mock(
  "../../apps/teacher-server/src/platform/persistence/sqlite-teaching-configuration-repository.js",
  () => ({
    SqliteTeachingConfigurationRepository: class {
      readonly fixture = true;
      constructor(database: unknown) {
        p.repository(database);
      }
    },
  }),
);
vi.mock("../../apps/teacher-server/src/teaching/configuration/configuration-service.js", () => ({
  TeachingConfigurationService: class {
    save = p.save;
    constructor(options: unknown) {
      p.service(options);
    }
  },
}));
vi.mock("../../apps/teacher-server/src/teaching/skills/bundled-skill-source.boundary.js", () => ({
  BundledSkillSource: class {
    list = p.list;
    constructor(path: string) {
      p.skills(path);
    }
  },
}));
import { completeModeInstructions } from "@marea/protocol";
import { provisionOnboarding, relocateOnboarding } from "./onboarding-provision.boundary.js";
import { emptySetupSettings, setupTeacher } from "./onboarding-settings.boundary.js";
import { setupInput } from "./onboarding.fixture.js";
const policy = { route: setupInput().route, teacherToolPolicy: { restrictions: [] } };
const input = (testingSkill = false) => ({
  request: setupInput({ testingSkill }),
  settings: emptySetupSettings(),
  origin: "http://127.0.0.1:18793",
});
beforeEach(() => {
  vi.resetAllMocks();
  p.acquireInstallation.mockReturnValue({ release: p.release });
  p.initializeSqliteStorage.mockReturnValue({ database: "database", close: p.close });
  p.serverSettingsStore.mockReturnValue({ write: p.write });
  p.serverSettingsOperator.mockReturnValue({ forClass: p.forClass });
  p.forClass.mockReturnValue(policy);
  p.list.mockResolvedValue([
    { id: "marea/testing", digest: "sha256:example" },
    { id: "other", digest: "sha256:other" },
  ]);
  p.readTeacherHostConfig.mockReturnValue({ identityProviders: [] });
});
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "creates a complete tutoring class and optionally selects the bundled example: %s",
  async (example) => {
    const run = vi.fn();
    const data = input(example);
    if (example)
      data.request = {
        ...data.request,
        google: { domain: "school.test", clientId: "client", clientSecret: "secret" },
      };
    await provisionOnboarding("/stage", "/release", "0.1.0-preview.18", data, run);
    const answers = {
      center: "Synthetic school",
      classroom: "Trial class",
      teacher: "Teacher",
      login: "teacher",
      port: 18793,
      origin: data.origin,
      google: data.request.google,
    };
    expect(p.scaffoldServer).toHaveBeenCalledExactlyOnceWith(
      "/stage",
      "/release",
      "0.1.0-preview.18",
      answers,
    );
    expect(p.provisionServer).toHaveBeenCalledExactlyOnceWith(
      "/stage",
      "/release",
      answers,
      data.request.password,
      run,
    );
    expect(p.initializeSqliteStorage).toHaveBeenCalledWith({
      databasePath: "/stage/marea.sqlite",
      schema: "student-identities",
    });
    expect(p.repository).toHaveBeenCalledWith("database");
    expect(p.write).toHaveBeenCalledWith(data.settings, 0);
    expect(p.skills).toHaveBeenCalledWith("/stage/core");
    expect(p.forClass).toHaveBeenCalledWith("class:main");
    expect(p.configureIdentityProviders).toHaveBeenCalledOnce();
    if (example) expect(p.list).toHaveBeenCalledWith("didactic");
    const configuration = p.service.mock.calls[0]?.[0] as {
      clock: { now: () => string };
      routes: { forClass: () => unknown };
      skills: { forTeacherClass: () => unknown };
    };
    expect(Date.parse(configuration.clock.now())).not.toBeNaN();
    expect(configuration.routes.forClass()).toBe(policy.route);
    expect(configuration.skills.forTeacherClass()).toMatchObject({ list: p.list });
    expect(
      (p.serverSettingsOperator.mock.calls[0]?.[0] as { forClass: () => unknown }).forClass(),
    ).toBeNull();
    expect(p.save).toHaveBeenCalledWith(
      setupTeacher,
      expect.objectContaining({
        classId: "class:main",
        expectedVersion: null,
        agentMode: "tutoring",
        automaticEvaluation: false,
        classInstructions: completeModeInstructions({ tutoring: "", free: "" }),
        selection: {
          didactic: example ? [{ id: "marea/testing", digest: "sha256:example" }] : [],
          evaluation: [],
        },
        teacherToolPolicy: policy.teacherToolPolicy,
      }),
    );
    expect(p.close).toHaveBeenCalledOnce();
    expect(p.release).toHaveBeenCalledOnce();
  },
);
it("always releases storage and ownership when prerequisites or persistence fail", async () => {
  p.forClass.mockReturnValueOnce(null);
  await expect(provisionOnboarding("/stage", "/release", "v", input(), vi.fn())).rejects.toThrow(
    "missing-initial-route",
  );
  p.list.mockResolvedValueOnce([]);
  await expect(
    provisionOnboarding("/stage", "/release", "v", input(true), vi.fn()),
  ).rejects.toThrow("missing-example-skill");
  p.save.mockRejectedValueOnce(new Error("write failed"));
  await expect(provisionOnboarding("/stage", "/release", "v", input(), vi.fn())).rejects.toThrow(
    "write failed",
  );
  expect(p.close).toHaveBeenCalledTimes(3);
  expect(p.release).toHaveBeenCalledTimes(3);
  p.initializeSqliteStorage.mockImplementationOnce(() => {
    throw new Error("database failed");
  });
  await expect(provisionOnboarding("/stage", "/release", "v", input(), vi.fn())).rejects.toThrow(
    "database failed",
  );
  expect(p.release).toHaveBeenCalledTimes(4);
});
it.each([undefined, [], [{ pluginId: "google", settingsPath: "/stage/state/google.json" }]])(
  "relocates declared private paths and preserves external release paths",
  (providers) => {
    p.readOperatorCliConfig.mockReturnValue({
      databasePath: "/stage/marea.sqlite",
      operatorPolicyPath: "/stage/policy.json",
      coreSourcePath: "/stage/core",
      centers: [{ id: "center:main", root: "/stage/centers/main" }],
      teachers: [{ id: "user:teacher", root: "/stage/teachers/main" }],
    });
    p.readOperationsConfig.mockReturnValue({
      databasePath: "/stage/marea.sqlite",
      indexPath: "/stage/index",
      backupRoot: "/stage/backups",
      stateFiles: ["/stage/state/extra"],
      authorityLineage: "keep",
    });
    p.readTeacherHostConfig.mockReturnValue({
      statusPath: "/stage/state/status",
      digestKeyPath: "/stage/state/key",
      dashboardDistPath: "/release/dashboard",
      identityProviders: providers,
    });
    relocateOnboarding("/stage", "/installed");
    const writes = p.writeFileSync.mock.calls.map(([path, body, mode]) => ({
      path: path as string,
      value: JSON.parse(body as string) as object,
      mode: mode as object,
    }));
    expect(writes).toEqual([
      {
        path: "/stage/config/operator-cli.json",
        value: {
          databasePath: "/installed/marea.sqlite",
          operatorPolicyPath: "/installed/policy.json",
          coreSourcePath: "/installed/core",
          centers: [{ id: "center:main", root: "/installed/centers/main" }],
          teachers: [{ id: "user:teacher", root: "/installed/teachers/main" }],
        },
        mode: { mode: 0o600 },
      },
      {
        path: "/stage/config/operations.json",
        value: {
          databasePath: "/installed/marea.sqlite",
          indexPath: "/installed/index",
          backupRoot: "/installed/backups",
          stateFiles: ["/installed/state/extra"],
          authorityLineage: "keep",
        },
        mode: { mode: 0o600 },
      },
      {
        path: "/stage/config/teacher-host.json",
        value: {
          statusPath: "/installed/state/status",
          digestKeyPath: "/installed/state/key",
          dashboardDistPath: "/release/dashboard",
          ...(providers === undefined
            ? {}
            : {
                identityProviders: providers.map((p) => ({
                  ...p,
                  settingsPath: "/installed/state/google.json",
                })),
              }),
        },
        mode: { mode: 0o600 },
      },
    ]);
  },
);
