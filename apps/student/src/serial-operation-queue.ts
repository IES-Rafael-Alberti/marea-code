export class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  after<T>(operation: () => Promise<T>): Promise<T> {
    return this.tail.then(operation, operation);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.after(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
