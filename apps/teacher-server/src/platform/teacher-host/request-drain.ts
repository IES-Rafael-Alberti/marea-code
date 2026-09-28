import type { HostDrainPort } from "../operations/host/contracts.js";

/** Admits requests while serving and waits for in-flight ones to finish before maintenance or exit. */
export class RequestDrain implements HostDrainPort {
  #accepting = true;
  #active = 0;
  #idle: (() => void)[] = [];

  public constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /** Runs the request when admitted; returns undefined while draining. */
  public admit<T>(operation: () => Promise<T>): Promise<T> | undefined {
    if (!this.#accepting) return undefined;
    this.#active += 1;
    return operation().finally(() => {
      this.#active -= 1;
      if (this.#active === 0) for (const resolve of this.#idle.splice(0)) resolve();
    });
  }

  public drain(input: { readonly drainUntil: string }): Promise<"drained" | "expired"> {
    this.#accepting = false;
    if (this.#active === 0) return Promise.resolve("drained");
    const remaining = Date.parse(input.drainUntil) - this.nowMs();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          resolve("expired");
        },
        Math.max(0, remaining),
      );
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve("drained");
      });
    });
  }

  public resume(): void {
    this.#accepting = true;
  }
}
