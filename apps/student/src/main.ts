import type { StoredCloseReason } from "./contracts.js";

export interface MareaSessionLifecycle {
  close(reason?: StoredCloseReason): Promise<void>;
  start(projectDisplayName: string): Promise<object>;
}

export interface MareaMainOptions {
  readonly controller: MareaSessionLifecycle;
  readonly projectDisplayName: string;
}

export interface InteractiveMareaMainOptions extends MareaMainOptions {
  readonly dispose: () => void;
  readonly onStarted?: (started: object) => void;
  readonly waitForExit: () => Promise<void>;
}

export async function runMarea(options: MareaMainOptions): Promise<void> {
  await options.controller.start(options.projectDisplayName);
}

export async function runInteractiveMarea(options: InteractiveMareaMainOptions): Promise<void> {
  try {
    const started = await options.controller.start(options.projectDisplayName);
    options.onStarted?.(started);
    try {
      await options.waitForExit();
    } catch (error) {
      await options.controller.close("fatal-error");
      throw error;
    }
    await options.controller.close("student-exit");
  } finally {
    options.dispose();
  }
}
