import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi, afterEach } from "vitest";
import { PreviewPanel, PreviewView } from "./preview-panel.js";
import { previewMessages } from "./preview-messages.js";
import { sample } from "./preview.fixture.js";
import type { PreviewState } from "./preview-controller.js";
const hooks = vi.hoisted(() => ({
  effects: [] as (() => () => void)[],
  dependencies: [] as (string | null | number | object)[][],
  set: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: PreviewState | number) => [initial, hooks.set],
  useEffect: (effect: () => () => void, dependencies: (string | null | number | object)[]) => {
    hooks.effects.push(effect);
    hooks.dependencies.push(dependencies);
  },
}));
afterEach(() => {
  hooks.effects = [];
  hooks.dependencies = [];
  vi.clearAllMocks();
});
it.each(["es", "en", "eu"] as const)("localizes all read-only states in %s", (locale) => {
  const m = previewMessages(locale);
  for (const status of ["empty", "loading", "error", "denied"] as const) {
    const html = renderToStaticMarkup(
      <PreviewView locale={locale} state={{ status }} classId={null} refresh={vi.fn()} />,
    );
    expect(html).toContain(m[status]);
    expect(html).toContain(m.synthetic);
    expect(html).toContain(m.policy);
    expect(html).toContain('role="status"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("<pre>");
  }
  for (const enabled of [false, true]) {
    const html = renderToStaticMarkup(
      <PreviewView
        locale={locale}
        state={{
          status: "ready",
          response: { ...sample, enabled, destinationCount: enabled ? 2 : 0 },
        }}
        classId="class:a"
        refresh={vi.fn()}
      />,
    );
    expect(html).toContain(enabled ? m.enabled : m.disabled);
    expect(html).toContain(`${m.destinations}: ${enabled ? "2" : "0"}`);
    expect(html).toContain("[REDACTED]");
    expect(html).toContain(m.sample);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("<input");
    expect(html).not.toContain(m.noAttributes);
  }
  expect(
    renderToStaticMarkup(
      <PreviewView
        locale={locale}
        state={{
          status: "ready",
          response: { ...sample, envelope: { ...sample.envelope, attributes: [] } },
        }}
        classId="class:a"
        refresh={vi.fn()}
      />,
    ),
  ).toContain(m.noAttributes);
});
it("loads and cancels on effect cleanup, skips empty scopes and wires explicit refresh", async () => {
  const fetchRequest = vi.fn().mockImplementation((_path: string, init: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...sample,
          requestId: (JSON.parse(init.body as string) as { requestId: string }).requestId,
        }),
      ),
    ),
  );
  const panel = PreviewPanel({ classId: "class:a", locale: "en", fetchRequest });
  expect(hooks.dependencies[0]).toEqual(["class:a", fetchRequest, 0]);
  expect(panel.props).toMatchObject({
    classId: "class:a",
    locale: "en",
    state: { status: "empty" },
  });
  const cleanup = hooks.effects[0]?.();
  expect(hooks.set).toHaveBeenCalledWith({ status: "loading" });
  await vi.waitFor(() => {
    expect(hooks.set).toHaveBeenCalledWith({
      status: "ready",
      response: expect.objectContaining({ enabled: false }) as typeof sample,
    });
  });
  expect((fetchRequest.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);
  cleanup?.();
  expect((fetchRequest.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  const props = panel.props as { refresh: () => void; state: PreviewState };
  props.refresh();
  expect(hooks.set).toHaveBeenCalledWith(1);
  hooks.set.mockClear();
  PreviewPanel({ classId: null, locale: "eu", fetchRequest });
  hooks.effects[1]?.()();
  expect(hooks.set).not.toHaveBeenCalled();
  expect(fetchRequest).toHaveBeenCalledOnce();
});

it("announces loading and disables refresh while a selected class is pending", () => {
  const html = renderToStaticMarkup(
    <PreviewView locale="en" state={{ status: "loading" }} classId="class:a" refresh={vi.fn()} />,
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-atomic="true"');
  expect(html).toContain('aria-live="polite"');
});
