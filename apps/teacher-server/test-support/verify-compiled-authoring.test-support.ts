import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect } from "vitest";

export function timerHarness(): {
  readonly active: Set<ReturnType<typeof setTimeout>>;
  readonly clearCount: number;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
} {
  const active = new Set<ReturnType<typeof setTimeout>>();
  let clearCount = 0;
  return {
    active,
    get clearCount() {
      return clearCount;
    },
    setTimer: ((...args: Parameters<typeof setTimeout>) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const timer = setTimeout(...args);
      active.add(timer);
      return timer;
    }) as typeof setTimeout,
    clearTimer: ((timer: Parameters<typeof clearTimeout>[0]) => {
      clearCount += 1;
      active.delete(timer as ReturnType<typeof setTimeout>);
      clearTimeout(timer);
    }) as typeof clearTimeout,
  };
}

export class SyntheticChild extends EventEmitter {
  public readonly stdout: EncodingStream | undefined;
  public readonly stderr: EncodingStream | undefined;
  public constructor(
    private readonly onKill: (signal?: NodeJS.Signals) => void,
    withOutput = true,
    encodings?: string[],
    private readonly killResult = true,
  ) {
    super();
    this.stdout = withOutput ? new EncodingStream(encodings) : undefined;
    this.stderr = withOutput ? new EncodingStream(encodings) : undefined;
  }
  public kill(signal?: NodeJS.Signals): boolean {
    this.onKill(signal);
    return this.killResult;
  }
  public emitClose(code: number | null): void {
    this.emit("close", code);
  }
  public emitError(error: Error | string): void {
    this.emit("error", error);
  }
  public emitOutput(stdout: string, stderr: string): void {
    this.stdout?.write(stdout);
    this.stderr?.write(stderr);
  }
}

class EncodingStream extends PassThrough {
  public constructor(private readonly encodings?: string[]) {
    super();
  }
  public override setEncoding(encoding: BufferEncoding): this {
    this.encodings?.push(encoding);
    return super.setEncoding(encoding);
  }
}

export async function expectFailure(
  operation: Promise<void>,
  message: string,
  errorName?: string,
  additionalMessage?: string | (() => string),
  exactMessage?: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    if (error instanceof AggregateError) {
      expect([
        "Compiled authoring verifier failed.",
        "Compiled authoring verifier failed without safe cleanup.",
      ]).toContain(error.message);
      expect(errors.every((item) => item instanceof Error)).toBe(true);
    }
    expect(errors.some((item) => item instanceof Error && item.message.includes(message))).toBe(
      true,
    );
    if (errorName !== undefined)
      expect(errors.some((item) => item instanceof Error && item.name === errorName)).toBe(true);
    if (additionalMessage !== undefined) {
      const expectedMessage =
        typeof additionalMessage === "function" ? additionalMessage() : additionalMessage;
      expect(
        errors.some((item) => item instanceof Error && item.message.includes(expectedMessage)),
      ).toBe(true);
    }
    if (exactMessage !== undefined)
      expect(errors.some((item) => item instanceof Error && item.message === exactMessage)).toBe(
        true,
      );
    return;
  }
  throw new Error(`Expected failure containing ${message}.`);
}

export function syntheticSpawn(
  buildCode = 0,
  smokeCode = 0,
  buildOutput = "",
  smokeOutput = "",
  encodings?: string[],
): typeof spawn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ((...args: Parameters<typeof spawn>) => {
    const [command, commandArgs, options] = args;
    expect(options.cwd).toBeDefined();
    const isBuild = command === "bun";
    expect(isBuild || command.endsWith("authoring-http-smoke")).toBe(true);
    if (isBuild) {
      expect(commandArgs.slice(0, 4)).toEqual([
        "build",
        "./smoke/compiled-skill-authoring-http.ts",
        "--compile",
        "--outfile",
      ]);
      expect(commandArgs[4]).toBeDefined();
    } else {
      expect(commandArgs).toEqual([]);
    }
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const child = new SyntheticChild(() => undefined, true, encodings);
    queueMicrotask(() => {
      child.emitOutput(isBuild ? buildOutput : smokeOutput, isBuild ? buildOutput : smokeOutput);
      child.emitClose(isBuild ? buildCode : smokeCode);
    });
    return child as never;
  }) as never as typeof spawn;
}

export function syntheticNoOutputSpawn(): typeof spawn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ((...args: Parameters<typeof spawn>) => {
    const [command] = args;
    const child = new SyntheticChild(() => undefined, false);
    expect(command === "bun" || command.endsWith("authoring-http-smoke")).toBe(true);
    queueMicrotask(() => {
      child.emitClose(0);
    });
    return child as never;
  }) as never as typeof spawn;
}

function childSpawn(
  onKill: (child: SyntheticChild) => void,
  onBuild: (child: SyntheticChild) => void = (child) => {
    queueMicrotask(() => {
      child.emitClose(0);
    });
  },
  onStart?: (child: SyntheticChild) => void,
): typeof spawn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ((...args: Parameters<typeof spawn>) => {
    const [command] = args;
    const child = new SyntheticChild(() => {
      onKill(child);
    });
    if (command === "bun") onBuild(child);
    else if (onStart !== undefined)
      queueMicrotask(() => {
        onStart(child);
      });
    return child as never;
  }) as never as typeof spawn;
}

export function syntheticTimeoutErrorSpawn(): typeof spawn {
  return childSpawn(
    () => undefined,
    (child) => {
      queueMicrotask(() => {
        child.emitClose(0);
      });
    },
    (child) => {
      child.emitError(new Error("synthetic child exit"));
      setTimeout(() => {
        child.emitClose(1);
      }, 5);
    },
  );
}

export function syntheticNonErrorChildSpawn(): typeof spawn {
  return childSpawn(
    () => undefined,
    (child) => {
      queueMicrotask(() => {
        child.emitClose(0);
      });
    },
    (child) => {
      child.emitError("synthetic non-error child");
      setTimeout(() => {
        child.emitClose(1);
      }, 5);
    },
  );
}

export function syntheticTimeoutCloseSpawn(): typeof spawn {
  return childSpawn(
    (child) => {
      child.emitClose(137);
    },
    (child) => {
      queueMicrotask(() => {
        child.emitClose(0);
      });
    },
  );
}

export function syntheticErrorThenDelayedCloseSpawn(): typeof spawn {
  return childSpawn(
    () => undefined,
    undefined,
    (child) => {
      child.emitError(new Error("synthetic child error"));
      setTimeout(() => {
        child.emitClose(1);
      }, 5);
    },
  );
}

export function syntheticErrorWithoutCloseSpawn(): typeof spawn {
  return childSpawn(
    () => undefined,
    undefined,
    (child) => {
      child.emitError(new Error("synthetic child error without close"));
    },
  );
}

export function syntheticTimeoutKillErrorCloseSpawn(): typeof spawn {
  return childSpawn((child) => {
    child.emitError(new Error("synthetic kill error"));
    setTimeout(() => {
      child.emitClose(137);
    }, 5);
  });
}

export function syntheticNoCloseSpawn(): typeof spawn {
  return childSpawn(() => undefined);
}

export function syntheticKillFailureSpawn(): typeof spawn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ((...args: Parameters<typeof spawn>) => {
    const [command] = args;
    const child = new SyntheticChild(() => undefined, true, undefined, false);
    if (command === "bun")
      queueMicrotask(() => {
        child.emitClose(0);
      });
    return child as never;
  }) as never as typeof spawn;
}

export function syntheticKillThrowSpawn(): typeof spawn {
  return childSpawn(() => {
    throw new Error("synthetic kill failure");
  });
}
