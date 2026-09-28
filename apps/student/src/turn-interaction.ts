export function interactionAfterAbort<T>(
  confirmation: () => Promise<T>,
  signal: AbortSignal,
  fallback: T,
  failureMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  const aborted = Promise.withResolvers<T>();
  const rejectApproval = (): void => {
    aborted.resolve(fallback);
  };
  signal.addEventListener("abort", rejectApproval);
  const requested = (async (): Promise<T> => {
    try {
      return await confirmation();
    } catch (error) {
      throw error instanceof Error ? error : new Error(failureMessage);
    }
  })();
  return Promise.race([requested, aborted.promise]).finally(() => {
    signal.removeEventListener("abort", rejectApproval);
  });
}
