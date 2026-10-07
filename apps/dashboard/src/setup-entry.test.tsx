import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
const ports = vi.hoisted(() => ({ render: vi.fn(), replace: vi.fn(), create: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: ports.create }));
vi.mock("./setup/wizard.js", () => ({ SetupWizard: () => null }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});
it.each([null, "", "invalid", "x".repeat(44), "x".repeat(43)])(
  "requires a valid capability before mounting the wizard: %s",
  async (token) => {
    const root = {};
    ports.create.mockReturnValue({ render: ports.render });
    const getElementById = vi.fn(() => root);
    vi.stubGlobal("document", { getElementById });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    vi.stubGlobal("location", {
      hash: token === null ? "" : `#token=${token}`,
      replace: ports.replace,
    });
    await import("./setup-entry.js");
    expect(ports.create).toHaveBeenCalledWith(root);
    expect(getElementById).toHaveBeenCalledWith("root");
    const node = ports.render.mock.calls[0]?.[0] as ReactElement<{
      openDashboard: (url: string) => void;
      initialLocale: string;
    }>;
    if (token?.length === 43) {
      expect(node.props.initialLocale).toBe("en");
      node.props.openDashboard("http://127.0.0.1/dashboard/");
      expect(ports.replace).toHaveBeenCalledWith("http://127.0.0.1/dashboard/");
    } else expect(renderToStaticMarkup(node)).toContain("Open the setup link");
  },
);
it("does nothing when its mount is absent", async () => {
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("navigator", { languages: [] });
  vi.stubGlobal("location", { hash: "" });
  await import("./setup-entry.js");
  expect(ports.create).not.toHaveBeenCalled();
});
