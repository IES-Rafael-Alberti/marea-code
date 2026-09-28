export function attemptCleanup(operation: () => void): void {
  try {
    operation();
  } catch {
    // Cleanup failures cannot change an already selected public outcome.
  }
}
