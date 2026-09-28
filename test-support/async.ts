export async function settleWithin<T>(
  operation: Promise<T>,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`Timed out waiting for ${description}.`));
  }, timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
