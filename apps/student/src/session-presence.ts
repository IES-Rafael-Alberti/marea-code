import type { RunToken } from "@marea/protocol";

import type { ConnectionDiagnostics } from "./connection-diagnostics.boundary.js";

export interface SessionPresenceOptions {
  readonly connection: ConnectionDiagnostics;
  readonly heartbeat: (token: RunToken) => Promise<void>;
  /** The run token for a background caller: it never asks the student to sign in. */
  readonly token: () => Promise<RunToken>;
  readonly closing: () => boolean;
  readonly aborted: () => boolean;
}

/**
 * The 30-second presence heartbeat of an open session. It never interrupts the student: it
 * never asks them to sign in, and a failure is recorded for the teacher instead. Signing in
 * again waits until the student acts.
 */
export class SessionPresence {
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;

  public constructor(private readonly options: SessionPresenceOptions) {}

  /** True while a heartbeat is in flight. */
  public get busy(): boolean {
    return this.#busy;
  }

  public start(): void {
    this.#timer = setInterval(() => {
      void this.send();
    }, 30000);
    this.#timer.unref();
    void this.send();
  }

  public stop(): void {
    clearInterval(this.#timer);
  }

  private async send(): Promise<void> {
    if (this.#busy || this.options.closing()) return;
    this.#busy = true;
    try {
      await this.options.connection.heartbeat(this.options.token, async (token) => {
        if (!this.options.aborted()) await this.options.heartbeat(token);
      });
    } finally {
      this.#busy = false;
    }
  }
}
