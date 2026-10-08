import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { sessionPorts } from "../../browser/typed-host-data.fixture.js";
import { ServerSettingsView } from "../modules/server-settings/view.js";
import { ExternalAccessView } from "../modules/external-access/view.js";
import { SkillAuthoringModule } from "../modules/skill-authoring/skill-authoring-module.js";
import { EducationalSettings } from "../modules/educational-insights/settings.js";
import { TeachingModule } from "../modules/teaching/teaching-module.js";
import type { WorkspaceSettings } from "./profile-shell.js";
import { TeacherWorkspace } from "./teacher-workspace.js";

interface ShellProps {
  readonly classes: readonly { classId: string }[];
  readonly classBusy: boolean;
  readonly hasClassDrafts: boolean;
  readonly settings: WorkspaceSettings;
  readonly onClassChange: (classId: string) => Promise<void>;
}
const profiles = { ...sessionPorts, fetch: vi.fn() };
function workspace(props: Partial<Parameters<typeof TeacherWorkspace>[0]> = {}) {
  const element = TeacherWorkspace({
    locale: "en",
    profiles,
    teaching: undefined,
    authoring: undefined,
    governance: undefined,
    ...props,
  }) as ReactElement<ShellProps>;
  if (!isValidElement(element)) throw new Error("Expected the profile shell");
  return element.props;
}
const content = (node: ReactNode) =>
  (node as ReactElement<{ content: Record<string, ReactNode> }>).props.content;
const types = (node: ReactNode) =>
  Children.toArray(Object.values(content(node))).map((child) =>
    isValidElement(child) ? child.type : null,
  );
const teaching = (busy: boolean, dirty: boolean, calls: string[] = []) =>
  ({
    state: {
      classes: [{ classId: "class:a", displayName: "Physics" }],
      classId: "class:a",
      busy,
      dirty,
    },
    controller: {
      selectClass: vi.fn((classId: string) => {
        calls.push(`teaching.select:${classId}`);
        return Promise.resolve();
      }),
      confirmClassSwitch: vi.fn((discard: boolean) => {
        calls.push(`teaching.confirm:${String(discard)}`);
        return Promise.resolve();
      }),
    },
  }) as never;
const authoring = (busy: boolean, dirty: boolean, calls: string[] = []) =>
  ({
    state: { busy, dirty },
    controller: {
      selectClass: vi.fn((classId: string) => {
        calls.push(`authoring.select:${classId}`);
        return Promise.resolve();
      }),
      confirmNavigation: vi.fn((discard: boolean) => {
        calls.push(`authoring.confirm:${String(discard)}`);
        return Promise.resolve();
      }),
    },
  }) as never;

it("drives teaching and skill editing from the shared selector, discarding after one decision", async () => {
  const calls: string[] = [];
  const shell = workspace({
    teaching: teaching(false, false, calls),
    authoring: authoring(false, false, calls),
  });
  await shell.onClassChange("class:a");
  expect(calls).toEqual([
    "teaching.select:class:a",
    "teaching.confirm:true",
    "authoring.select:class:a",
    "authoring.confirm:true",
  ]);
  expect(types(shell.settings.classroom)).toEqual([
    TeachingModule,
    ExternalAccessView,
    EducationalSettings,
    SkillAuthoringModule,
  ]);
  const access = content(shell.settings.classroom).access as ReactElement<{
    classId: string | null;
    fetchRequest: object;
  }>;
  expect(access.props).toMatchObject({ classId: "class:a", fetchRequest: profiles.fetch });
  expect((content(shell.settings.classroom).features as ReactElement).key).toBe(
    "education:class:a",
  );
  const server = shell.settings.server as ReactElement<{ classNames: object }>;
  expect(server.type).toBe(ServerSettingsView);
  expect(server.props.classNames).toEqual({ "class:a": "Physics" });
});

it("reports busy and dirty state from either class module", () => {
  for (const [teachingState, authoringState, busy, dirty] of [
    [[true, false], [false, false], true, false],
    [[false, false], [true, false], true, false],
    [[false, true], [false, false], false, true],
    [[false, false], [false, true], false, true],
  ] as const)
    expect(
      workspace({
        teaching: teaching(teachingState[0], teachingState[1]),
        authoring: authoring(authoringState[0], authoringState[1]),
      }),
    ).toMatchObject({ classBusy: busy, hasClassDrafts: dirty });
});

it("adds center administration only for confirmed administrators", async () => {
  const governance = (administrator: boolean) =>
    ({ state: { access: { administrator } }, controller: {} }) as never;
  expect(workspace({ governance: governance(false) }).settings.administration).toBeUndefined();
  const shell = workspace({ governance: governance(true) });
  expect(shell.settings.administration).toBeDefined();
  expect(shell).toMatchObject({ classes: [], classBusy: false, hasClassDrafts: false });
  expect(types(shell.settings.classroom)).toEqual([ExternalAccessView, EducationalSettings]);
  expect((content(shell.settings.classroom).features as ReactElement).key).toBe("education:none");
  expect(
    (content(shell.settings.classroom).access as ReactElement<{ classId: string | null }>).props
      .classId,
  ).toBeNull();
  expect(
    (shell.settings.server as ReactElement<{ classNames: object }>).props.classNames,
  ).toStrictEqual({});
  await expect(shell.onClassChange("class:a")).resolves.toBeUndefined();
});
