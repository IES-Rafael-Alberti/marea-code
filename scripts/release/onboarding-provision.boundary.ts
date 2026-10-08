import { LearningProgress } from "../../apps/teacher-server/src/educational-insights/progress.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityProviderCatalog } from "@marea/plugin-runtime";
import {
  configureIdentityProviders,
  readIdentityProviderSettings,
  systemIdentityRuntime,
} from "../../apps/teacher-server/src/platform/teacher-host/identity-provider-composition.js";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { completeModeInstructions, type ServerSetupRequest } from "@marea/protocol";
import type { ServerSettings } from "../../apps/teacher-server/src/server-settings/contracts.js";
import { serverSettingsStore } from "../../apps/teacher-server/src/platform/teacher-host/server-settings-store.boundary.js";
import { serverSettingsOperator } from "../../apps/teacher-server/src/server-settings/operator.js";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import { readOperatorCliConfig } from "../../apps/teacher-server/src/platform/operator-cli/composition.js";
import { readOperationsConfig } from "../../apps/teacher-server/src/platform/operations-cli/operations-config.js";
import { readTeacherHostConfig } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js";
import { SqliteTeachingConfigurationRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { TeachingConfigurationService } from "../../apps/teacher-server/src/teaching/configuration/configuration-service.js";
import { cryptoIdGenerator } from "../../apps/teacher-server/src/identity/system-security.boundary.js";
import { BundledSkillSource } from "../../apps/teacher-server/src/teaching/skills/bundled-skill-source.boundary.js";
import {
  scaffoldServer,
  provisionServer,
  type RunPrivateCommand,
} from "./preview-setup.boundary.js";
import { setupTeacher } from "./onboarding-settings.boundary.js";

/** Only runs against a fresh private staging directory, never an existing school. */
export async function provisionOnboarding(
  stage: string,
  release: string,
  version: string,
  input: { request: ServerSetupRequest; settings: ServerSettings; origin: string },
  run: RunPrivateCommand,
): Promise<void> {
  const { request, settings, origin } = input;
  const answers = {
    center: request.center,
    classroom: request.classroom,
    teacher: request.teacher,
    login: request.login,
    port: request.port,
    origin,
    identityProviders: request.identityProviders,
  };
  scaffoldServer(stage, release, version, answers);
  configureIdentityProviders(
    identityProviderCatalog,
    readTeacherHostConfig(stage).identityProviders,
    readIdentityProviderSettings,
    systemIdentityRuntime,
  );
  provisionServer(stage, release, answers, request.password, run);
  const owner = acquireInstallation(stage);
  try {
    const storage = initializeSqliteStorage({
      databasePath: join(stage, "marea.sqlite"),
      schema: "observability",
    });
    try {
      const store = serverSettingsStore(stage);
      store.write(settings, 0);
      const policy = serverSettingsOperator({ forClass: () => null }, store).forClass("class:main");
      if (policy === null) throw new Error("missing-initial-route");
      const skills = new BundledSkillSource(join(stage, "core"));
      const selected = request.testingSkill
        ? (await skills.list("didactic"))
            .filter((skill) => skill.id === "marea/testing")
            .map(({ id, digest }) => ({ id, digest }))
        : [];
      if (request.testingSkill && selected.length !== 1) throw new Error("missing-example-skill");
      const evaluation = request.features?.automaticEvaluation
        ? (await skills.list("evaluation"))
            .filter((skill) => skill.id === "marea/evaluate")
            .map(({ id, digest }) => ({ id, digest }))
        : [];
      if (request.features?.automaticEvaluation && evaluation.length !== 1)
        throw new Error("missing-evaluation-method");
      if (request.features?.map)
        new LearningProgress(storage.database).configure(
          "class:main",
          { map: true, adaptive: false },
          "initial",
        );
      const service = new TeachingConfigurationService({
        clock: { now: () => new Date().toISOString() },
        ids: cryptoIdGenerator,
        repository: new SqliteTeachingConfigurationRepository(storage.database),
        routes: { forClass: () => policy.route },
        skills: { forTeacherClass: () => skills },
      });
      await service.save(setupTeacher, {
        classId: "class:main",
        expectedVersion: null,
        agentMode: "tutoring",
        socraticMode: "normal",
        automaticEvaluation: request.features?.automaticEvaluation ?? false,
        classInstructions: completeModeInstructions({ tutoring: "", free: "" }),
        selection: { didactic: selected, evaluation },
        teacherToolPolicy: policy.teacherToolPolicy,
      });
    } finally {
      storage.close();
    }
  } finally {
    owner.release();
  }
}

/** Rewrite only declared installation paths before the staging directory is atomically promoted. */
export function relocateOnboarding(stage: string, installation: string): void {
  const operator = readOperatorCliConfig(stage);
  const operations = readOperationsConfig(stage);
  const host = readTeacherHostConfig(stage);
  const at = (path: string) => join(installation, path.slice(stage.length + 1));
  const write = (name: string, value: object) => {
    writeFileSync(join(stage, "config", name), JSON.stringify(value, null, 2), { mode: 0o600 });
  };
  write("operator-cli.json", {
    ...operator,
    databasePath: at(operator.databasePath),
    operatorPolicyPath: at(operator.operatorPolicyPath),
    coreSourcePath: at(operator.coreSourcePath),
    centers: operator.centers.map((entry) => ({ ...entry, root: at(entry.root) })),
    teachers: operator.teachers.map((entry) => ({ ...entry, root: at(entry.root) })),
  });
  write("operations.json", {
    ...operations,
    databasePath: at(operations.databasePath),
    indexPath: at(operations.indexPath),
    backupRoot: at(operations.backupRoot),
    stateFiles: operations.stateFiles.map(at),
  });
  write("teacher-host.json", {
    ...host,
    statusPath: at(host.statusPath),
    digestKeyPath: at(host.digestKeyPath),
    identityProviders: host.identityProviders?.map((provider) => ({
      ...provider,
      settingsPath: at(provider.settingsPath),
    })),
  });
}
