import { describe, expect, it, vi } from "vitest";

import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";
import { createPresentation } from "./presentation.js";
import { collectUnhandledRejections } from "../../test-support/unhandled-rejections.boundary.js";

const copy = PARITY_TEST_COPY;
const context = { branch: "main", cwd: "/project", model: "", repositoryUrl: "" };

describe("parity presentation language command", () => {
  it("updates copy and keeps the local command out of the model", async () => {
    const nextCopy = {
      ...copy,
      help: "Laguntza",
      commands: { ...copy.commands, language: "Aldatu hizkuntza" },
    };
    const onLanguageCommand = vi.fn(() =>
      Promise.resolve({
        copy: { parity: { copy: nextCopy, context } },
        notice: "Hizkuntza aldatu da",
      }),
    );
    const dispatch = vi.fn();
    const history = { entries: [], remember: vi.fn() };
    const presentation = createPresentation(context, copy, dispatch, history, onLanguageCommand);
    expect(presentation.submit("/language")).toBe(true);
    await vi.waitFor(() => {
      expect(onLanguageCommand).toHaveBeenCalledExactlyOnceWith({
        parity: { copy, context, history },
      });
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(presentation.snapshot().transcript.at(-1)).toMatchObject({
      kind: "notice",
      text: "Hizkuntza aldatu da",
    });
    expect(presentation.submit("/help")).toBe(true);
    expect(presentation.snapshot().transcript.at(-1)).toMatchObject({ text: "Laguntza" });
    presentation.setCopy(copy);
    expect(presentation.submit("/help")).toBe(true);
    expect(presentation.snapshot().transcript.at(-1)).toMatchObject({ text: copy.help });
  });

  it("ignores a language command that produces no change", async () => {
    const onLanguageCommand = vi.fn(() => null);
    const presentation = createPresentation(context, copy, vi.fn(), undefined, onLanguageCommand);
    expect(
      await collectUnhandledRejections(() => {
        expect(presentation.submit("/language")).toBe(true);
      }),
    ).toEqual([]);
    expect(onLanguageCommand.mock.calls).toStrictEqual([[{ parity: { copy, context } }]]);
    expect(presentation.submit("/help")).toBe(true);
    expect(presentation.snapshot().transcript.at(-1)).toMatchObject({ text: copy.help });
  });

  it("applies a language copy without adding a notice when none is supplied", async () => {
    const nextCopy = { ...copy, commands: { ...copy.commands, language: "Aldatu" } };
    const presentation = createPresentation(context, copy, vi.fn(), undefined, () => ({
      copy: { parity: { copy: nextCopy, context } },
    }));
    expect(presentation.submit("/language")).toBe(true);
    await Promise.resolve();
    expect(presentation.snapshot().transcript.at(-1)?.kind).not.toBe("notice");
  });

  it("keeps the language command local when no handler is composed", () => {
    const presentation = createPresentation(context, copy, vi.fn());
    expect(presentation.submit("/language")).toBe(true);
  });
});
