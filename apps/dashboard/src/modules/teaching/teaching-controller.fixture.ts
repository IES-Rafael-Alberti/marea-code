import {
  SaveTeachingConfigurationResponseSchema,
  TeachingSettingsSchema,
  TeachingCatalogEntrySchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  TeachingConfigurationResponseSchema,
  type TeachingCatalogEntry,
  type TeachingClassSummary,
  type TeachingConfiguration,
  type TeachingSettings,
} from "@marea/protocol";
import { vi } from "vitest";

import type { TeachingClient } from "./teaching-contracts.js";

const REQUEST_ID = "request:one";
const PROTOCOL_VERSION = "0.1";
export const CLASS_A = "class:one";
export const CLASS_B = "class:two";
export const VERSION_A = "revision:one";
export const VERSION_B = "revision:two";
export const VERSION_C = "revision:three";
export const DIGEST = `sha256:${"a".repeat(64)}`;

export function settings(patch: object = {}): TeachingSettings {
  return TeachingSettingsSchema.parse({
    agentMode: "tutoring",
    classInstructions: { tutoring: "Ask one question.", free: "" },
    selection: { didactic: [], evaluation: [] },
    automaticEvaluation: false,
    ...patch,
  });
}

export function classSummary(classId = CLASS_A, displayName = "Physics"): TeachingClassSummary {
  return { classId, displayName };
}

export function classesPage(
  classes: readonly TeachingClassSummary[],
  nextAfterClassId: string | null = null,
) {
  return TeachingClassesResponseSchema.parse({
    kind: "teaching-classes-response",
    protocolVersion: PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    classes,
    nextAfterClassId,
  });
}

export function skillEntry(
  id = "marea/testing",
  kind: "didactic" | "evaluation" = "didactic",
): TeachingCatalogEntry {
  const [source] = id.split("/");
  return TeachingCatalogEntrySchema.parse({
    id,
    name: "testing",
    description: "Practice testing skills.",
    kind,
    source,
    digest: DIGEST,
    compatibility: null,
  });
}

export function catalogPage(
  classId: string,
  skills: readonly TeachingCatalogEntry[],
  nextAfterSkillId: string | null = null,
) {
  return TeachingCatalogResponseSchema.parse({
    kind: "teaching-catalog-response",
    protocolVersion: PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    classId,
    skills,
    nextAfterSkillId,
  });
}

export function configuration(version: string, value: TeachingSettings = settings()) {
  return { version, settings: value } satisfies TeachingConfiguration;
}

export function readResponse(
  classId: string,
  configurationValue: TeachingConfiguration | null,
  operatorReady = true,
) {
  return TeachingConfigurationResponseSchema.parse({
    kind: "teaching-configuration-response",
    protocolVersion: PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    classId,
    configuration: configurationValue,
    operatorReady,
  });
}

export function savedResponse(classId: string, configurationValue: TeachingConfiguration) {
  return SaveTeachingConfigurationResponseSchema.parse({
    kind: "teaching-configuration-saved",
    protocolVersion: PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    classId,
    configuration: configurationValue,
  });
}

export function mockClient() {
  return {
    classes: vi.fn<TeachingClient["classes"]>().mockResolvedValue(classesPage([], null)),
    read: vi.fn<TeachingClient["read"]>().mockResolvedValue(readResponse(CLASS_A, null, true)),
    catalog: vi.fn<TeachingClient["catalog"]>().mockResolvedValue(catalogPage(CLASS_A, [], null)),
    save: vi
      .fn<TeachingClient["save"]>()
      .mockResolvedValue(savedResponse(CLASS_A, configuration(VERSION_A))),
  };
}
