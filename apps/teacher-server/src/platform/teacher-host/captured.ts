/** A value a host port captures while starting; reading it earlier is a composition defect. */
export function captured<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The teacher host state is not available yet.");
  return value;
}
