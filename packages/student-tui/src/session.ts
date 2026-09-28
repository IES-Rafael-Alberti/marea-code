import type {
  SignalSource,
  StudentTuiExitReason,
  StudentTuiIntent,
  StudentTuiOutcome,
  StudentTuiSession,
  StudentTuiView,
} from "./contracts.js";
import { attemptCleanup } from "./cleanup.js";
import { createScreenController, type ScreenController } from "./screen-controller.js";

interface SessionOptions {
  readonly setExitCode: (code: number) => void;
  readonly signals: SignalSource;
  readonly view: StudentTuiView;
}

export interface SessionBinding {
  readonly session: StudentTuiSession;
  handleIntent(intent: StudentTuiIntent): void;
}

const OUTCOMES: Readonly<Record<StudentTuiExitReason, StudentTuiOutcome>> = Object.freeze({
  closed: Object.freeze({ exitCode: 0, reason: "closed" }),
  quit: Object.freeze({ exitCode: 0, reason: "quit" }),
  sigint: Object.freeze({ exitCode: 130, reason: "sigint" }),
  sigterm: Object.freeze({ exitCode: 143, reason: "sigterm" }),
});

function initializeScreen(view: StudentTuiView): ScreenController {
  try {
    return createScreenController(view);
  } catch {
    attemptCleanup(() => {
      view.dispose();
    });
    throw new Error("Student TUI setup failed.");
  }
}

export function createStudentTuiSession(options: SessionOptions): SessionBinding {
  const screen = initializeScreen(options.view);
  let resolveOutcome!: (outcome: StudentTuiOutcome) => void;
  const outcome = new Promise<StudentTuiOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let resolveCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  let settled = false;
  const unsubscribe = new Set<() => void>();

  const removeSignalListeners = (): void => {
    for (const remove of unsubscribe) attemptCleanup(remove);
  };

  const cancelCurrent = (): void => {
    if (screen.snapshot().status !== "streaming") return;
    attemptCleanup(() => {
      screen.cancel();
    });
    resolveCancellation();
  };

  const finish = (reason: StudentTuiExitReason): boolean => {
    if (settled) return false;
    cancelCurrent();
    settled = true;
    attemptCleanup(() => {
      screen.dispose();
    });
    removeSignalListeners();
    const result = OUTCOMES[reason];
    attemptCleanup(() => {
      options.setExitCode(result.exitCode);
    });
    resolveOutcome(result);
    return true;
  };

  try {
    unsubscribe.add(options.signals.subscribe("SIGINT", () => finish("sigint")));
    unsubscribe.add(options.signals.subscribe("SIGTERM", () => finish("sigterm")));
  } catch {
    removeSignalListeners();
    attemptCleanup(() => {
      screen.dispose();
    });
    throw new Error("Student TUI signal setup failed.");
  }

  const session: StudentTuiSession = Object.freeze({
    appendText(chunk: string): boolean {
      return !settled && screen.appendText(chunk);
    },
    cancellation,
    close(): boolean {
      return finish("closed");
    },
    complete(): boolean {
      return !settled && screen.complete();
    },
    outcome,
    snapshot: () => screen.snapshot(),
  });

  return Object.freeze({
    handleIntent(intent: StudentTuiIntent): void {
      if (intent === "cancel") cancelCurrent();
      else finish(intent === "interrupt" ? "sigint" : "quit");
    },
    session,
  });
}
