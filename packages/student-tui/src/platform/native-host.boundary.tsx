/** @jsxImportSource @opentui/react */
import { requireParserAsset } from "./parser-asset.boundary.js";
import { registerReferenceMarkdown } from "./reference-markdown.boundary.js";
import { registerReferenceBoxes } from "./reference-box.boundary.js";
import { installTerminalControls } from "./terminal-controls.js";
import { createCliRenderer, getTreeSitterClient } from "@opentui/core";
import { createRoot, flushSync, type Root } from "@opentui/react";
import { useSyncExternalStore, type ReactNode } from "react";

export interface OpenTuiHost {
  dispose(): void;
  render(node: ReactNode): void;
}

export async function createNativeOpenTuiHost(
  options: { readonly mouse?: boolean } = {},
): Promise<OpenTuiHost> {
  requireParserAsset();
  registerReferenceBoxes();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: options.mouse ?? true,
    openConsoleOnError: false,
  });
  registerReferenceMarkdown(getTreeSitterClient());
  let screen: ReactNode = null;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const snapshot = () => screen;
  function Screen() {
    return useSyncExternalStore(subscribe, snapshot);
  }
  let root: Root;
  const release = installTerminalControls(renderer);
  try {
    renderer.setTerminalTitle("Marea Code");
    root = createRoot(renderer);
    // OpenTUI's root.render creates a reconciler container on every call.
    // Mount once; keep component identity and terminal state across updates.
    root.render(<Screen />);
  } catch {
    release();
    renderer.destroy();
    throw new Error("OpenTUI React root creation failed.");
  }
  let disposed = false;

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        release();
        flushSync(() => {
          root.unmount();
        });
      } finally {
        renderer.destroy();
      }
    },
    render(node: ReactNode): void {
      if (disposed) return;
      screen = node;
      for (const listener of listeners) listener();
    },
  });
}
