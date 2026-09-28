import { createElement, type ReactElement } from "react";
import { vi } from "vitest";

import type {
  SkillAuthoringActions,
  SkillAuthoringModuleProperties,
} from "./skill-authoring-contracts.js";
import { SkillAuthoringModule } from "./skill-authoring-module.js";
import type { SkillAuthoringFileExchange } from "./skill-authoring-files.js";
import {
  skillAuthoringActionsFixture,
  skillAuthoringStateFixture,
} from "./skill-authoring.fixture.js";
import { reviewElements } from "../evaluation/react-tree.fixture.js";

export function skillAuthoringFileExchangeFixture(): SkillAuthoringFileExchange {
  return {
    exportFile: vi.fn<SkillAuthoringFileExchange["exportFile"]>().mockResolvedValue(undefined),
    importDirectory: vi.fn<SkillAuthoringFileExchange["importDirectory"]>().mockResolvedValue(null),
    importExplicit: vi
      .fn<SkillAuthoringFileExchange["importExplicit"]>()
      .mockResolvedValue([{ content: "Imported", path: "SKILL.md" }]),
  };
}

export function skillAuthoringViewPropertiesFixture(
  controller: SkillAuthoringActions = skillAuthoringActionsFixture(),
  statePatch: Parameters<typeof skillAuthoringStateFixture>[0] = {},
): SkillAuthoringModuleProperties {
  return {
    controller,
    locale: "en",
    state: skillAuthoringStateFixture(statePatch),
  };
}

export function skillAuthoringActionsFixtureForView(): SkillAuthoringActions {
  return {
    ...skillAuthoringActionsFixture(),
    acceptReadback: vi.fn(),
    confirmNavigation: vi
      .fn<SkillAuthoringActions["confirmNavigation"]>()
      .mockResolvedValue(undefined),
    copySkill: vi.fn<SkillAuthoringActions["copySkill"]>().mockResolvedValue(undefined),
    editDraft: vi.fn(),
    loadCatalog: vi.fn<SkillAuthoringActions["loadCatalog"]>().mockResolvedValue(undefined),
    loadClasses: vi.fn<SkillAuthoringActions["loadClasses"]>().mockResolvedValue(undefined),
    reload: vi.fn<SkillAuthoringActions["reload"]>().mockResolvedValue(undefined),
    saveDraft: vi.fn<SkillAuthoringActions["saveDraft"]>().mockResolvedValue(undefined),
    selectClass: vi.fn<SkillAuthoringActions["selectClass"]>().mockResolvedValue(undefined),
    selectSkill: vi.fn<SkillAuthoringActions["selectSkill"]>().mockResolvedValue(undefined),
    startPersonalDraft: vi
      .fn<SkillAuthoringActions["startPersonalDraft"]>()
      .mockResolvedValue(undefined),
    validateDraft: vi.fn<SkillAuthoringActions["validateDraft"]>().mockResolvedValue(undefined),
  };
}

function skillAuthoringViewElementFixture(
  statePatch: Parameters<typeof skillAuthoringStateFixture>[0] = {},
  controller: SkillAuthoringActions = skillAuthoringActionsFixtureForView(),
): {
  readonly controller: SkillAuthoringActions;
  readonly element: ReactElement;
  readonly files: SkillAuthoringFileExchange;
} {
  const properties = skillAuthoringViewPropertiesFixture(controller, statePatch);
  const files = skillAuthoringFileExchangeFixture();
  return {
    controller,
    element: createElement(SkillAuthoringModule, {
      ...properties,
      files,
      liveFileOperations: false,
    }),
    files,
  };
}

export function skillAuthoringViewFixture(
  statePatch: Parameters<typeof skillAuthoringStateFixture>[0] = {},
  controller: SkillAuthoringActions = skillAuthoringActionsFixtureForView(),
) {
  const fixture = skillAuthoringViewElementFixture(statePatch, controller);
  return { ...fixture, elements: reviewElements(fixture.element) };
}
