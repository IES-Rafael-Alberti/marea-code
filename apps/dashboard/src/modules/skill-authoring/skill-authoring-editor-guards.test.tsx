import { describe, expect, it, vi } from "vitest";

import { skillAuthoringDraftFixture } from "./skill-authoring.fixture.js";
import { SkillAuthoringLiveEditor } from "./skill-authoring-editor.js";
import { skillAuthoringEditorPropertiesFixture } from "./skill-authoring-editor.fixture.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

type HookValue = boolean | number | string | object | null;
interface Ref {
  current: HookValue;
}
const harness = vi.hoisted(() => ({
  refs: [] as Ref[],
  refCursor: 0,
  stateCursor: 0,
  updates: [] as HookValue[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | undefined) => {
      const cleanup = effect();
      if (cleanup !== undefined) harness.updates.push(true);
    },
    useRef: (initial: HookValue) => {
      const existing = harness.refs[harness.refCursor++];
      if (existing !== undefined) return existing;
      const ref = { current: initial };
      harness.refs.push(ref);
      return ref;
    },
    useState: (initial: HookValue) => {
      harness.stateCursor++;
      return [initial, (value: HookValue) => harness.updates.push(value)];
    },
  };
});

describe("skill authoring live editor guards", () => {
  it("requires staged fields, renders the prompt after rerender, and replaces explicitly", () => {
    harness.refs.length = 0;
    harness.refCursor = 0;
    harness.stateCursor = 0;
    harness.updates.length = 0;
    const current = skillAuthoringEditorPropertiesFixture({ dirty: true });
    const initial = reviewElements(<SkillAuthoringLiveEditor {...current.properties} />);
    expect(
      initial.some(
        (item) => item.props.children === skillAuthoringMessages("en").importPendingHeading,
      ),
    ).toBe(false);
    const pending = harness.refs[4];
    const pendingContext = harness.refs[5];
    const pendingGeneration = harness.refs[6];
    if (pending === undefined || pendingContext === undefined || pendingGeneration === undefined)
      throw new Error("Missing staged refs.");
    pending.current = [{ path: "SKILL.md", content: "staged" }];
    pendingContext.current = harness.refs[2]?.current ?? null;
    pendingGeneration.current = harness.refs[3]?.current ?? null;
    harness.refCursor = 0;
    harness.stateCursor = 0;
    const rerendered = SkillAuthoringLiveEditor(current.properties);
    for (const ref of [pending, pendingContext, pendingGeneration]) {
      const saved = ref.current;
      ref.current = null;
      expect(() => {
        (
          rerendered.props as { fileOperations: { replaceImport: () => void } }
        ).fileOperations.replaceImport();
      }).not.toThrow();
      expect(current.edit).not.toHaveBeenCalled();
      ref.current = saved;
    }
    const staged = reviewElements(rerendered);
    expect(
      staged.some(
        (item) => item.props.children === skillAuthoringMessages("en").importPendingHeading,
      ),
    ).toBe(true);
    reviewButton(staged, skillAuthoringMessages("en").importReplace).props.onClick?.();
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ path: "SKILL.md", content: "staged" }],
    });
    expect(harness.updates.filter((value) => value === null).length).toBeGreaterThanOrEqual(2);
  });
});
