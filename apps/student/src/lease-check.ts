import { StudentHttpError } from "./http-error.js";

/** A background check found no usable sign-in; the student is asked when they next act. */
export function signInRequired(): StudentHttpError {
  return new StudentHttpError(401, "auth.invalid", false);
}

/**
 * Runs one lease check at a time and lets every caller share it. A caller who may sign in
 * (the student acting) and joins a background check that fails tries again on its own, so a
 * failing background check never keeps the student from signing in.
 */
export class SharedLeaseCheck<T> {
  #current: { readonly result: Promise<T>; readonly interactive: boolean } | null = null;

  public constructor(private readonly check: (interactive: boolean) => Promise<T>) {}

  public run(interactive: boolean): Promise<T> {
    const current = this.#current;
    if (current !== null) {
      return interactive && !current.interactive
        ? current.result.catch(() => this.run(true))
        : current.result;
    }
    const result = this.check(interactive).finally(() => {
      this.#current = null;
    });
    this.#current = { interactive, result };
    return result;
  }
}
