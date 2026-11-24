import { ActiveRunDashboardResponseSchema } from "@marea/protocol";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { vi } from "vitest";

export function createRootRecorder(): {
  readonly rendered: ReactNode[];
  readonly root: Root;
  readonly unmount: ReturnType<typeof vi.fn>;
} {
  const rendered: ReactNode[] = [];
  const unmount = vi.fn();
  return {
    rendered,
    unmount,
    root: {
      render: (children): void => {
        rendered.push(children);
      },
      unmount,
    },
  };
}

export function createDocument(root: HTMLElement | null): Document {
  return {
    documentElement: { lang: "" },
    getElementById: (id: string): HTMLElement | null => (id === "root" ? root : null),
  } as Document;
}

export const emptyResponse = ActiveRunDashboardResponseSchema.parse({
  kind: "active-runs-response",
  protocolVersion: "0.1",
  requestId: "request:dashboard",
  generatedAt: "2026-09-03T08:00:00.000Z",
  viewer: { role: "teacher", displayName: "Ada" },
  runs: [],
  nextCursor: null,
});
