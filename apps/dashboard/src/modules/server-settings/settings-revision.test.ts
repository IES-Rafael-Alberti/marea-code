import { expect, it } from "vitest";
import { advanceSettingsRevision } from "./settings-revision.js";

it("advances only the matching saved base while preserving every draft field", () => {
  const change = { before: 2, after: 3 };
  const draft = { revision: 2, model: "unsaved", nested: { enabled: true } };
  expect(advanceSettingsRevision(draft, change)).toEqual({ ...draft, revision: 3 });
  expect(draft.revision).toBe(2);
  for (const state of [null, {}, { revision: 1 }, { revision: 3 }])
    expect(advanceSettingsRevision(state, change)).toBe(state);
});
