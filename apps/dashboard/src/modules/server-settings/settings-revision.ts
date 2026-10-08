export interface SettingsRevision {
  readonly before: number;
  readonly after: number;
}

/** Disjoint forms may advance a shared revision only from the same saved base. */
export function advanceSettingsRevision<T extends object | null>(
  state: T,
  change: SettingsRevision,
): T {
  return state && "revision" in state && state.revision === change.before
    ? { ...state, revision: change.after }
    : state;
}
