// Captured before any test installs fake timers.
const nextMacrotask = globalThis.setImmediate;

/**
 * Fire-and-forget promise failures otherwise surface only after the test has passed, where the
 * runner reports them outside any assertion. Observe them inside the test instead.
 */
export async function collectUnhandledRejections(
  action: () => Promise<void> | void,
): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    await action();
    await new Promise<void>((resolve) => {
      nextMacrotask(resolve);
    });
  } finally {
    process.off("unhandledRejection", record);
  }
  return rejections;
}
