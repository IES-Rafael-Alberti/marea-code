import { CanonicalRunEventSchema, type CanonicalRunEvent } from "@marea/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ copied: false, initial: null as boolean | null, set: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: boolean) => {
    state.initial = initial;
    return [state.copied, state.set];
  },
}));

import { ConversationEvent } from "./conversation-events.js";
import { sessionsMessages } from "./sessions-messages.js";
import { technicalDetail, TurnDiagnostic } from "./turn-diagnostic.js";

const event = CanonicalRunEventSchema.parse({
  eventType: "turn-diagnostic",
  eventId: "event:diagnostic",
  sequence: 9,
  occurredAt: "2026-11-24T18:23:32.000Z",
  messageId: "message:1",
  category: "unexpected/adapter.upstream-contract-changed",
  retryable: false,
  exception: { name: "AgentAdapterError", message: "unsupported approval payload" },
  causes: [{ name: "ZodError", message: "too many items" }],
  stack: "AgentAdapterError: unsupported\n    at approvalEventFor",
  requestId: "request:model",
  modelResponse: '{"tool":"execute"}',
  client: { version: "0.1.0-preview.44", platform: "win32-x64" },
}) as Extract<CanonicalRunEvent, { eventType: "turn-diagnostic" }>;

function button(node: ReactNode): ReactElement<{ onClick: () => void }> | null {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.type === "button") return node as ReactElement<{ onClick: () => void }>;
  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = button(child as ReactNode);
    if (found !== null) return found;
  }
  return null;
}

describe("turn diagnostic in the session view", () => {
  it("collects the category, versions, exception chain, stack and model response", () => {
    expect(technicalDetail(event)).toBe(
      [
        "category: unexpected/adapter.upstream-contract-changed",
        "retryable: false",
        "client: 0.1.0-preview.44 (win32-x64)",
        "request: request:model",
        "exception: AgentAdapterError: unsupported approval payload",
        "caused by: ZodError: too many items",
        "",
        "AgentAdapterError: unsupported\n    at approvalEventFor",
        "",
        "model response:",
        '{"tool":"execute"}',
      ].join("\n"),
    );
    const minimal = { ...event };
    Reflect.deleteProperty(minimal, "requestId");
    Reflect.deleteProperty(minimal, "modelResponse");
    expect(technicalDetail(minimal)).toBe(
      [
        "category: unexpected/adapter.upstream-contract-changed",
        "retryable: false",
        "client: 0.1.0-preview.44 (win32-x64)",
        "exception: AgentAdapterError: unsupported approval payload",
        "caused by: ZodError: too many items",
        "",
        "AgentAdapterError: unsupported\n    at approvalEventFor",
      ].join("\n"),
    );
  });

  it.each(["es", "en", "eu"] as const)(
    "shows a collapsed %s detail with a copy button",
    (locale) => {
      const m = sessionsMessages(locale);
      const markup = renderToStaticMarkup(<ConversationEvent event={event} messages={m} />);
      expect(markup).toContain(m.technicalDetail);
      expect(markup).toContain("unexpected/adapter.upstream-contract-changed");
      expect(markup).toContain(`<summary>${m.showDetail}</summary>`);
      expect(markup).toContain(m.copyDetail);
      expect(markup).toContain('<time dateTime="2026-11-24T18:23:32.000Z">18:23:32</time>');
      // The copy confirmation starts hidden.
      expect(state.initial).toBe(false);
    },
  );

  it("copies the technical detail and confirms it", async () => {
    const copy = vi.fn(() => Promise.resolve());
    const m = sessionsMessages("es");
    button(TurnDiagnostic({ event, messages: m, copy }))?.props.onClick();
    expect(copy).toHaveBeenCalledWith(technicalDetail(event));
    await vi.waitFor(() => {
      expect(state.set).toHaveBeenCalledWith(true);
    });
    state.copied = true;
    expect(
      renderToStaticMarkup(<TurnDiagnostic event={event} messages={m} copy={copy} />),
    ).toContain(m.copied);
    state.copied = false;
  });

  it("copies through the browser clipboard by default", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    button(TurnDiagnostic({ event, messages: sessionsMessages("en") }))?.props.onClick();
    expect(writeText).toHaveBeenCalledWith(technicalDetail(event));
    vi.unstubAllGlobals();
  });
});
