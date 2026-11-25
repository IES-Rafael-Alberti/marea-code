import { expect, it, vi } from "vitest";

import { createPresentation } from "./presentation.js";
import { PARITY_TEST_COPY as copy } from "../../test-support/parity-copy.js";

const context = { cwd: "/project", branch: "", repositoryUrl: "", model: "" };
const usage = { inputTokens: 2_400, outputTokens: 21, lastInputTokens: 2_360 };
const ready = { approval: null, messages: [], status: "ready" as const };

it("keeps the usage line hidden until the student asks for it, and saves each change", () => {
  const onVisibilityChange = vi.fn();
  const view = createPresentation(context, copy, vi.fn(), undefined, undefined, {
    visible: false,
    onVisibilityChange,
  });
  view.sync({ ...ready, usage });
  expect(view.snapshot().usageLine).toBeNull();
  expect(view.submit("/usage")).toBe(true);
  expect(view.snapshot().usageLine).toBe("↑2.4k ↓21");
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  view.sync({ ...ready, usage: { ...usage, inputTokens: 5_000, contextWindowTokens: 262_144 } });
  expect(view.snapshot().usageLine).toBe("↑5k ↓21 0.9%/262k");
  // A snapshot without usage keeps what was shown.
  view.sync(ready);
  expect(view.snapshot().usageLine).toBe("↑5k ↓21 0.9%/262k");
  expect(view.submit("/uso")).toBe(true);
  expect(view.snapshot().usageLine).toBeNull();
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
});

it("starts visible when the student left it on, showing nothing until usage arrives", () => {
  const view = createPresentation(context, copy, vi.fn(), undefined, undefined, { visible: true });
  view.sync(ready);
  expect(view.snapshot().usageLine).toBeNull();
  view.sync({ ...ready, usage });
  expect(view.snapshot().usageLine).toBe("↑2.4k ↓21");
  expect(view.submit("/usage")).toBe(true);
  expect(view.snapshot().usageLine).toBeNull();
});

it("is hidden by default without a saved preference", () => {
  const view = createPresentation(context, copy, vi.fn());
  view.sync({ ...ready, usage });
  expect(view.snapshot().usageLine).toBeNull();
  view.submit("/usage");
  expect(view.snapshot().usageLine).toBe("↑2.4k ↓21");
});
