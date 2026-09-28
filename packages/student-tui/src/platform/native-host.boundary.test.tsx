import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  asset: vi.fn(),
  parser: {},
  boxes: vi.fn(),
  markdown: vi.fn(),
  createRenderer: vi.fn(),
  createRoot: vi.fn(),
  destroy: vi.fn(),
  title: vi.fn(),
  release: vi.fn(),
  install: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
  store: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: doubles.store,
}));

vi.mock("./parser-asset.boundary.js", () => ({ requireParserAsset: doubles.asset }));
vi.mock("./reference-markdown.boundary.js", () => ({
  registerReferenceMarkdown: doubles.markdown,
}));
vi.mock("./reference-box.boundary.js", () => ({ registerReferenceBoxes: doubles.boxes }));
vi.mock("./terminal-controls.js", () => ({ installTerminalControls: doubles.install }));
vi.mock("@opentui/core", () => ({
  createCliRenderer: doubles.createRenderer,
  getTreeSitterClient: () => doubles.parser,
}));
vi.mock("@opentui/react", () => ({
  createRoot: doubles.createRoot,
  flushSync: (callback: () => void) => {
    callback();
  },
}));

import { createNativeOpenTuiHost } from "./native-host.boundary.js";

describe("createNativeOpenTuiHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.createRenderer.mockResolvedValue({
      destroy: doubles.destroy,
      setTerminalTitle: doubles.title,
    });
    doubles.install.mockReturnValue(doubles.release);
    doubles.createRoot.mockReturnValue({ render: doubles.render, unmount: doubles.unmount });
  });

  it("renders through React and disposes both layers once", async () => {
    const host = await createNativeOpenTuiHost();
    const node: ReactNode = "screen";

    host.render(node);
    host.dispose();
    host.dispose();
    host.render("late");

    expect(doubles.asset).toHaveBeenCalledOnce();
    expect(doubles.boxes).toHaveBeenCalledOnce();
    expect(doubles.markdown).toHaveBeenCalledExactlyOnceWith(doubles.parser);
    expect(doubles.createRenderer).toHaveBeenCalledWith({
      exitOnCtrlC: false,
      useMouse: true,
      openConsoleOnError: false,
    });
    expect(doubles.createRoot).toHaveBeenCalledWith({
      destroy: doubles.destroy,
      setTerminalTitle: doubles.title,
    });
    expect(doubles.render).toHaveBeenCalledOnce();
    expect(doubles.title).toHaveBeenCalledExactlyOnceWith("Marea Code");
    expect(doubles.release).toHaveBeenCalledOnce();
    expect(doubles.unmount).toHaveBeenCalledOnce();
    expect(doubles.destroy).toHaveBeenCalledOnce();
  });

  it("keeps one root and publishes the latest screen to active subscribers", async () => {
    const host = await createNativeOpenTuiHost();
    const mounted = doubles.render.mock.calls[0]?.[0] as { type: () => ReactNode };
    doubles.store.mockReturnValue("mounted screen");
    expect(mounted.type()).toBe("mounted screen");
    const [subscribe, snapshot] = doubles.store.mock.calls[0] as [
      (listener: () => void) => () => void,
      () => ReactNode,
    ];
    expect(snapshot()).toBeNull();
    host.render("before subscription");
    expect(snapshot()).toBe("before subscription");
    const changed = vi.fn();
    const second = vi.fn();
    const unsubscribe = subscribe(changed);
    const unsubscribeSecond = subscribe(second);
    host.render("first");
    expect(snapshot()).toBe("first");
    expect(changed).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribe();
    host.render("second");
    expect(snapshot()).toBe("second");
    expect(changed).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    host.dispose();
    host.render("late");
    expect(snapshot()).toBe("second");
    expect(doubles.render).toHaveBeenCalledOnce();
  });

  it("cleans up when the initial root render fails", async () => {
    doubles.render.mockImplementationOnce(() => {
      throw new Error("mount failed");
    });
    await expect(createNativeOpenTuiHost()).rejects.toThrow("OpenTUI React root creation failed.");
    expect(doubles.release).toHaveBeenCalledOnce();
    expect(doubles.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the native renderer when React unmounting fails", async () => {
    doubles.unmount.mockImplementationOnce(() => {
      throw new Error("unmount failed");
    });
    const host = await createNativeOpenTuiHost();

    expect(() => {
      host.dispose();
    }).toThrow("unmount failed");
    expect(doubles.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the native renderer when React root creation fails", async () => {
    doubles.createRoot.mockImplementationOnce(() => {
      throw new Error("root failed");
    });

    await expect(createNativeOpenTuiHost()).rejects.toThrow("OpenTUI React root creation failed.");
    expect(doubles.release).toHaveBeenCalledOnce();
    expect(doubles.destroy).toHaveBeenCalledOnce();
  });

  it("allows native terminal selection when mouse reporting is disabled", async () => {
    const host = await createNativeOpenTuiHost({ mouse: false });
    expect(doubles.createRenderer).toHaveBeenLastCalledWith({
      exitOnCtrlC: false,
      useMouse: false,
      openConsoleOnError: false,
    });
    host.dispose();
  });
});
