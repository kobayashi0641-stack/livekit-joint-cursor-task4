export type SequentialUploadQueueOptions = {
  maxAttempts: number;
  retryDelayMs: number;
};

type QueueEntry<T> = {
  key: string;
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
};

export class SequentialUploadQueue<T> {
  private readonly entries: QueueEntry<T>[] = [];
  private readonly pendingByKey = new Map<string, Promise<void>>();
  private processing = false;
  private flushWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private terminalErrors: unknown[] = [];

  constructor(
    private readonly upload: (value: T) => Promise<void>,
    private readonly options: SequentialUploadQueueOptions,
  ) {}

  get pendingCount(): number {
    return this.pendingByKey.size;
  }

  enqueue(key: string, value: T): Promise<void> {
    const existing = this.pendingByKey.get(key);
    if (existing) return existing;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: QueueEntry<T> = { key, value, resolve, reject, promise };
    this.pendingByKey.set(key, promise);
    this.entries.push(entry);
    void this.process();
    return promise;
  }

  flush(): Promise<void> {
    if (!this.processing && this.entries.length === 0) {
      if (this.terminalErrors.length > 0) {
        const errors = this.terminalErrors.splice(0);
        return Promise.reject(new AggregateError(errors, 'One or more recording uploads failed'));
      }
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
    });
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.entries.length > 0) {
        const entry = this.entries.shift()!;
        try {
          await this.uploadWithRetry(entry.value);
          entry.resolve();
        } catch (error) {
          this.terminalErrors.push(error);
          entry.reject(error);
        } finally {
          this.pendingByKey.delete(entry.key);
        }
      }
    } finally {
      this.processing = false;
      const waiters = this.flushWaiters.splice(0);
      if (this.terminalErrors.length > 0) {
        const errors = this.terminalErrors.splice(0);
        const error = new AggregateError(errors, 'One or more recording uploads failed');
        waiters.forEach((waiter) => waiter.reject(error));
      } else {
        waiters.forEach((waiter) => waiter.resolve());
      }
    }
  }

  private async uploadWithRetry(value: T): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        await this.upload(value);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxAttempts && this.options.retryDelayMs > 0) {
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, this.options.retryDelayMs * attempt);
          });
        }
      }
    }
    throw lastError;
  }
}
