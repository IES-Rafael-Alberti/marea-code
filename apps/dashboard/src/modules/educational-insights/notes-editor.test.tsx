import { hooks, mocked, render } from "./hooks.fixture.js";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CriterionNotes, LONG_NOTES_CHARACTERS, mergeNotes } from "./notes-editor.js";
import { notesMessages, proposalFailure } from "./notes-messages.js";
import { button, elements } from "./interactions.fixture.js";

const m = notesMessages("es");
const onSaved = vi.fn();
const editor = () =>
  CriterionNotes({
    client: mocked.client,
    classId: "class:a",
    studentId: "student",
    criterionKey: "key",
    locale: "es",
    onSaved,
  });
const opened = { notes: "07/09/2026: First.", omitted: 0, revision: "sha256:a" };
const markup = () => renderToStaticMarkup(render(editor));
const textarea = () => {
  const found = elements(render(editor)).find((e) => e.type === "textarea");
  if (!found) throw new Error("Missing textarea");
  return found.props;
};
const type = (value: string) => {
  textarea().onChange?.({ currentTarget: { value, checked: false } });
};
async function open(value: object = opened) {
  mocked.client.mockResolvedValueOnce(value);
  button(render(editor), m.notes).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
}

describe("notes merge after a conflict", () => {
  it("adds what an approval appended below the draft and never drops either text", () => {
    expect(mergeNotes("a", "mine", "a\nb")).toBe("mine\nb");
    expect(mergeNotes("", "mine", "b")).toBe("mine\nb");
    expect(mergeNotes("a", "", "a\nb")).toBe("b");
    expect(mergeNotes("a", "mine", "a")).toBe("mine");
    expect(mergeNotes("a", "mine", "aX\nY")).toBe("mine\nX\nY");
    expect(mergeNotes("a", "mine", "other")).toBe("mine\nother");
  });
});

describe("criterion notes editor", () => {
  it("opens the whole text with its count, help and actions", async () => {
    expect(markup()).not.toContain("<textarea");
    expect(button(render(editor), m.notes).disabled).toBe(false);
    expect(hooks.dependencies).toEqual([[]]);
    await open();
    expect(mocked.client.mock.lastCall?.slice(0, 2)).toEqual([
      "class:a",
      { kind: "notes", studentId: "student", key: "key" },
    ]);
    expect(textarea().value).toBe(opened.notes);
    const html = markup();
    expect(html).toContain(m.notesHelp);
    expect(html).toContain(m.count(opened.notes.length));
    expect(html).not.toContain(m.long);
    expect(html).not.toContain(m.omitted);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(m.proposed);
    for (const label of [m.propose, m.save, m.cancel])
      expect(button(render(editor), label).disabled).toBe(false);
    button(render(editor), m.cancel).onClick?.();
    expect(markup()).not.toContain("<textarea");
  });

  it("warns about long, too long and partially shown notes", async () => {
    await open({ ...opened, omitted: 3 });
    expect(markup()).toContain(m.omitted);
    type("x".repeat(LONG_NOTES_CHARACTERS));
    expect(markup()).not.toContain(m.long);
    type("x".repeat(LONG_NOTES_CHARACTERS + 1));
    expect(markup()).toContain(m.long);
    expect(button(render(editor), m.save).disabled).toBe(false);
    type("x".repeat(200_000));
    expect(markup()).not.toContain(m.tooLong);
    type("x".repeat(200_001));
    expect(markup()).toContain(m.tooLong);
    expect(button(render(editor), m.save).disabled).toBe(true);
  });

  it("saves the draft with the opened revision and reloads the progress", async () => {
    await open();
    type("Rewritten.");
    mocked.client.mockResolvedValueOnce({ ...opened, notes: "Rewritten.", conflict: false });
    button(render(editor), m.save).onClick?.();
    expect(button(render(editor), m.save).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocked.client.mock.lastCall?.[1]).toEqual({
      kind: "save-notes",
      notes: "Rewritten.",
      expectedRevision: "sha256:a",
      studentId: "student",
      key: "key",
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(markup()).not.toContain("<textarea");
  });

  it("keeps both texts and the newer revision when an approval appended meanwhile", async () => {
    await open();
    type("Mine.");
    mocked.client.mockResolvedValueOnce({
      notes: `${opened.notes}\n08/09/2026: New.`,
      omitted: 0,
      revision: "sha256:b",
      conflict: true,
    });
    button(render(editor), m.save).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(textarea().value).toBe("Mine.\n08/09/2026: New.");
    expect(markup()).toContain(m.conflict);
    expect(onSaved).not.toHaveBeenCalled();
    mocked.client.mockResolvedValueOnce({ ...opened, conflict: false });
    button(render(editor), m.save).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocked.client.mock.lastCall?.[1]).toMatchObject({ expectedRevision: "sha256:b" });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("places a proposal in the draft for review without saving", async () => {
    await open();
    mocked.client.mockResolvedValueOnce({ proposal: "Resumen.", failure: null });
    button(render(editor), m.propose).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocked.client.mock.lastCall?.[1]).toEqual({
      kind: "propose-notes",
      studentId: "student",
      key: "key",
    });
    expect(textarea().value).toBe("Resumen.");
    expect(markup()).toContain(m.proposed);
    expect(mocked.client).toHaveBeenCalledTimes(2);
  });

  it.each(["budget", null])("keeps the text when a proposal fails (%s)", async (failure) => {
    await open();
    mocked.client.mockResolvedValueOnce({ proposal: null, failure });
    button(render(editor), m.propose).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(textarea().value).toBe(opened.notes);
    expect(markup()).toContain(proposalFailure(m, failure));
  });

  it("shows request failures and keeps the draft", async () => {
    mocked.client.mockRejectedValueOnce(new Error("offline"));
    button(render(editor), m.notes).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(markup()).toContain(m.error);
    expect(markup()).not.toContain(m.proposalFailed);
    expect(button(render(editor), m.notes).disabled).toBe(false);
    await open();
    expect(markup()).not.toContain(m.error);
    type("Mine.");
    mocked.client.mockRejectedValueOnce(new Error("offline"));
    button(render(editor), m.save).onClick?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(textarea().value).toBe("Mine.");
    expect(markup()).toContain(m.error);
    button(render(editor), m.cancel).onClick?.();
    expect(markup()).not.toContain(m.error);
  });

  it.each([false, true])("publishes nothing after unmount (failure: %s)", async (failure) => {
    const pending = Promise.withResolvers<object>();
    mocked.client.mockReturnValueOnce(pending.promise);
    render(editor);
    const dispose = hooks.effects[0]?.();
    button(render(editor), m.notes).onClick?.();
    if (typeof dispose === "function") dispose();
    if (failure) pending.reject(new Error("offline"));
    else pending.resolve(opened);
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.values[0]).toBeNull();
    expect(hooks.values[2]).toBe(true);
    expect(hooks.values[3]).toBeNull();
    expect((mocked.client.mock.lastCall?.[3] as AbortSignal).aborted).toBe(true);
  });
});

describe("proposal failure messages", () => {
  it("names each closed failure in Spanish first", () => {
    expect(proposalFailure(m, "empty")).toBe(m.empty);
    expect(proposalFailure(m, "unconfigured")).toBe(m.unconfigured);
    expect(proposalFailure(m, "budget")).toBe(m.budget);
    expect(proposalFailure(m, "input-too-large")).toBe(m.tooLarge);
    expect(proposalFailure(m, "provider")).toBe(m.proposalFailed);
    expect(notesMessages("en").notes).toBe("Learning notes");
    expect(notesMessages("eu").notes).toBe("Ikaskuntza-oharrak");
  });
});
