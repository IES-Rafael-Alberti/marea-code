/** Coalesces live invalidations without losing a change received during a read. */
export class SessionRefresh {
  private running = false;
  private generation = Symbol();
  private readonly lifetime = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly read: () => Promise<void>,
    private readonly interval: number,
  ) {}
  invalidate(): void {
    this.generation = Symbol();
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.running || this.lifetime.signal.aborted) return;
    clearTimeout(this.timer);
    this.running = true;
    const observed = this.generation;
    try {
      await this.read();
    } finally {
      this.running = false;
      this.schedule(observed);
    }
  }
  private schedule(observed: symbol): void {
    if (this.lifetime.signal.aborted) return;
    if (observed !== this.generation) void this.refresh();
    else
      this.timer = setTimeout(() => {
        void this.refresh();
      }, this.interval);
  }

  dispose(): void {
    this.lifetime.abort();
    clearTimeout(this.timer);
  }
}
