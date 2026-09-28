export class MutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
