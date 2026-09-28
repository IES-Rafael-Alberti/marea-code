const gates = new Map<string, Promise<void>>();

/**
 * Serializes independent stores that manage the same resolved owner root.
 * Gate chains are retained for the process lifetime; owner roots are bounded.
 */
export function withOwnerGate<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = gates.get(root) ?? Promise.resolve();
  const operation = previous.then(run);
  gates.set(
    root,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return operation;
}
