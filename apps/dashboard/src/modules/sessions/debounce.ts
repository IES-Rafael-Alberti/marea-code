/** Runs the latest request once `waitMs` have passed without a newer one. */
export class Debounce {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly waitMs: number) {}
  run(action: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      action();
    }, this.waitMs);
  }
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
