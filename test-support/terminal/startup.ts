import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

import type {
  InferenceCancellation,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "../../packages/plugin-api/src/index.js";
import type { AgentMode } from "../../packages/protocol/src/index.js";
import { cryptoIdGenerator } from "../../apps/teacher-server/src/identity/system-security.boundary.js";
import { rowText } from "../../apps/teacher-server/src/platform/persistence/row-parser.boundary.js";
import { SqliteTeachingConfigurationRepository } from "../../apps/teacher-server/src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { ConfigurationSnapshotSource } from "../../apps/teacher-server/src/teaching/configuration/configuration-snapshot-source.js";
import { TeachingConfigurationService } from "../../apps/teacher-server/src/teaching/configuration/configuration-service.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
} from "../../apps/teacher-server/src/teaching/skills/index.js";
import {
  teachingInput,
  teachingSkill,
} from "../../apps/teacher-server/test-support/teaching-fixture.js";
import { writeCatalog } from "../../apps/teacher-server/test-support/teaching-integration.fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../apps/teacher-server/test-support/usage-fixture.js";
import { createAcceptanceHarness } from "../acceptance/harness.js";
import { DeterministicInferenceProvider } from "../acceptance/inference.js";

const ReadPageSchema = z.object({ content: z.string() }).loose();

export class StartupInferenceProvider extends DeterministicInferenceProvider {
  skillId = "";
  skillPath = "SKILL.md";
  pauseNextFinal = false;

  override async *stream(
    request: InferenceProviderRequest,
    cancellation: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent> {
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      yield* super.stream(request, cancellation);
      return;
    }
    const isFinal =
      last?.toolCallId === "startup-project" ||
      (last?.toolCallId === "startup-list" &&
        ReadPageSchema.parse(JSON.parse(last.content)).content === "[]");
    if (isFinal && this.pauseNextFinal) {
      this.pauseNextFinal = false;
      yield* super.stream(request, cancellation);
      return;
    }
    this.requests.push(request);
    if (isFinal) {
      yield {
        type: "text-delta",
        text:
          last.toolCallId === "startup-list"
            ? "What small project would you like to build?"
            : "Startup exercise ready.",
      };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const call =
      last?.toolCallId === "startup-skill"
        ? { callId: "startup-list", name: "marea_list_project", arguments: { path: "/" } }
        : last?.toolCallId === "startup-list"
          ? {
              callId: "startup-project",
              name: "marea_read_project",
              arguments: { path: "/exercise.txt" },
            }
          : {
              callId: "startup-skill",
              name: "marea_read_skill",
              arguments: { path: this.skillPath, skillId: this.skillId },
            };
    yield { type: "tool-call", ...call };
    yield { type: "usage", inputTokens: 5, outputTokens: 3 };
    yield { type: "completed", finishReason: "tool-call" };
  }
}

export async function createStartupHarness(root: string, mode: AgentMode, empty: boolean) {
  const provider = new StartupInferenceProvider();
  const harness = await createAcceptanceHarness({
    provider,
    snapshotSource: (database) =>
      new ConfigurationSnapshotSource(new SqliteTeachingConfigurationRepository(database)),
  });
  try {
    const row = harness.database.readOne(
      "SELECT teacher_id, class_id FROM marea_teacher_classes LIMIT 1",
    );
    if (row === undefined) throw new Error("Synthetic teaching authority is missing.");
    const teacherId = rowText(row, "teacher_id");
    const classId = rowText(row, "class_id");
    const teacherRoot = join(root, "personal-skills");
    const coreRoot = join(root, "core-skills");
    await writeCatalog(teacherRoot, teachingSkill("didactic"));
    await writeCatalog(coreRoot, teachingSkill("evaluation"));
    const source = new CompositeSkillSource([
      new DirectorySkillSource(teacherRoot, { source: "teacher", id: teacherId }),
      new BundledSkillSource(coreRoot),
    ]);
    const didactic = await source.list("didactic");
    provider.skillId = didactic[0]?.id ?? "missing";
    const configuration = new TeachingConfigurationService({
      clock: harness.clock,
      ids: cryptoIdGenerator,
      repository: new SqliteTeachingConfigurationRepository(harness.database),
      routes: {
        forClass: () => ({
          version: "route:startup",
          modelAlias: "marea",
          providerRoute: {
            model: "deterministic-upstream",
            providerId: "test.deterministic",
            budget: SYNTHETIC_ROUTE_BUDGET,
          },
        }),
      },
      skills: { forTeacherClass: () => source },
    });
    await configuration.save(
      { userId: teacherId, classId: null, displayName: "Synthetic teacher", role: "teacher" },
      {
        ...teachingInput(mode),
        classId,
        selection: { didactic: didactic.map(({ id, digest }) => ({ id, digest })), evaluation: [] },
      },
    );
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    if (!empty) await writeFile(join(projectRoot, "exercise.txt"), "Synthetic exercise input.\n");
    await rm(teacherRoot, { recursive: true });
    await rm(coreRoot, { recursive: true });
    return { ...harness, provider, projectRoot };
  } catch (error) {
    await harness.close();
    throw error;
  }
}
