import type { SubmitEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { SkillAuthoringController } from "./modules/skill-authoring/skill-authoring-controller.js";
import { skillAuthoringMessages } from "./modules/skill-authoring/skill-authoring-messages.js";
import { SkillAuthoringView } from "./modules/skill-authoring/skill-authoring-view.js";
import { skillAuthoringFileExchangeFixture } from "./modules/skill-authoring/skill-authoring-view.fixture.js";
import { TeachingController } from "./modules/teaching/teaching-controller.js";
import { teachingMessages } from "./modules/teaching/teaching-messages.js";
import { TeachingModule } from "./modules/teaching/teaching-module.js";
import { reviewButton, reviewElements } from "./modules/evaluation/react-tree.fixture.js";
import {
  workflowDraft,
  workflowSettings,
  workflowTransports,
  WORKFLOW_CLASS_A,
  WORKFLOW_CLASS_B,
  WORKFLOW_DIGEST_C,
  WORKFLOW_DIGEST_A,
  WORKFLOW_DIGEST_B,
} from "./teaching-authoring-workflow.fixture.js";

function teachingElements(teaching: TeachingController) {
  return reviewElements(
    <TeachingModule locale="en" state={teaching.state} controller={teaching} />,
  );
}

function authoringElements(authoring: SkillAuthoringController) {
  return reviewElements(
    <SkillAuthoringView
      state={authoring.state}
      controller={authoring}
      messages={skillAuthoringMessages("en")}
      files={skillAuthoringFileExchangeFixture()}
      liveFileOperations={false}
    />,
  );
}

function cloneState<T>(state: T): T {
  return JSON.parse(JSON.stringify(state)) as T;
}

interface StateSnapshot<T> {
  readonly state: T;
  readonly calls: readonly string[];
}

function snapshot<T>(state: T, calls: readonly string[]): StateSnapshot<T> {
  return { state: cloneState(state), calls: [...calls] };
}

function expectUnchanged<T>(state: T, calls: readonly string[], expected: StateSnapshot<T>) {
  expect(state).toEqual(expected.state);
  expect(calls).toEqual(expected.calls);
}

function catalogDigests(catalog: readonly { readonly id: string; readonly digest: string }[]) {
  return catalog.map(({ id, digest }) => ({ id, digest }));
}

function teachingSave(teaching: TeachingController) {
  reviewButton(teachingElements(teaching), teachingMessages("en").save).props.onClick?.();
}
function authoringSave(authoring: SkillAuthoringController) {
  reviewButton(authoringElements(authoring), skillAuthoringMessages("en").save).props.onClick?.();
}

async function reloadTeaching(teaching: TeachingController, calls: string[]) {
  const before = calls.length;
  reviewButton(teachingElements(teaching), teachingMessages("en").reloadCurrent).props.onClick?.();
  await vi.waitFor(() => {
    expect(teaching.state.busy).toBe(false);
  });
  expect(calls.slice(before)).toEqual([`read:${WORKFLOW_CLASS_A}`, `catalog:${WORKFLOW_CLASS_A}`]);
}
function toggleSkill(teaching: TeachingController, id: string, digest: string) {
  const input = teachingElements(teaching).find(
    (entry) => entry.type === "input" && entry.props.value === `${id}:${digest}`,
  );
  if (input === undefined) throw new Error(`Missing rendered teaching skill ${id}:${digest}`);
  (input.props as { onChange?: () => void }).onChange?.();
}
function submitCopy(authoring: SkillAuthoringController, slug: string) {
  const form = authoringElements(authoring).find(
    (entry) =>
      entry.type === "form" &&
      (entry.props as { className?: string }).className === "skill-authoring-copy",
  );
  if (form === undefined) throw new Error("Missing rendered copy form");
  const savedFormData = globalThis.FormData;
  class CopyFormData {
    get(name: string) {
      return name === "destinationSlug" ? slug : "";
    }
  }
  try {
    vi.stubGlobal("FormData", CopyFormData);
    (form.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void }).onSubmit?.({
      preventDefault: () => undefined,
      currentTarget: {} as HTMLFormElement,
    } as SubmitEvent<HTMLFormElement>);
  } finally {
    vi.stubGlobal("FormData", savedFormData);
  }
}

function requestTeachingClass(teaching: TeachingController, classId: string) {
  const selects = teachingElements(teaching).filter(
    (entry) => entry.type === "select" && entry.props.value === teaching.state.classId,
  );
  if (selects.length !== 1)
    throw new Error(`Expected one teaching class selector, got ${String(selects.length)}`);
  (
    selects[0]?.props as { onChange?: (event: { currentTarget: { value: string } }) => void }
  ).onChange?.({ currentTarget: { value: classId } });
}

function requestAuthoringClass(authoring: SkillAuthoringController, classId: string) {
  const selects = authoringElements(authoring).filter(
    (entry) => entry.type === "select" && entry.props.value === authoring.state.classId,
  );
  if (selects.length !== 1)
    throw new Error(`Expected one authoring class selector, got ${String(selects.length)}`);
  (
    selects[0]?.props as { onChange?: (event: { currentTarget: { value: string } }) => void }
  ).onChange?.({ currentTarget: { value: classId } });
}

async function settleTeaching(teaching: TeachingController) {
  await vi.waitFor(() => {
    expect(teaching.state.busy).toBe(false);
  });
}

async function settleAuthoring(authoring: SkillAuthoringController) {
  await vi.waitFor(() => {
    expect(authoring.state.busy).toBe(false);
  });
}

async function loadedPair() {
  const transport = workflowTransports();
  const teaching = new TeachingController(transport.teaching, vi.fn());
  const authoring = new SkillAuthoringController(transport.authoring, vi.fn());
  await teaching.loadClasses();
  await teaching.selectClass(WORKFLOW_CLASS_A);
  await authoring.loadClasses();
  await authoring.selectClass(WORKFLOW_CLASS_A);
  return { transport, teaching, authoring };
}

describe("cross-controller teaching and authoring workflow", () => {
  it("saves authoring, reloads teaching, enables an exact revision, then disables it", async () => {
    const { transport, teaching, authoring } = await loadedPair();
    await authoring.startPersonalDraft("testing");
    authoring.editDraft(workflowDraft("testing", "Saved authoring A"));
    const before = {
      teaching: transport.teachingCalls.length,
      authoring: transport.authoringCalls.length,
    };
    authoringSave(authoring);
    await vi.waitFor(() => {
      expect(authoring.state.dirty).toBe(false);
    });
    expect(transport.teachingCalls.length).toBe(before.teaching);
    expect(transport.authoringCalls.slice(before.authoring)).toEqual([
      `save:${WORKFLOW_CLASS_A}:${WORKFLOW_DIGEST_A}`,
    ]);
    expect(teaching.state.configuration?.settings.selection.didactic).toEqual([]);
    await reloadTeaching(teaching, transport.teachingCalls);
    expect(
      teaching.state.catalog.find((entry) => entry.id === "teacher/alice/testing")?.digest,
    ).toBe(WORKFLOW_DIGEST_B);
    toggleSkill(teaching, "teacher/alice/testing", WORKFLOW_DIGEST_B);
    teachingSave(teaching);
    await vi.waitFor(() => {
      expect(teaching.state.dirty).toBe(false);
    });
    expect(transport.teachingCalls.at(-1)).toBe(`save:${WORKFLOW_CLASS_A}:revision:one`);
    expect(teaching.state.configuration?.settings.selection.didactic).toEqual([
      { id: "teacher/alice/testing", digest: WORKFLOW_DIGEST_B },
    ]);
    toggleSkill(teaching, "teacher/alice/testing", WORKFLOW_DIGEST_B);
    teachingSave(teaching);
    await vi.waitFor(() => {
      expect(teaching.state.dirty).toBe(false);
    });
    expect(teaching.state.configuration?.settings.selection.didactic).toEqual([]);
    expect(transport.teachingCalls.filter((call) => call.startsWith("save:")).length).toBe(2);
  });

  it("copies through the rendered form, proves no automatic teaching write, reloads teaching, and enables the copied digest", async () => {
    const { transport, teaching, authoring } = await loadedPair();
    await authoring.selectSkill("marea/bundled");
    const before = {
      teaching: transport.teachingCalls.length,
      authoring: transport.authoringCalls.length,
    };
    submitCopy(authoring, "copied");
    await vi.waitFor(() => {
      expect(authoring.state.personalSlug).toBe("copied");
    });
    expect(transport.teachingCalls.length).toBe(before.teaching);
    expect(transport.authoringCalls.slice(before.authoring)).toEqual([
      `copy:${WORKFLOW_CLASS_A}:marea/bundled:${WORKFLOW_DIGEST_A}:copied`,
    ]);
    await reloadTeaching(teaching, transport.teachingCalls);
    expect(
      teaching.state.catalog.find((entry) => entry.id === "teacher/alice/copied")?.digest,
    ).toBe(WORKFLOW_DIGEST_B);
    toggleSkill(teaching, "teacher/alice/copied", WORKFLOW_DIGEST_B);
    teachingSave(teaching);
    await vi.waitFor(() => {
      expect(teaching.state.dirty).toBe(false);
    });
    expect(teaching.state.configuration?.settings.selection.didactic).toEqual([
      { id: "teacher/alice/copied", digest: WORKFLOW_DIGEST_B },
    ]);
  });

  it("keeps the same selected personal slug at digest A while replacing it at digest B", async () => {
    const { transport, teaching, authoring } = await loadedPair();
    toggleSkill(teaching, "teacher/alice/testing", WORKFLOW_DIGEST_A);
    teachingSave(teaching);
    await vi.waitFor(() => {
      expect(teaching.state.dirty).toBe(false);
    });
    await authoring.startPersonalDraft("testing");
    authoring.editDraft(workflowDraft("testing", "Replacement B"));
    authoringSave(authoring);
    await vi.waitFor(() => {
      expect(authoring.state.dirty).toBe(false);
    });
    await reloadTeaching(teaching, transport.teachingCalls);
    expect(teaching.state.configuration?.settings.selection.didactic).toEqual([
      { id: "teacher/alice/testing", digest: WORKFLOW_DIGEST_A },
    ]);
    expect(
      teaching.state.catalog.find((entry) => entry.id === "teacher/alice/testing")?.digest,
    ).toBe(WORKFLOW_DIGEST_B);
  });

  it("switches teaching independently through cancel and accept while authoring stays intact", async () => {
    const { transport, teaching, authoring } = await loadedPair();
    teaching.edit(workflowSettings("Keep teaching A"));
    await authoring.startPersonalDraft("testing");
    authoring.editDraft(workflowDraft("testing", "Keep authoring A"));
    const authoringBefore = snapshot(authoring.state, transport.authoringCalls);

    requestTeachingClass(teaching, WORKFLOW_CLASS_B);
    expect(teaching.state.pendingClassId).toBe(WORKFLOW_CLASS_B);
    expectUnchanged(authoring.state, transport.authoringCalls, authoringBefore);

    reviewButton(teachingElements(teaching), teachingMessages("en").switchCancel).props.onClick?.();
    expect(teaching.state.classId).toBe(WORKFLOW_CLASS_A);
    expect(teaching.state.draft?.classInstructions.tutoring).toBe("Keep teaching A");
    expectUnchanged(authoring.state, transport.authoringCalls, authoringBefore);

    requestTeachingClass(teaching, WORKFLOW_CLASS_B);
    expect(teaching.state.pendingClassId).toBe(WORKFLOW_CLASS_B);
    expectUnchanged(authoring.state, transport.authoringCalls, authoringBefore);

    const teachingCallsBeforeAccept = [...transport.teachingCalls];
    reviewButton(
      teachingElements(teaching),
      teachingMessages("en").switchDiscard,
    ).props.onClick?.();
    await settleTeaching(teaching);
    expectUnchanged(authoring.state, transport.authoringCalls, authoringBefore);
    expect(transport.teachingCalls.slice(teachingCallsBeforeAccept.length)).toEqual([
      `read:${WORKFLOW_CLASS_B}`,
      `catalog:${WORKFLOW_CLASS_B}`,
    ]);
    expect(teaching.state.classId).toBe(WORKFLOW_CLASS_B);
    expect(teaching.state.configuration).toEqual({
      version: "revision:two",
      settings: workflowSettings("B original"),
    });
    expect(catalogDigests(teaching.state.catalog)).toEqual([
      { id: "teacher/alice/other", digest: WORKFLOW_DIGEST_C },
    ]);
    expect(authoring.state.classId).toBe(WORKFLOW_CLASS_A);
    expect(catalogDigests(authoring.state.catalog)).toEqual([
      { id: "teacher/alice/testing", digest: WORKFLOW_DIGEST_A },
      { id: "marea/bundled", digest: WORKFLOW_DIGEST_A },
    ]);
  });

  it("switches authoring independently through cancel and accept while teaching stays intact", async () => {
    const { transport, teaching, authoring } = await loadedPair();
    teaching.edit(workflowSettings("Keep teaching A"));
    await authoring.startPersonalDraft("testing");
    authoring.editDraft(workflowDraft("testing", "Keep authoring A"));
    const teachingBefore = snapshot(teaching.state, transport.teachingCalls);

    requestAuthoringClass(authoring, WORKFLOW_CLASS_B);
    expect(authoring.state.pendingTarget).toEqual({ kind: "class", classId: WORKFLOW_CLASS_B });
    expectUnchanged(teaching.state, transport.teachingCalls, teachingBefore);

    reviewButton(
      authoringElements(authoring),
      skillAuthoringMessages("en").cancelNavigation,
    ).props.onClick?.();
    expect(authoring.state.classId).toBe(WORKFLOW_CLASS_A);
    expect(authoring.state.draft?.files[0]?.content).toBe("Keep authoring A");
    expectUnchanged(teaching.state, transport.teachingCalls, teachingBefore);

    requestAuthoringClass(authoring, WORKFLOW_CLASS_B);
    expect(authoring.state.pendingTarget).toEqual({ kind: "class", classId: WORKFLOW_CLASS_B });
    expectUnchanged(teaching.state, transport.teachingCalls, teachingBefore);

    const authoringCallsBeforeAccept = [...transport.authoringCalls];
    reviewButton(
      authoringElements(authoring),
      skillAuthoringMessages("en").discardAndNavigate,
    ).props.onClick?.();
    await settleAuthoring(authoring);
    expectUnchanged(teaching.state, transport.teachingCalls, teachingBefore);
    expect(transport.authoringCalls.slice(authoringCallsBeforeAccept.length)).toEqual([
      `catalog:${WORKFLOW_CLASS_B}`,
    ]);
    expect(authoring.state.classId).toBe(WORKFLOW_CLASS_B);
    expect(authoring.state.draft).toBeNull();
    expect(catalogDigests(authoring.state.catalog)).toEqual([
      { id: "teacher/alice/other", digest: WORKFLOW_DIGEST_C },
    ]);
    expect(teaching.state.classId).toBe(WORKFLOW_CLASS_A);
    expect(teaching.state.configuration).toEqual({
      version: "revision:one",
      settings: workflowSettings(),
    });
    expect(catalogDigests(teaching.state.catalog)).toEqual([
      { id: "teacher/alice/testing", digest: WORKFLOW_DIGEST_A },
      { id: "marea/bundled", digest: WORKFLOW_DIGEST_A },
    ]);
  });

  it.each(["conflict", "uncertain"] as const)(
    "recovers %s independently at every readback step and ignores both late disposed responses",
    async (code) => {
      const { transport, teaching, authoring } = await loadedPair();
      teaching.edit(workflowSettings("Retained teaching"));
      await authoring.startPersonalDraft("testing");
      authoring.editDraft(workflowDraft("testing", "Retained authoring"));
      transport.failures.teaching.set("save", Object.assign(new Error(code), { code }));
      transport.failures.authoring.set("save", Object.assign(new Error(code), { code }));

      const authoringBeforeTeachingFailure = snapshot(authoring.state, transport.authoringCalls);
      teachingSave(teaching);
      await vi.waitFor(() => {
        expect(teaching.state.problem).toBe(code);
      });
      expectUnchanged(authoring.state, transport.authoringCalls, authoringBeforeTeachingFailure);

      const teachingAfterFailure = snapshot(teaching.state, transport.teachingCalls);
      authoringSave(authoring);
      await vi.waitFor(() => {
        expect(authoring.state.problem).toBe(code);
      });
      expectUnchanged(teaching.state, transport.teachingCalls, teachingAfterFailure);
      const authoringAfterFailure = snapshot(authoring.state, transport.authoringCalls);

      const teachingReadCalls = [...transport.teachingCalls];
      reviewButton(
        teachingElements(teaching),
        teachingMessages("en").reloadCurrent,
      ).props.onClick?.();
      expectUnchanged(authoring.state, transport.authoringCalls, authoringAfterFailure);
      await settleTeaching(teaching);
      expectUnchanged(authoring.state, transport.authoringCalls, authoringAfterFailure);
      expect(transport.teachingCalls.slice(teachingReadCalls.length)).toEqual([
        `read:${WORKFLOW_CLASS_A}`,
        `catalog:${WORKFLOW_CLASS_A}`,
      ]);
      expect(teaching.state.draft?.classInstructions.tutoring).toBe("Retained teaching");
      expect(teaching.state.dirty).toBe(true);
      expect(teaching.state.problem).toBe(code);
      expect(teaching.state.recovery).not.toBeNull();

      reviewButton(
        teachingElements(teaching),
        teachingMessages("en").acceptCurrent,
      ).props.onClick?.();
      expectUnchanged(authoring.state, transport.authoringCalls, authoringAfterFailure);
      expect(teaching.state.recovery).toBeNull();
      expect(teaching.state.problem).toBeNull();
      expect(teaching.state.dirty).toBe(false);
      expect(teaching.state.classId).toBe(WORKFLOW_CLASS_A);

      const teachingBeforeAuthoringReadback = snapshot(teaching.state, transport.teachingCalls);
      const authoringReadCalls = [...transport.authoringCalls];
      reviewButton(
        authoringElements(authoring),
        skillAuthoringMessages("en").reload,
      ).props.onClick?.();
      expectUnchanged(teaching.state, transport.teachingCalls, teachingBeforeAuthoringReadback);
      await settleAuthoring(authoring);
      expectUnchanged(teaching.state, transport.teachingCalls, teachingBeforeAuthoringReadback);
      expect(transport.authoringCalls.slice(authoringReadCalls.length)).toEqual([
        `readPersonal:${WORKFLOW_CLASS_A}:testing`,
      ]);
      expect(authoring.state.draft?.files[0]?.content).toBe("Retained authoring");
      expect(authoring.state.dirty).toBe(true);
      expect(authoring.state.problem).toBe(code);
      expect(authoring.state.recovery).not.toBeNull();

      reviewButton(
        authoringElements(authoring),
        skillAuthoringMessages("en").acceptReadback,
      ).props.onClick?.();
      expectUnchanged(teaching.state, transport.teachingCalls, teachingBeforeAuthoringReadback);
      expect(authoring.state.recovery).toBeNull();
      expect(authoring.state.problem).toBeNull();
      expect(authoring.state.dirty).toBe(false);
      expect(authoring.state.classId).toBe(WORKFLOW_CLASS_A);
      expect(authoring.state.loadedBundle?.digest).toBe(WORKFLOW_DIGEST_A);
      expect(authoring.state.draft?.files[0]?.content).toBe("Teach one idea.");

      let releaseTeaching!: () => void;
      let releaseAuthoring!: () => void;
      transport.late.teaching = new Promise<never>((resolve) => {
        releaseTeaching = () => {
          resolve(undefined as never);
        };
      });
      const lateTeaching = new TeachingController(transport.teaching, vi.fn());
      const lateAuthoring = new SkillAuthoringController(transport.authoring, vi.fn());
      const teachingLoad = lateTeaching.selectClass(WORKFLOW_CLASS_A);
      await lateAuthoring.selectClass(WORKFLOW_CLASS_A);
      transport.late.authoring = new Promise<never>((resolve) => {
        releaseAuthoring = () => {
          resolve(undefined as never);
        };
      });
      const authoringLoad = lateAuthoring.startPersonalDraft("late");
      lateTeaching.dispose();
      lateAuthoring.dispose();
      const teachingDisposed = lateTeaching.state;
      const authoringDisposed = lateAuthoring.state;
      releaseTeaching();
      releaseAuthoring();
      await teachingLoad;
      await authoringLoad;
      expect(lateTeaching.state).toBe(teachingDisposed);
      expect(lateAuthoring.state).toBe(authoringDisposed);
    },
  );
});
